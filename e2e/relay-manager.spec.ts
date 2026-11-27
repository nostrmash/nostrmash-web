import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

import type { SignedEvent, UnsignedEvent } from "../lib/api/schemas/relay-manager";
import {
  currentRelay,
  managerPubkey,
  nextRelay,
  readOnlyPubkey,
  sharedOutbox,
  signFixture,
  sourceEvent,
} from "./relay-manager-fixture.mjs";

type TestPage = Window & { signRelayTest: (event: UnsignedEvent) => Promise<SignedEvent> };

async function connectFixtureSigner(
  page: Page,
  options?: { afterSign?: () => void; signerPubkey?: string }
) {
  const signed: UnsignedEvent[] = [];
  await page.exposeFunction("signRelayTest", (event: UnsignedEvent) => {
    signed.push(event);
    options?.afterSign?.();
    return signFixture(event);
  });
  await page.addInitScript((pubkey) => {
    const browser = window as unknown as TestPage;
    Object.defineProperty(browser, "nostr", {
      value: {
        getPublicKey: async () => pubkey,
        signEvent: (event: UnsignedEvent) => browser.signRelayTest(event),
      },
    });
  }, options?.signerPubkey ?? managerPubkey);
  return signed;
}

async function inspect(page: Page, pubkey: string) {
  await page.getByRole("textbox", { name: /inspect .*account/i }).fill(pubkey);
  await page.getByRole("button", { name: "Inspect account", exact: true }).click();
}

test.use({ video: process.env.RELAY_MANAGER_ARTIFACTS ? "on" : "off" });

test.describe("Relay Manager", () => {
  test("reviews, signs, publishes and verifies a replacement with a partial retry", async ({
    page,
    request,
  }, info) => {
    await request.post("http://127.0.0.1:8080/__fixtures/relay-manager/reset");
    const signed = await connectFixtureSigner(page);
    const sends: { url: string; event: SignedEvent }[] = [];
    let latest: SignedEvent = sourceEvent;
    const attempts = new Map<string, number>();
    await page.routeWebSocket(/^wss:\/\/(purplepag\.es|relay\.damus\.io|nos\.lol)\/?$/, (relay) => {
      relay.onMessage((data) => {
        const [type, value] = JSON.parse(String(data));
        if (type === "REQ") {
          relay.send(JSON.stringify(["EVENT", value, latest]));
          relay.send(JSON.stringify(["EOSE", value]));
        }
        if (type === "EVENT") {
          const host = new URL(relay.url()).hostname;
          const used = (attempts.get(host) ?? 0) + 1;
          attempts.set(host, used);
          sends.push({ url: host, event: value });
          const accepted = host !== "nos.lol" || used > 1;
          if (accepted) latest = value;
          relay.send(
            JSON.stringify(["OK", value.id, accepted, accepted ? "" : "restricted: test access"])
          );
        }
      });
    });
    await page.goto("/relays");
    await page.getByRole("link", { name: "Relay Manager" }).click();
    await expect(page.getByRole("heading", { name: "Relay Manager" })).toBeVisible();
    await inspect(page, managerPubkey);
    await expect(page).toHaveURL(new RegExp(`viewer=${managerPubkey}`));
    await expect(page.getByRole("heading", { name: "Avery Relay" })).toBeVisible();
    await expect(page.getByText("Your public inbox has one relay.")).toBeVisible();
    await expect(page.getByText(/public follows, interactions and declarations/)).toBeVisible();
    const roles = page.getByText("Roles to optimize", { exact: true });
    await roles.click();
    await page.getByRole("checkbox", { name: "Public outbox" }).uncheck();
    await page.getByRole("checkbox", { name: "DM inbox" }).uncheck();
    await page.getByRole("checkbox", { name: "Search relays" }).uncheck();
    await roles.click();
    await page.getByRole("button", { name: "Optimize configuration" }).click();
    await expect(page.getByRole("heading", { name: "Proposed configuration" })).toBeVisible();
    await expect(page.getByText("Added in proposal", { exact: true })).toBeVisible();
    await expect(page.getByText("Removed in proposal", { exact: true })).toBeVisible();
    expect(signed).toHaveLength(0);
    await page.getByRole("button", { name: "Connect a signer" }).click();
    await expect(page.getByText("Signer owns this account")).toBeVisible();
    await page.getByRole("button", { name: "Refresh sources and review" }).click();
    await expect(page.getByRole("heading", { name: "Final review" })).toBeVisible();
    expect(signed).toHaveLength(0);
    if (process.env.RELAY_MANAGER_ARTIFACTS) {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await page.screenshot({
        path: info.outputPath("relay-manager-desktop.png"),
        fullPage: true,
        animations: "disabled",
      });
    }
    await page.getByRole("button", { name: "Sign and publish reviewed changes" }).click();
    await expect(page.getByText("Sample verified", { exact: true })).toBeVisible();
    expect(signed).toHaveLength(1);
    expect(signed[0]?.content).toBe("preserved content");
    expect(signed[0]?.tags).toEqual([
      ["r", sharedOutbox, "write"],
      ["custom", "keep"],
      ["r", nextRelay, "read"],
    ]);
    expect(sends).toHaveLength(3);
    await expect(page.getByText("2 of 3 relays accepted")).toBeVisible();
    await expect(
      page.getByText("Index has a different version or is still updating")
    ).toBeVisible();
    await page.getByRole("button", { name: "Refresh configuration" }).click();
    await expect(page.getByText("Visible in index")).toBeVisible();
    await page.getByRole("button", { name: "Retry unaccepted relays" }).click();
    await expect(page.getByText("3 of 3 relays accepted")).toBeVisible();
    expect(signed).toHaveLength(1);
    expect(sends).toHaveLength(4);
    expect(new Set(sends.map(({ event }) => event.id)).size).toBe(1);
    await page.getByRole("button", { name: "Finish and refresh account" }).click();
    const current = page.getByRole("complementary", {
      name: "Current configuration and diagnostics",
    });
    await current.getByText("Public inbox", { exact: true }).last().click();
    await expect(current.getByText(nextRelay, { exact: true })).toBeVisible();
  });

  test("keeps other accounts read-only and cannot apply an unreadable proposal on mobile", async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const signed = await connectFixtureSigner(page, { signerPubkey: readOnlyPubkey });
    await page.goto("/relays/manager");
    await page.getByRole("textbox", { name: "Inspect an account" }).fill("not-a-public-key");
    await page.getByRole("button", { name: "Inspect account", exact: true }).click();
    await expect(
      page.getByText("Enter a valid npub, nprofile or 64-character public key.")
    ).toBeVisible();
    await inspect(page, `nostr:${readOnlyPubkey}`);
    await expect(page.getByRole("heading", { name: "Public Observer" })).toBeVisible();
    await expect(page.getByText("Read-only", { exact: true })).toBeVisible();
    await page.getByLabel("Optimization preset").selectOption("privacy");
    await expect(page.getByText(/DM privacy depends on verified relay behavior/)).toBeVisible();
    await page.getByRole("button", { name: "Optimize configuration" }).click();
    await expect(page.getByText("Unsafe or incomplete proposal")).toBeVisible();
    await page.getByRole("button", { name: "Connect a signer" }).click();
    await expect(page.getByText("Signer owns this account")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sign and publish reviewed changes" })
    ).toHaveCount(0);
    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    expect(horizontalOverflow).toBe(false);
    const violations = await new AxeBuilder({ page })
      .include("#main-content")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(violations.violations).toEqual([]);
    if (process.env.RELAY_MANAGER_ARTIFACTS) {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await page.screenshot({
        path: info.outputPath("relay-manager-mobile.png"),
        fullPage: true,
        animations: "disabled",
      });
    }
    await inspect(page, "d".repeat(64));
    await expect(page.getByText("Connected to another account")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Proposed configuration" })).toHaveCount(0);
    expect(signed).toHaveLength(0);
  });

  test("discards approval when a newer source appears during review", async ({ page }) => {
    const signed = await connectFixtureSigner(page);
    let latest = sourceEvent;
    await page.routeWebSocket(/^wss:\/\/(purplepag\.es|relay\.damus\.io|nos\.lol)\/?$/, (relay) => {
      relay.onMessage((data) => {
        const [type, id] = JSON.parse(String(data));
        expect(type).toBe("REQ");
        relay.send(JSON.stringify(["EVENT", id, latest]));
        relay.send(JSON.stringify(["EOSE", id]));
      });
    });
    await page.route("**/api/relay-manager/config?*", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.sources[0].canonical_event_id = sourceEvent.id;
      data.sources[0].projection_event_id = sourceEvent.id;
      await route.fulfill({ response, json: data });
    });
    await page.route("**/api/relay-manager/optimize", async (route) => {
      const body = route.request().postDataJSON();
      const response = await route.fetch({
        postData: { ...body, source_events: body.source_events ?? [sourceEvent] },
      });
      await route.fulfill({ response });
    });
    await page.goto(`/relays/manager?viewer=${managerPubkey}`);
    await page.getByRole("button", { name: "Connect a signer" }).click();
    await page.getByRole("button", { name: "Optimize configuration" }).click();
    await page.getByRole("button", { name: "Refresh sources and review" }).click();
    await expect(page.getByRole("heading", { name: "Final review" })).toBeVisible();
    latest = signFixture({
      ...sourceEvent,
      created_at: sourceEvent.created_at + 20,
      tags: [...sourceEvent.tags, ["updated", currentRelay]],
    });
    await page.getByRole("button", { name: "Sign and publish reviewed changes" }).click();
    await expect(
      page.getByText(
        "The proposal or publication targets changed. Review the updated plan and confirm it again."
      )
    ).toBeVisible();
    expect(signed).toHaveLength(0);
  });
});
