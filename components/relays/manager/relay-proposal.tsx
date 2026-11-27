import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { Pill } from "@/components/ui/pill";
import type { RelayConfig, RelayPlan, SignedEvent } from "@/lib/api/schemas/relay-manager";
import { proposalEvents } from "@/lib/relays/manager/apply";
import { normalizeRelayEndpoint } from "@/lib/relays/manager/identity";
import { roleLabel, roleRelaysFromTags, share, words } from "@/lib/relays/manager/presentation";
import type { CandidateAction } from "./relay-candidates";

export function ProposalComparison({
  plan,
  config,
  sources,
  evidence,
  addCandidate,
}: {
  plan: RelayPlan;
  config: RelayConfig;
  sources?: SignedEvent[];
  evidence?: RelayPlan;
  addCandidate: CandidateAction;
}) {
  const events = proposalEvents(plan);
  const reasons = [
    ...(plan.unsatisfied_constraints ?? []),
    ...(plan.proposal.blocking_reasons ?? []),
  ];
  const noChange =
    !events.length &&
    plan.constraints_satisfied &&
    plan.proposal.proposal_safe &&
    plan.proposal.source_complete &&
    !plan.proposal.requires_refresh &&
    !plan.proposal.requires_review &&
    plan.roles.every((role) =>
      (role.recommendations ?? []).every((r) => r.action === "retain" || r.action === "investigate")
    );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Pill>{plan.constraints_satisfied ? "Constraints satisfied" : "Unmet constraints"}</Pill>
        <Pill>
          {plan.proposal.proposal_safe ? "Safe patch assessment" : "Unsafe or incomplete proposal"}
        </Pill>
        <Pill>{plan.proposal.source_complete ? "Source complete" : "Source incomplete"}</Pill>
        {plan.proposal.requires_refresh ? <Pill>Source refresh required</Pill> : null}
        {plan.proposal.requires_review ? <Pill>Backend review hold</Pill> : null}
        {plan.proposal.ready_to_sign ? (
          <Pill tone="reason">Backend signing checks passed</Pill>
        ) : null}
      </div>
      {noChange ? (
        <p role="status" className="text-ink text-sm font-medium">
          No change proposed. No publication is necessary.
        </p>
      ) : null}
      {reasons.length ? (
        <ul className="border-edge space-y-2 rounded-xl border p-3 text-sm">
          {reasons.map((reason, index) => (
            <li key={`${reason.code}-${index}`}>
              {reason.text} <span className="text-ink-muted text-xs">({words(reason.code)})</span>
            </li>
          ))}
        </ul>
      ) : null}
      {plan.proposal.warnings?.map((warning, index) => (
        <p className="text-ink-muted text-sm" key={`${warning.code}-${index}`}>
          {warning.text}
        </p>
      ))}
      {plan.shared_configuration?.map((shared) => (
        <p key={shared.kind} className="text-ink-soft text-sm">
          <strong>Shared kind {shared.kind}.</strong> {shared.note}
        </p>
      ))}
      {plan.roles.map((role) => {
        const selected = role.selection.selected ?? [];
        const entry = config.account.roles.find((entry) => entry.role === role.role);
        const kind = role.role.startsWith("public_")
          ? 10002
          : role.role === "keypackage"
            ? sources?.some((event) => event.kind === 10002)
              ? 10002
              : 10051
            : (
                { dm_inbox: 10050, search: 10007, favorite: 10012, wiki: 10102 } as Record<
                  string,
                  number
                >
              )[role.role];
        const source = sources?.find((event) => event.kind === kind);
        const current = source
          ? roleRelaysFromTags(role.role, source.kind, source.tags).map(
              (url) => normalizeRelayEndpoint(url) ?? url
            )
          : (entry?.relays ?? []).map((relay) => relay.url);
        const next = selected.map((relay) => relay.url);
        const ranks =
          role.ranking ?? evidence?.roles.find((entry) => entry.role === role.role)?.ranking ?? [];
        const rankedByUrl = new Map(ranks.map((item) => [item.url, item]));
        const currentOperators = current.map((url) => rankedByUrl.get(url)?.operator_key);
        const operatorComparison = currentOperators.every(Boolean)
          ? `${new Set(currentOperators).size} → ${role.selection.operator_count} operator groups`
          : `${role.selection.operator_count} operator groups in proposed set`;
        const reliability = (url: string) => {
          const row = rankedByUrl.get(url);
          if (!row?.capabilities?.connect?.observed_at || row.components.reliability === undefined)
            return null;
          return (
            <p className="text-ink-muted text-xs">
              Model reliability factor {row.components.reliability.toFixed(2)}
            </p>
          );
        };
        const covered =
          role.selection.known_weight > 0 &&
          (role.role === "public_inbox" || role.role === "public_outbox");
        return (
          <div key={role.role} className="border-edge rounded-2xl border p-4">
            <h3 className="text-ink font-semibold">{roleLabel(role.role)}</h3>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <h4 className="text-ink-muted mb-2 text-xs font-semibold">
                  {source ? "Refreshed current list" : "Indexed current list"}
                </h4>
                {current.length ? (
                  <ul className="space-y-2">
                    {current.map((url) => (
                      <li key={url} className="space-y-1 text-sm">
                        <Pill>{next.includes(url) ? "Retained" : "Removed in proposal"}</Pill>
                        <p className="break-all">{url}</p>
                        {reliability(url)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-ink-muted text-sm">
                    {entry?.availability === "empty"
                      ? "Explicitly empty"
                      : "No current endpoints in this view"}
                  </p>
                )}
              </div>
              <div>
                <h4 className="text-ink-muted mb-2 text-xs font-semibold">Proposed list</h4>
                {selected.length ? (
                  <ul className="space-y-2">
                    {selected.map((relay) => (
                      <li key={relay.url} className="space-y-1 text-sm">
                        <Pill tone={current.includes(relay.url) ? "neutral" : "entity"}>
                          {current.includes(relay.url) ? "Retained" : "Added in proposal"}
                        </Pill>
                        {relay.pinned ? <Pill>Pinned</Pill> : null}
                        <p className="break-all">{relay.url}</p>
                        {reliability(relay.url)}
                        {covered && relay.marginal_coverage > 0 ? (
                          <p className="text-ink-muted text-xs">
                            Adds {share(relay.marginal_coverage)} declared overlap
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-ink-muted text-sm">No selected endpoints</p>
                )}
              </div>
            </div>
            {covered ? (
              <p className="text-ink-soft mt-3 text-sm">
                Declared neighborhood overlap · {share(role.selection.current_coverage)} →{" "}
                {share(role.selection.proposed_coverage)}
              </p>
            ) : null}
            <p className="text-ink-muted mt-1 text-sm">
              {operatorComparison}
              {role.selection.operator_count > 0
                ? ` · largest share ${share(role.selection.max_operator_share)}`
                : ""}
            </p>
            {!role.selection.constraints_satisfied ? (
              <p className="mt-2 text-sm">This role has unmet constraints.</p>
            ) : null}
            {[
              ...(role.selection.unsatisfied_constraints ?? []),
              ...(role.selection.qualifications ?? []),
            ].map((r, index) => (
              <p key={`${r.code}-${index}`} className="text-ink-muted mt-1 text-sm">
                {r.text}
              </p>
            ))}
            {role.recommendations?.length ? (
              <Disclosure title="Why these changes" className="mt-3">
                <ul className="space-y-3 text-sm">
                  {role.recommendations.map((r, index) => {
                    const url = r.suggested ?? r.current;
                    return (
                      <li key={`${r.action}-${url}-${index}`} className="space-y-1">
                        <p className="font-medium capitalize">
                          {r.action}
                          {url ? ` · ${url}` : ""}
                        </p>
                        <p className="text-ink-muted">{r.text}</p>
                        {r.attention_required ? <Pill>Review carefully</Pill> : null}
                        {r.limitations?.map((text) => (
                          <p className="text-ink-muted" key={text}>
                            {text}
                          </p>
                        ))}
                        {url ? (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => addCandidate(role.role, url, "pinned")}
                            >
                              Pin for next run
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => addCandidate(role.role, url, "excluded")}
                            >
                              Exclude for next run
                            </Button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </Disclosure>
            ) : null}
          </div>
        );
      })}
      {events.length ? (
        <ul className="text-ink-muted space-y-1 text-sm">
          {events.map((event) => (
            <li key={event.kind}>
              Kind {event.kind} · {event.change ?? "operation unknown"} ·{" "}
              {event.proposal_safe ? "Safe individual patch" : "Unsafe individual patch"}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
