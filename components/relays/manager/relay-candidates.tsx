"use client";

import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { Pill } from "@/components/ui/pill";
import { relayManagerApi } from "@/lib/api/endpoints/relay-manager";
import { rankedRole, type RelayPlan, type RelayRole } from "@/lib/api/schemas/relay-manager";
import { roleCanOptimize } from "@/lib/relays/manager/apply";
import { relayHost, roleLabel, share, words } from "@/lib/relays/manager/presentation";
import { selectClass } from "./constraints-form";
import { RelayAddress, RelayEvidence } from "./relay-evidence";
import { useRelayData } from "./use-relay-data";

export type CandidateAction = (role: string, url: string, field: "pinned" | "excluded") => void;

function useRankings(role: string, revision: number) {
  const load = useCallback((signal: AbortSignal) => relayManagerApi.rankings(role, signal), [role]);
  return useRelayData(role ? load : undefined, revision);
}

export function RoleRankings({
  roles,
  relay,
  addCandidate,
}: {
  roles: RelayRole[];
  relay?: string;
  addCandidate?: CandidateAction;
}) {
  const available = roles.filter((role) => rankedRole.safeParse(role.role).success);
  const [requestedRole, setRequestedRole] = useState("public_inbox");
  const [revision, setRevision] = useState(0);
  const role = available.some((item) => item.role === requestedRole)
    ? requestedRole
    : (available[0]?.role ?? "");
  const { data, loading, error } = useRankings(role, revision);
  return (
    <div className="space-y-4">
      {relay ? (
        <div className="border-edge space-y-2 rounded-xl border p-4">
          <RelayAddress url={relay} />
          <RelayEvidence url={relay} role={role ?? "public_inbox"} />
          {role && roleCanOptimize(role) && addCandidate ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => addCandidate(role, relay, "pinned")}
            >
              Pin this relay for {roleLabel(role)}
            </Button>
          ) : null}
        </div>
      ) : null}
      {available.length ? (
        <label className="text-ink-soft block max-w-xs space-y-1 text-sm">
          Ranking role
          <select
            className={selectClass}
            value={role}
            onChange={(event) => setRequestedRole(event.target.value)}
          >
            {available.map((item) => (
              <option value={item.role} key={item.role}>
                {roleLabel(item.role)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {loading ? (
        <p role="status" className="text-ink-muted text-sm">
          Loading role rankings…
        </p>
      ) : null}
      {error ? (
        <p className="text-ink-muted text-sm">
          {error}{" "}
          <Button variant="secondary" size="sm" onClick={() => setRevision(revision + 1)}>
            Retry rankings
          </Button>
        </p>
      ) : null}
      {data ? (
        <>
          <p className="text-ink-muted text-sm">
            {data.positive_adoption
              ? "Ranked for the selected role using public declarations and stored evidence."
              : "Listed here by blocklist references."}{" "}
            {data.note}
          </p>
          {data.fallbacks?.includes("stats_not_ready") ? (
            <p className="text-ink-muted text-sm">Role statistics are still being computed.</p>
          ) : null}
          {!data.relays.length ? (
            <p className="text-ink-muted text-sm">No ranked relays are available for this role.</p>
          ) : null}
          <ol className="divide-edge divide-y">
            {data.relays.map((candidate, index) => (
              <li className="space-y-2 py-3" key={candidate.url}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 gap-3">
                    <span className="text-ink-muted w-6 shrink-0 pt-0.5 text-sm tabular-nums">
                      {index + 1}
                    </span>
                    <RelayAddress url={candidate.url} />
                  </div>
                  {addCandidate && roleCanOptimize(data.role) && candidate.eligible ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => addCandidate(data.role, candidate.url, "pinned")}
                      aria-label={`Pin for next run: ${relayHost(candidate.url)} for ${roleLabel(data.role)}`}
                    >
                      Pin for next run
                    </Button>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Pill>
                    {candidate.distinct_users.toLocaleString()}{" "}
                    {data.positive_adoption ? "declarations" : "references"}
                  </Pill>
                  {data.positive_adoption ? (
                    <Pill>
                      Trust-weighted adoption{" "}
                      {candidate.trust_weighted.toLocaleString(undefined, {
                        maximumFractionDigits: 3,
                      })}
                    </Pill>
                  ) : null}
                  {candidate.score != null ? (
                    <Pill>Role score {candidate.score.toFixed(2)}</Pill>
                  ) : null}
                  <Pill>{candidate.confidence_label} confidence</Pill>
                  {candidate.ineligible_reason ? (
                    <Pill>{words(candidate.ineligible_reason)}</Pill>
                  ) : null}
                </div>
                {candidate.operator_key ? (
                  <p className="text-ink-muted text-xs break-all">
                    Operator evidence · {candidate.operator_key}
                  </p>
                ) : null}
                {candidate.reasons?.length ? (
                  <p className="text-ink-muted text-sm">
                    {candidate.reasons
                      .slice(0, 2)
                      .map(({ text }) => text)
                      .join(" ")}
                  </p>
                ) : null}
                <RelayEvidence
                  url={candidate.url}
                  role={data.role}
                  initial={candidate.capabilities}
                />
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </div>
  );
}

export function Recommendations({
  plan,
  addCandidate,
}: {
  plan: RelayPlan;
  addCandidate: CandidateAction;
}) {
  return (
    <div className="space-y-3">
      <p className="text-ink-muted text-sm">
        {plan.cohort.used === "personalized"
          ? `This uses public follows, interactions and declarations from a neighborhood of ${plan.cohort.size.toLocaleString()} accounts.`
          : "There is too little public neighborhood data for this account. Suggestions use trust-weighted global adoption and other stored evidence."}
        {plan.fallbacks?.includes("sparse_declarations")
          ? " Some roles have sparse declarations."
          : ""}
      </p>
      {plan.roles.map((item) => (
        <Disclosure
          key={item.role}
          title={roleLabel(item.role)}
          description={`${item.recommendations?.length ?? 0} suggestions${item.candidates_truncated ? " · limited candidate shortlist" : ""}`}
        >
          {!item.recommendations?.length ? (
            <p className="text-ink-muted text-sm">No suggestions available for this role.</p>
          ) : null}
          <ul className="divide-edge divide-y">
            {item.recommendations?.map((r, index) => {
              const url = r.suggested ?? r.current;
              const candidate = item.ranking?.find((row) => row.url === url);
              const selected = item.selection.selected?.find((row) => row.url === url);
              return (
                <li className="space-y-2 py-3 text-sm" key={`${r.action}-${url}-${index}`}>
                  <div className="flex flex-wrap gap-2">
                    <Pill className="capitalize" tone="reason">
                      {r.action}
                    </Pill>
                    <Pill>{r.confidence_label} confidence</Pill>
                    {candidate?.current ? <Pill>Already configured</Pill> : null}
                    {r.attention_required ? <Pill>Review required</Pill> : null}
                  </div>
                  {url ? <RelayAddress url={url} /> : null}
                  {r.current && r.suggested && r.current !== r.suggested ? (
                    <p className="text-ink-muted break-all">Replaces {r.current}</p>
                  ) : null}
                  <p>{r.text}</p>
                  {candidate?.reasons?.map((reason) => (
                    <p className="text-ink-muted" key={reason.code}>
                      {reason.text}
                    </p>
                  ))}
                  {selected &&
                  item.selection.known_weight > 0 &&
                  (item.role === "public_inbox" || item.role === "public_outbox") ? (
                    <p className="text-ink-muted">
                      Adds {share(selected.marginal_coverage)} declared neighborhood overlap in this
                      set.
                    </p>
                  ) : null}
                  {r.limitations?.map((text) => (
                    <p className="text-ink-muted" key={text}>
                      {text}
                    </p>
                  ))}
                  {url &&
                  roleCanOptimize(item.role) &&
                  (r.action === "add" || r.action === "replace" || r.action === "retain") ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => addCandidate(item.role, url, "pinned")}
                    >
                      Pin for next run
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Disclosure>
      ))}
    </div>
  );
}
