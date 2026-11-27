import {
  authPreference,
  optimizeRequestSchema,
  type OptimizeRequest,
  type RelayPreset,
} from "@/lib/api/schemas/relay-manager";
import { normalizeRelayEndpoint } from "./identity";
import { roleLabel } from "./presentation";

export const endpointFields = {
  pinned: "Pinned relays",
  excluded: "Excluded relays",
  preferred: "Preferred relays",
  custom: "Additional candidate relays",
  paid_access: "Paid relays you can access",
} as const;
export const thresholdFields = {
  min_reliability: "Minimum reliability",
  min_capability_confidence: "Minimum capability confidence",
  diversity: "Operator diversity preference",
} as const;
export const toggleFields = {
  retain_existing: "Retain eligible existing relays",
  free_only: "Use free relays or relays I can access",
  require_operator_diversity: "Require multiple known operators",
  require_verified_privacy: "Require verified recipient-only DM access",
} as const;
export const weights = [
  "personalized",
  "reliability",
  "latency",
  "reach",
  "privacy",
  "functionality",
] as const;
export type ConstraintDraft = Partial<
  Record<
    | keyof typeof endpointFields
    | keyof typeof thresholdFields
    | keyof typeof toggleFields
    | "min"
    | "max"
    | "auth_read"
    | "auth_write"
    | (typeof weights)[number],
    string
  >
>;
export type Drafts = { global: ConstraintDraft; byRole: Record<string, ConstraintDraft> };

export function endpoints(value: string | undefined) {
  return (value ?? "").split(/[\s,]+/).filter(Boolean);
}

function parseNumber(value: string | undefined, label: string, max: number, integer = false) {
  if (!value?.trim()) return;
  const result = Number(value);
  if (
    !Number.isFinite(result) ||
    result < 0 ||
    result > max ||
    (integer && !Number.isInteger(result))
  ) {
    throw new Error(`${label} must be ${integer ? "a whole number " : ""}between 0 and ${max}.`);
  }
  return result;
}

function parseDraft(draft: ConstraintDraft, preset: RelayPreset) {
  const constraints: Record<string, unknown> = Object.fromEntries(
    Object.entries(endpointFields).flatMap(([name, label]) => {
      const raw = endpoints(draft[name as keyof typeof endpointFields]);
      if (raw.length > 80) throw new Error(`${label} accepts up to 80 endpoints.`);
      const normalized = raw.map((url) => {
        const result = normalizeRelayEndpoint(url);
        if (!result)
          throw new Error(
            `${label} requires valid ws:// or wss:// URLs without credentials, queries or fragments.`
          );
        return result;
      });
      return raw.length ? [[name, [...new Set(normalized)]]] : [];
    })
  );
  for (const [key, label] of Object.entries(thresholdFields)) {
    const value = parseNumber(draft[key as keyof typeof thresholdFields], label, 1);
    if (key === "diversity" && value !== undefined && value < 0.2) {
      throw new Error("Operator diversity preference must be between 0.2 and 1.");
    }
    if (value !== undefined) constraints[key] = value;
  }
  for (const key of Object.keys(toggleFields) as (keyof typeof toggleFields)[]) {
    if (draft[key]) constraints[key] = draft[key] === "yes";
  }
  for (const key of ["auth_read", "auth_write"] as const) {
    if (draft[key]) constraints[key] = authPreference.parse(draft[key]);
  }
  if (preset === "custom") {
    const custom = Object.fromEntries(
      weights.flatMap((key) => {
        const value = parseNumber(draft[key], `${key} weight`, 1);
        return value === undefined ? [] : [[key, value]];
      })
    );
    if (Object.keys(custom).length) constraints.weights = custom;
  }
  return constraints;
}

export function optimizationRequest(
  pubkey: string,
  roles: string[],
  preset: RelayPreset,
  drafts: Drafts,
  allowCreate: boolean,
  allowRecreate: boolean
): OptimizeRequest {
  if (!roles.length) throw new Error("Select at least one relay role to optimize.");
  const global = parseDraft(drafts.global, preset);
  const by_role = Object.fromEntries(
    roles.flatMap((role) => {
      const draft = drafts.byRole[role];
      if (!draft) return [];
      const min = parseNumber(draft.min, `${roleLabel(role)} minimum`, 32, true);
      const max = parseNumber(draft.max, `${roleLabel(role)} maximum`, 32, true);
      if (max === 0) throw new Error(`${roleLabel(role)} maximum must be at least 1.`);
      if (min !== undefined && max !== undefined && min > max) {
        throw new Error(`${roleLabel(role)} minimum cannot exceed its maximum.`);
      }
      return [[role, { ...parseDraft(draft, preset), min, max }]];
    })
  );
  const parsed = optimizeRequestSchema.safeParse({
    pubkey,
    roles,
    preset,
    constraints: { global, by_role },
    ...(allowCreate ? { allow_create: true } : {}),
    ...(allowRecreate ? { allow_recreate: true } : {}),
  });
  if (!parsed.success) throw new Error("Check the constraints and select supported relay roles.");
  return parsed.data;
}

export function candidateState(
  drafts: Drafts,
  role: string,
  field: "pinned" | "excluded",
  url: string
) {
  const includes = (value: string | undefined) =>
    endpoints(value).some((raw) => normalizeRelayEndpoint(raw) === normalizeRelayEndpoint(url));
  const local = drafts.byRole[role]?.[field];
  return (
    includes(local) || ((field === "excluded" || !local?.trim()) && includes(drafts.global[field]))
  );
}
