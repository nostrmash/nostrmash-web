# Contributing to NostrMash Web

Node.js 20.19+, 22.12+, or 23.2+ (CI uses Node 22) and pnpm 10.18.1 (`packageManager` in `package.json`). Node 22.0–22.11 and 23.0–23.1 are outside the Vite and Sentry engine ranges.

```bash
pnpm install
pnpm validate
pnpm test
```

## Pull requests

- Branch from `main` and keep the change focused.
- Run `pnpm validate` and `pnpm test` before opening the pull request.
- Update the README when routes or the API contract change.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report unacceptable behavior on Nostr at `npub1ckqlguq0htvs3smwy8pl5uwmfas0h208p7p8hs92ghaurgkmzzrsw3vlh0`.
