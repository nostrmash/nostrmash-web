# Security Policy

## Supported versions

Security fixes ship on the latest `main` commit.

## Production surface

The public site is a Next.js app on Cloudflare Workers (OpenNext). It does not run the Vite dev server, Vite middleware, or `next dev`.

- Keep `global_fetch_strictly_public` in `wrangler.jsonc`. That flag stops Worker `fetch` from dialing private addresses.
- Do not set `NEXT_PUBLIC_DEBUG_PANELS=1` on a production build. It renders raw API payloads in the page.
- `NEXT_PUBLIC_SENTRY_DSN` is public by design. `SENTRY_AUTH_TOKEN` is a build secret and must not be prefixed with `NEXT_PUBLIC_`.
- Browser source maps are off. Sentry deletes the maps it uploads.

## Reporting a vulnerability

Do not open a public GitHub issue for an unfixed vulnerability.

- Message us on Nostr at `npub1ckqlguq0htvs3smwy8pl5uwmfas0h208p7p8hs92ghaurgkmzzrsw3vlh0`, or
- Open a [private GitHub security advisory](https://github.com/nostrmash/nostrmash-web/security/advisories/new)

Include a description, steps to reproduce, impact, and a suggested fix if you have one.

## Response

- Initial response within 2 business days
- Status update within 7 days
- Public disclosure after a fix is available

We will credit you in the advisory unless you ask to stay anonymous.
