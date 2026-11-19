# NostrMash Web

[![CI](https://github.com/nostrmash/nostrmash-web/actions/workflows/ci.yml/badge.svg)](https://github.com/nostrmash/nostrmash-web/actions/workflows/ci.yml)
[![License: Unlicense](https://img.shields.io/badge/license-Unlicense-blue)](LICENSE)

Public explorer for [NostrMash](https://nostrmash.com) ([repository](https://github.com/nostrmash/nostrmash)). Search notes and profiles, and browse trends, relays, and network stats. The site reads the NostrMash API and does not talk to relays itself.

NostrMash maintains several standalone Nostr developer utilities. They can be used independently of NostrMash Core. One of them is the [Nostr Read Gateway](https://github.com/nostrmash/nostr-read-gateway).

## Stack

- Next.js 16 App Router
- React 19
- TypeScript
- Tailwind CSS v4
- Cloudflare Workers deployment via OpenNext

## Routes

| Route                              | Purpose                               |
| ---------------------------------- | ------------------------------------- |
| `/`                                | Discovery home                        |
| `/search`                          | Search notes and profiles             |
| `/profiles/[pubkeyOrNpub]`         | Profile detail and activity           |
| `/notes/[eventId]`                 | Note detail and thread                |
| `/trending`                        | Trending hub                          |
| `/trending/notes`                  | Trending notes                        |
| `/trending/profiles`               | Trending profiles                     |
| `/trending/hashtags`               | Trending hashtags                     |
| `/trending/domains`                | Trending domains                      |
| `/trending/long-form`              | Trending articles                     |
| `/trending/pictures`               | Trending pictures                     |
| `/trending/videos`                 | Trending videos                       |
| `/trending/shorts`                 | Trending shorts                       |
| `/discovery/conversations/hot`     | Conversations, under Notes            |
| `/live`                            | Live activities, under Media          |
| `/discovery/profiles/rising`       | Rising profiles                       |
| `/hashtags/[hashtag]`              | Hashtag detail                        |
| `/hashtags/[hashtag]/notes`        | Notes for a hashtag                   |
| `/domains/[domain]`                | Domain detail                         |
| `/domains/[domain]/notes`          | Notes for a domain                    |
| `/relays`                          | Relay explorer                        |
| `/relays/[relayHost]`              | Relay detail                          |
| `/relays/health`                   | Relay health                          |
| `/relays/popular`                  | Popular relays                        |
| `/relays/probe-health`             | Redirects to `/relays/health#connect` |
| `/stats`                           | Network and content stats             |
| `/methodology`                     | How to interpret the index            |
| `/about`                           | About NostrMash                       |
| `/developers`                      | Developer introduction                |
| `/me`                              | Your view                             |
| `/day/[date]`                      | Notes for one day                     |
| `/badges/[address]`                | Badge detail                          |
| `/goals`                           | Goals                                 |
| `/polls`                           | Polls                                 |
| `/groups`                          | Groups                                |
| `/groups/[relayHost]/[...groupId]` | One group                             |
| `/curation-sets`                   | Curation sets                         |
| `/curation-sets/[address]`         | One curation set                      |
| `/embed/notes/[eventId]`           | Embeddable note                       |
| `/discovery/notes/bookmarked`      | Bookmarked notes                      |
| `/discovery/notes/zapped`          | Zapped notes                          |
| `/discovery/profiles/followed`     | Followed profiles                     |
| `/discovery/profiles/supported`    | Supported profiles                    |
| `/stats/activity`                  | Activity stats                        |
| `/stats/communities`               | Community stats                       |
| `/stats/moderation`                | Moderation stats                      |
| `/stats/people`                    | People stats                          |
| `/stats/relays`                    | Relay stats                           |
| `/stats/zaps`                      | Zap stats                             |

Primary nav: Discover, Network, Stats, and Your view (`/me`). Methodology is in the footer.

Route handlers, not pages: `/api/search/suggest`, `/api/discovery-window/unsupported`, `/api/oembed`, `/api/link-preview`, `/feeds/*.xml`, `/img`, and `/video-frame`.

Design notes that are not the operator guide: `docs/product-plan.md`, `docs/product-design.md`, and `docs/discover-art-directions.md`.

## API contract

The web app consumes the existing NostrMash public REST API (for example `/api/v1/search`, `/api/v1/profiles/{pubkey}`, `/api/v1/discovery/*`) and keeps business logic in the backend. It does not talk to Nostr relays directly.

Set your API base URL in `.env.local`:

```bash
cp .env.example .env.local
```

`.env.example` points at `http://localhost:8080`, which is a local [NostrMash](https://github.com/nostrmash/nostrmash) API (`make` / Docker in that repo). The production Worker var is `https://api.nostrmash.com`. `pnpm generate:api-types` reads `../nostrmash/docs/openapi.yaml`, so that checkout has to sit next to this one.

## Local development

Use Node.js 20.19+, 22.12+, or 23.2+ (CI uses 22) and pnpm 10.18.1. Enable Corepack, or install the pnpm version in `package.json` `packageManager`, so you do not mix lockfiles.

```bash
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

`pnpm install` without `--frozen-lockfile` is fine while you are changing dependencies. CI installs with `--frozen-lockfile`.

The dev server is Next.js (`pnpm dev`). Vite is only the Vitest runner. Production is the OpenNext Worker, not the Vite or Next dev server.

## Quality checks

```bash
pnpm validate
pnpm test
pnpm audit:deps
pnpm build
```

`pnpm validate` runs format check, lint, and typecheck. `pnpm audit:deps` prints every advisory and fails on ones that are not listed, with a reason, in `security/accepted-advisories.json`.

## Cloudflare deployment

OpenNext and Wrangler config live in:

- `open-next.config.ts`
- `wrangler.jsonc`

Useful scripts:

```bash
pnpm cf:build
pnpm cf:preview
pnpm cf:deploy
```

`pnpm cf:deploy` is `wrangler deploy --keep-vars`, so dashboard vars are kept. Other scripts: `cf:typegen`, `prod:validate`, `test:e2e`, `generate-icons`, `generate:api-types`.

Before deploy, make sure you have:

- an account-owned Cloudflare API token in GitHub, not `wrangler login`
- created the R2 bucket named in `wrangler.jsonc` (`nostrmash-web-opennext-cache`, binding `NEXT_INC_CACHE_R2_BUCKET`)
- set `NOSTRMASH_API_BASE_URL` and `NEXT_PUBLIC_SITE_URL` (the checked-in `wrangler.jsonc` already sets the production values)
- the `WORKER_SELF_REFERENCE` service binding (`nostrmash-web`), the Images binding, and the `SUGGEST_RATE_LIMITER` rate limit (`namespace_id` is account-specific)

CI deploys only from a push to `main`, and only after quality, the OpenNext build, and Playwright pass. The deploy job uses the `production` environment. It runs `pnpm exec tsx scripts/cloudflare-deploy-preflight.ts --live` before Wrangler. That check refuses to start when `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` is missing or malformed, and it never falls back to another account or to interactive OAuth. A failed OpenNext build is a separate earlier job. A failed preflight is an authentication or permission failure.

The preflight calls `wrangler whoami` and `wrangler r2 bucket info`. It does not create the bucket and it does not deploy. Create `nostrmash-web-opennext-cache` in the same account before the first deploy. OpenNext still tries to populate that bucket during deploy.

### GitHub secrets

Repository secrets were not copied when this repository moved to the `nostrmash` organization. Add these on the **production** environment, because the deploy job sets `environment: production`.

1. Open `https://github.com/nostrmash/nostrmash-web/settings/environments`.
2. Open `production`.
3. Add environment secrets, not repository variables:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID` (the 32-character account id from the Workers overview)
4. Optional build secrets, if Sentry source maps should upload: `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `NEXT_PUBLIC_SENTRY_DSN`.
5. Optional production check: `PROD_VALIDATE_TOKEN`.

Create the token at `https://dash.cloudflare.com/profile/api-tokens` as an **account-owned** custom token limited to this one account. `wrangler login` cannot express these scopes. Minimum permissions:

- Account, Workers Scripts, Edit (Workers Editor). The Worker `nostrmash-web` must already exist, or the token also needs permission to create it.
- Account, Workers R2 Storage, Edit. OpenNext provisions and writes the cache bucket. Workers Editor alone does not grant that R2 API call.
- Account, Account Settings, Read, so the preflight can confirm the account id.
- Account, Cloudflare Images, Edit, for the `IMAGES` binding if that binding is not already attached.

Do not grant every account. Do not put the token in the repository. Zone, Workers Routes, Write is required only if a later deploy adds or changes a route. The checked-in `wrangler.jsonc` has no routes.

Production is deployed by Cloudflare Workers Builds on every push to `main`. The GitHub check is `Workers Builds: nostrmash-web`. The Actions `deploy` job also deploys when `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set on the `production` environment. Without those secrets it skips Wrangler and says so. `prod-validate` then checks `https://nostrmash.com`. A green quality job alone does not mean production was deployed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues through [SECURITY.md](SECURITY.md).

## License

Released into the public domain under the [Unlicense](LICENSE).
