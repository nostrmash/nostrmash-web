# Relay Manager

Open **Network → Relay Manager** to inspect a public account, or follow **Inspect relay configuration** from a profile. The `viewer` query parameter identifies the public account. Relay pages can also link to the rankings for a public endpoint. The manager accepts hex, npub, nprofile, and the `nostr:` prefix. A NIP-05 address needs to be resolved to a public key first. The browser keeps optimization preferences, signer sessions, approvals, signed events, and receipts in memory for the active account.

## Inspect and optimize

The role catalog drives the workspace. Index freshness, explicit empty lists, legacy fallbacks, tombstones, and incomplete sources have separate states. Kind 10002 contains the public inbox and outbox. Current Marmot KeyPackage discovery uses the same outbox and historical accounts may still publish kind 10051. Kind 10013 stays encrypted in the user's client. Blossom servers are HTTP media endpoints.

The page loads configuration, diagnostics, recommendations, and rankings independently. Open **Relay evidence** to check role-specific observations. DM privacy reports gift-wrap acceptance, recipient retrieval, authentication, and observer exposure independently. Active probes are off during the initial rollout, so unknown evidence is expected. Public neighborhood overlap reflects relay declarations. The optimizer also supports global fallback, which the UI identifies.

Select a preset and optimize the default communication and discovery roles, a single role, or another eligible combination. Pin or exclude candidates and rerun optimization to update the preview. Use **Advanced constraints** to set global preferences and role overrides. Favorites and wiki relays require explicit selection. Blocklists, encrypted lists, custom relay sets, and Blossom servers stay outside the editing workflow.

## Apply and verify

1. Connect a NIP-07 browser signer for the inspected account. Public inspection and optimization previews are available without a signer.
2. Review the proposed changes, then choose **Refresh sources and review**. The browser uses a bounded sample of TLS relay connections from the discovery list and the account's current public outbox. It queries applicable replaceable events and author-signed deletions, validates event hashes and Schnorr signatures, and uses NIP-01 ordering, including lower event ID on timestamp ties. At least two distinct relay hosts must finish the bounded source query. Truncated queries, unavailable sources, relevant deletions and conflicting blocklist state can stop the operation.
3. The browser supplies complete signed source events to the optimizer with the original constraints. The review binds the exact proposed patch, the source reference, material changes, warnings, and targets. When any of those changes, review and confirmation are required again.
4. Choose **Sign and publish reviewed changes**. The browser refreshes again, checks the connected public key, and sends each approved unsigned event with the current timestamp to the signer. It validates the signer's returned ID, signature, public key, kind, timestamp, tags and content. Unknown tags and encrypted content in a configuration patch pass through unchanged. Another relay source check before publishing catches changes that occurred while a signer prompt was open.
5. The browser publishes the exact signed events to a bounded set of current outbox and discovery relays. Each event and relay has a separate receipt. **Retry unaccepted relays** reuses the signed event after checking for conflicting replacements. A batch of replaceable events can succeed partially.
6. The verifier receives the exact signed event and checks a sample of publication relays. The receipts, exact event retrieval, latest-version agreement, and indexed configuration each have separate states. Refresh or verify again while the index catches up.

The signer path requires the backend's aggregate and per-event safety checks. Creating or recreating a list requires separate preview consent and remains on backend review hold. A local lack of results cannot prove a list never existed. The browser can report NIP-42 or access restrictions and continue with other relays. NIP-42 negotiation and NIP-46 remote signing remain future enhancements. A sample cannot establish a globally latest version or guarantee propagation. Switching accounts or leaving the manager clears account-scoped publication state.

## API and deployment

The same-origin route accepts a fixed operation allowlist. Profile metadata uses the existing profile endpoint. The Relay Intelligence operations are:

| Method | NostrMash endpoint                                |
| ------ | ------------------------------------------------- |
| GET    | `/api/v1/relays/roles`                            |
| GET    | `/api/v1/relays/rankings`                         |
| GET    | `/api/v1/relays/capabilities`                     |
| GET    | `/api/v1/profiles/{pubkey}/relay-config`          |
| GET    | `/api/v1/profiles/{pubkey}/relay-diagnostics`     |
| GET    | `/api/v1/profiles/{pubkey}/relay-recommendations` |
| POST   | `/api/v1/relays/optimize`                         |
| POST   | `/api/v1/relays/verify`                           |

The backend bounds and caches public GETs. Account refresh bypasses browser and durable Worker caches. POSTs are limited to 64 KiB, require JSON, and use no-store at both hops. The transfer path excludes payloads from application tracing and error telemetry. Signing and publication run in the browser over direct relay connections. The backend optimizes and samples read-back.

API types are generated from backend main at `5ea1f0df3d5f12d60732882ab7ba8baf07571581`. Several read endpoints in that OpenAPI revision document examples without response schemas. The frontend validates them against the corresponding backend structs. Two concrete OpenAPI gaps are that the verify request describes `event` as an opaque object, which generates `Record<string, never>`, and the verify example uses `agreement` while the Go response uses `latest_agreement`. The adapter supplies the NIP-01 event schema and reads the actual field. A backend documentation follow-up can reference named response schemas for these endpoints and fix the verify example.

After approval, run the existing quality, OpenNext build, and browser checks against a review environment. Confirm the public endpoints, then exercise the entire workflow using a dedicated test Nostr account and controlled relays. Keep active probes off for the initial release. Check optimizer `overloaded` and `rate_limited` responses, read-back conflicts, and the delay between acceptance and indexing before enabling a production rollout.
