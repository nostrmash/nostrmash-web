"use client";

import { useCallback, useState } from "react";

import Link from "@/components/app-link";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { relayManagerApi } from "@/lib/api/endpoints/relay-manager";
import type { RelayCapabilities, ScoredRelay } from "@/lib/api/schemas/relay-manager";
import { normalizeRelayEndpoint } from "@/lib/relays/manager/identity";
import { dateLabel, relayHost, share, words } from "@/lib/relays/manager/presentation";
import { useRelayData } from "./use-relay-data";

const relevant: Record<string, string[]> = {
  public_inbox: ["read_subscription", "auth"],
  public_outbox: ["write", "auth_write", "auth"],
  search: ["search", "auth_search"],
  dm_inbox: ["giftwrap_accept", "auth_recipient", "auth_giftwrap"],
  keypackage: ["keypackage"],
  blossom: ["retention"],
};

const capabilityLabels: Record<string, string> = {
  read_subscription: "Read subscription",
  auth: "General authentication",
  auth_write: "Write authentication",
  auth_search: "Search authentication",
  auth_recipient: "Recipient authentication",
  auth_giftwrap: "Gift-wrap publication authentication",
  giftwrap_accept: "Gift-wrap acceptance",
  keypackage: "Kind 30443 transport",
  write: "Note publication",
};

function EvidenceList({
  role,
  capabilities,
}: {
  role: string;
  capabilities: ScoredRelay["capabilities"];
}) {
  return (
    <ul className="space-y-2 text-sm">
      {(relevant[role] ?? ["connect", "read_subscription", "auth"]).map((name) => {
        const evidence = capabilities?.[name];
        const status = evidence?.freshness === "stale" ? "stale" : (evidence?.status ?? "unknown");
        return (
          <li key={name}>
            <div className="flex flex-wrap items-center gap-2">
              <span>{capabilityLabels[name] ?? words(name)}</span>
              <Pill className="capitalize">{words(status)}</Pill>
            </div>
            {evidence ? (
              <p className="text-ink-muted mt-1 text-xs">
                {share(evidence.confidence)} evidence confidence
                {evidence.observed_at ? ` · ${dateLabel(evidence.observed_at)}` : ""}
                {evidence.recent_inconclusive
                  ? ` · ${evidence.recent_inconclusive} inconclusive observations`
                  : ""}
                {evidence.detail ? ` · ${evidence.detail}` : ""}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

const privacyChecks = {
  gift_wrap_accepted: "Gift-wrap acceptance",
  recipient_retrieval_verified: "Authenticated recipient retrieval",
  recipient_auth_verified: "Recipient authentication",
  publication_auth_verified: "Publication authentication",
  unauthenticated_exposure: "Unauthenticated observer exposure",
  authenticated_observer_exposure: "Authenticated observer exposure",
} as const;

function PrivacyEvidence({ privacy, capabilities }: RelayCapabilities) {
  const comprehensive =
    privacy.comprehensive &&
    !privacy.stale &&
    !privacy.exposure_unresolved &&
    !privacy.exposure_confirmed &&
    privacy.unauthenticated_exposure === false &&
    privacy.authenticated_observer_exposure === false;
  return (
    <div className="border-edge space-y-3 border-t pt-3">
      <p className="text-ink font-medium">DM privacy evidence</p>
      <p className="text-ink-muted text-sm">
        {privacy.exposure_confirmed ? "Envelope exposure observed. " : ""}
        {comprehensive
          ? "Recipient-only access verified in sampled tests."
          : privacy.stale
            ? "Privacy evidence is stale."
            : "Recipient-only access is unverified."}
        {privacy.exposure_unresolved ? " Observer exposure remains unresolved." : ""}
      </p>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        {Object.entries(privacyChecks).map(([key, label]) => {
          const value = privacy[key as keyof typeof privacyChecks];
          return (
            <div key={key}>
              <dt className="text-ink-muted">{label}</dt>
              <dd>{value === null ? "Unknown" : value ? "Yes" : "No"}</dd>
            </div>
          );
        })}
      </dl>
      <p className="text-ink-muted text-xs">
        {privacy.freshness ? `Evidence ${privacy.freshness}. ` : ""}
        {privacy.confidence !== undefined
          ? `${share(privacy.confidence)} evidence confidence. `
          : ""}
        {privacy.private_observed_at
          ? `Recipient checked ${dateLabel(privacy.private_observed_at)}. `
          : ""}
        {privacy.exposure_observed_at
          ? `Exposure checked ${dateLabel(privacy.exposure_observed_at)}. `
          : ""}
        {capabilities.giftwrap_accept?.status === "verified"
          ? "Accepting an encrypted envelope and limiting who can retrieve it are separate checks."
          : ""}
      </p>
      {privacy.access_paths?.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer">Individual access checks</summary>
          <ul className="mt-2 space-y-1">
            {privacy.access_paths.map((path) => (
              <li key={path.name}>
                {words(path.name)} · {words(path.status)}
                {path.observed_at ? ` · ${dateLabel(path.observed_at)}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function RelayEvidence({
  url,
  role,
  initial,
}: {
  url: string;
  role: string;
  initial?: ScoredRelay["capabilities"];
}) {
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) => relayManagerApi.capabilities(url, signal),
    [url]
  );
  const { data, error, loading } = useRelayData(open ? load : undefined, revision);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)} className="text-sm">
      <summary className="text-link cursor-pointer rounded">Relay evidence</summary>
      {open ? (
        <div className="border-edge mt-2 space-y-3 rounded-xl border p-3">
          {loading ? (
            <p role="status" className="text-ink-muted">
              Loading stored evidence…
            </p>
          ) : null}
          {error ? (
            <p role="status">
              {error}{" "}
              <Button size="sm" variant="secondary" onClick={() => setRevision(revision + 1)}>
                Retry
              </Button>
            </p>
          ) : null}
          <EvidenceList role={role} capabilities={data?.capabilities ?? initial} />
          {role === "dm_inbox" && data ? <PrivacyEvidence {...data} /> : null}
          {role === "keypackage" ? (
            <p className="text-ink-muted">Kind 30443 transport verification is unknown.</p>
          ) : null}
          {data?.propagation.Known ? (
            <p className="text-ink-muted">
              Observed public activity over 7 days ·{" "}
              {data.propagation.EventsSeen7d.toLocaleString()} events seen ·{" "}
              {data.propagation.FirstSeen7d.toLocaleString()} first seen here.
            </p>
          ) : null}
          {data?.capabilities.payment ? (
            <p>Payment evidence · {words(data.capabilities.payment.status)}</p>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

export function RelayAddress({ url }: { url: string }) {
  const host = relayHost(url);
  return (
    <div className="min-w-0">
      {normalizeRelayEndpoint(url) ? (
        <Link
          href={`/relays/${encodeURIComponent(host)}`}
          className="text-link font-medium break-all"
        >
          {host}
        </Link>
      ) : (
        <p className="text-ink font-medium break-all">{host}</p>
      )}
      <p className="text-ink-muted mt-0.5 font-mono text-xs break-all">{url}</p>
    </div>
  );
}
