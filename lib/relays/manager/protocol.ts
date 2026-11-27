import { schnorr } from "@noble/curves/secp256k1";

import {
  signedEventSchema,
  type SignedEvent,
  type UnsignedEvent,
} from "@/lib/api/schemas/relay-manager";
import { secureSocketUrl } from "./identity";

export function eventPayload(event: UnsignedEvent) {
  return JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
}

export async function validateSignedEvent(value: unknown): Promise<SignedEvent | undefined> {
  const parsed = signedEventSchema.safeParse(value);
  if (!parsed.success) return;
  const event = parsed.data;
  const bytes = new TextEncoder().encode(eventPayload(event));
  if (bytes.byteLength > 64 * 1024) return;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const id = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (event.id !== id || !schnorr.verify(event.sig, hash, event.pubkey)) return;
  return event;
}

export function compareEvents(first: SignedEvent, second: SignedEvent): number {
  if (first.created_at !== second.created_at) return second.created_at - first.created_at;
  return first.id < second.id ? -1 : first.id > second.id ? 1 : 0;
}

function connect<T>(
  url: string,
  signal: AbortSignal,
  fallback: (outcome: "timeout" | "connection_failure" | "unknown") => T,
  onOpen: (socket: WebSocket) => void,
  onFrame: (frame: unknown[], finish: (result: T) => void) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const endpoint = secureSocketUrl(url);
    let socket: WebSocket;
    try {
      if (!endpoint) throw new Error("Invalid destination");
      socket = new WebSocket(endpoint);
    } catch {
      resolve(fallback("connection_failure"));
      return;
    }
    let frames = 0;
    let bytes = 0;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
    };
    const finish = (result: T) => {
      cleanup();
      resolve(result);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const timer = setTimeout(() => finish(fallback("timeout")), 5_000);
    signal.addEventListener("abort", abort, { once: true });
    socket.onopen = () => {
      try {
        onOpen(socket);
      } catch {
        finish(fallback("connection_failure"));
      }
    };
    socket.onerror = () => finish(fallback("connection_failure"));
    socket.onclose = () => finish(fallback("unknown"));
    socket.onmessage = (message: MessageEvent<unknown>) => {
      if (typeof message.data !== "string") return finish(fallback("unknown"));
      bytes += message.data.length;
      if (++frames > 155 || message.data.length > 64 * 1024 || bytes > 512 * 1024) {
        return finish(fallback("unknown"));
      }
      try {
        const frame: unknown = JSON.parse(message.data);
        if (Array.isArray(frame)) onFrame(frame, finish);
      } catch {
        finish(fallback("unknown"));
      }
    };
  });
}

const sourceLimit = 4;
const deletionLimit = 80;
type SourceSample = { complete: boolean; events: unknown[] };

export async function readRelaySources(
  url: string,
  pubkey: string,
  kinds: number[],
  signal: AbortSignal
): Promise<{ complete: boolean; events: SignedEvent[] }> {
  const id = crypto.randomUUID();
  const allowed = new Set([5, ...kinds]);
  const raw: unknown[] = [];
  const sample = await connect<SourceSample>(
    url,
    signal,
    () => ({ complete: false, events: raw }),
    (socket) => {
      socket.send(
        JSON.stringify([
          "REQ",
          id,
          ...kinds.map((kind) => ({ authors: [pubkey], kinds: [kind], limit: sourceLimit })),
          { authors: [pubkey], kinds: [5], limit: deletionLimit },
        ])
      );
    },
    (frame, finish) => {
      if (frame[0] === "EVENT" && frame[1] === id) raw.push(frame[2]);
      if (frame[0] === "EOSE" && frame[1] === id && frame.length === 2) {
        finish({ complete: true, events: raw });
      }
      if ((frame[0] === "CLOSED" && frame[1] === id) || frame[0] === "AUTH") {
        finish({ complete: false, events: raw });
      }
    }
  );
  let complete = sample.complete;
  const events: SignedEvent[] = [];
  const seen = new Map<number, number>();
  const now = Math.floor(Date.now() / 1000);
  for (const rawEvent of sample.events) {
    const event = await validateSignedEvent(rawEvent);
    if (!event || event.pubkey !== pubkey || !allowed.has(event.kind) || event.created_at > now) {
      complete = false;
      // A valid future event can still win precedence. Abort the refresh if
      // any sampled relay knows about one, even when other relays finish.
      if (event?.pubkey === pubkey && allowed.has(event.kind) && event.created_at > now) {
        throw new Error(
          "A relay returned a future-dated configuration event. Try again after checking your clock."
        );
      }
      continue;
    }
    const total = (seen.get(event.kind) ?? 0) + 1;
    seen.set(event.kind, total);
    if (total >= (event.kind === 5 ? deletionLimit : sourceLimit)) complete = false;
    events.push(event);
  }
  signal.throwIfAborted();
  return { complete, events };
}

export type PublicationOutcome =
  | "accepted"
  | "rejected"
  | "authentication_required"
  | "access_restricted"
  | "timeout"
  | "connection_failure"
  | "unknown";
export type PublicationReceipt = { url: string; outcome: PublicationOutcome };

export function publishToRelay(event: SignedEvent, url: string, signal: AbortSignal) {
  return connect<PublicationReceipt>(
    url,
    signal,
    (outcome) => ({ url, outcome }),
    (socket) => socket.send(JSON.stringify(["EVENT", event])),
    (frame, finish) => {
      if (frame[0] === "AUTH" && typeof frame[1] === "string") {
        finish({ url, outcome: "authentication_required" });
      }
      if (frame[0] !== "OK" || frame[1] !== event.id || typeof frame[2] !== "boolean") return;
      const message = typeof frame[3] === "string" ? frame[3].toLowerCase() : "";
      const outcome = frame[2]
        ? "accepted"
        : message.startsWith("auth-required:")
          ? "authentication_required"
          : /^(payment-required|restricted):/.test(message)
            ? "access_restricted"
            : "rejected";
      finish({ url, outcome });
    }
  );
}
