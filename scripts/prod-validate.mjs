#!/usr/bin/env node
/**
 * Post-deploy smoke checks against the live site.
 * Usage: node scripts/prod-validate.mjs [baseUrl]
 *
 * GitHub-hosted runners sit in datacenter IP space, so Cloudflare Bot Fight
 * Mode often 403s a subset of these requests. We send a dedicated UA, retry
 * 403/429 with backoff, and optionally attach `x-nostrmash-validate` when
 * PROD_VALIDATE_TOKEN is set (pair that with a WAF skip rule if flakes persist).
 */
import { createHash } from "node:crypto";

const baseUrl = (
  process.argv[2] ||
  process.env.PROD_VALIDATE_BASE_URL ||
  "https://nostrmash.com"
).replace(/\/$/, "");

const VALIDATE_TOKEN = process.env.PROD_VALIDATE_TOKEN ?? "";
const MAX_ATTEMPTS = 5;
const RETRYABLE = new Set([403, 429, 502, 503, 504]);

const failures = [];

function requestHeaders() {
  const headers = {
    Accept: "*/*",
    "User-Agent": "Mozilla/5.0 (compatible; NostrMash-ProdValidate/1.0; +https://nostrmash.com)",
  };
  if (VALIDATE_TOKEN) {
    headers["x-nostrmash-validate"] = VALIDATE_TOKEN;
  }
  return headers;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, init = {}) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(url, {
      ...init,
      headers: { ...requestHeaders(), ...(init.headers ?? {}) },
      redirect: "follow",
    });
    if (response.ok || !RETRYABLE.has(response.status) || attempt === MAX_ATTEMPTS) {
      return response;
    }
    lastError = response.status;
    await sleep(400 * 2 ** (attempt - 1));
  }
  throw new Error(`HTTP ${lastError}`);
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.error(`FAIL  ${name}: ${message}`);
  }
}

/** Summarize a failed response so CI logs show *why* (edge vs app, ray id). */
async function describeFailure(response) {
  const headers = ["cf-ray", "cf-mitigated", "server", "content-type"]
    .map((name) => {
      const value = response.headers.get(name);
      return value ? `${name}=${value}` : null;
    })
    .filter(Boolean)
    .join(" ");
  let body = "";
  try {
    body = (await response.text()).replace(/\s+/g, " ").slice(0, 200);
  } catch {
    // ignore unreadable bodies
  }
  return `HTTP ${response.status} [${headers}] body: ${body}`;
}

async function fetchText(path, expectedType) {
  const response = await fetchWithRetry(`${baseUrl}${path}`);
  if (!response.ok) {
    throw new Error(await describeFailure(response));
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (expectedType && !contentType.includes(expectedType)) {
    throw new Error(`expected content-type containing ${expectedType}, got ${contentType}`);
  }
  return { response, text: await response.text(), contentType };
}

await check("robots.txt", async () => {
  const { text } = await fetchText("/robots.txt", "text/plain");
  if (!/Sitemap:/i.test(text)) throw new Error("missing Sitemap directive");
});

await check("sitemap.xml", async () => {
  const { text } = await fetchText("/sitemap.xml", "xml");
  if (!text.includes("<urlset")) throw new Error("missing urlset");
});

await check("backend API reachable from datacenter clients", async () => {
  // The worker builds feeds by calling api.nostrmash.com from Cloudflare
  // datacenter IPs; feed readers and integrators hit it from server IPs too.
  // A bot-management challenge here breaks both, so probe it directly.
  const response = await fetchWithRetry(
    "https://api.nostrmash.com/api/v1/discovery/notes/trending?window=24h&limit=1"
  );
  if (!response.ok) throw new Error(await describeFailure(response));
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(`expected JSON, got ${contentType}`);
  }
});

await check("Relay Manager POST on the deployed Worker", async () => {
  const pubkey = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
  const created_at = Math.floor(Date.now() / 1000);
  const kind = 10002;
  const tags = [];
  const content = "";
  const id = createHash("sha256")
    .update(JSON.stringify([0, pubkey, created_at, kind, tags, content]))
    .digest("hex");
  // An invalid signature exercises the POST without dialing any relay.
  const response = await fetchWithRetry(`${baseUrl}/api/relay-manager/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event: { id, pubkey, created_at, kind, tags, content, sig: "0".repeat(128) },
      relays: ["wss://relay.damus.io"],
    }),
  });
  if (!response.ok) throw new Error(await describeFailure(response));
  if (!/\bno-store\b/i.test(response.headers.get("cache-control") ?? "")) {
    throw new Error("Relay verification response is missing no-store");
  }
  const result = await response.json();
  if (result.signature_valid !== false || result.sample_verified !== false) {
    throw new Error("Relay verification did not reject the invalid signature");
  }
});

await check("trending notes RSS", async () => {
  const { text, contentType } = await fetchText("/feeds/trending-notes.xml");
  if (!/rss|xml/i.test(contentType)) throw new Error(`unexpected type ${contentType}`);
  if (!text.includes("<rss") || !text.includes("<channel>")) {
    throw new Error("invalid RSS document");
  }
});

await check("oEmbed", async () => {
  const noteUrl = `${baseUrl}/notes/${"a".repeat(64)}`;
  const response = await fetchWithRetry(`${baseUrl}/api/oembed?url=${encodeURIComponent(noteUrl)}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json();
  if (json.type !== "rich") throw new Error(`unexpected type ${json.type}`);
  if (!String(json.html).includes("/embed/notes/")) throw new Error("missing embed iframe");
});

await check("home OG + JSON-LD", async () => {
  const { text } = await fetchText("/", "text/html");
  if (!/property=["']og:title["']/.test(text)) throw new Error("missing og:title");
  const match = text.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!match) throw new Error("missing JSON-LD script");
  const parsed = JSON.parse(match[1]);
  if (parsed["@type"] !== "WebSite") throw new Error(`unexpected @type ${parsed["@type"]}`);
});

await check("default opengraph-image", async () => {
  const response = await fetchWithRetry(`${baseUrl}/opengraph-image`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("image/")) {
    throw new Error(`expected image/*, got ${contentType}`);
  }
});

await check("CSP nonce on home", async () => {
  const response = await fetchWithRetry(`${baseUrl}/`);
  const csp = response.headers.get("content-security-policy") ?? "";
  if (!/script-src[^;]*'nonce-/.test(csp)) throw new Error("missing script nonce");
  if (/script-src[^;]*'unsafe-inline'/.test(csp)) {
    throw new Error("script-src still allows unsafe-inline");
  }
  if (/script-src[^;]*unsafe-eval/.test(csp)) {
    throw new Error("production script-src allows unsafe-eval");
  }
  if (/connect-src[^;]*localhost/.test(csp)) {
    throw new Error("production connect-src allows localhost");
  }
  if (response.headers.get("x-content-type-options") !== "nosniff") {
    throw new Error("missing nosniff");
  }
  if (response.headers.get("referrer-policy") !== "strict-origin-when-cross-origin") {
    throw new Error(`unexpected referrer policy: ${response.headers.get("referrer-policy")}`);
  }
});

if (failures.length > 0) {
  console.error(`\n${failures.length} prod-validate check(s) failed against ${baseUrl}`);
  if (failures.some((failure) => failure.includes("HTTP 403"))) {
    console.error(
      "HTTP 403 from GitHub-hosted runners is usually Cloudflare Bot Fight Mode. " +
        "Set repo secret PROD_VALIDATE_TOKEN and add a WAF skip for header " +
        "x-nostrmash-validate if retries are not enough."
    );
  }
  process.exit(1);
}

console.log(`\nAll prod-validate checks passed against ${baseUrl}`);
