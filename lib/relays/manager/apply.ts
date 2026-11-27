import type {
  OptimizeRequest,
  ProposedRelayEvent,
  RelayConfig,
  RelayPlan,
  SignedEvent,
  UnsignedEvent,
} from "@/lib/api/schemas/relay-manager";
import type { NostrSigner } from "@/lib/nostr/browser-signer";
import { secureSocketUrl } from "./identity";
import { compareEvents, eventPayload, readRelaySources, validateSignedEvent } from "./protocol";

const discovery = ["wss://purplepag.es", "wss://relay.damus.io", "wss://nos.lol"];
const writableKinds: Record<string, number> = {
  public_inbox: 10002,
  public_outbox: 10002,
  dm_inbox: 10050,
  search: 10007,
  keypackage: 10051,
  favorite: 10012,
  wiki: 10102,
};

export function roleCanOptimize(role: string) {
  return Object.hasOwn(writableKinds, role);
}

function kindsFor(roles: string[]) {
  return new Set(
    roles.flatMap((role) => {
      if (role === "keypackage") return [10002, 10051];
      return roleCanOptimize(role) ? [writableKinds[role]!] : [];
    })
  );
}

function uniqueTargets(endpoints: string[], limit: number) {
  const targets = new Map<string, string>();
  for (const endpoint of endpoints) {
    const url = secureSocketUrl(endpoint);
    if (!url) continue;
    const host = new URL(url).hostname.replace(/\.$/, "");
    if (!targets.has(host)) targets.set(host, url);
    if (targets.size >= limit) break;
  }
  return [...targets.values()];
}

export function relayTargets(config: RelayConfig, plan?: RelayPlan) {
  const declared = (role: string) =>
    config.account.roles.find((item) => item.role === role)?.relays ?? [];
  const blocked = new Set(
    declared("blocked").flatMap(({ url }) => (URL.canParse(url) ? [new URL(url).href] : []))
  );
  const allowed = (url: string) => URL.canParse(url) && !blocked.has(new URL(url).href);
  const current = declared("public_outbox")
    .filter((relay) => relay.public_safe && allowed(relay.url))
    .map((relay) => relay.url);
  const outbox = plan?.roles.find((item) => item.role === "public_outbox");
  const removed = new Set(
    outbox
      ? current.filter((url) => !outbox.selection.selected?.some((relay) => relay.url === url))
      : []
  );
  return {
    sources: uniqueTargets([...discovery.filter(allowed), ...current], 5),
    publish: uniqueTargets(
      [
        ...uniqueTargets(
          current.filter((url) => !removed.has(url)),
          2
        ),
        ...discovery.filter(allowed),
      ],
      5
    ),
  };
}

function isDeleted(event: SignedEvent, deletion: SignedEvent) {
  return deletion.tags.some(([type, value]) =>
    type === "e"
      ? value === event.id
      : type === "a" &&
        value === `${event.kind}:${event.pubkey}:` &&
        deletion.created_at >= event.created_at
  );
}

export async function refreshSources(
  config: RelayConfig,
  request: OptimizeRequest,
  signal: AbortSignal
) {
  const pubkey = config.account.pubkey;
  if (config.sources.some((source) => source.kind === 10006 && source.requires_refresh)) {
    throw new Error(
      "The account blocklist is incomplete in the index. Refresh the account before applying changes."
    );
  }
  const kinds = [...new Set([10002, 10006, ...kindsFor(request.roles ?? [])])];
  const targets = relayTargets(config).sources;
  const samples = await Promise.all(
    targets.map((url) => readRelaySources(url, pubkey, kinds, signal))
  );
  if (samples.filter((sample) => sample.complete).length < 2) {
    throw new Error(
      "Fewer than two relay hosts completed the source and deletion queries. Refresh the indexed configuration and try again."
    );
  }
  // A signed event or deletion from a partial response is still evidence.
  const events = samples.flatMap((sample) => sample.events);
  const deletions = events.filter((event) => event.kind === 5);
  const sources: SignedEvent[] = [];
  for (const kind of kinds) {
    const latest = events.filter((event) => event.kind === kind).sort(compareEvents)[0];
    const indexed = config.sources.find((entry) => entry.kind === kind && !entry.d_tag);
    const indexedId = indexed?.canonical_event_id ?? indexed?.projection_event_id;
    const indexedRole = config.account.roles.find(
      (role) => role.event_id && role.relays.some((relay) => relay.source_kind === kind)
    );
    const expected = indexedId ?? indexedRole?.event_id;
    if (latest && deletions.some((deletion) => isDeleted(latest, deletion))) {
      throw new Error(
        `A relay returned a deletion for the latest kind ${kind} source. Refresh the account before reviewing another proposal.`
      );
    }
    if ((expected && !latest) || (kind === 10006 && expected !== latest?.id)) {
      throw new Error(
        `The sampled relays and index could not establish the current kind ${kind} source. Refresh the account and try again.`
      );
    }
    if (latest) sources.push(latest);
  }
  return sources;
}

export function proposalEvents(plan: RelayPlan): ProposedRelayEvent[] {
  const { public_relays, lists } = plan.proposal;
  return [...(public_relays ? [public_relays] : []), ...(lists ?? [])];
}

export function proposalFingerprint(plan: RelayPlan) {
  // Graph scores and timestamps can change between requests. Bind approval to
  // the exact event patch, material role changes and actionable warnings.
  return JSON.stringify({
    pubkey: plan.pubkey,
    events: proposalEvents(plan).map((e) => [
      e.pubkey,
      e.kind,
      e.based_on_event_id,
      e.based_on_created_at,
      e.change,
      e.tags,
      e.content,
      e.proposal_safe,
    ]),
    flags: [
      plan.constraints_satisfied,
      plan.proposal.proposal_safe,
      plan.proposal.source_complete,
      plan.proposal.requires_refresh,
      plan.proposal.requires_review,
      plan.proposal.ready_to_sign,
    ],
    warnings: [
      plan.proposal.warnings,
      plan.proposal.blocking_reasons,
      plan.unsatisfied_constraints,
    ],
    shared: plan.shared_configuration,
    roles: plan.roles.map((role) => [
      role.role,
      role.selection.selected?.map((relay) => relay.url),
      role.recommendations
        ?.filter((r) => r.attention_required)
        .map((r) => [r.action, r.current, r.suggested, r.reason_codes]),
    ]),
  });
}

export function signingTemplates(
  plan: RelayPlan,
  request: OptimizeRequest,
  sources: SignedEvent[],
  now = Math.floor(Date.now() / 1000)
): UnsignedEvent[] {
  const proposal = plan.proposal;
  const events = proposalEvents(plan);
  if (
    plan.pubkey !== request.pubkey ||
    !proposal.ready_to_sign ||
    !plan.constraints_satisfied ||
    !proposal.proposal_safe ||
    !proposal.source_complete ||
    proposal.requires_review ||
    proposal.requires_refresh ||
    proposal.blocking_reasons?.length ||
    plan.unsatisfied_constraints?.length ||
    plan.roles.some(
      (role) =>
        !role.selection.constraints_satisfied ||
        !role.selection.independently_satisfied ||
        role.selection.unsatisfied_constraints?.length
    ) ||
    !events.length
  ) {
    throw new Error(
      "The optimizer has not marked this replacement ready to sign. Review the source and constraint findings."
    );
  }
  const kinds = kindsFor(request.roles ?? []);
  const seen = new Set<number>();
  const publicReplacement = proposal.public_relays;
  const lists = proposal.lists ?? [];
  if (
    (publicReplacement && publicReplacement.kind !== 10002) ||
    lists.some((e) => e.kind === 10002)
  ) {
    throw new Error(
      "The public inbox, outbox and KeyPackage discovery require a single shared replacement."
    );
  }
  return events.map((event) => {
    const source = sources.find(
      (item) => item.kind === event.kind && item.pubkey === request.pubkey
    );
    if (
      !kinds.has(event.kind) ||
      seen.has(event.kind) ||
      !source ||
      event.pubkey !== request.pubkey ||
      !event.proposal_safe ||
      event.change !== "replacement" ||
      event.based_on_event_id !== source.id ||
      event.based_on_created_at !== source.created_at ||
      event.content !== source.content ||
      (event.kind === 10051 && sources.some((item) => item.kind === 10002))
    ) {
      throw new Error(
        "The proposal does not match the independently refreshed source. Review a new optimization before signing."
      );
    }
    if (source.created_at >= now) {
      throw new Error(
        "The source timestamp is too recent to replace. Wait a moment and refresh again."
      );
    }
    seen.add(event.kind);
    return {
      pubkey: event.pubkey,
      kind: event.kind,
      content: event.content,
      tags: event.tags ?? [],
      created_at: now,
    };
  });
}

export async function assertSignerAccount(
  signer: NostrSigner,
  pubkey: string,
  signal: AbortSignal
) {
  signal.throwIfAborted();
  const current = await signer.getPublicKey().catch(() => undefined);
  signal.throwIfAborted();
  if (typeof current !== "string" || current.toLowerCase() !== pubkey) {
    throw new Error(
      "The browser signer no longer controls this account. Reconnect it before applying changes."
    );
  }
}

export async function signTemplates(
  signer: NostrSigner,
  templates: UnsignedEvent[],
  signal: AbortSignal
) {
  const signed: SignedEvent[] = [];
  for (const template of templates) {
    if (Math.floor(Date.now() / 1000) - template.created_at > 60) {
      throw new Error(
        "This review expired before signing finished. Refresh the sources and review again."
      );
    }
    await assertSignerAccount(signer, template.pubkey, signal);
    const approved = eventPayload(template);
    let value: unknown;
    try {
      value = await signer.signEvent(structuredClone(template));
    } catch {
      signal.throwIfAborted();
      throw new Error("The browser signer declined the signature request.");
    }
    await assertSignerAccount(signer, template.pubkey, signal);
    const event = await validateSignedEvent(value);
    signal.throwIfAborted();
    const now = Math.floor(Date.now() / 1000);
    if (
      !event ||
      eventPayload(event) !== approved ||
      event.created_at > now ||
      now - event.created_at > 60
    ) {
      throw new Error(
        "The signature was invalid, expired, or the signed event differed from the reviewed event."
      );
    }
    signed.push(event);
  }
  return signed;
}
