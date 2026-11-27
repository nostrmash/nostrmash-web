import type { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import {
  capabilitiesSchema,
  configurationSchema,
  diagnosticsSchema,
  optimizationSchema,
  rankingsSchema,
  rolesSchema,
  verificationSchema,
  type OptimizeRequest,
  type RelayPreset,
  type VerifyRequest,
} from "@/lib/api/schemas/relay-manager";
import type { ApiErrorBody, Profile } from "@/lib/types/api";

const base = "/api/relay-manager";
type Query = Record<string, string>;

export function relayManagerError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "overloaded") return "The optimizer is busy. Try again shortly.";
    if (error.isRateLimited) return "Too many requests. Wait before trying again.";
    if (error.code === "feature_disabled") return "Relay intelligence is currently unavailable.";
    if (error.code === "invalid_response")
      return "The relay service returned an unexpected response.";
    if (error.code === "invalid_request")
      return "The relay service rejected these inputs. Check the constraints and try again.";
  }
  return "The relay service could not complete this request. Try again.";
}

function retryDelay(header: string | null): number {
  if (!header) return 1_000;
  const seconds = Number(header);
  return Number.isFinite(seconds)
    ? Math.max(seconds * 1_000, 0)
    : Math.max(Date.parse(header) - Date.now(), 0);
}

async function request<T>(
  operation: string,
  schema: z.ZodType<T>,
  signal: AbortSignal,
  query?: Query,
  body?: OptimizeRequest | VerifyRequest
): Promise<T> {
  const path = `${base}/${operation}${query ? `?${new URLSearchParams(query)}` : ""}`;
  const send = () =>
    fetch(path, {
      signal,
      cache: "no-store",
      ...(body
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });
  let response = await send();
  let payload: unknown = await response.json();
  const getError = () =>
    ApiError.fromResponse(
      response.status,
      response.statusText,
      operation,
      payload as ApiErrorBody | undefined,
      response.headers.get("x-request-id"),
      response.statusText,
      response.headers.get("retry-after") ?? undefined
    );
  // An overloaded optimizer never starts the refused work. Retrying other
  // failures automatically can duplicate expensive requests or extend a 429.
  if (operation === "optimize" && response.status === 503 && getError().code === "overloaded") {
    const delay = retryDelay(response.headers.get("retry-after"));
    if (delay <= 3_000) {
      await new Promise<void>((resolve, reject) => {
        signal.throwIfAborted();
        const cancel = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", cancel);
          resolve();
        }, delay);
        signal.addEventListener("abort", cancel, { once: true });
      });
      response = await send();
      payload = await response.json();
    }
  }
  if (!response.ok) throw getError();
  const parsed = schema.safeParse(payload);
  if (!parsed.success)
    throw new ApiError({
      status: 502,
      path: operation,
      code: "invalid_response",
      message: "Unexpected relay response",
    });
  return parsed.data;
}

export const relayManagerApi = {
  roles: (signal: AbortSignal) => request("roles", rolesSchema, signal),
  rankings: (role: string, signal: AbortSignal) =>
    request("rankings", rankingsSchema, signal, { role }),
  capabilities: (relay_url: string, signal: AbortSignal) =>
    request("capabilities", capabilitiesSchema, signal, { relay_url }),
  config: async (pubkey: string, signal: AbortSignal) => {
    const data = await request("config", configurationSchema, signal, { pubkey });
    if (data.account.pubkey !== pubkey)
      throw new Error("Relay configuration belongs to another account.");
    return { ...data, sources: data.sources ?? [] };
  },
  diagnostics: (pubkey: string, signal: AbortSignal) =>
    request("diagnostics", diagnosticsSchema, signal, { pubkey }),
  recommendations: (pubkey: string, preset: RelayPreset, signal: AbortSignal) =>
    request("recommendations", optimizationSchema, signal, { pubkey, preset }),
  optimize: (body: OptimizeRequest, signal: AbortSignal) =>
    request("optimize", optimizationSchema, signal, undefined, body),
  verify: (body: VerifyRequest, signal: AbortSignal) =>
    request("verify", verificationSchema, signal, undefined, body),
};

export async function getRelayManagerProfile(
  pubkey: string,
  signal: AbortSignal
): Promise<Profile | null> {
  const response = await fetch(`${base}/profile?pubkey=${pubkey}`, { signal });
  if (!response.ok) return null;
  const profile: Profile = await response.json();
  return profile?.pubkey === pubkey ? profile : null;
}
