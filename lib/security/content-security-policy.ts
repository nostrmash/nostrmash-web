/**
 * Per-request CSP. Next reads `nonce-…` from the request policy and stamps
 * framework scripts. Styles stay `unsafe-inline` because Tailwind sets style
 * attributes. `connect-src https:` is required for arbitrary Nostr media.
 * Localhost is a dev-server exception only.
 */
export function buildContentSecurityPolicy(options: {
  nonce: string;
  isEmbed: boolean;
  isDev: boolean;
}): string {
  const { nonce, isEmbed, isDev } = options;
  const connectSrc = [
    "'self'",
    "https:",
    // Relay Manager opens client-controlled Nostr sockets. CSP belongs to the
    // document and must also work when arriving through App Router navigation.
    "wss:",
    ...(isDev ? ["http://localhost:*", "http://127.0.0.1:*"] : []),
  ];

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    // blob: is the MediaSource URL hls.js assigns to the video element.
    "media-src 'self' blob: https:",
    "font-src 'self' data:",
    `connect-src ${connectSrc.join(" ")}`,
    // Privacy-enhanced YouTube embeds only — no X/Twitter frame hosts.
    "frame-src 'self' https://www.youtube-nocookie.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    isEmbed ? "frame-ancestors *" : "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}
