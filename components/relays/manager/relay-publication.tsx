import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { Pill } from "@/components/ui/pill";
import type { RelayConfig } from "@/lib/api/schemas/relay-manager";
import { words } from "@/lib/relays/manager/presentation";
import type { Published } from "./use-relay-workflow";

const outcomes = {
  accepted: "Accepted",
  rejected: "Rejected",
  authentication_required: "Authentication required",
  access_restricted: "Payment or access restricted",
  timeout: "Timed out",
  connection_failure: "Connection failed",
  unknown: "Outcome unknown",
};

export function PublicationResults({
  entries,
  config,
  canRetry,
  busy,
  retry,
  verify,
  close,
}: {
  entries: Published[];
  config: RelayConfig;
  canRetry: boolean;
  busy: boolean;
  retry: () => void;
  verify: () => void;
  close: () => void;
}) {
  const hasReceipts = entries.some((entry) => entry.receipts.length);
  const hasFailures = entries.some((entry) =>
    entry.receipts.some((receipt) => receipt.outcome !== "accepted")
  );
  const conflict = entries.some((entry) =>
    entry.verification?.relays?.some((relay) => relay.outcome === "conflict")
  );
  return (
    <div className="space-y-4">
      <p className="text-ink-muted text-sm">
        Each event is published independently. Relay acknowledgements and sampled read-back can
        arrive before the account index updates.
      </p>
      {entries.map(({ event, receipts, verification, verificationError }) => {
        const source = config.sources.find((item) => item.kind === event.kind && !item.d_tag);
        const indexed =
          source?.canonical_event_id === event.id ||
          config.account.roles.some((role) => role.event_id === event.id);
        const accepted = receipts.filter((receipt) => receipt.outcome === "accepted").length;
        return (
          <article key={event.id} className="border-edge space-y-3 rounded-2xl border p-4">
            <div className="flex flex-wrap gap-2">
              <Pill>Kind {event.kind}</Pill>
              <Pill>
                {accepted} of {receipts.length} relays accepted
              </Pill>
              <Pill>
                {indexed
                  ? "Visible in index"
                  : "Index has a different version or is still updating"}
              </Pill>
            </div>
            <p className="text-ink-muted font-mono text-xs break-all">{event.id}</p>
            <Disclosure title="Publication acknowledgements">
              {receipts.length ? (
                <ul className="space-y-2 text-sm">
                  {receipts.map((receipt) => (
                    <li className="break-all" key={receipt.url}>
                      {receipt.url} · <strong>{outcomes[receipt.outcome]}</strong>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-ink-muted text-sm">Waiting for relay acknowledgements.</p>
              )}
            </Disclosure>
            {verification ? (
              <div className="space-y-2 text-sm">
                <p className="font-semibold">
                  {verification.sample_verified
                    ? "Sample verified"
                    : verification.reason === "conflict"
                      ? "Conflicting relay versions observed"
                      : "Sample verification incomplete"}
                </p>
                <p className="text-ink-muted">
                  {verification.exact_retrieved_count} exact retrievals ·{" "}
                  {verification.latest_agreement_count} agreed on the latest version across{" "}
                  {verification.relays?.length ?? 0} sampled relays.
                </p>
                <Disclosure
                  title="Sampled relay checks"
                  description="Each relay is checked for the exact event and the latest replaceable version."
                >
                  <ul className="space-y-2">
                    {verification.relays?.map((row) => (
                      <li className="break-all" key={row.relay_url}>
                        {row.relay_url} · {words(row.outcome)} ·{" "}
                        {row.retrieved ? "Exact event found" : "Exact retrieval unconfirmed"} ·{" "}
                        {row.latest_agrees
                          ? "Latest version agrees"
                          : "Latest agreement unconfirmed"}
                        {row.outcome === "conflict" && row.latest_id ? (
                          <p className="font-mono text-xs">Conflicting ID {row.latest_id}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              </div>
            ) : null}
            {verificationError ? (
              <p role="status" className="text-ink-muted text-sm">
                Sample verification unavailable. {verificationError} Relay acknowledgements are
                still shown above.
              </p>
            ) : null}
          </article>
        );
      })}
      <div className="flex flex-wrap gap-2">
        {canRetry && hasFailures && !conflict ? (
          <Button variant="secondary" disabled={busy} onClick={retry}>
            Retry unaccepted relays
          </Button>
        ) : null}
        {hasReceipts ? (
          <Button variant="secondary" disabled={busy} onClick={verify}>
            Verify sample again
          </Button>
        ) : null}
        <Button variant="secondary" disabled={busy} onClick={close}>
          Finish and refresh account
        </Button>
      </div>
    </div>
  );
}
