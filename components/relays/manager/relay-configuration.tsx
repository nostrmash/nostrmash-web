import { Disclosure } from "@/components/ui/disclosure";
import { Pill } from "@/components/ui/pill";
import type { RelayConfig, RelayFinding, RelayRole } from "@/lib/api/schemas/relay-manager";
import type { Drafts } from "@/lib/relays/manager/constraints";
import { candidateState } from "@/lib/relays/manager/constraints";
import {
  availabilityLabel,
  dateLabel,
  findingActions,
  roleGroups,
  roleLabel,
  sourceLabel,
} from "@/lib/relays/manager/presentation";
import { RelayAddress, RelayEvidence } from "./relay-evidence";

type Declared = RelayConfig["account"]["roles"][number]["relays"][number];

function CurrentRelays({
  role,
  relays,
  drafts,
}: {
  role: string;
  relays: Declared[];
  drafts: Drafts;
}) {
  return (
    <ul className="divide-edge divide-y">
      {relays.map((relay, index) => (
        <li className="space-y-2 py-3" key={`${relay.url}-${relay.marker ?? ""}-${index}`}>
          <RelayAddress url={relay.url} />
          <div className="flex flex-wrap gap-1.5">
            {relay.marker ? <Pill>{relay.marker}</Pill> : null}
            <Pill>Kind {relay.source_kind}</Pill>
            {!relay.public_safe ? <Pill>Outside global rankings</Pill> : null}
            {candidateState(drafts, role, "pinned", relay.url) ? (
              <Pill>Pinned for next run</Pill>
            ) : null}
            {candidateState(drafts, role, "excluded", relay.url) ? (
              <Pill>Excluded for next run</Pill>
            ) : null}
          </div>
          {relay.public_safe && role !== "blocked" ? (
            <RelayEvidence url={relay.url} role={role} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function Configuration({
  config,
  roles,
  drafts,
}: {
  config: RelayConfig;
  roles: RelayRole[];
  drafts: Drafts;
}) {
  const catalog = new Map(roles.map((role) => [role.role, role]));
  const configs = new Map(config.account.roles.map((role) => [role.role, role]));
  const ids = [
    ...new Set([
      ...catalog.keys(),
      ...configs.keys(),
      ...(config.account.relay_sets.length ? ["relay_set"] : []),
    ]),
  ];
  const ungrouped = ids.filter((id) => !roleGroups.some((group) => group.roles.includes(id)));
  return (
    <div className="space-y-5">
      {[...roleGroups, { label: "Other roles", roles: ungrouped }].map((group) => {
        const groupRoles = group.roles.filter((id) => ids.includes(id));
        if (!groupRoles.length) return null;
        return (
          <div key={group.label} className="space-y-2">
            <h3 className="text-ink-muted px-1 text-xs font-semibold">{group.label}</h3>
            {groupRoles.map((id) => {
              const entry = configs.get(id);
              const details = catalog.get(id);
              const sources = config.sources.filter(
                (source) =>
                  details?.kinds.includes(source.kind) ||
                  entry?.relays.some((relay) => relay.source_kind === source.kind)
              );
              const status = sources.find(
                (source) => source.status === "deleted" && !entry?.event_id
              )
                ? "Deleted configuration"
                : id === "relay_set"
                  ? `${config.account.relay_sets.length} sets`
                  : availabilityLabel[entry?.availability ?? "missing"];
              return (
                <Disclosure
                  key={id}
                  title={roleLabel(id)}
                  description={`${status}${entry?.relays.length ? ` · ${entry.relays.length} endpoints` : ""}`}
                >
                  <div className="space-y-2 text-sm">
                    {details ? <p className="text-ink-muted">{details.notes}</p> : null}
                    {entry?.created_at ? (
                      <p>Source event published {dateLabel(entry.created_at)}</p>
                    ) : null}
                    {entry?.source?.includes("legacy") ||
                    entry?.relays.some(
                      (relay) => relay.source_kind === 3 || relay.source_kind === 10051
                    ) ? (
                      <Pill>Legacy fallback</Pill>
                    ) : null}
                    {entry?.truncated ? <Pill>Incomplete · relay list truncated</Pill> : null}
                    {entry?.invalid_endpoint_count ? (
                      <p>{entry.invalid_endpoint_count} invalid endpoints were omitted.</p>
                    ) : null}
                    {sources
                      .filter((source) => source.status !== "current")
                      .map((source) => (
                        <p key={`${source.kind}/${source.d_tag ?? ""}`} className="text-ink-muted">
                          Kind {source.kind} · {sourceLabel[source.status]}
                          {source.note ? ` · ${source.note}` : ""}
                        </p>
                      ))}
                    {id === "keypackage" ? (
                      <p>
                        Kind 30443 transport evidence is unknown.{" "}
                        {config.account.keypackage_discovery === "nip65_outbox"
                          ? "The public outbox and KeyPackage discovery share kind 10002."
                          : ""}
                      </p>
                    ) : null}
                    {entry?.availability !== "client_side" && entry?.relays.length ? (
                      <CurrentRelays role={id} relays={entry.relays} drafts={drafts} />
                    ) : null}
                    {id === "relay_set"
                      ? config.account.relay_sets.map((set) => (
                          <Disclosure
                            key={set.d_tag}
                            title={set.title || set.d_tag || "Unnamed set"}
                            description={availabilityLabel[set.availability]}
                          >
                            <CurrentRelays role={id} relays={set.relays} drafts={drafts} />
                          </Disclosure>
                        ))
                      : null}
                  </div>
                </Disclosure>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

const severityOrder = { critical: 0, warning: 1, suggestion: 2, info: 3 };

export function Findings({ findings }: { findings: RelayFinding[] }) {
  if (!findings.length)
    return (
      <p className="text-ink-muted text-sm">
        The relay service reported no findings for this snapshot.
      </p>
    );
  const sorted = [...findings].sort(
    (a, b) => severityOrder[a.severity] - severityOrder[b.severity]
  );
  const important = sorted.filter((item) => severityOrder[item.severity] < 2);
  const secondary = sorted.filter((item) => severityOrder[item.severity] >= 2);
  const render = (items: RelayFinding[]) => (
    <ul className="space-y-3">
      {items.map((item, index) => (
        <li
          key={`${item.code}-${index}`}
          className="border-edge bg-surface/45 rounded-xl border p-3 text-sm"
        >
          <div className="mb-2 flex flex-wrap gap-2">
            <Pill className="capitalize" tone={item.severity === "critical" ? "reason" : "neutral"}>
              {item.severity}
            </Pill>
            {item.role ? <Pill>{roleLabel(item.role)}</Pill> : null}
          </div>
          <p>{item.text}</p>
          {findingActions[item.code] ? (
            <p className="text-ink-muted mt-1">{findingActions[item.code]}</p>
          ) : null}
          <details className="text-ink-muted mt-2 text-xs">
            <summary className="text-link cursor-pointer">Finding details</summary>
            <p className="mt-1 break-all">
              {item.code}
              {item.relay_url ? ` · ${item.relay_url}` : ""}
              {item.observed_at ? ` · ${dateLabel(item.observed_at)}` : ""}
            </p>
          </details>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="space-y-3">
      {render(important.slice(0, 3))}
      {important.length > 3 || secondary.length ? (
        <Disclosure
          title="More diagnostic findings"
          description={`${Math.max(important.length - 3, 0) + secondary.length} additional findings`}
        >
          {render([...important.slice(3), ...secondary])}
        </Disclosure>
      ) : null}
    </div>
  );
}
