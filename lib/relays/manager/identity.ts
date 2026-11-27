import { decodeNip19 } from "@/lib/nostr/nip19";

export function accountKey(input: string): string | undefined {
  const value = input.trim().replace(/^nostr:/i, "");
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  // Accept only public NIP-19 representations, including profile pointers.
  if (!/^(npub|nprofile)1/i.test(value) || value.length > 2048) return;
  const parsed = decodeNip19(value);
  if (parsed?.type === "npub") return parsed.data;
  if (parsed?.type === "nprofile") return parsed.data.pubkey;
}

export function relayManagerHref(pubkey?: string, relay?: string) {
  const query = new URLSearchParams();
  if (pubkey) query.set("viewer", pubkey);
  const endpoint = relay ? normalizeRelayEndpoint(relay) : undefined;
  if (endpoint) query.set("relay", endpoint);
  return `/relays/manager${query.size ? `?${query}` : ""}`;
}

export function normalizeRelayEndpoint(value: string): string | undefined {
  const raw = value.trim();
  if (!/^wss?:\/\/[^/?#]+/i.test(raw) || /[\s?#\\]/.test(raw) || raw.length > 2048) return;
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password || raw.includes("@")) return;
    // Preserve the escaped path and explicit default ports as the API does.
    const authority = /^wss?:\/\/([^/]+)(.*)$/i.exec(raw);
    if (!authority?.[1] || authority[1].includes("%") || /%(?![0-9a-f]{2})/i.test(raw)) return;
    const path = authority[2];
    return `${parsed.protocol}//${authority[1].toLowerCase()}${path === "/" ? "" : path}`;
  } catch {
    return;
  }
}

export function secureSocketUrl(value: string): string | undefined {
  const endpoint = normalizeRelayEndpoint(value);
  if (!endpoint?.startsWith("wss://")) return;
  const host = new URL(endpoint).hostname.replace(/\.$/, "");
  // Only connect the browser to public DNS names over TLS. Exclude literal
  // addresses, private suffixes and names potentially resolved through mDNS.
  if (
    !/^(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*$/i.test(host) ||
    /\.(local|localhost|internal|lan|home|test|invalid|onion|arpa)$/i.test(host) ||
    host === "metadata.goog"
  )
    return;
  return endpoint;
}
