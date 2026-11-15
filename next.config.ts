import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// Only needed for `next dev` bindings. Running during `next build` can crash
// local Miniflare/workerd (SQLite schema mismatch) and is unused in CI builds.
if (process.env.NODE_ENV === "development") {
  void initOpenNextCloudflareForDev();
}

if (process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_DEBUG_PANELS === "1") {
  console.warn(
    "[security] NEXT_PUBLIC_DEBUG_PANELS=1 exposes raw API payloads in this production build."
  );
}

// CSP (incl. per-request script nonce + embed frame-ancestors carve-out) is set
// in middleware.ts so Next can stamp nonces onto framework scripts during SSR.
const securityHeaders = [
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains; preload",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Browser source maps stay off. Sentry upload deletes the maps it generates.
  productionBrowserSourceMaps: false,
  // The dev server is opened at 127.0.0.1 while Next advertises localhost.
  allowedDevOrigins: ["127.0.0.1"],
  // @sentry/nextjs (node entry) pulls Orchestrion / APM packages that load
  // es-module-lexer's inline WASM. Cloudflare Workers reject WebAssembly.compile()
  // from buffers ("Wasm code generation disallowed by embedder"). Stub them —
  // they only exist for Node Module._compile instrumentation.
  serverExternalPackages: [
    "@apm-js-collab/code-transformer",
    "@apm-js-collab/code-transformer-bundler-plugins",
    "@apm-js-collab/tracing-hooks",
  ],
  turbopack: {
    resolveAlias: {
      "@apm-js-collab/code-transformer": "./stubs/empty-code-transformer.js",
      "@apm-js-collab/code-transformer-bundler-plugins":
        "./stubs/empty-code-transformer-bundler-plugins.js",
      "@apm-js-collab/tracing-hooks": "./stubs/empty-tracing-hooks.js",
    },
  },
  images: {
    // Remote avatars and media use unoptimized <Image> or the /img proxy.
    // A wildcard remotePatterns entry would make /_next/image fetch
    // attacker-chosen URLs. Redirects are disabled so a later allow-list
    // cannot be skipped by a 302.
    imageSizes: [96],
    maximumRedirects: 0,
    remotePatterns: [],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
  async redirects() {
    return [
      {
        source: "/relays/probe-health",
        destination: "/relays/health#connect",
        permanent: true,
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },
  // Disable automatic tunnel route; OpenNext/Workers handle routing themselves.
  tunnelRoute: undefined,
  // Works for Turbopack and webpack. The old `webpack.treeshake` option does not.
  bundleSizeOptimizations: {
    excludeDebugStatements: true,
  },
});
