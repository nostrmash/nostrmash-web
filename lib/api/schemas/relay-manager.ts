import { z } from "zod";

import type { ApiJsonResponse, paths } from "@/lib/types/generated";

export const pubkeySchema = z.string().regex(/^[0-9a-f]{64}$/);
const positiveTimestamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const time = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();
const fraction = z.number().min(0).max(1);
const strings = z.array(z.string());
const availability = z.enum(["missing", "empty", "present", "client_side"]);
const confidenceLabel = z.enum(["high", "medium", "low", "insufficient"]);
const reason = z.object({ code: z.string(), text: z.string() });

const roleIds = [
  "public_inbox",
  "public_outbox",
  "dm_inbox",
  "search",
  "blocked",
  "favorite",
  "relay_set",
  "keypackage",
  "blossom",
  "wiki",
  "private_storage",
] as const;
const roleId = z.enum(roleIds);
export const rankedRole = roleId.exclude(["private_storage", "relay_set"]);
export const presetSchema = z.enum([
  "balanced",
  "creator",
  "privacy",
  "minimal",
  "decentralization",
  "custom",
]);
export const authPreference = z.enum(["allow", "prefer_without", "require", "reject"]);

type OptimizePath = paths["/api/v1/relays/optimize"]["post"];
type VerifyPath = paths["/api/v1/relays/verify"]["post"];
export type OptimizeRequest = OptimizePath["requestBody"]["content"]["application/json"];
// OpenAPI leaves the signed event object opaque. Validate its NIP-01 shape locally.
export type VerifyRequest = Omit<
  VerifyPath["requestBody"]["content"]["application/json"],
  "event"
> & { event: SignedEvent };

export const unsignedEventSchema = z.object({
  pubkey: pubkeySchema,
  kind: count.max(65535),
  created_at: positiveTimestamp,
  content: z.string(),
  tags: z.array(strings),
});
export const signedEventSchema = unsignedEventSchema.extend({
  id: pubkeySchema,
  sig: z.string().regex(/^[0-9a-f]{128}$/),
});
export type UnsignedEvent = z.infer<typeof unsignedEventSchema>;
export type SignedEvent = z.infer<typeof signedEventSchema>;

const endpointInput = z.string().max(2048);
const constraintFields = {
  pinned: z.array(endpointInput).max(80).optional(),
  excluded: z.array(endpointInput).max(80).optional(),
  preferred: z.array(endpointInput).max(80).optional(),
  custom: z.array(endpointInput).max(80).optional(),
  paid_access: z.array(endpointInput).max(80).optional(),
  free_only: z.boolean().optional(),
  auth_read: authPreference.optional(),
  auth_write: authPreference.optional(),
  min_reliability: fraction.optional(),
  min_capability_confidence: fraction.optional(),
  diversity: fraction.min(0.2).optional(),
  require_operator_diversity: z.boolean().optional(),
  require_verified_privacy: z.boolean().optional(),
  retain_existing: z.boolean().optional(),
  weights: z
    .record(
      z.enum(["personalized", "reliability", "latency", "reach", "privacy", "functionality"]),
      fraction
    )
    .optional(),
};
const relayCount = count.max(32);
const perRoleConstraint = z.strictObject({
  ...constraintFields,
  min: relayCount.optional(),
  max: relayCount.min(1).optional(),
});
const globalConstraint = z.strictObject({
  ...constraintFields,
  min: z.partialRecord(roleId, relayCount).optional(),
  max: z.partialRecord(roleId, relayCount.min(1)).optional(),
});
export const optimizeRequestSchema = z.strictObject({
  pubkey: pubkeySchema,
  preset: presetSchema.optional(),
  roles: z.array(roleId).max(roleIds.length).optional(),
  constraints: globalConstraint
    .extend({
      global: globalConstraint.optional(),
      by_role: z.partialRecord(roleId, perRoleConstraint).optional(),
    })
    .optional(),
  supplied_relays: z
    .array(z.strictObject({ url: endpointInput, role: roleId }))
    .max(80)
    .optional(),
  source_events: z.array(signedEventSchema).max(8).optional(),
  allow_create: z.boolean().optional(),
  allow_recreate: z.boolean().optional(),
}) satisfies z.ZodType<OptimizeRequest>;
export const verifyRequestSchema = z.strictObject({
  event: signedEventSchema,
  relays: z.array(endpointInput).min(1).max(8),
}) satisfies z.ZodType<VerifyRequest>;

// Read response shapes with no OpenAPI response schema are validated against
// the backend's relayintel response structs. Unknown evidence is extensible.
const meta = z.object({
  algorithm: z.literal("relay-intel-v1"),
  tie_break: z.literal("lower_event_id"),
});
const statsMeta = meta.extend({
  score_version: z.literal("relay-score-v1"),
  optimizer_version: z.literal("relay-opt-v3"),
  tie_break_note: z.string(),
  generated_at: time,
  stats_computed_at: time.nullish(),
  fallbacks: strings.nullish(),
});

export const rolesSchema = meta.extend({
  roles: z.array(
    z.object({
      role: z.string(),
      kinds: z.array(count),
      endpoint_type: z.enum(["nostr_relay", "blossom_http"]),
      default_min: count,
      default_max: count,
      positive_adoption: z.boolean(),
      client_side: z.boolean().optional(),
      optimized_by_default: z.boolean(),
      notes: z.string(),
    })
  ),
});

const source = z.object({
  kind: count,
  d_tag: z.string().optional(),
  projection_event_id: pubkeySchema.optional(),
  canonical_event_id: pubkeySchema.optional(),
  status: z.enum([
    "current",
    "stale",
    "missing",
    "deleted",
    "too_large",
    "unreadable",
    "stale_client",
    "inconsistent",
  ]),
  requires_refresh: z.boolean(),
  note: z.string().optional(),
});
const declared = z.object({
  url: z.string(),
  marker: z.string().optional(),
  public_safe: z.boolean(),
  source_kind: count,
  source_event_id: pubkeySchema,
  created_at: positiveTimestamp,
  declaration_source: z.string(),
});
const roleConfig = z.object({
  role: z.string(),
  availability,
  source: z.string().optional(),
  event_id: pubkeySchema.optional(),
  created_at: positiveTimestamp.optional(),
  truncated: z.boolean().optional(),
  invalid_endpoint_count: count.optional(),
  relays: z.array(declared),
});
export const configurationSchema = statsMeta.extend({
  account: z.object({
    pubkey: pubkeySchema,
    roles: z.array(roleConfig),
    relay_sets: z.array(
      roleConfig.omit({ role: true }).extend({ d_tag: z.string(), title: z.string().optional() })
    ),
    modern_public: availability,
    legacy_public: availability,
    keypackage_discovery: z.string().optional(),
  }),
  sources: z.array(source).nullish(),
  note: z.string(),
});
export const diagnosticsSchema = statsMeta.extend({
  pubkey: pubkeySchema,
  sources: z.array(source).nullish(),
  findings: z
    .array(
      reason.extend({
        severity: z.enum(["critical", "warning", "suggestion", "info"]),
        role: z.string().optional(),
        relay_url: z.string().optional(),
        observed_at: time.optional(),
      })
    )
    .nullable(),
});

const capability = z.object({
  status: z.string(),
  confidence: fraction,
  source: z.string(),
  observed_at: time.optional(),
  freshness: z.string().optional(),
  sample_count: count.optional(),
  recent_inconclusive: count.optional(),
  detail: z.string().optional(),
});
const capabilities = z.record(z.string(), capability);
const scoredRelay = z.object({
  url: z.string(),
  domain: z.string().optional(),
  role: z.string(),
  eligible: z.boolean(),
  ineligible_reason: z.string().optional(),
  operator_key: z.string().optional(),
  score: fraction.nullish(),
  confidence: fraction,
  confidence_label: confidenceLabel,
  distinct_users: count,
  active_users: count,
  modern_users: count,
  legacy_users: count,
  trust_weighted: z.number().nonnegative(),
  cohort_coverage: fraction,
  reasons: z.array(reason).nullable(),
  capabilities: capabilities.optional(),
  components: z.record(z.string(), fraction),
  current: z.boolean(),
  pinned: z.boolean(),
  paid_access: z.boolean().optional(),
});

export const rankingsSchema = statsMeta.extend({
  role: z.string(),
  positive_adoption: z.boolean(),
  coverage_definition: z.string(),
  relays: z.array(scoredRelay),
  ranking: z.string(),
  candidate_pool: count,
  note: z.string(),
});

const privacyFlag = z.boolean().nullable();
const privacy = z.object({
  assessment: z.string(),
  recipient_retrieval_verified: privacyFlag,
  gift_wrap_accepted: privacyFlag,
  exposure_confirmed: z.boolean(),
  exposure_unresolved: z.boolean(),
  recipient_auth_verified: privacyFlag,
  publication_auth_verified: privacyFlag,
  recipient_exact_verified: privacyFlag,
  recipient_tag_verified: privacyFlag,
  unauthenticated_exposure: privacyFlag,
  authenticated_observer_exposure: privacyFlag,
  comprehensive: z.boolean(),
  stale: z.boolean(),
  confidence: fraction.optional(),
  freshness: z.string().optional(),
  evidence_version: count.optional(),
  private_observed_at: time.optional(),
  exposure_observed_at: time.optional(),
  access_paths: z
    .array(
      z.object({
        name: z.string(),
        status: z.string(),
        retrieved: z.boolean().optional(),
        authenticated: z.boolean().optional(),
        unauthenticated: z.boolean().optional(),
        observed_at: time.optional(),
        confidence: fraction.optional(),
        freshness: z.string().optional(),
      })
    )
    .optional(),
});
export const capabilitiesSchema = statsMeta.extend({
  relay_url: z.string(),
  endpoint_type: z.string(),
  capabilities,
  privacy,
  propagation: z.object({ EventsSeen7d: count, FirstSeen7d: count, Known: z.boolean() }),
  note: z.string(),
});

const recommendation = z.object({
  action: z.enum(["add", "remove", "replace", "retain", "investigate"]),
  role: z.string(),
  current: z.string().optional(),
  suggested: z.string().optional(),
  reason_codes: strings.nullable(),
  text: z.string(),
  estimated_benefit: z.number().optional(),
  confidence: fraction,
  confidence_label: confidenceLabel,
  attention_required: z.boolean(),
  limitations: strings.nullish(),
});
const proposalEvent = z.object({
  kind: count,
  pubkey: pubkeySchema,
  content: z.string(),
  tags: z.array(strings).nullable(),
  based_on_event_id: pubkeySchema.optional(),
  based_on_created_at: positiveTimestamp.optional(),
  proposal_safe: z.boolean(),
  source_origin: z.string().optional(),
  change: z.enum(["replacement", "creation", "recreation"]).optional(),
  note: z.string(),
});
const selection = z.object({
  selected: z
    .array(
      z.object({
        url: z.string(),
        marginal_coverage: fraction,
        unique_coverage: fraction,
        operator_key: z.string().optional(),
        pinned: z.boolean().optional(),
        current: z.boolean().optional(),
      })
    )
    .nullable(),
  current_coverage: fraction,
  proposed_coverage: fraction,
  improvement: z.number(),
  unknown_weight: z.number().nonnegative(),
  known_weight: z.number().nonnegative(),
  distinct_endpoints: count,
  operator_count: count,
  max_operator_share: fraction,
  concentration_basis: z.string(),
  redundancy: z.number().nonnegative(),
  constraints_satisfied: z.boolean(),
  independently_satisfied: z.boolean(),
  qualifications: z.array(reason).nullish(),
  unsatisfied_constraints: z.array(reason).nullish(),
  coverage_definition: z.string(),
});
export const optimizationSchema = statsMeta.extend({
  pubkey: pubkeySchema,
  preset: presetSchema,
  preset_version: z.string(),
  cohort: z.object({
    size: count,
    truncated: z.boolean(),
    trust_data: z.boolean(),
    used: z.enum(["personalized", "global_fallback"]),
  }),
  sources: z.array(source).nullish(),
  roles: z.array(
    z.object({
      role: roleId,
      availability,
      fallback: z.string().optional(),
      selection,
      recommendations: z.array(recommendation).nullable(),
      ranking: z.array(scoredRelay).nullish(),
      candidate_limit: count.optional(),
      candidates_truncated: z.boolean().optional(),
    })
  ),
  proposal: z.object({
    note: z.string(),
    proposal_safe: z.boolean(),
    source_complete: z.boolean(),
    requires_refresh: z.boolean(),
    requires_review: z.boolean(),
    ready_to_sign: z.boolean(),
    public_relays: proposalEvent.optional(),
    lists: z.array(proposalEvent).nullish(),
    source_origin: z.string().optional(),
    source_event_id: pubkeySchema.optional(),
    source_created_at: positiveTimestamp.optional(),
    warnings: z.array(reason).nullish(),
    blocking_reasons: z.array(reason).nullish(),
  }),
  constraints_satisfied: z.boolean(),
  unsatisfied_constraints: z.array(reason).nullish(),
  shared_configuration: z
    .array(z.object({ roles: strings, kind: count, note: z.string() }))
    .nullish(),
}) satisfies z.ZodType<ApiJsonResponse<"/api/v1/relays/optimize", "post">>;

export const verificationSchema = z.object({
  signature_valid: z.boolean(),
  event_id: pubkeySchema.optional(),
  retrieved_count: count,
  exact_retrieved_count: count,
  latest_agreement_count: count,
  latest_agreement: z.boolean(),
  partial: z.boolean(),
  sample_verified: z.boolean(),
  sample_agreement: z.boolean(),
  reason: z.string().optional(),
  note: z.string(),
  relays: z
    .array(
      z.object({
        relay_url: z.string(),
        outcome: z.enum([
          "retrieved",
          "not_found",
          "conflict",
          "timeout",
          "unavailable",
          "rejected",
          "not_queried",
        ]),
        retrieved_id: pubkeySchema.optional(),
        latest_id: pubkeySchema.optional(),
        latest_created_at: positiveTimestamp.optional(),
        retrieved: z.boolean(),
        latest_verified: z.boolean(),
        latest_agrees: z.boolean(),
        error: z.string().optional(),
      })
    )
    .nullable(),
});

export type RelayRole = z.infer<typeof rolesSchema>["roles"][number];
export type RelayConfig = Omit<z.infer<typeof configurationSchema>, "sources"> & {
  sources: NonNullable<z.infer<typeof configurationSchema>["sources"]>;
};
export type RelayFinding = NonNullable<z.infer<typeof diagnosticsSchema>["findings"]>[number];
export type RelayCapabilities = z.infer<typeof capabilitiesSchema>;
export type ScoredRelay = z.infer<typeof scoredRelay>;
export type RelayPlan = z.infer<typeof optimizationSchema>;
export type RelayPreset = z.infer<typeof presetSchema>;
export type RelayVerification = z.infer<typeof verificationSchema>;
export type ProposedRelayEvent = z.infer<typeof proposalEvent>;
