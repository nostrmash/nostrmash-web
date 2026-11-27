import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1";

const secret = Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? 1 : 0));
export const managerPubkey = Buffer.from(schnorr.getPublicKey(secret)).toString("hex");
export const readOnlyPubkey = "c".repeat(64);
export const currentRelay = "wss://purplepag.es";
export const nextRelay = "wss://nos.lol";
export const sharedOutbox = "wss://relay.damus.io";
export const initialTimestamp = 1785300000;

export function signFixture(event) {
  const payload = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  const digest = createHash("sha256").update(payload).digest();
  return {
    ...event,
    id: digest.toString("hex"),
    sig: Buffer.from(schnorr.sign(digest, secret)).toString("hex"),
  };
}

export const sourceEvent = signFixture({
  kind: 10002,
  pubkey: managerPubkey,
  content: "preserved content",
  created_at: initialTimestamp,
  tags: [
    ["r", currentRelay, "read"],
    ["r", sharedOutbox, "write"],
    ["custom", "keep"],
  ],
});

const meta = {
  algorithm: "relay-intel-v1",
  score_version: "relay-score-v1",
  optimizer_version: "relay-opt-v3",
  tie_break: "lower_event_id",
  tie_break_note: "Timestamp ties keep the lower event ID.",
  generated_at: "2026-07-30T10:00:00.000Z",
  stats_computed_at: "2026-07-30T10:00:00.000Z",
};
const role = (role, kinds, optimized_by_default, notes) => ({
  role,
  kinds,
  optimized_by_default,
  notes,
  endpoint_type: "nostr_relay",
  default_min: 1,
  default_max: 4,
  positive_adoption: role !== "blocked",
});
export const roles = [
  role("public_inbox", [10002, 3], true, "Public inbox relays are where clients send mentions."),
  role("public_outbox", [10002, 3], true, "Public outbox relays advertise where you publish."),
  role("dm_inbox", [10050], true, "DM inbox relays are used by clients that support gift wraps."),
  role("search", [10007], true, "Search relays handle NIP-50 search."),
  role("keypackage", [10002, 10051], false, "Marmot discovers KeyPackages on the public outbox."),
  role("blocked", [10006], false, "Account blocklist."),
];
const candidate = (role, url, current = false) => ({
  role,
  url,
  current,
  pinned: false,
  score: 0.72,
  confidence: 0.8,
  confidence_label: "medium",
  eligible: true,
  distinct_users: 1200,
  active_users: 22,
  modern_users: 1100,
  legacy_users: 100,
  trust_weighted: 0.45,
  cohort_coverage: 0.3,
  components: { reliability: 0.85 },
  operator_key: `host:${new URL(url).hostname}`,
  reasons: [
    {
      code: "cohort_overlap",
      text: "This relay appears in more public declarations from your neighborhood.",
    },
  ],
});
const check = (role, urls, current, unsatisfied) => ({
  selected: urls.map((url) => ({
    url,
    current: current.includes(url),
    marginal_coverage: 0.3,
    unique_coverage: 0.2,
  })),
  current_coverage: 0.25,
  proposed_coverage: 0.62,
  improvement: 0.37,
  unknown_weight: 0.2,
  known_weight: 0.8,
  operator_count: urls.length,
  distinct_endpoints: urls.length,
  max_operator_share: urls.length ? 1 / urls.length : 0,
  concentration_basis: "host_or_nip11_pubkey",
  redundancy: 0,
  constraints_satisfied: !unsatisfied,
  independently_satisfied: !unsatisfied,
  coverage_definition: "Declared preference overlap.",
  ...(unsatisfied
    ? {
        unsatisfied_constraints: [
          { code: "operator_diversity", text: "The role needs more than one known operator." },
        ],
      }
    : {}),
});
const registry = new Map();
const pending = new Map();

function config(pubkey) {
  const waiting = pending.get(pubkey);
  if (waiting) {
    if (waiting.skip) waiting.skip = false;
    else {
      registry.set(pubkey, waiting.event);
      pending.delete(pubkey);
    }
  }
  const active = registry.get(pubkey) ?? sourceEvent;
  const member = (url, marker) => ({
    url,
    public_safe: true,
    marker,
    source_kind: 10002,
    source_event_id: active.id,
    created_at: active.created_at,
    declaration_source: "nip65",
  });
  return {
    ...meta,
    note: "Indexed configuration",
    account: {
      pubkey,
      modern_public: "present",
      legacy_public: "missing",
      keypackage_discovery: "nip65_outbox",
      relay_sets: [],
      roles: roles.map(({ role }) => {
        const marker = role === "public_inbox" ? "read" : "write";
        const modern = ["public_inbox", "public_outbox", "keypackage"].includes(role);
        const relays = modern
          ? active.tags
              .filter(([name, , mode]) => name === "r" && (!mode || marker === mode))
              .map(([, url]) => member(url, marker))
          : [];
        return {
          role,
          relays,
          availability: modern ? (relays.length ? "present" : "empty") : "missing",
          ...(modern
            ? { event_id: active.id, created_at: active.created_at, source: "nip65" }
            : {}),
        };
      }),
    },
    sources: [
      {
        kind: 10002,
        status: "current",
        requires_refresh: false,
        canonical_event_id: active.id,
        projection_event_id: active.id,
      },
    ],
  };
}

function plan(input, includeRanking) {
  const { pubkey, preset = "balanced" } = input;
  const unsafe = pubkey === readOnlyPubkey;
  const selectedRoles = input.roles ?? ["public_inbox", "public_outbox"];
  const base =
    input.source_events?.find((event) => event.kind === 10002) ??
    registry.get(pubkey) ??
    sourceEvent;
  const oldInbox = base.tags
    .filter(([name, , marker]) => name === "r" && marker === "read")
    .map(([, url]) => url);
  const rules = input.constraints?.by_role?.public_inbox ?? {};
  const forced =
    rules.require_operator_diversity ?? input.constraints?.global?.require_operator_diversity;
  const proposed = rules.pinned?.length
    ? rules.pinned
    : rules.excluded?.includes(nextRelay)
      ? oldInbox
      : [nextRelay];
  const hasChange =
    selectedRoles.includes("public_inbox") && JSON.stringify(oldInbox) !== JSON.stringify(proposed);
  const proposal = {
    note: "Unsigned preview. The client must sign and publish.",
    proposal_safe: !unsafe,
    source_complete: !unsafe,
    requires_refresh: unsafe,
    requires_review: false,
    ready_to_sign: hasChange && !unsafe && !forced,
    ...(unsafe
      ? {
          blocking_reasons: [
            { code: "source_unreadable", text: "The source event is unreadable." },
          ],
        }
      : {}),
    ...(!unsafe && hasChange
      ? {
          public_relays: {
            kind: 10002,
            pubkey,
            content: base.content,
            based_on_event_id: base.id,
            based_on_created_at: base.created_at,
            tags: [
              ...base.tags.filter(([name, , marker]) => name !== "r" || marker !== "read"),
              ...proposed.map((url) => ["r", url, "read"]),
            ],
            proposal_safe: true,
            source_origin: input.source_events ? "client" : "indexed",
            change: "replacement",
            note: "Unsigned patch.",
          },
        }
      : {}),
  };
  return {
    ...meta,
    pubkey,
    preset,
    preset_version: `${preset}-v1`,
    constraints_satisfied: !forced,
    cohort: { size: 37, truncated: false, trust_data: true, used: "personalized" },
    roles: selectedRoles.map((role) => {
      const inbox = role === "public_inbox";
      const urls = inbox ? proposed : [sharedOutbox];
      const existing = inbox ? oldInbox : [sharedOutbox];
      return {
        role,
        availability: "present",
        selection: check(role, urls, existing, forced),
        recommendations: urls.map((url) => ({
          action: existing.includes(url) ? "retain" : "replace",
          role,
          current: existing[0],
          suggested: url,
          reason_codes: ["cohort_overlap"],
          text: existing.includes(url)
            ? "This endpoint remains useful."
            : "Adds complementary overlap for your public inbox.",
          confidence: 0.8,
          confidence_label: "medium",
          attention_required: false,
        })),
        ...(includeRanking
          ? { ranking: urls.map((url) => candidate(role, url, existing.includes(url))) }
          : {}),
      };
    }),
    proposal,
  };
}

export async function managerFixture(url, body) {
  const { pathname, searchParams } = url;
  if (pathname === "/__fixtures/relay-manager/reset") {
    registry.clear();
    pending.clear();
    return { ok: true };
  }
  const profile =
    /^\/api\/v1\/profiles\/([a-f0-9]{64})(?:\/relay-(config|diagnostics|recommendations))?$/.exec(
      pathname
    );
  if (profile) {
    const [, pubkey, operation] = profile;
    if (operation === "config") return config(pubkey);
    if (operation === "diagnostics")
      return {
        ...meta,
        pubkey,
        findings: [
          {
            code: "insufficient_redundancy",
            severity: "warning",
            role: "public_inbox",
            text: "Your public inbox has one relay.",
          },
        ],
      };
    if (operation === "recommendations")
      return plan({ pubkey, preset: searchParams.get("preset") ?? "balanced" }, true);
    if (pubkey === managerPubkey || pubkey === readOnlyPubkey)
      return { pubkey, display_name: pubkey === managerPubkey ? "Avery Relay" : "Public Observer" };
  }
  if (pathname === "/api/v1/relays/roles") return { ...meta, roles };
  if (pathname === "/api/v1/relays/rankings") {
    const role = searchParams.get("role");
    return {
      ...meta,
      role,
      positive_adoption: role !== "blocked",
      coverage_definition: "Public declarations",
      relays: [candidate(role, nextRelay), candidate(role, currentRelay, true)],
      ranking: "role",
      candidate_pool: 2,
      note: "Role-specific adoption and observations.",
    };
  }
  if (pathname === "/api/v1/relays/capabilities")
    return {
      ...meta,
      relay_url: searchParams.get("relay_url"),
      endpoint_type: "nostr_relay",
      capabilities: {
        giftwrap_accept: { status: "verified", source: "probe", confidence: 0.8 },
        read_subscription: { status: "observed", source: "read_probe", confidence: 0.6 },
      },
      privacy: {
        assessment: "privacy_unknown",
        recipient_retrieval_verified: null,
        gift_wrap_accepted: true,
        exposure_confirmed: false,
        exposure_unresolved: true,
        recipient_auth_verified: null,
        publication_auth_verified: null,
        recipient_exact_verified: null,
        recipient_tag_verified: null,
        unauthenticated_exposure: null,
        authenticated_observer_exposure: null,
        comprehensive: false,
        stale: false,
        freshness: "unknown",
      },
      propagation: { EventsSeen7d: 1090, FirstSeen7d: 32, Known: true },
      note: "Stored evidence.",
    };
  if (pathname === "/api/v1/relays/optimize") return plan(await body(), false);
  if (pathname === "/api/v1/relays/verify") {
    const { event, relays } = await body();
    const followUp = registry.has(event.pubkey);
    if (!followUp) pending.set(event.pubkey, { event, skip: true });
    return {
      signature_valid: true,
      event_id: event.id,
      note: "Sample only.",
      sample_verified: true,
      sample_agreement: true,
      exact_retrieved_count: 2,
      latest_agreement_count: 2,
      retrieved_count: 2,
      latest_agreement: true,
      partial: true,
      reason: "ok",
      relays: relays.map((relay_url, index) => ({
        relay_url,
        outcome: index < 2 || followUp ? "retrieved" : "timeout",
        retrieved: index < 2 || followUp,
        latest_verified: index < 2 || followUp,
        latest_agrees: index < 2 || followUp,
      })),
    };
  }
}
