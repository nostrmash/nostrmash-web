"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from "react";

import Link from "@/components/app-link";
import { ProfileAvatar } from "@/components/explorer/profile-avatar";
import { profileLabel, truncateIdentifier } from "@/components/explorer/utils";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { Input } from "@/components/ui/input";
import { Pill } from "@/components/ui/pill";
import { SectionCard } from "@/components/ui/section-card";
import { getRelayManagerProfile, relayManagerApi } from "@/lib/api/endpoints/relay-manager";
import type { RelayPreset, RelayRole } from "@/lib/api/schemas/relay-manager";
import { browserSigner, nip07Signer } from "@/lib/nostr/browser-signer";
import { hexToNpub } from "@/lib/nostr/nip19";
import { proposalEvents, relayTargets, roleCanOptimize } from "@/lib/relays/manager/apply";
import { endpoints, optimizationRequest, type Drafts } from "@/lib/relays/manager/constraints";
import {
  accountKey,
  normalizeRelayEndpoint,
  relayManagerHref,
} from "@/lib/relays/manager/identity";
import { dateLabel, presets, roleLabel } from "@/lib/relays/manager/presentation";

import { ConstraintsForm, selectClass } from "./constraints-form";
import { Recommendations, RoleRankings, type CandidateAction } from "./relay-candidates";
import { Configuration, Findings } from "./relay-configuration";
import { ProposalComparison } from "./relay-proposal";
import { PublicationResults } from "./relay-publication";
import { useRelayData } from "./use-relay-data";
import { useRelayWorkflow, type ConnectedSigner } from "./use-relay-workflow";

const panel = "min-w-0 rounded-2xl border border-edge bg-surface/55 p-4 sm:p-6";
const title = "nm-title text-ink";
const checkbox =
  "accent-accent focus-visible:ring-accent-soft size-4 shrink-0 focus-visible:ring-2";

export function ManagerSkeleton({ label = "Loading relay configuration…" }: { label?: string }) {
  return (
    <div role="status" className="border-edge space-y-3 rounded-2xl border p-5">
      <p className="text-ink-muted text-sm">{label}</p>
      <div aria-hidden="true" className="bg-surface-raised h-3 w-2/3 animate-pulse rounded-md" />
      <div aria-hidden="true" className="bg-surface-raised h-3 w-1/2 animate-pulse rounded-md" />
    </div>
  );
}

function AccountLookup({ pubkey, select }: { pubkey?: string; select: (pubkey?: string) => void }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = accountKey(input);
    if (!key) {
      setError("Enter a valid npub, nprofile or 64-character public key.");
      return;
    }
    setError("");
    setInput("");
    select(key);
  }
  return (
    <form className="min-w-0 space-y-2" onSubmit={submit}>
      <label className="text-ink-soft block text-sm font-medium" htmlFor="relay-account">
        {pubkey ? "Inspect another account" : "Inspect an account"}
      </label>
      <div className="flex flex-wrap items-stretch gap-2 sm:flex-nowrap">
        <Input
          id="relay-account"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          maxLength={2048}
          placeholder="npub, nprofile or public key"
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "relay-account-error" : undefined}
        />
        <Button type="submit">Inspect account</Button>
      </div>
      {error ? (
        <p id="relay-account-error" role="alert" className="text-ink-soft text-sm">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function RelayManager() {
  const query = useSearchParams();
  const rawAccount = query.get("viewer");
  const pubkey = rawAccount ? accountKey(rawAccount) : undefined;
  const rawRelay = query.get("relay");
  const relay = rawRelay ? normalizeRelayEndpoint(rawRelay) : undefined;
  const [signer, setSigner] = useState<ConnectedSigner>();
  const [signerBusy, setSignerBusy] = useState(false);
  const [signerError, setSignerError] = useState("");
  const [roleRevision, setRoleRevision] = useState(0);
  const roles = useRelayData(relayManagerApi.roles, roleRevision);
  const workRef = useRef<AbortController>(undefined);
  const lookup = useRef<symbol>(undefined);

  useEffect(() => {
    const abort = () => workRef.current?.abort();
    window.addEventListener("popstate", abort);
    return () => window.removeEventListener("popstate", abort);
  }, []);

  function select(key?: string) {
    if (key === pubkey && rawAccount === (key ?? null)) return;
    workRef.current?.abort();
    window.history.pushState(null, "", relayManagerHref(key, relay));
  }

  async function connect() {
    setSignerError("");
    const next = nip07Signer();
    const extension = browserSigner();
    if (!next || !extension) {
      setSignerError(
        "This browser has no NIP-07 signer that supports signing. You can still inspect public accounts."
      );
      return;
    }
    const attempt = Symbol();
    lookup.current = attempt;
    setSignerBusy(true);
    try {
      const key = await next.getPublicKey();
      if (lookup.current !== attempt) return;
      if (browserSigner() !== extension || !/^[0-9a-f]{64}$/i.test(key)) {
        throw new Error("Invalid public key");
      }
      workRef.current?.abort();
      const current = key.toLowerCase();
      setSigner({ pubkey: current, signer: next, extension });
      if (!new URL(window.location.href).searchParams.get("viewer")) select(current);
    } catch {
      if (lookup.current === attempt)
        setSignerError("The browser signer did not return a public key. Try connecting it again.");
    } finally {
      if (lookup.current === attempt) setSignerBusy(false);
    }
  }

  function disconnect() {
    lookup.current = undefined;
    workRef.current?.abort();
    setSignerBusy(false);
    setSignerError("");
    setSigner(undefined);
  }

  function signerLost() {
    setSigner(undefined);
    setSignerError(
      "The browser signer disconnected or switched accounts. Connect it again to manage this configuration."
    );
  }

  const owner = pubkey && signer?.pubkey === pubkey ? signer : undefined;
  return (
    <>
      <div className={`${panel} ${pubkey ? "space-y-4" : "space-y-6"}`}>
        {!pubkey ? (
          <div className="max-w-2xl space-y-2">
            <h2 className={title}>Find the right relays for your account</h2>
            <p className="text-ink-muted text-sm leading-relaxed">
              Inspect public relay lists, compare role-specific suggestions, and review a
              configuration before signing it with your browser extension.
            </p>
          </div>
        ) : null}
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)]">
          <AccountLookup key={pubkey} pubkey={pubkey} select={select} />
          <div className="space-y-2">
            <p className="text-ink-soft text-sm font-medium">Browser signer</p>
            <div className="flex flex-wrap items-center gap-2">
              {signer ? (
                <>
                  <Pill tone={owner ? "entity" : "neutral"}>
                    {owner ? "Connected · can manage" : "Connected to another account"}
                  </Pill>
                  {!owner ? (
                    <Button variant="secondary" size="sm" onClick={() => select(signer.pubkey)}>
                      Inspect signer account
                    </Button>
                  ) : null}
                  <Button variant="secondary" size="sm" onClick={disconnect}>
                    Disconnect
                  </Button>
                </>
              ) : (
                <Button variant="secondary" disabled={signerBusy} onClick={connect}>
                  {signerBusy ? "Connecting…" : "Connect a signer"}
                </Button>
              )}
              {pubkey ? (
                <Button variant="ghost" size="sm" onClick={() => select()}>
                  Clear account
                </Button>
              ) : null}
            </div>
            {signerError ? (
              <p role="alert" className="text-ink-muted text-sm">
                {signerError}
              </p>
            ) : null}
            {pubkey && !owner ? (
              <p className="text-ink-muted text-xs">
                Public inspection is read-only. You can preview changes.
              </p>
            ) : null}
          </div>
        </div>
        {rawAccount && !pubkey ? (
          <p role="alert" className="text-ink-muted text-sm">
            The shared link does not contain a valid public account key.
          </p>
        ) : null}
      </div>
      {roles.error ? (
        <p className="text-ink-muted text-sm">
          {roles.error}{" "}
          <Button variant="secondary" size="sm" onClick={() => setRoleRevision(roleRevision + 1)}>
            Retry role catalog
          </Button>
        </p>
      ) : null}
      {pubkey ? (
        <AccountWorkspace
          key={pubkey}
          pubkey={pubkey}
          owner={owner}
          roles={roles.data?.roles ?? []}
          workRef={workRef}
          onSignerLost={signerLost}
          relay={relay}
          roleLoading={roles.loading}
        />
      ) : (
        <SectionCard
          title="Explore role rankings"
          description="Compare public adoption and observed capability across Nostr relay roles."
          id="rankings"
        >
          {roles.loading ? (
            <ManagerSkeleton label="Loading relay roles…" />
          ) : (
            <RoleRankings roles={roles.data?.roles ?? []} relay={relay} />
          )}
        </SectionCard>
      )}
    </>
  );
}

function AccountWorkspace({
  pubkey,
  owner,
  roles,
  workRef,
  onSignerLost,
  relay,
  roleLoading,
}: {
  pubkey: string;
  owner?: ConnectedSigner;
  roles: RelayRole[];
  workRef: RefObject<AbortController | undefined>;
  onSignerLost: () => void;
  relay?: string;
  roleLoading: boolean;
}) {
  const [revision, setRevision] = useState(0);
  const [recommendationRevision, setRecommendationRevision] = useState(0);
  const [preset, setPreset] = useState<RelayPreset>("balanced");
  const [selected, setSelected] = useState<string[]>();
  const [drafts, setDrafts] = useState<Drafts>({ global: {}, byRole: {} });
  const [allowCreate, setCreate] = useState(false);
  const [allowRecreate, setRecreate] = useState(false);
  const [candidateNotice, setCandidateNotice] = useState("");
  const loadConfig = useCallback(
    (signal: AbortSignal) => relayManagerApi.config(pubkey, signal),
    [pubkey]
  );
  const loadProfile = useCallback(
    (signal: AbortSignal) => getRelayManagerProfile(pubkey, signal),
    [pubkey]
  );
  const loadDiagnostics = useCallback(
    (signal: AbortSignal) => relayManagerApi.diagnostics(pubkey, signal),
    [pubkey]
  );
  const loadRecommendations = useCallback(
    (signal: AbortSignal) => relayManagerApi.recommendations(pubkey, preset, signal),
    [pubkey, preset]
  );
  const config = useRelayData(loadConfig, revision);
  const profile = useRelayData(loadProfile);
  const diagnostics = useRelayData(loadDiagnostics, revision);
  const recommendations = useRelayData(loadRecommendations, recommendationRevision);
  const available = roles.filter((role) => roleCanOptimize(role.role));
  const selection =
    selected ?? available.filter((role) => role.optimized_by_default).map((role) => role.role);
  const reload = () => {
    setRevision((value) => value + 1);
    setRecommendationRevision((value) => value + 1);
  };
  const workflow = useRelayWorkflow({ pubkey, owner, workRef, reload, onSignerLost });
  const busy = Boolean(workflow.busy);
  const editingLocked = busy || Boolean(workflow.published.length);
  const snapshot = config.data?.account;
  const identity = profile.data ?? { pubkey };
  const npub = hexToNpub(pubkey) ?? pubkey;
  const displayName = profile.data ? profileLabel(identity) : "Public account";

  function updateDrafts(next: Drafts) {
    workflow.invalidate();
    setCandidateNotice("");
    setDrafts(next);
  }

  const addCandidate: CandidateAction = (role, raw, field) => {
    if (editingLocked || !available.some((item) => item.role === role)) return;
    const url = normalizeRelayEndpoint(raw);
    if (!url)
      return workflow.reportError("This endpoint cannot be used as a Nostr relay candidate.");
    const scoped = drafts.byRole[role] ?? {};
    const inherit =
      field === "pinned" && !scoped.pinned?.trim() ? endpoints(drafts.global.pinned) : [];
    const next = [...new Set([...inherit, ...endpoints(scoped[field]), url])].join("\n");
    updateDrafts({ ...drafts, byRole: { ...drafts.byRole, [role]: { ...scoped, [field]: next } } });
    setSelected([...new Set([...selection, role])]);
    setCandidateNotice(
      `${field === "pinned" ? "Pinned" : "Excluded"} ${url} for ${roleLabel(role)} on your next optimization.`
    );
  };

  function optimize(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editingLocked) return;
    try {
      const request = optimizationRequest(
        pubkey,
        selection,
        preset,
        drafts,
        Boolean(owner && allowCreate),
        Boolean(owner && allowRecreate)
      );
      setCandidateNotice("");
      void workflow.optimize(request);
    } catch (error) {
      workflow.reportError(
        error instanceof Error ? error.message : "Review the optimization constraints."
      );
    }
  }

  const data = config.data;
  const selectedKinds = available
    .filter((role) => selection.includes(role.role))
    .flatMap((role) => role.kinds);
  const selectedConfig = snapshot?.roles.filter((role) => selection.includes(role.role));
  const canPreviewCreation =
    selectedConfig?.some((role) => role.availability === "missing") ||
    (snapshot?.modern_public === "missing" && selectedKinds.includes(10002));
  const canPreviewRecreation = data?.sources.some(
    (source) => source.status === "deleted" && selectedKinds.includes(source.kind)
  );
  const endpointsCount = new Set(
    snapshot?.roles.flatMap((role) =>
      role.role !== "blocked" && role.role !== "blossom" && role.availability !== "client_side"
        ? role.relays.map((relay) => relay.url)
        : []
    )
  ).size;
  const missingRoles = snapshot?.roles.filter(
    (role) =>
      available.some((item) => item.role === role.role && item.optimized_by_default) &&
      role.availability === "missing"
  );
  const issues = diagnostics.data?.findings?.filter(
    (finding) => finding.severity === "critical" || finding.severity === "warning"
  );
  const needsRefresh =
    data?.sources.some((source) => source.requires_refresh) ||
    snapshot?.roles.some((role) => role.truncated);
  const proposal = workflow.proposal;
  const recommendationPlan =
    recommendations.data?.pubkey === pubkey ? recommendations.data : undefined;

  return (
    <>
      <header className={`${panel} space-y-4`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <ProfileAvatar
              profile={identity}
              size={56}
              alt=""
              className="border-edge shrink-0 rounded-full border"
            />
            <div className="min-w-0">
              <h2 className={title}>{displayName}</h2>
              <Link className="text-link font-mono text-sm" title={npub} href={`/profiles/${npub}`}>
                {truncateIdentifier(npub, "npub")}
              </Link>
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || config.loading}
            onClick={() => {
              if (!workflow.published.length) workflow.invalidate();
              reload();
            }}
          >
            Refresh configuration
          </Button>
        </div>
        <div className="flex flex-wrap gap-2" aria-live="polite">
          {data ? (
            <Pill tone="freshness">
              {config.loading
                ? "Refreshing · previous indexed snapshot"
                : `${config.error ? "Last indexed snapshot" : "Index checked"} ${dateLabel(data.generated_at)}`}
            </Pill>
          ) : null}
          {!profile.loading && !profile.data ? <Pill>Profile metadata unavailable</Pill> : null}
          {needsRefresh ? <Pill>Stale or incomplete sources</Pill> : null}
          {owner ? <Pill tone="entity">Signer owns this account</Pill> : <Pill>Read-only</Pill>}
        </div>
        {config.error ? (
          <p role="alert" className="text-ink-muted text-sm">
            {config.error}{" "}
            <Button size="sm" variant="secondary" onClick={reload}>
              Retry configuration
            </Button>
          </p>
        ) : null}
        {!data && config.loading ? <ManagerSkeleton /> : null}
        {snapshot ? (
          <dl className="border-edge grid grid-cols-2 gap-3 border-t pt-4 sm:grid-cols-4">
            <div>
              <dt className="text-ink-muted text-xs">Configured endpoints</dt>
              <dd className="text-ink text-2xl font-semibold tabular-nums">{endpointsCount}</dd>
            </div>
            <div>
              <dt className="text-ink-muted text-xs">Public relay list</dt>
              <dd className="text-ink mt-1 text-sm font-medium">
                {snapshot.modern_public === "empty"
                  ? "Explicitly empty"
                  : snapshot.modern_public === "present"
                    ? "NIP-65 configured"
                    : snapshot.legacy_public === "present"
                      ? "Legacy fallback"
                      : "Missing"}
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted text-xs">Missing common roles</dt>
              <dd className="text-ink text-2xl font-semibold tabular-nums">
                {roleLoading ? "…" : (missingRoles?.length ?? 0)}
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted text-xs">Diagnostic findings</dt>
              <dd className="text-ink text-2xl font-semibold tabular-nums">
                {diagnostics.data ? (issues?.length ?? 0) : "—"}
              </dd>
            </div>
          </dl>
        ) : null}
        {snapshot?.roles.every((role) => role.availability === "missing") ? (
          <p className="text-ink-muted text-sm">
            The index has no relay lists for this account. The public key may be new or outside the
            index.
          </p>
        ) : null}
      </header>

      {data ? (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          <section className={`${panel} space-y-5`} aria-labelledby="optimize-title">
            <div className="space-y-2">
              <h2 id="optimize-title" className={title}>
                Optimize configuration
              </h2>
              <p className="text-ink-muted text-sm">
                Preview a complementary set based on public neighborhood overlap, role capability,
                and reliability.
              </p>
            </div>
            <form onSubmit={optimize} noValidate>
              <fieldset disabled={editingLocked} className="space-y-4 disabled:opacity-65">
                <label className="text-ink-soft block max-w-sm space-y-1 text-sm">
                  Optimization preset
                  <select
                    value={preset}
                    className={selectClass}
                    onChange={(event) => {
                      setPreset(event.target.value as RelayPreset);
                      workflow.invalidate();
                    }}
                  >
                    {Object.entries(presets).map(([key, value]) => (
                      <option value={key} key={key}>
                        {value.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="text-ink-muted text-sm">{presets[preset].description}</p>
                <Disclosure
                  title="Roles to optimize"
                  description={
                    selection.map(roleLabel).join(", ") || "Choose role lists to include."
                  }
                >
                  <div className="grid gap-2 sm:grid-cols-2">
                    {available.map((role) => (
                      <label
                        className="text-ink-soft flex items-center gap-2 py-1.5 text-sm"
                        key={role.role}
                      >
                        <input
                          type="checkbox"
                          className={checkbox}
                          checked={selection.includes(role.role)}
                          onChange={(event) => {
                            setSelected(
                              event.target.checked
                                ? [...selection, role.role]
                                : selection.filter((item) => item !== role.role)
                            );
                            workflow.invalidate();
                          }}
                        />{" "}
                        {roleLabel(role.role)}
                      </label>
                    ))}
                  </div>
                  <p className="text-ink-muted mt-2 text-xs">
                    Inbox and outbox share kind 10002. KeyPackage discovery can use the same outbox.
                  </p>
                </Disclosure>
                <ConstraintsForm
                  roles={available}
                  preset={preset}
                  drafts={drafts}
                  onChange={updateDrafts}
                />
                {owner && (canPreviewCreation || canPreviewRecreation) ? (
                  <Disclosure title="Creation and recreation">
                    <div className="space-y-3 text-sm">
                      <p className="text-ink-muted">
                        Request a separate preview for a first list or a deleted list. These
                        operations stay on backend review hold.
                      </p>
                      {canPreviewCreation ? (
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            className={checkbox}
                            checked={allowCreate}
                            onChange={(event) => {
                              setCreate(event.target.checked);
                              workflow.invalidate();
                            }}
                          />{" "}
                          Preview creating a missing list
                        </label>
                      ) : null}
                      {canPreviewRecreation ? (
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            className={checkbox}
                            checked={allowRecreate}
                            onChange={(event) => {
                              setRecreate(event.target.checked);
                              workflow.invalidate();
                            }}
                          />{" "}
                          Preview recreating a deleted list
                        </label>
                      ) : null}
                    </div>
                  </Disclosure>
                ) : null}
                <Button
                  className="w-full sm:w-auto"
                  type="submit"
                  disabled={!available.length || config.loading}
                >
                  Optimize configuration
                </Button>
              </fieldset>
            </form>
            {workflow.busy || workflow.notice || candidateNotice ? (
              <p role="status" className="text-ink-soft text-sm">
                {workflow.busy || workflow.notice || candidateNotice}
              </p>
            ) : null}
            {workflow.error ? (
              <p role="alert" className="text-ink-soft border-edge rounded-xl border p-3 text-sm">
                {workflow.error}
              </p>
            ) : null}

            {workflow.published.length ? (
              <div className="border-edge space-y-3 border-t pt-4">
                <h3 className={title}>Publication and verification</h3>
                <PublicationResults
                  entries={workflow.published}
                  config={data}
                  canRetry={Boolean(owner)}
                  busy={busy}
                  retry={workflow.retryPublication}
                  verify={workflow.reverify}
                  close={workflow.closePublication}
                />
              </div>
            ) : null}

            {proposal && !workflow.published.length ? (
              <section
                className="border-edge space-y-4 border-t pt-5"
                aria-labelledby="proposal-title"
              >
                <h3 id="proposal-title" className={title}>
                  Proposed configuration
                </h3>
                <ProposalComparison
                  config={data}
                  plan={proposal.plan}
                  sources={proposal.sources}
                  evidence={recommendationPlan}
                  addCandidate={addCandidate}
                />
                {proposal.plan.proposal.requires_review ? (
                  <p className="text-ink-muted text-sm">
                    This operation requires backend review. Publication becomes available when the
                    optimizer returns a complete, ready-to-sign replacement.
                  </p>
                ) : null}
                {workflow.review ? (
                  <div
                    aria-labelledby="final-review"
                    className="border-accent-soft space-y-3 rounded-xl border p-4"
                  >
                    <h4 id="final-review" className="font-semibold">
                      Final review
                    </h4>
                    <p className="text-ink-muted text-sm">
                      Account <span className="font-mono break-all">{npub}</span>
                    </p>
                    <p className="text-sm">
                      Replace{" "}
                      {proposalEvents(workflow.review.proposal.plan)
                        .map((event) => `kind ${event.kind}`)
                        .join(", ")}{" "}
                      for{" "}
                      {workflow.review.proposal.plan.roles
                        .map((item) => roleLabel(item.role))
                        .join(", ")}
                      .
                    </p>
                    <p className="text-ink-muted text-sm">
                      Changes and warnings are listed above. Only the listed signed events will be
                      sent to these relays.
                    </p>
                    <ul className="space-y-1 font-mono text-xs">
                      {workflow.review.targets.map((url) => (
                        <li className="break-all" key={url}>
                          {url}
                        </li>
                      ))}
                    </ul>
                    <p className="text-ink-muted text-xs">
                      A fresh relay sample checks recent changes and deletions. Other copies can
                      exist elsewhere on the network.
                    </p>
                    <Button disabled={busy} onClick={workflow.confirm}>
                      Sign and publish reviewed changes
                    </Button>
                  </div>
                ) : owner &&
                  proposal.plan.constraints_satisfied &&
                  !proposal.plan.proposal.requires_review &&
                  (proposalEvents(proposal.plan).length > 0 ||
                    proposal.plan.proposal.requires_refresh) ? (
                  <>
                    <p className="text-ink-muted text-sm">
                      Source sample ·{" "}
                      {relayTargets(data).sources.join(", ") || "No eligible relay hosts"}
                    </p>
                    <Button disabled={busy || config.loading} onClick={workflow.prepare}>
                      Refresh sources and review
                    </Button>
                  </>
                ) : !owner && proposalEvents(proposal.plan).length ? (
                  <p className="text-ink-muted text-sm">
                    Connect this account’s signer to review the current signed sources.
                  </p>
                ) : null}
              </section>
            ) : null}
          </section>

          <aside
            className={`${panel} space-y-5`}
            aria-label="Current configuration and diagnostics"
          >
            <div className="space-y-3">
              <h2 className={title}>Diagnostics</h2>
              {diagnostics.loading && !diagnostics.data ? (
                <p role="status" className="text-ink-muted text-sm">
                  Checking configuration…
                </p>
              ) : null}
              {diagnostics.error ? (
                <p className="text-ink-muted text-sm">
                  {diagnostics.error}{" "}
                  <Button size="sm" variant="secondary" onClick={reload}>
                    Retry diagnostics
                  </Button>
                </p>
              ) : null}
              {diagnostics.data?.pubkey === pubkey ? (
                <Findings findings={diagnostics.data.findings ?? []} />
              ) : null}
            </div>
            <div className="border-edge space-y-3 border-t pt-5">
              <h2 className={title}>Current configuration</h2>
              <Configuration config={data} roles={roles} drafts={drafts} />
            </div>
          </aside>
        </div>
      ) : null}

      <SectionCard
        title="Recommendations for this account"
        description="Compare suggestions for each role and pin candidates for the next optimization."
        id="recommendations"
      >
        {recommendations.loading ? (
          <p role="status" className="text-ink-muted text-sm">
            Loading recommendations…
          </p>
        ) : null}
        {recommendations.error ? (
          <p className="text-ink-muted text-sm">
            {recommendations.error}{" "}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setRecommendationRevision(recommendationRevision + 1)}
            >
              Retry recommendations
            </Button>
          </p>
        ) : null}
        {recommendationPlan ? (
          <Recommendations plan={recommendationPlan} addCandidate={addCandidate} />
        ) : null}
      </SectionCard>
      <SectionCard title="Explore role rankings" id="rankings">
        <RoleRankings roles={roles} relay={relay} addCandidate={addCandidate} />
      </SectionCard>
    </>
  );
}
