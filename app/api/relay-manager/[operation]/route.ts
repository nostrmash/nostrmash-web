import type { NextRequest } from "next/server";

import { getProfile } from "@/lib/api/endpoints/profiles";
import { ApiError, fetchApiJson } from "@/lib/api/http";
import {
  optimizeRequestSchema,
  presetSchema,
  pubkeySchema,
  rankedRole,
  verifyRequestSchema,
} from "@/lib/api/schemas/relay-manager";
import { isCrossSiteRequest } from "@/lib/security/request";

type Context = { params: Promise<{ operation: string }> };
const noStore = { "Cache-Control": "no-store", "CDN-Cache-Control": "no-store" };
const maxBodyBytes = 64 * 1024;

function errorResponse(status: number, code: string, retryAfter?: string) {
  return Response.json(
    { error: { code } },
    {
      status,
      headers: { ...noStore, ...(retryAfter ? { "Retry-After": retryAfter } : {}) },
    }
  );
}

function upstreamError(error: unknown) {
  if (error instanceof ApiError && error.status >= 400 && error.status <= 599) {
    return errorResponse(error.status, error.code ?? "upstream_error", error.retryAfter);
  }
  return errorResponse(502, "upstream_error");
}

export async function GET(request: NextRequest, { params }: Context) {
  const { operation } = await params;
  const query = request.nextUrl.searchParams;
  const signal = request.signal;
  let path: string;
  let upstreamQuery: Record<string, string | number | undefined> | undefined;
  switch (operation) {
    case "roles":
      path = "/api/v1/relays/roles";
      break;
    case "rankings": {
      const role = rankedRole.safeParse(query.get("role"));
      if (!role.success) return errorResponse(400, "invalid_request");
      path = "/api/v1/relays/rankings";
      upstreamQuery = { role: role.data, limit: 16 };
      break;
    }
    case "capabilities": {
      const relay_url = query.get("relay_url");
      if (!relay_url || relay_url.length > 2048 || !/^(wss?|https?):\/\//i.test(relay_url)) {
        return errorResponse(400, "invalid_request");
      }
      path = "/api/v1/relays/capabilities";
      upstreamQuery = { relay_url };
      break;
    }
    case "config":
    case "diagnostics":
    case "recommendations":
    case "profile": {
      const pubkey = pubkeySchema.safeParse(query.get("pubkey"));
      if (!pubkey.success) return errorResponse(400, "invalid_request");
      if (operation === "profile") {
        try {
          const profile = await getProfile(pubkey.data, "requestTime");
          return Response.json(profile, { headers: noStore });
        } catch (error) {
          return upstreamError(error);
        }
      }
      path = `/api/v1/profiles/${pubkey.data}/relay-${operation}`;
      if (operation === "recommendations") {
        const preset = presetSchema.safeParse(query.get("preset") ?? "balanced");
        if (!preset.success) return errorResponse(400, "invalid_request");
        upstreamQuery = { preset: preset.data };
      }
      break;
    }
    default:
      return errorResponse(404, "not_found");
  }
  try {
    const payload = await fetchApiJson(path, { query: upstreamQuery, init: { signal } });
    // The backend already bounds and caches the public GETs. Keep these
    // wrappers revalidatable on demand and out of the durable entity cache.
    return Response.json(payload, { headers: noStore });
  } catch (error) {
    return upstreamError(error);
  }
}

async function readJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return JSON.parse(body + decoder.decode());
      size += chunk.value.byteLength;
      if (size > maxBodyBytes) {
        await reader.cancel();
        throw new RangeError();
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export async function POST(request: NextRequest, { params }: Context) {
  const { operation } = await params;
  if (operation !== "optimize" && operation !== "verify") return errorResponse(404, "not_found");
  if (isCrossSiteRequest(request)) return errorResponse(403, "forbidden");
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return errorResponse(415, "invalid_request");
  }
  let input: unknown;
  try {
    input = await readJson(request);
  } catch (error) {
    return errorResponse(error instanceof RangeError ? 413 : 400, "invalid_request");
  }
  const parsed = (operation === "optimize" ? optimizeRequestSchema : verifyRequestSchema).safeParse(
    input
  );
  if (!parsed.success) return errorResponse(400, "invalid_request");
  try {
    const payload = await fetchApiJson(`/api/v1/relays/${operation}`, {
      sensitive: true,
      timeoutMs: 25_000,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
        signal: request.signal,
      },
    });
    return Response.json(payload, { headers: noStore });
  } catch (error) {
    return upstreamError(error);
  }
}
