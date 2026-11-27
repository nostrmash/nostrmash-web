import { afterEach, describe, expect, it, vi } from "vitest";

import {
  currentRelay,
  managerFixture,
  managerPubkey,
  nextRelay,
  readOnlyPubkey,
  signFixture,
  sourceEvent,
} from "../../../e2e/relay-manager-fixture.mjs";
import type { ApiError } from "@/lib/api/errors";
import { relayManagerApi } from "@/lib/api/endpoints/relay-manager";
import {
  capabilitiesSchema,
  configurationSchema,
  optimizationSchema,
  verificationSchema,
  type OptimizeRequest,
  type RelayConfig,
  type RelayPlan,
  type SignedEvent,
} from "@/lib/api/schemas/relay-manager";
import { encodeNprofile, hexToNpub } from "@/lib/nostr/nip19";
import { proposalFingerprint, refreshSources, signingTemplates, signTemplates } from "./apply";
import { optimizationRequest } from "./constraints";
import { accountKey, normalizeRelayEndpoint, relayManagerHref, secureSocketUrl } from "./identity";
import { compareEvents, publishToRelay, validateSignedEvent } from "./protocol";

const request = {
  pubkey: managerPubkey,
  roles: ["public_inbox"],
  preset: "balanced",
} satisfies OptimizeRequest;
const signal = () => new AbortController().signal;
const url = (path: string) => new URL(path, "https://api.example");
const fixture = (path: string, body?: unknown) => managerFixture(url(path), async () => body);
const optimize = (body: unknown) => fixture("/api/v1/relays/optimize", body);
const now = Math.floor(Date.now() / 1000);

async function ready(): Promise<RelayPlan> {
  return optimizationSchema.parse(await optimize(request));
}

async function configuration(): Promise<RelayConfig> {
  const parsed = configurationSchema.parse(
    await fixture(`/api/v1/profiles/${managerPubkey}/relay-config`)
  );
  return { ...parsed, sources: parsed.sources ?? [] };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("public relay identity and constraints", () => {
  it("normalizes supported public representations and keeps relay hints out of account links", () => {
    expect(accountKey(managerPubkey.toUpperCase())).toBe(managerPubkey);
    expect(accountKey(`nostr:${hexToNpub(managerPubkey)}`)).toBe(managerPubkey);
    const pointer = encodeNprofile({ pubkey: managerPubkey, relays: [currentRelay] })!;
    expect(accountKey(pointer)).toBe(managerPubkey);
    expect(relayManagerHref(accountKey(pointer))).toBe(`/relays/manager?viewer=${managerPubkey}`);
    expect(accountKey("nsec1thisisnotpublic")).toBeUndefined();
  });

  it("preserves endpoint paths and rejects malformed, private and insecure socket destinations", () => {
    expect(normalizeRelayEndpoint(" WSS://EXAMPLE.COM/path/ ")).toBe("wss://example.com/path/");
    expect(normalizeRelayEndpoint("wss://relay.example/")).toBe("wss://relay.example");
    expect(normalizeRelayEndpoint("wss://user@relay.example")).toBeUndefined();
    expect(normalizeRelayEndpoint("https://relay.example")).toBeUndefined();
    expect(normalizeRelayEndpoint("wss://relay.example?redirect=elsewhere")).toBeUndefined();
    expect(secureSocketUrl("wss://127.1")).toBeUndefined();
    expect(secureSocketUrl("wss://foo.local")).toBeUndefined();
    expect(secureSocketUrl("ws://relay.example")).toBeUndefined();
  });

  it("validates counts, pins and excluded endpoints while preserving the chosen preset", () => {
    const drafts = {
      global: { excluded: currentRelay, retain_existing: "no" },
      byRole: { public_inbox: { pinned: nextRelay, min: "1", max: "2" } },
    };
    expect(
      optimizationRequest(managerPubkey, request.roles, "privacy", drafts, false, false)
    ).toMatchObject({
      preset: "privacy",
      constraints: {
        global: { excluded: [currentRelay], retain_existing: false },
        by_role: { public_inbox: { pinned: [nextRelay], min: 1, max: 2 } },
      },
    });
    expect(() =>
      optimizationRequest(
        managerPubkey,
        request.roles,
        "balanced",
        {
          global: {},
          byRole: { public_inbox: { min: "4", max: "1" } },
        },
        false,
        false
      )
    ).toThrow("minimum cannot exceed");
    expect(() =>
      optimizationRequest(
        managerPubkey,
        request.roles,
        "balanced",
        {
          global: { excluded: "ftp://invalid" },
          byRole: {},
        },
        false,
        false
      )
    ).toThrow("valid ws:// or wss://");
  });
});

describe("Relay Intelligence contract", () => {
  it("keeps missing and explicitly empty lists, source freshness and Marmot sharing distinct", async () => {
    const config = await configuration();
    expect(config.account.roles.find(({ role }) => role === "dm_inbox")?.availability).toBe(
      "missing"
    );
    const modified = structuredClone(config);
    modified.account.roles[0]!.availability = "empty";
    modified.account.roles[0]!.relays = [];
    modified.sources[0]!.status = "stale";
    modified.sources[0]!.requires_refresh = true;
    const parsed = configurationSchema.parse(modified);
    expect(parsed.account.roles[0]?.availability).toBe("empty");
    expect(parsed.sources?.[0]?.requires_refresh).toBe(true);
    expect(config.account.keypackage_discovery).toBe("nip65_outbox");
  });

  it("keeps privacy nulls and future evidence statuses separate from verified evidence", async () => {
    const data = await fixture(`/api/v1/relays/capabilities?relay_url=${nextRelay}`);
    const parsed = capabilitiesSchema.parse(data);
    const evidence = capabilitiesSchema.parse({
      ...parsed,
      capabilities: {
        ...parsed.capabilities,
        future_transport: { status: "temporarily_unavailable", source: "probe", confidence: 0.1 },
      },
    });
    expect(evidence.capabilities.future_transport?.status).toBe("temporarily_unavailable");
    expect(evidence.privacy.gift_wrap_accepted).toBe(true);
    expect(evidence.privacy.authenticated_observer_exposure).toBeNull();
    expect(evidence.privacy.comprehensive).toBe(false);
  });

  it("allows unsafe and partially safe previews without granting signing authority", async () => {
    const unreadable = optimizationSchema.parse(
      await optimize({ ...request, pubkey: readOnlyPubkey })
    );
    expect(unreadable.proposal.source_complete).toBe(false);
    expect(unreadable.proposal.requires_refresh).toBe(true);
    const plan = await ready();
    plan.proposal.requires_refresh = true;
    expect(plan.proposal.public_relays?.proposal_safe).toBe(true);
    expect(() => signingTemplates(plan, request, [sourceEvent], now)).toThrow("not marked");
  });

  it("distinguishes optimizer overload and client rate limiting", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "overloaded" } },
          { status: 503, headers: { "Retry-After": "0" } }
        )
      )
      .mockResolvedValueOnce(Response.json(await ready()))
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "rate_limited" } },
          { status: 429, headers: { "Retry-After": "8" } }
        )
      );
    vi.stubGlobal("fetch", fetcher);
    await expect(relayManagerApi.optimize(request, signal())).resolves.toMatchObject({
      pubkey: managerPubkey,
    });
    await expect(relayManagerApi.optimize(request, signal())).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      retryAfter: "8",
    } satisfies Partial<ApiError>);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("retains the difference between exact retrieval and latest-version agreement", () => {
    const data = verificationSchema.parse({
      signature_valid: true,
      event_id: sourceEvent.id,
      retrieved_count: 1,
      exact_retrieved_count: 1,
      latest_agreement_count: 0,
      latest_agreement: false,
      partial: true,
      sample_verified: false,
      sample_agreement: false,
      reason: "conflict",
      note: "One relay returned a newer version.",
      relays: [
        {
          relay_url: currentRelay,
          outcome: "conflict",
          retrieved: true,
          latest_verified: true,
          latest_agrees: false,
          latest_id: "a".repeat(64),
        },
      ],
    });
    expect(data.relays?.[0]).toMatchObject({
      retrieved: true,
      latest_agrees: false,
      outcome: "conflict",
    });
  });
});

describe("signing safety", () => {
  it("preserves the complete approved backend patch and validates the result", async () => {
    const templates = signingTemplates(await ready(), request, [sourceEvent], now);
    const signer = { getPublicKey: async () => managerPubkey, signEvent: vi.fn(signFixture) };
    const [signed] = await signTemplates(signer, templates, signal());
    expect(await validateSignedEvent(signed)).toEqual(signed);
    expect(signed?.content).toBe("preserved content");
    expect(signed?.tags).toContainEqual(["custom", "keep"]);
    expect(signed?.tags).toContainEqual(["r", nextRelay, "read"]);
    expect(signer.signEvent).toHaveBeenCalledTimes(1);
  });

  it("invalidates approval when the patch source changes and rejects a recently replaced timestamp", async () => {
    const plan = await ready();
    const newer = signFixture({ ...sourceEvent, created_at: now });
    const refreshed = optimizationSchema.parse(
      await optimize({ ...request, source_events: [newer] })
    );
    expect(proposalFingerprint(refreshed)).not.toBe(proposalFingerprint(plan));
    expect(() => signingTemplates(plan, request, [newer], now)).toThrow("independently refreshed");
    expect(() => signingTemplates(refreshed, request, [newer], now)).toThrow("too recent");
  });

  it.each(["creation", "recreation"] as const)(
    "honors the backend review hold for %s even with preview consent",
    async (change) => {
      const plan = await ready();
      plan.proposal.public_relays!.change = change;
      plan.proposal.requires_review = true;
      expect(() =>
        signingTemplates(
          plan,
          { ...request, allow_create: true, allow_recreate: true },
          [sourceEvent],
          now
        )
      ).toThrow("not marked");
    }
  );

  it("rejects an unsatisfied mandatory constraint and a duplicate shared event", async () => {
    const plan = await ready();
    plan.constraints_satisfied = false;
    expect(() => signingTemplates(plan, request, [sourceEvent], now)).toThrow("not marked");
    plan.constraints_satisfied = true;
    plan.proposal.lists = [plan.proposal.public_relays!];
    expect(() => signingTemplates(plan, request, [sourceEvent], now)).toThrow(
      "single shared replacement"
    );
  });

  it("honors signer rejection, account mismatch and an account switch during signing", async () => {
    const templates = signingTemplates(await ready(), request, [sourceEvent], now);
    const noSignature = vi.fn(async () => {
      throw new Error("rejected");
    });
    await expect(
      signTemplates(
        { getPublicKey: async () => managerPubkey, signEvent: noSignature },
        templates,
        signal()
      )
    ).rejects.toThrow("declined");
    noSignature.mockClear();
    await expect(
      signTemplates(
        { getPublicKey: async () => readOnlyPubkey, signEvent: noSignature },
        templates,
        signal()
      )
    ).rejects.toThrow("no longer controls");
    expect(noSignature).not.toHaveBeenCalled();
    const controller = new AbortController();
    await expect(
      signTemplates(
        {
          getPublicKey: async () => managerPubkey,
          signEvent: async (event) => {
            controller.abort(new Error("account changed"));
            return signFixture(event);
          },
        },
        templates,
        controller.signal
      )
    ).rejects.toThrow("account changed");
  });

  it("rejects signatures with modified content, modified tags, or invalid signature bytes", async () => {
    const templates = signingTemplates(await ready(), request, [sourceEvent], now);
    for (const signEvent of [
      async (event: SignedEvent) => signFixture({ ...event, content: "changed" }),
      async (event: SignedEvent) => signFixture({ ...event, tags: [] }),
      async (event: SignedEvent) => ({ ...signFixture(event), sig: "f".repeat(128) }),
    ]) {
      await expect(
        signTemplates(
          {
            getPublicKey: async () => managerPubkey,
            signEvent: (event) => signEvent(event as SignedEvent),
          },
          templates,
          signal()
        )
      ).rejects.toThrow("invalid, expired, or");
    }
  });
});

class ControlledSocket {
  static handler: (socket: ControlledSocket, frame: unknown[]) => void;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    queueMicrotask(() => this.onopen?.());
  }
  send(frame: string) {
    ControlledSocket.handler(this, JSON.parse(frame));
  }
  receive(frame: unknown[]) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  close() {}
}

describe("bounded relay I/O", () => {
  it("chooses a lower event id at equal timestamps", () => {
    const a = { ...sourceEvent, id: "a".repeat(64) };
    const b = { ...sourceEvent, id: "b".repeat(64) };
    expect([b, a].sort(compareEvents)).toEqual([a, b]);
  });

  it("requires completed source and deletion samples and fails closed on a signed deletion", async () => {
    vi.stubGlobal("WebSocket", ControlledSocket);
    const cfg = await configuration();
    ControlledSocket.handler = (socket, [, subscription]) => {
      socket.receive(["EVENT", subscription, sourceEvent]);
      socket.receive(["CLOSED", subscription, "auth-required: fixture"]);
    };
    await expect(refreshSources(cfg, request, signal())).rejects.toThrow(
      "Fewer than two relay hosts"
    );
    const deletion = signFixture({
      ...sourceEvent,
      kind: 5,
      created_at: sourceEvent.created_at + 1,
      tags: [["e", sourceEvent.id]],
    });
    ControlledSocket.handler = (socket, [, subscription]) => {
      socket.receive(["EVENT", subscription, sourceEvent]);
      socket.receive(["EVENT", subscription, deletion]);
      socket.receive(["EOSE", subscription]);
    };
    await expect(refreshSources(cfg, request, signal())).rejects.toThrow("returned a deletion");
  });

  it("requires an exact OK and distinguishes rejection, authentication, timeout and partial results", async () => {
    vi.stubGlobal("WebSocket", ControlledSocket);
    vi.useFakeTimers();
    ControlledSocket.handler = (socket) => {
      switch (new URL(socket.url).hostname) {
        case "accept.example":
          socket.receive(["OK", sourceEvent.id, true, ""]);
          break;
        case "reject.example":
          socket.receive(["OK", sourceEvent.id, false, "invalid: fixture"]);
          break;
        case "auth.example":
          socket.receive(["AUTH", "test"]);
          break;
        case "ignore.example":
          socket.receive(["OK", "wrong-id", true, ""]);
          break;
      }
    };
    const outcomes = Promise.all(
      ["accept", "reject", "auth", "ignore"].map((host) =>
        publishToRelay(sourceEvent, `wss://${host}.example`, signal())
      )
    );
    await vi.advanceTimersByTimeAsync(5_001);
    expect((await outcomes).map((outcome) => outcome.outcome)).toEqual([
      "accepted",
      "rejected",
      "authentication_required",
      "timeout",
    ]);
  });
});
