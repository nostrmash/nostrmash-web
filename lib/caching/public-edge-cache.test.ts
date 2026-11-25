import { describe, expect, it } from "vitest";

import { SECTION_ERROR_REQUEST_HEADER, markSectionError } from "./section-error-signal";
import {
  ENTITY_EDGE_CACHE_CONTROL,
  PUBLIC_EDGE_CACHE_CONTROL,
  SECTION_ERROR_RESPONSE_HEADER,
  applyPublicEdgeCache,
  documentCacheRequest,
  publicEdgeCacheHeaders,
  respondWithPublicEdgeCache,
  type DocumentCache,
} from "./public-edge-cache";

const VIEWER = "f".repeat(64);

function response(status = 200, headers?: HeadersInit, body = "ok") {
  return new Response(body, { status, headers });
}

function createCache() {
  const store = new Map<string, Response>();
  const controls: Array<string | null> = [];
  const cache: DocumentCache = {
    async match(request) {
      const found = store.get(request.url);
      return found ? found.clone() : undefined;
    },
    async put(request, stored) {
      controls.push(stored.headers.get("Cache-Control"));
      store.set(request.url, stored.clone());
    },
  };
  return { cache, controls, size: () => store.size };
}

async function settle(
  result: Response | null,
  pending: Promise<unknown>[]
): Promise<{ response: Response | null; body: string }> {
  const bodyPromise = result?.text() ?? Promise.resolve("");
  const [, body] = await Promise.all([Promise.all(pending), bodyPromise]);
  return { response: result, body };
}

describe("publicEdgeCacheHeaders", () => {
  it("caches the stable public pages for 60 seconds", () => {
    const headers = publicEdgeCacheHeaders(new URL("https://nostrmash.com/relays"), response());
    expect(headers?.get("Cache-Control")).toBe(PUBLIC_EDGE_CACHE_CONTROL);
    expect(headers?.get("Vary")).toBe("RSC, Next-Router-Prefetch");
  });

  it("keeps the homepage from mixing language-cookie visitors with everyone else", () => {
    const headers = publicEdgeCacheHeaders(new URL("https://nostrmash.com/"), response());
    expect(headers?.get("Vary")).toContain("Cookie");
  });

  it("keeps varying rankings on the cookie after lang and viewer are in the query", () => {
    const ready = publicEdgeCacheHeaders(
      new URL(`https://nostrmash.com/?lang=de&viewer=${VIEWER}&window=7d`),
      response()
    );
    expect(ready?.get("Vary")).toContain("Cookie");
  });

  it("preserves an existing Vary list and drops router headers that are not cached", () => {
    const headers = publicEdgeCacheHeaders(
      new URL("https://nostrmash.com/methodology"),
      response(200, {
        Vary: "Accept-Encoding, Next-Router-State-Tree, Next-Router-Segment-Prefetch",
      })
    );
    expect(headers?.get("Vary")).toBe("Accept-Encoding, RSC, Next-Router-Prefetch");
  });

  it("caches rankings, stats, and search for 60 seconds", () => {
    for (const path of [
      "/trending/notes",
      "/discovery/profiles/rising",
      "/stats",
      "/stats/people",
      "/search",
    ]) {
      const headers = publicEdgeCacheHeaders(new URL(`https://nostrmash.com${path}`), response());
      expect(headers?.get("Cache-Control")).toBe(PUBLIC_EDGE_CACHE_CONTROL);
    }
  });

  it("keeps a ranking without its cookie param from being shared", () => {
    const trending = publicEdgeCacheHeaders(
      new URL("https://nostrmash.com/trending/notes"),
      response()
    );
    expect(trending?.get("Vary")).toContain("Cookie");

    const followed = publicEdgeCacheHeaders(
      new URL("https://nostrmash.com/discovery/profiles/followed"),
      response()
    );
    expect(followed?.get("Vary")).toContain("Cookie");

    const search = publicEdgeCacheHeaders(new URL("https://nostrmash.com/search"), response());
    expect(search?.get("Vary")).toContain("Cookie");
  });

  it("keeps a browser from reusing a ranking after its cookies change", () => {
    for (const path of [
      "/trending/notes?lang=de",
      `/trending/notes?lang=de&viewer=${VIEWER}`,
      `/discovery/profiles/followed?viewer=${VIEWER}`,
    ]) {
      const headers = publicEdgeCacheHeaders(new URL(`https://nostrmash.com${path}`), response());
      expect(headers?.get("Vary")).toContain("Cookie");
    }

    const search = publicEdgeCacheHeaders(
      new URL("https://nostrmash.com/search?q=nostr&lang=de"),
      response()
    );
    expect(search?.get("Vary")).not.toContain("Cookie");
  });

  it("caches entity pages longer and does not vary them on cookies", () => {
    for (const path of [
      "/notes/abc",
      "/profiles/abc",
      "/hashtags/nostr",
      "/hashtags/nostr/notes",
      "/domains/example.com",
      "/relays/relay.example",
    ]) {
      const headers = publicEdgeCacheHeaders(new URL(`https://nostrmash.com${path}`), response());
      expect(headers?.get("Cache-Control")).toBe(ENTITY_EDGE_CACHE_CONTROL);
      expect(headers?.get("Vary")).not.toContain("Cookie");
    }
  });

  it("keeps relay health on the short shared cache", () => {
    const headers = publicEdgeCacheHeaders(
      new URL("https://nostrmash.com/relays/health"),
      response()
    );
    expect(headers?.get("Cache-Control")).toBe(PUBLIC_EDGE_CACHE_CONTROL);
  });

  it("leaves personal pages, APIs, errors, and cookie-setting responses uncached", () => {
    expect(publicEdgeCacheHeaders(new URL("https://nostrmash.com/me"), response())).toBeNull();
    expect(
      publicEdgeCacheHeaders(new URL("https://nostrmash.com/api/link-preview"), response())
    ).toBeNull();
    expect(
      publicEdgeCacheHeaders(new URL("https://nostrmash.com/methodology"), response(500))
    ).toBeNull();
    expect(
      publicEdgeCacheHeaders(
        new URL("https://nostrmash.com/"),
        response(200, { "Set-Cookie": "nm_lang=de" })
      )
    ).toBeNull();
  });
});

describe("applyPublicEdgeCache", () => {
  it("does not read an entity body to decide the cache", async () => {
    let read = false;
    const body = new ReadableStream({
      pull(controller) {
        read = true;
        controller.enqueue(new TextEncoder().encode("Couldn’t load this section"));
        controller.close();
      },
    });
    const cached = applyPublicEdgeCache(
      new URL("https://nostrmash.com/hashtags/bitcoin/notes"),
      new Response(body, { status: 200 })
    );
    expect(read).toBe(false);
    expect(cached.headers.get("Cache-Control")).toBe(ENTITY_EDGE_CACHE_CONTROL);
    expect(await cached.text()).toContain("Couldn’t load this section");
  });

  it("keeps a failed section out of the cache when the response says so", () => {
    const cached = applyPublicEdgeCache(
      new URL("https://nostrmash.com/hashtags/bitcoin/notes"),
      new Response("ok", { status: 200, headers: { [SECTION_ERROR_RESPONSE_HEADER]: "1" } })
    );
    expect(cached.headers.get("Cache-Control")).toBe("private, no-store");
    expect(cached.headers.get(SECTION_ERROR_RESPONSE_HEADER)).toBeNull();
  });

  it("streams a ranking without reading the body for the error mark", async () => {
    const cached = applyPublicEdgeCache(
      new URL("https://nostrmash.com/"),
      new Response("Couldn’t load this section", { status: 200 })
    );
    expect(cached.headers.get("Cache-Control")).toBe(PUBLIC_EDGE_CACHE_CONTROL);
  });
});

describe("documentCacheRequest", () => {
  it("keys RSC and prefetch, and ignores the router state tree", () => {
    const html = documentCacheRequest(new Request("https://nostrmash.com/relays"));
    const rsc = documentCacheRequest(
      new Request("https://nostrmash.com/relays", {
        headers: {
          rsc: "1",
          "next-router-prefetch": "1",
          "next-router-state-tree": "%5B%22%22%5D",
          "next-router-segment-prefetch": "/relays",
        },
      })
    );
    const sameTree = documentCacheRequest(
      new Request("https://nostrmash.com/relays", {
        headers: { rsc: "1", "next-router-prefetch": "1", "next-router-state-tree": "other" },
      })
    );

    expect(html.url).not.toBe(rsc.url);
    expect(rsc.url).toBe(sameTree.url);
    expect(new URL(rsc.url).searchParams.get("__nm_rsc")).toBe("1");
    expect(new URL(rsc.url).searchParams.get("__nm_prefetch")).toBe("1");
    expect(rsc.url).not.toContain("state-tree");
  });

  it("does not put an unrelated cookie in the key", () => {
    const anonymous = documentCacheRequest(new Request("https://nostrmash.com/relays"));
    const other = documentCacheRequest(
      new Request("https://nostrmash.com/relays", { headers: { cookie: "session=a" } })
    );
    expect(anonymous.url).toBe(other.url);
  });

  it("separates a ranking whose 30-day option is hidden", () => {
    const open = documentCacheRequest(new Request("https://nostrmash.com/?window=7d"));
    const hidden = documentCacheRequest(
      new Request("https://nostrmash.com/?window=7d", { headers: { cookie: "nm_no_30d=1" } })
    );
    expect(open.url).not.toBe(hidden.url);
    expect(new URL(hidden.url).searchParams.get("__nm_no30d")).toBe("1");
  });
});

describe("respondWithPublicEdgeCache", () => {
  async function render(
    request: Request,
    origin: (request: Request) => Promise<Response>,
    options?: { maxCacheBytes?: number; cache?: DocumentCache | null }
  ) {
    const pending: Promise<unknown>[] = [];
    const bucket = options?.cache === undefined ? createCache() : null;
    const result = await respondWithPublicEdgeCache({
      request,
      cache: options?.cache === undefined ? bucket!.cache : options.cache,
      origin,
      waitUntil: (promise) => {
        pending.push(promise);
      },
      maxCacheBytes: options?.maxCacheBytes,
    });
    const settled = await settle(result, pending);
    return { ...settled, bucket };
  }

  it("serves a second request from the cache", async () => {
    let renders = 0;
    const origin = () => {
      renders += 1;
      return Promise.resolve(new Response("home"));
    };
    const bucket = createCache();
    const first = await render(new Request("https://nostrmash.com/relays"), origin, {
      cache: bucket.cache,
    });
    const second = await render(new Request("https://nostrmash.com/relays"), origin, {
      cache: bucket.cache,
    });

    expect(renders).toBe(1);
    expect(first.body).toBe("home");
    expect(second.body).toBe("home");
    expect(first.response?.headers.get("Cache-Control")).toBe(PUBLIC_EDGE_CACHE_CONTROL);
    expect(second.response?.headers.get("Cache-Control")).toBe(PUBLIC_EDGE_CACHE_CONTROL);
  });

  it("strips the state tree before render and shares that document", async () => {
    let seen: Request | undefined;
    const { bucket } = await render(
      new Request("https://nostrmash.com/methodology", {
        headers: { rsc: "1", "next-router-state-tree": "a", "next-router-segment-prefetch": "b" },
      }),
      (request) => {
        seen = request;
        return Promise.resolve(new Response("full"));
      }
    );

    expect(seen?.headers.get("next-router-state-tree")).toBeNull();
    expect(seen?.headers.get("next-router-segment-prefetch")).toBeNull();
    expect(seen?.headers.get("rsc")).toBe("1");
    expect(seen?.headers.get(SECTION_ERROR_REQUEST_HEADER)).toBeTruthy();
    expect(bucket?.size()).toBe(1);
  });

  it("does not store an entity page that failed a section", async () => {
    const { response, body, bucket } = await render(
      new Request("https://nostrmash.com/hashtags/bitcoin/notes"),
      (request) => {
        markSectionError(request.headers.get(SECTION_ERROR_REQUEST_HEADER) ?? "");
        return Promise.resolve(new Response("Couldn’t load this section"));
      }
    );

    expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
    expect(body).toContain("Couldn’t load this section");
    expect(bucket?.size()).toBe(0);
  });

  it("stores a clean entity page for the edge and does not pin it on the first browser", async () => {
    const { response, bucket } = await render(new Request("https://nostrmash.com/notes/abc"), () =>
      Promise.resolve(new Response("<article>note</article>"))
    );

    expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
    expect(bucket?.controls).toEqual([ENTITY_EDGE_CACHE_CONTROL]);
  });

  it("still stores a shared page when a section failed", async () => {
    const { response, bucket } = await render(new Request("https://nostrmash.com/"), (request) => {
      markSectionError(request.headers.get(SECTION_ERROR_REQUEST_HEADER) ?? "");
      return Promise.resolve(new Response("Couldn’t load this section"));
    });

    expect(response?.headers.get("Cache-Control")).toBe(PUBLIC_EDGE_CACHE_CONTROL);
    expect(bucket?.size()).toBe(1);
  });

  it("skips the cache when a language or viewer cookie would redirect", async () => {
    let renders = 0;
    const origin = () => {
      renders += 1;
      return Promise.resolve(new Response("nope"));
    };

    const home = await render(
      new Request("https://nostrmash.com/", { headers: { cookie: "nm_lang=de" } }),
      origin
    );
    const withViewer = await render(
      new Request("https://nostrmash.com/?lang=de", { headers: { cookie: `nm_viewer=${VIEWER}` } }),
      origin
    );
    const search = await render(
      new Request("https://nostrmash.com/search", { headers: { cookie: "other=1; nm_lang=de" } }),
      origin
    );
    const followed = await render(
      new Request("https://nostrmash.com/discovery/profiles/followed", {
        headers: { cookie: `nm_viewer=${VIEWER}` },
      }),
      origin
    );

    expect(home.response).toBeNull();
    expect(withViewer.response).toBeNull();
    expect(search.response).toBeNull();
    expect(followed.response).toBeNull();
    expect(renders).toBe(0);
  });

  it("shares the document across unrelated cookies", async () => {
    let renders = 0;
    const origin = () => {
      renders += 1;
      return Promise.resolve(new Response("shared"));
    };
    const bucket = createCache();
    await render(
      new Request("https://nostrmash.com/relays", { headers: { cookie: "session=a" } }),
      origin,
      { cache: bucket.cache }
    );
    await render(
      new Request("https://nostrmash.com/relays", { headers: { cookie: "session=b" } }),
      origin,
      { cache: bucket.cache }
    );
    const allLanguages = await render(
      new Request("https://nostrmash.com/", { headers: { cookie: "nm_lang=all" } }),
      origin,
      { cache: bucket.cache }
    );

    expect(renders).toBe(2);
    expect(allLanguages.response).not.toBeNull();
  });

  it("does not store an oversized entity body", async () => {
    const { body, bucket } = await render(
      new Request("https://nostrmash.com/profiles/abc"),
      () => Promise.resolve(new Response("0123456789")),
      { maxCacheBytes: 4 }
    );
    expect(body).toBe("0123456789");
    expect(bucket?.size()).toBe(0);
  });

  it("follows a saved discovery window instead of serving the default ranking", async () => {
    let renders = 0;
    const origin = () => {
      renders += 1;
      return Promise.resolve(new Response("ranking"));
    };
    const saved = await render(
      new Request("https://nostrmash.com/", { headers: { cookie: "nm_win=7d" } }),
      origin
    );
    const rejectedMonth = await render(
      new Request("https://nostrmash.com/?window=30d", { headers: { cookie: "nm_no_30d=1" } }),
      origin
    );
    const uncertain = await render(
      new Request("https://nostrmash.com/", {
        headers: { cookie: "nm_win=30d; nm_no_30d=1" },
      }),
      origin
    );

    expect(saved.response).toBeNull();
    expect(rejectedMonth.response).toBeNull();
    expect(uncertain.response).toBeNull();
    expect(renders).toBe(0);
  });

  it("shares an explicit window across the cookie that only remembers it", async () => {
    let renders = 0;
    const origin = () => {
      renders += 1;
      return Promise.resolve(new Response("week"));
    };
    const bucket = createCache();
    await render(
      new Request("https://nostrmash.com/?window=7d", { headers: { cookie: "nm_win=7d" } }),
      origin,
      { cache: bucket.cache }
    );
    const second = await render(new Request("https://nostrmash.com/?window=7d"), origin, {
      cache: bucket.cache,
    });

    expect(renders).toBe(1);
    expect(second.body).toBe("week");
  });

  it("leaves video previews, personal pages, and other methods to the caller", async () => {
    let renders = 0;
    const origin = () => {
      renders += 1;
      return Promise.resolve(new Response("x"));
    };
    expect(
      (await render(new Request("https://nostrmash.com/video-frame"), origin)).response
    ).toBeNull();
    expect((await render(new Request("https://nostrmash.com/me"), origin)).response).toBeNull();
    expect(
      (await render(new Request("https://nostrmash.com/", { method: "POST" }), origin)).response
    ).toBeNull();
    expect(renders).toBe(0);
  });
});
