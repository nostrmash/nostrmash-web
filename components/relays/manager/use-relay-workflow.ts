"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

import { ApiError } from "@/lib/api/errors";
import { relayManagerApi, relayManagerError } from "@/lib/api/endpoints/relay-manager";
import type {
  OptimizeRequest,
  RelayPlan,
  RelayVerification,
  SignedEvent,
} from "@/lib/api/schemas/relay-manager";
import { browserSigner, nip07Signer, type NostrSigner } from "@/lib/nostr/browser-signer";
import {
  assertSignerAccount,
  proposalEvents,
  proposalFingerprint,
  refreshSources,
  relayTargets,
  signingTemplates,
  signTemplates,
} from "@/lib/relays/manager/apply";
import { publishToRelay, type PublicationReceipt } from "@/lib/relays/manager/protocol";

export type ConnectedSigner = {
  pubkey: string;
  signer: NostrSigner;
  extension: ReturnType<typeof browserSigner>;
};

type Proposal = { plan: RelayPlan; input: OptimizeRequest; sources?: SignedEvent[] };
type Review = { proposal: Proposal; targets: string[]; signer: ConnectedSigner };
export type Published = {
  event: SignedEvent;
  receipts: PublicationReceipt[];
  verification?: RelayVerification;
  verificationError?: string;
};

function failure(error: unknown) {
  if (error instanceof ApiError) return relayManagerError(error);
  return error instanceof Error ? error.message : "The relay workflow could not be completed.";
}

export function useRelayWorkflow({
  pubkey,
  owner,
  workRef,
  reload,
  onSignerLost,
}: {
  pubkey: string;
  owner?: ConnectedSigner;
  workRef: RefObject<AbortController | undefined>;
  reload: () => void;
  onSignerLost: () => void;
}) {
  const [proposal, setProposal] = useState<Proposal>();
  const [review, setReview] = useState<Review>();
  const [published, setPublished] = useState<Published[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const ownedOperation = useRef<AbortController>(undefined);

  useLayoutEffect(
    () => () => {
      ownedOperation.current?.abort();
      if (workRef.current === ownedOperation.current) workRef.current = undefined;
      // A signer disconnect or switch also invalidates any pending signature.
    },
    [owner, workRef]
  );

  function invalidate() {
    setReview(undefined);
    setProposal(undefined);
    setNotice("");
    setError("");
  }

  function reportError(message: string) {
    setError(message);
  }

  async function run(label: string, action: (signal: AbortSignal) => Promise<void>) {
    if (workRef.current && !workRef.current.signal.aborted) return;
    const controller = new AbortController();
    ownedOperation.current = controller;
    workRef.current = controller;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await action(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) setError(failure(error));
    } finally {
      if (ownedOperation.current === controller) setBusy("");
      if (workRef.current === controller) workRef.current = undefined;
    }
  }

  async function optimize(input: OptimizeRequest) {
    invalidate();
    await run("Optimizing configuration…", async (signal) => {
      const plan = await relayManagerApi.optimize(input, signal);
      signal.throwIfAborted();
      if (plan.pubkey !== pubkey)
        throw new Error("The service returned a proposal for another account.");
      setProposal({ plan, input });
      setNotice("Optimization complete. Review the proposal below.");
    });
  }

  async function checkOwner(connected: ConnectedSigner, signal: AbortSignal) {
    if (!nip07Signer() || browserSigner() !== connected.extension) {
      onSignerLost();
      throw new Error("The browser signer disconnected. Connect it again to continue.");
    }
    try {
      await assertSignerAccount(connected.signer, pubkey, signal);
    } catch (error) {
      if (!signal.aborted) onSignerLost();
      throw error;
    }
  }

  async function fresh(proposed: Proposal, signal: AbortSignal) {
    const config = await relayManagerApi.config(pubkey, signal);
    const sources = await refreshSources(config, proposed.input, signal);
    const body = { ...proposed.input, source_events: sources };
    if (new TextEncoder().encode(JSON.stringify(body)).length > 64 * 1024) {
      throw new Error(
        "The complete signed sources and constraints exceed the optimizer’s request limit."
      );
    }
    const plan = await relayManagerApi.optimize(body, signal);
    signal.throwIfAborted();
    if (plan.pubkey !== pubkey)
      throw new Error("The service returned a proposal for another account.");
    return { sources, plan, input: proposed.input, config };
  }

  async function prepare() {
    if (!proposal || !owner) return;
    await run("Refreshing signed source events…", async (signal) => {
      await checkOwner(owner, signal);
      const updated = await fresh(proposal, signal);
      setProposal(updated);
      const targets = relayTargets(updated.config, updated.plan).publish;
      if (
        !proposalEvents(updated.plan).length &&
        updated.plan.proposal.proposal_safe &&
        updated.plan.constraints_satisfied
      ) {
        setNotice("The refreshed sources produced no publication-ready change.");
        return;
      }
      signingTemplates(updated.plan, updated.input, updated.sources);
      if (!targets.length) throw new Error("No suitable publication relay is available.");
      setReview({ proposal: updated, targets, signer: owner });
      setNotice(
        proposalFingerprint(updated.plan) === proposalFingerprint(proposal.plan)
          ? "Source refresh complete. Review the publication targets and confirm when ready."
          : "The refreshed sources changed the proposal. Review the updated comparison before confirming."
      );
    });
  }

  async function verify(entries: Published[], targets: string[], signal: AbortSignal) {
    const checked = await Promise.all(
      entries.map(async (entry): Promise<Published> => {
        try {
          const verification = await relayManagerApi.verify(
            { event: entry.event, relays: targets },
            signal
          );
          if (!verification.signature_valid || verification.event_id !== entry.event.id) {
            throw new Error("The verification response did not identify the signed event.");
          }
          return { ...entry, verification, verificationError: undefined };
        } catch (error) {
          signal.throwIfAborted();
          return { ...entry, verificationError: failure(error) };
        }
      })
    );
    signal.throwIfAborted();
    setPublished(checked);
    reload();
  }

  async function publish(entries: Published[], targets: string[], signal: AbortSignal) {
    const results = await Promise.all(
      entries.map(async (entry): Promise<Published> => {
        const existing = new Map(entry.receipts.map((result) => [result.url, result]));
        const outstanding = targets.filter((url) => existing.get(url)?.outcome !== "accepted");
        const receipts = await Promise.all(
          outstanding.map(async (url) => {
            const receipt = await publishToRelay(entry.event, url, signal);
            signal.throwIfAborted();
            setPublished((batch) =>
              batch.map((item) =>
                item.event.id === entry.event.id
                  ? {
                      ...item,
                      receipts: item.receipts.map((previous) =>
                        previous.url === receipt.url ? receipt : previous
                      ),
                    }
                  : item
              )
            );
            return receipt;
          })
        );
        for (const receipt of receipts) existing.set(receipt.url, receipt);
        return { event: entry.event, receipts: [...existing.values()] };
      })
    );
    signal.throwIfAborted();
    setPublished(results);
    setBusy("Checking sampled propagation…");
    await verify(results, targets, signal);
  }

  async function confirm() {
    if (!review || owner !== review.signer || published.length) return;
    setReview(undefined);
    await run("Rechecking source events before signing…", async (signal) => {
      await checkOwner(owner, signal);
      const updated = await fresh(review.proposal, signal);
      setProposal(updated);
      const targets = relayTargets(updated.config, updated.plan).publish;
      const same =
        proposalFingerprint(updated.plan) === proposalFingerprint(review.proposal.plan) &&
        JSON.stringify(targets) === JSON.stringify(review.targets);
      const templates = signingTemplates(updated.plan, updated.input, updated.sources);
      if (!same) {
        if (targets.length) setReview({ proposal: updated, targets, signer: owner });
        setNotice(
          "The proposal or publication targets changed. Review the updated plan and confirm it again."
        );
        return;
      }
      setBusy("Waiting for the browser signer…");
      const events = await signTemplates(owner.signer, templates, signal);
      // A human can leave the signer prompt open while another client writes.
      setBusy("Checking sources again before publication…");
      const afterSigning = await refreshSources(updated.config, updated.input, signal);
      if (
        JSON.stringify(afterSigning.map((e) => e.id)) !==
        JSON.stringify(updated.sources.map((e) => e.id))
      ) {
        throw new Error(
          "A source event changed while the signer was open. Refresh and review a new proposal."
        );
      }
      await checkOwner(owner, signal);
      if (events.some((event) => Math.floor(Date.now() / 1000) - event.created_at > 60)) {
        throw new Error(
          "The signed review expired during the final source check. Review the proposal again."
        );
      }
      const entries: Published[] = events.map((event) => ({
        event,
        receipts: targets.map((url) => ({ url, outcome: "unknown" })),
      }));
      // Keep the signed batch in memory before starting the first network send.
      setPublished(entries);
      setBusy("Publishing signed events…");
      await publish(entries, targets, signal);
    });
  }

  function publicationTargets() {
    return [...new Set(published.flatMap((entry) => entry.receipts.map((receipt) => receipt.url)))];
  }

  async function retryPublication() {
    if (!owner || !proposal || !published.length) return;
    const targets = publicationTargets();
    if (!targets.length) return;
    await run("Checking for conflicts before retrying…", async (signal) => {
      await checkOwner(owner, signal);
      const config = await relayManagerApi.config(pubkey, signal);
      const latest = await refreshSources(config, proposal.input, signal);
      const stillAllowed = relayTargets(config, proposal.plan).publish;
      if (targets.some((url) => !stillAllowed.includes(url))) {
        throw new Error("Publication targets changed. Refresh and review a new proposal.");
      }
      const conflicting = published.some(
        ({ event, verification }) =>
          verification?.relays?.some((row) => row.outcome === "conflict") ||
          latest.some(
            (current) =>
              current.kind === event.kind &&
              current.id !== event.id &&
              !proposalEvents(proposal.plan).some(
                (baseEvent) =>
                  baseEvent.kind === event.kind && baseEvent.based_on_event_id === current.id
              )
          )
      );
      if (conflicting)
        throw new Error(
          "A conflicting replacement was detected. Review the current configuration before publishing again."
        );
      await checkOwner(owner, signal);
      setBusy("Retrying the same signed events…");
      await publish(published, targets, signal);
    });
  }

  async function reverify() {
    const targets = publicationTargets();
    if (!published.length || !targets.length) return;
    await run("Checking sampled propagation…", (signal) => verify(published, targets, signal));
  }

  function closePublication() {
    setPublished([]);
    invalidate();
    reload();
  }

  return {
    proposal,
    review: review?.signer === owner ? review : undefined,
    published,
    busy,
    error,
    notice,
    optimize,
    prepare,
    confirm,
    retryPublication,
    reverify,
    closePublication,
    invalidate,
    reportError,
  };
}
