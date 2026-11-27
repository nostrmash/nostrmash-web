import type { RelayPreset } from "@/lib/api/schemas/relay-manager";

export const roleGroups = [
  { label: "Public communication", roles: ["public_inbox", "public_outbox"] },
  { label: "Private messaging", roles: ["dm_inbox"] },
  { label: "Discovery", roles: ["search"] },
  { label: "Marmot", roles: ["keypackage"] },
  { label: "Personal preferences", roles: ["favorite", "blocked"] },
  { label: "Advanced", roles: ["relay_set", "private_storage", "wiki"] },
  { label: "Media storage", roles: ["blossom"] },
];

const labels: Record<string, string> = {
  public_inbox: "Public inbox",
  public_outbox: "Public outbox",
  dm_inbox: "DM inbox",
  search: "Search relays",
  keypackage: "KeyPackage transport",
  favorite: "Favorites",
  blocked: "Blocked relays",
  relay_set: "Relay sets",
  private_storage: "Private storage",
  wiki: "Wiki relays",
  blossom: "Blossom servers",
};

export const words = (value: string) => value.replaceAll("_", " ");
export const roleLabel = (role: string) => labels[role] ?? words(role);
export const relayHost = (url: string) => (URL.canParse(url) ? new URL(url).host : url);
export const share = (value: number) =>
  new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 1 }).format(value);
export const dateLabel = (value: string | number) =>
  new Date(typeof value === "number" ? value * 1000 : value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

export const availabilityLabel: Record<string, string> = {
  missing: "Missing",
  empty: "Explicitly empty",
  present: "Configured",
  client_side: "Encrypted · client only",
};

export const sourceLabel: Record<string, string> = {
  current: "Current in index",
  stale: "Stale projection",
  missing: "Missing projection",
  deleted: "Deleted configuration",
  too_large: "Incomplete · source exceeds limits",
  unreadable: "Unreadable source",
  stale_client: "Older source supplied",
  inconsistent: "Projection differs",
};

export const presets: Record<RelayPreset, { label: string; description: string }> = {
  balanced: {
    label: "Balanced",
    description: "Balances neighborhood overlap, reliability and relay count.",
  },
  creator: {
    label: "Creator",
    description: "Favors public reach and coverage for accounts that publish frequently.",
  },
  privacy: {
    label: "Privacy",
    description:
      "Favors smaller lists and stronger privacy evidence. DM privacy depends on verified relay behavior.",
  },
  minimal: {
    label: "Minimal",
    description: "Aims for the minimum relay count for each selected role.",
  },
  decentralization: {
    label: "Decentralization",
    description: "Puts more weight on using different relay operators.",
  },
  custom: { label: "Custom", description: "Use your own scoring weights and constraints." },
};

export const findingActions: Record<string, string> = {
  missing_modern_config:
    "Preview a public inbox and outbox. Review creation separately if this is your account.",
  explicit_empty_config: "Leave this empty if intentional, or preview candidates for this role.",
  obsolete_legacy_config:
    "Review the public roles in your Nostr client and consider publishing a modern relay list.",
  blocked_relay_in_active_config:
    "Exclude this endpoint from the active role or review your blocklist in your client.",
  dm_privacy_unverified: "Inspect recipient and observer evidence before choosing a DM relay.",
  dm_privacy_unsuitable: "Compare other DM relays with evidence of authenticated recipient access.",
  unreachable: "Check the relay again before changing your list.",
  repeated_connection_failures: "Check the relay’s current status and compare a replacement.",
  infrastructure_concentration:
    "Compare a proposal using the operator diversity preference or requirement.",
  insufficient_redundancy: "Preview an extra relay for this role so it can tolerate outages.",
  excessive_relay_count: "Set a smaller maximum for this role and review the resulting overlap.",
  duplicate_url: "Review role membership and use one entry per endpoint.",
  keypackage_migration_required:
    "Publish a fresh KeyPackage from your Marmot client after changing its transport.",
  legacy_keypackage_list: "Check which discovery method your Marmot client uses.",
  dm_history_not_migrated: "Keep access to the previous DM relays if you need historical messages.",
  stale_health: "Open relay evidence and check the date of the last observation.",
  private_config_client_side: "Open your Nostr client to review this encrypted list.",
  private_endpoint: "Check its reachability from the clients where you use it.",
  sparse_declarations:
    "Compare role rankings where the neighborhood has sparse public declarations.",
  projection_stale: "Refresh the authoritative source before applying a proposal.",
  projection_missing: "Refresh the authoritative source before applying a proposal.",
  projection_inconsistent: "Refresh the authoritative source before applying a proposal.",
  source_deleted: "Review a recreation explicitly if you intend to restore this list.",
  source_unreadable: "Check the signed configuration in your Nostr client.",
  source_too_large: "Review the full list in your Nostr client before making changes.",
};

export function roleRelaysFromTags(role: string, kind: number, tags: string[][]) {
  return [
    ...new Set(
      tags.flatMap(([name, url, marker]) => {
        if (!url) return [];
        if (kind === 10002) {
          const expected = role === "public_inbox" ? "read" : "write";
          return name === "r" && (!marker || marker === expected) ? [url] : [];
        }
        return name === "relay" ? [url] : [];
      })
    ),
  ];
}
