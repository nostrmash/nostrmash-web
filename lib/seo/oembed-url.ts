const MAX_EVENT_ID_LENGTH = 2_000;

function isOembedHost(hostname: string, siteHost: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const site = siteHost.toLowerCase().replace(/\.$/, "");
  if (host === site || host === "localhost" || host === "127.0.0.1") return true;
  return host.endsWith(`.${site}`);
}

/** Note id from an oEmbed `url`, or null when the host is not this site. */
export function noteIdFromOembedUrl(raw: string, siteUrl: string): string | null {
  let url: URL;
  let site: URL;
  try {
    url = new URL(raw);
    site = new URL(siteUrl);
  } catch {
    return null;
  }
  if (!isOembedHost(url.hostname, site.hostname)) return null;
  const match = url.pathname.match(/^\/notes\/([^/]+)\/?$/);
  const eventId = match?.[1];
  if (!eventId || eventId.length > MAX_EVENT_ID_LENGTH) return null;
  try {
    return decodeURIComponent(eventId);
  } catch {
    return null;
  }
}
