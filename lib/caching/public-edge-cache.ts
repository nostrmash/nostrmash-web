import {
  DISCOVERY_30D_HIDDEN_COOKIE,
  DISCOVERY_LAST_WINDOW_COOKIE,
  DISCOVERY_WINDOW_PREFERENCE_COOKIE,
  discoveryWindowPreferenceHref,
} from "@/lib/discover/discovery-window-session";
import { takeSectionError, SECTION_ERROR_REQUEST_HEADER } from "@/lib/caching/section-error-signal";
import { RANKING_PATHS, VIEWER_ONLY_PATHS } from "@/lib/routing/ranking-paths";
import { LANGUAGE_COOKIE, resolveLanguagePreference } from "@/lib/search-params/language";
import type { RouteSearchParams } from "@/lib/search-params/pagination";
import { resolveRankingPreference } from "@/lib/search-params/ranking-decision";
import { VIEWER_COOKIE, resolveViewerPreference } from "@/lib/search-params/viewer";
import { isStatsWindow, readStatsWindow } from "@/lib/search-params/window";

/**
 * Public documents, cached inside the Worker with `caches.default`.
 *
 * Workers Caching stays off (`wrangler.jsonc`). While it is on, every request
 * is billed — static assets and cache hits included — and a path cannot be
 * excluded. Assets are free only when it is off. A hit here still invokes the
 * Worker (one request, almost no CPU) and skips the render.
 *
 * Shared pages stay fresh for 60s, matching the homepage revalidate. Entity
 * pages can be a few minutes stale at the edge; browsers only keep them for
 * the shorter max-age. `caches.default` does not refresh in the background, so
 * these headers use a real freshness lifetime and no stale-while-revalidate.
 * s-maxage would also disable that directive if Workers Caching were turned
 * back on.
 */

const SHARED_EXACT_PATHS = new Set([
  ...RANKING_PATHS,
  "/relays",
  "/relays/health",
  "/relays/popular",
  "/methodology",
  "/stats",
  "/search",
]);

const ENTITY_PREFIXES = ["/notes/", "/profiles/", "/hashtags/", "/domains/", "/relays/"];

/** Browser and edge share 60s. A longer edge TTL would outlive the page data. */
export const PUBLIC_EDGE_CACHE_CONTROL = "public, max-age=60, s-maxage=60";

/**
 * Edge keeps an entity for 10 minutes. Browsers recheck after a minute, so a
 * bad first paint is not stuck on the device for the whole edge lifetime.
 */
export const ENTITY_EDGE_CACHE_CONTROL = "public, max-age=60, s-maxage=600";

/**
 * The live entity response, before we know the body rendered cleanly.
 * The stored copy uses {@link ENTITY_EDGE_CACHE_CONTROL} only when it did.
 * A failed section must not be pinned for later visitors.
 */
const LIVE_ENTITY_CACHE_CONTROL = "private, no-store";

/** Set on the origin response to skip the document cache without reading the body. */
export const SECTION_ERROR_RESPONSE_HEADER = "x-nm-section-error";

/**
 * Next document and RSC requests share a URL. `RSC` and `Next-Router-Prefetch`
 * change the payload. `Next-Router-State-Tree` does not: omitting it returns a
 * full RSC payload, so it is not part of the key. Neither is
 * `Next-Router-Segment-Prefetch` (the Worker strips it and the server falls
 * back to a broader prefetch that can be shared).
 */
const DOCUMENT_VARY = ["RSC", "Next-Router-Prefetch"];

const VARY_DROPPED = new Set(["next-router-state-tree", "next-router-segment-prefetch"]);

/** Above this, the document is streamed to the visitor and not stored. */
const DEFAULT_MAX_CACHE_BYTES = 2_000_000;

const ROUTER_HEADERS_STRIPPED = ["next-router-state-tree", "next-router-segment-prefetch"];

export type DocumentCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

function cacheControlFor(pathname: string): string | null {
  if (SHARED_EXACT_PATHS.has(pathname) || pathname.startsWith("/stats/")) {
    return PUBLIC_EDGE_CACHE_CONTROL;
  }
  if (ENTITY_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return ENTITY_EDGE_CACHE_CONTROL;
  }
  return null;
}

/**
 * A cookie can still change this response: language, viewer, or the hidden
 * 30-day window. The edge cache does not vary on the raw Cookie header —
 * unrelated cookies would never hit. Requests that would redirect miss the
 * cache and fall through. Vary stays on the response so a browser does not
 * reuse the document after one of those cookies appears.
 */
function variesOnCookie(url: URL): boolean {
  if (RANKING_PATHS.has(url.pathname)) return true;
  if (url.pathname === "/search") return !url.searchParams.has("lang");
  return false;
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

function routeParams(url: URL): RouteSearchParams {
  const params: RouteSearchParams = {};
  url.searchParams.forEach((value, key) => {
    params[key] = value;
  });
  return params;
}

/**
 * Saved 7d/30d, or a rejected 30d, would send this ranking somewhere else.
 * `nm_window` is missing and the last range can still come from Referer, so
 * that case is not cached.
 */
function wouldRedirectDiscoveryWindow(url: URL, cookieHeader: string | null): boolean {
  if (!RANKING_PATHS.has(url.pathname)) return false;
  const params = routeParams(url);
  const preference = readCookie(cookieHeader, DISCOVERY_WINDOW_PREFERENCE_COOKIE);
  const monthHidden = readCookie(cookieHeader, DISCOVERY_30D_HIDDEN_COOKIE) === "1";
  const savedPrevious = readCookie(cookieHeader, DISCOVERY_LAST_WINDOW_COOKIE);
  const previous = savedPrevious === "7d" ? "7d" : "24h";
  const windowParam = params.window;
  const explicitWindow = isStatsWindow(typeof windowParam === "string" ? windowParam : undefined);

  if (
    preference === "30d" &&
    monthHidden &&
    !explicitWindow &&
    savedPrevious !== "24h" &&
    savedPrevious !== "7d"
  ) {
    return true;
  }

  if (discoveryWindowPreferenceHref(url.pathname, params, preference, monthHidden, previous)) {
    return true;
  }
  return readStatsWindow(params) === "30d" && monthHidden;
}

/**
 * True when middleware or the page would redirect this URL onto `lang` /
 * `viewer`. Serving a cached 200 here would skip that redirect.
 */
function wouldRedirectPersonalized(url: URL, cookieHeader: string | null): boolean {
  const path = url.pathname;
  if (!RANKING_PATHS.has(path) && path !== "/search") return false;
  const params = routeParams(url);
  const lang = readCookie(cookieHeader, LANGUAGE_COOKIE);
  const viewer = readCookie(cookieHeader, VIEWER_COOKIE);
  if (path === "/search") {
    return resolveLanguagePreference(path, params, lang).redirectTo !== undefined;
  }
  if (VIEWER_ONLY_PATHS.has(path)) {
    return resolveViewerPreference(path, params, viewer).redirectTo !== undefined;
  }
  return resolveRankingPreference(path, params, lang, viewer).redirectTo !== undefined;
}

export function publicEdgeCacheHeaders(url: URL, response: Response): Headers | null {
  const cacheControl = cacheControlFor(url.pathname);
  if (!cacheControl) return null;
  if (response.status !== 200) return null;
  // A Set-Cookie response is not safe to reuse.
  if (response.headers.has("set-cookie")) return null;

  const headers = new Headers(response.headers);
  headers.set("Cache-Control", cacheControl);

  const vary = new Set(
    (headers.get("Vary") ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && !VARY_DROPPED.has(part.toLowerCase()))
  );
  for (const name of DOCUMENT_VARY) vary.add(name);
  if (variesOnCookie(url)) vary.add("Cookie");
  headers.set("Vary", [...vary].join(", "));
  return headers;
}

/**
 * Apply document cache headers. Does not read the body.
 * A failed section is signaled with {@link SECTION_ERROR_RESPONSE_HEADER}
 * or, from a server component, via {@link takeSectionError}.
 */
export function applyPublicEdgeCache(url: URL, response: Response): Response {
  const headers = publicEdgeCacheHeaders(url, response);
  if (!headers) return response;

  const sectionFailed = response.headers.get(SECTION_ERROR_RESPONSE_HEADER) === "1";
  headers.delete(SECTION_ERROR_RESPONSE_HEADER);
  if (sectionFailed) headers.set("Cache-Control", "private, no-store");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Cache key for one document variant. The state tree is intentionally absent. */
export function documentCacheRequest(request: Request): Request {
  const url = new URL(request.url);
  url.hash = "";
  url.searchParams.set("__nm_rsc", request.headers.get("rsc") ?? "");
  url.searchParams.set("__nm_prefetch", request.headers.get("next-router-prefetch") ?? "");
  const nextUrl = request.headers.get("next-url");
  if (nextUrl) url.searchParams.set("__nm_nexturl", nextUrl);
  // The selector hides 30d after the index rejects it. Same URL, different HTML.
  if (
    RANKING_PATHS.has(url.pathname) &&
    readCookie(request.headers.get("cookie"), DISCOVERY_30D_HIDDEN_COOKIE) === "1"
  ) {
    url.searchParams.set("__nm_no30d", "1");
  }
  return new Request(url.toString(), { method: "GET" });
}

function originRequest(request: Request, requestId: string): Request {
  const headers = new Headers(request.headers);
  for (const name of ROUTER_HEADERS_STRIPPED) headers.delete(name);
  headers.set(SECTION_ERROR_REQUEST_HEADER, requestId);
  return new Request(request, { headers });
}

function isStoredDocument(response: Response): boolean {
  const cacheControl = response.headers.get("Cache-Control");
  return cacheControl === PUBLIC_EDGE_CACHE_CONTROL || cacheControl === ENTITY_EDGE_CACHE_CONTROL;
}

async function readBody(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let oversize = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || oversize) continue;
      if (total + value.byteLength > maxBytes) {
        oversize = true;
        chunks.length = 0;
        continue;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (oversize) return null;
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function storeDocument(
  cache: DocumentCache,
  key: Request,
  headers: Headers,
  statusText: string,
  bytes: Uint8Array
): Promise<void> {
  const stored = new Headers(headers);
  stored.delete("transfer-encoding");
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  stored.set("content-length", String(payload.byteLength));
  await cache.put(
    key,
    new Response(payload, {
      status: 200,
      statusText,
      headers: stored,
    })
  );
}

/**
 * Serve a public GET from the document cache, or render and store it.
 * Returns null when this request must hit the origin through the normal
 * Worker path (personal redirect, video preview, non-document, non-GET).
 */
export async function respondWithPublicEdgeCache(input: {
  request: Request;
  cache: DocumentCache | null;
  origin: (request: Request) => Promise<Response>;
  waitUntil: (promise: Promise<unknown>) => void;
  maxCacheBytes?: number;
}): Promise<Response | null> {
  const { request, cache, origin, waitUntil } = input;
  if (request.method !== "GET") return null;
  const url = new URL(request.url);
  if (url.pathname === "/video-frame") return null;
  if (!cacheControlFor(url.pathname)) return null;
  const cookieHeader = request.headers.get("cookie");
  if (
    wouldRedirectPersonalized(url, cookieHeader) ||
    wouldRedirectDiscoveryWindow(url, cookieHeader)
  ) {
    return null;
  }

  const key = documentCacheRequest(request);
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch {
      // The page still renders. A cache read is not required to answer.
    }
  }

  const requestId = crypto.randomUUID();
  let originResponse: Response;
  try {
    originResponse = await origin(originRequest(request, requestId));
  } catch (error) {
    takeSectionError(requestId);
    throw error;
  }

  const prepared = applyPublicEdgeCache(url, originResponse);
  if (!cache || !isStoredDocument(prepared)) return prepared;

  const maxCacheBytes = input.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
  const entity = prepared.headers.get("Cache-Control") === ENTITY_EDGE_CACHE_CONTROL;
  const clientHeaders = new Headers(prepared.headers);
  if (entity) clientHeaders.set("Cache-Control", LIVE_ENTITY_CACHE_CONTROL);

  const remember = (bytes: Uint8Array | null) =>
    storeIfClean(cache, key, prepared.headers, prepared.statusText, bytes, requestId, entity);

  if (!prepared.body) {
    waitUntil(remember(new Uint8Array()).catch(() => undefined));
    return new Response(null, {
      status: prepared.status,
      statusText: prepared.statusText,
      headers: clientHeaders,
    });
  }

  const [clientBody, cacheBody] = prepared.body.tee();
  waitUntil(
    readBody(cacheBody, maxCacheBytes)
      .then((bytes) => remember(bytes))
      .catch(() => {
        takeSectionError(requestId);
      })
  );

  return new Response(clientBody, {
    status: prepared.status,
    statusText: prepared.statusText,
    headers: clientHeaders,
  });
}

async function storeIfClean(
  cache: DocumentCache,
  key: Request,
  headers: Headers,
  statusText: string,
  bytes: Uint8Array | null,
  requestId: string,
  entity: boolean
): Promise<void> {
  const failed = takeSectionError(requestId);
  if (!bytes || (entity && failed)) return;
  await storeDocument(cache, key, headers, statusText, bytes);
}
