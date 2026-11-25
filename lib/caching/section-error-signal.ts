/**
 * Failed-section flag shared by the Next render and the Worker fetch handler.
 *
 * Those run in one isolate but not in one module instance: OpenNext bundles
 * the app separately from `cloudflare/worker.ts`. Module state would not be
 * visible on both sides. `globalThis` is.
 *
 * The id is a request header the Worker sets (`x-nm-cache-id`). Next's
 * `headers()` is read-only, so a server component cannot set a response
 * header; it records the id here while it renders. The Worker reads the flag
 * only after the body has finished, which is after that render.
 */

const REGISTRY_KEY = Symbol.for("nostrmash.sectionLoadErrors");
const TTL_MS = 60_000;
const MAX_ENTRIES = 2000;
const MAX_ID_LENGTH = 80;

type Registry = Map<string, number>;

function registry(): Registry {
  const target = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };
  const existing = target[REGISTRY_KEY];
  if (existing) return existing;
  const created: Registry = new Map();
  target[REGISTRY_KEY] = created;
  return created;
}

export const SECTION_ERROR_REQUEST_HEADER = "x-nm-cache-id";

export function markSectionError(requestId: string): void {
  if (requestId.length === 0 || requestId.length > MAX_ID_LENGTH) return;
  const map = registry();
  const now = Date.now();
  if (map.size > 200) {
    for (const [id, at] of map) {
      if (now - at > TTL_MS) map.delete(id);
    }
  }
  while (map.size >= MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  map.set(requestId, now);
}

/** True when this request rendered a failed section. Clears the flag. */
export function takeSectionError(requestId: string): boolean {
  const map = registry();
  const at = map.get(requestId);
  map.delete(requestId);
  return at !== undefined && Date.now() - at <= TTL_MS;
}
