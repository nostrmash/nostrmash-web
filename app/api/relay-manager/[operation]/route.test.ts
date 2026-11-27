import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "./route";
import { ApiError, fetchApiJson } from "@/lib/api/http";
import { managerPubkey, sourceEvent } from "../../../../e2e/relay-manager-fixture.mjs";

vi.mock("@/lib/api/endpoints/profiles", () => ({ getProfile: vi.fn() }));
vi.mock(import("@/lib/api/http"), async (importActual) => ({
  ...(await importActual()),
  fetchApiJson: vi.fn(),
}));

const context = (operation: string) => ({ params: Promise.resolve({ operation }) });
const base = "https://nostrmash.example/api/relay-manager";

function post(operation: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`${base}/${operation}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(fetchApiJson).mockReset();
});

describe("relay manager route", () => {
  it("only permits fixed upstream endpoints and validated query parameters", async () => {
    vi.mocked(fetchApiJson).mockResolvedValue({ roles: [] });
    await GET(new NextRequest(`${base}/roles?url=https://other.example`), context("roles"));
    expect(fetchApiJson).toHaveBeenCalledWith("/api/v1/relays/roles", expect.anything());
    expect(
      (await GET(new NextRequest(`${base}/config?pubkey=bad`), context("config"))).status
    ).toBe(400);
    expect((await GET(new NextRequest(`${base}/other`), context("other"))).status).toBe(404);
    expect(fetchApiJson).toHaveBeenCalledTimes(1);
  });

  it("bounds the body, rejects cross-site submissions and validates signed event fields", async () => {
    expect(
      (
        await POST(
          post("optimize", { pubkey: managerPubkey, junk: "X".repeat(65_536) }),
          context("optimize")
        )
      ).status
    ).toBe(413);
    expect(
      (
        await POST(
          post("optimize", { pubkey: managerPubkey }, { "Sec-Fetch-Site": "cross-site" }),
          context("optimize")
        )
      ).status
    ).toBe(403);
    expect(
      (
        await POST(
          post("verify", {
            event: { ...sourceEvent, sig: "bad" },
            relays: ["wss://relay.example"],
          }),
          context("verify")
        )
      ).status
    ).toBe(400);
    expect(fetchApiJson).not.toHaveBeenCalled();
  });

  it("forwards bounded signed source requests without caching and preserves overload semantics", async () => {
    vi.mocked(fetchApiJson).mockRejectedValue(
      new ApiError({
        status: 503,
        code: "overloaded",
        message: "Busy",
        path: "optimize",
        retryAfter: "1",
      })
    );
    const input = { pubkey: managerPubkey, source_events: [sourceEvent] };
    const response = await POST(post("optimize", input), context("optimize"));
    expect(fetchApiJson).toHaveBeenCalledWith(
      "/api/v1/relays/optimize",
      expect.objectContaining({
        sensitive: true,
        init: expect.objectContaining({
          body: JSON.stringify({
            pubkey: managerPubkey,
            source_events: [
              {
                pubkey: sourceEvent.pubkey,
                kind: sourceEvent.kind,
                created_at: sourceEvent.created_at,
                content: sourceEvent.content,
                tags: sourceEvent.tags,
                id: sourceEvent.id,
                sig: sourceEvent.sig,
              },
            ],
          }),
        }),
      })
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.json()).toEqual({ error: { code: "overloaded" } });
  });
});
