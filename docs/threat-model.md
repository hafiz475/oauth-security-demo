# Threat model

Scope: the connect layer of a multi-tenant product that integrates 13 third-party apps through four OAuth patterns, plus credential-based (non-OAuth) apps. Actors: a signed-in member of a business, an external attacker who can host pages and send links, and scripts running in the victim's page. Out of scope: compromise of the backend host or the AES key, and a provider's own security.

"Before" describes the naive implementation each mitigation replaces. It is not a description of any particular codebase.

## T1. Login CSRF on the OAuth callback (closed by M1)

- **Attack:** the attacker starts a flow with their own provider account, stops at the callback, and gets the victim's browser to open `…/callback?code=ATTACKER_CODE&state=…` (a link, an image tag, a hidden iframe).
- **Impact:** the victim's workspace gets connected to the attacker's account. Leads, calendar events or messages then flow to the attacker, or the attacker's data gets injected into the victim's workspace.
- **Before:** the callback exchanged any code it received. `state` was missing, or was a constant, or was checked only for presence.
- **Mitigation:** a random `state` per flow, stored server-side and bound to the session that started it. It is compared in constant time, consumed atomically on first use, and expires after 10 minutes. Full-page flows also carry a per-tab nonce (`<server>.<tab>`) that the SPA checks before sending the code anywhere. Google flows add PKCE S256.
- **Residual risk:** an attacker who controls the victim's session cookie already has the session. A forced `SameSite=None` cross-origin deployment depends on correct CORS configuration (only `APP_ORIGIN` is reflected).

## T2. Tokens reachable from the browser (closed by M2)

- **Attack:** any script in the page (XSS, a compromised npm dependency, a malicious extension) reads tokens from API responses, the DOM, `localStorage` or a query cache.
- **Impact:** long-lived page tokens allow posting as the page, reading leads and changing ads, all without the victim present.
- **Before:** `GET /pages` returned each page with its `access_token`, which the browser held and sent back to load forms.
- **Mitigation:** tokens exist only server-side, encrypted with AES-256-GCM (random 12-byte IV, 16-byte tag, key from env; the server refuses to boot without it). Every page response passes through `toPublicPage` (`pageId`, `name`, `category`, `tasks`). Forms and fields are fetched by page id, and the backend attaches the token in an `Authorization` header. Legacy plaintext rows are migrated and the plaintext table is dropped. A dev-only tripwire in the UI stops rendering if a token-shaped key ever arrives.
- **Residual risk:** a stolen key decrypts the vault, so the key belongs in a secret manager with rotation, which is out of scope here. An XSS can still *use* the session to call page-id endpoints while the victim is present. It just cannot take tokens away.

## T3. Credentials in URLs (closed by M3)

- **Attack:** none needed. Anything in a URL is copied into browser history, `Referer` headers, server and CDN access logs, and analytics.
- **Impact:** API keys and secrets for credential-based apps sit in plaintext in places with broad read access and long retention.
- **Before:** the connect popup was opened as `/connect?apiKey=…&secret=…`.
- **Mitigation:** `POST /integration/pending` takes credentials in the body (query strings are rejected; each app has a strict zod schema). It encrypts them before insert and returns an opaque `pendingId` that is single-use, valid for 5 minutes, and bound to the same business and member. Redemption is a single atomic `UPDATE … RETURNING`. The SPA builds every URL through `buildOAuthUrl`, which throws on credential-shaped keys. Logs record paths without query strings and redact sensitive keys. All responses send `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
- **Residual risk:** OAuth codes and states still travel in callback URLs, because the protocol requires it. They are single-use, short-lived, stripped from history on arrival, and never logged.

## T4. Spoofable or stuck popup completion (closed by M4)

- **Attack:** a hostile window or iframe posts `{status:'success'}` to the opener. Alternatively the flow relies on polling `popup.closed`, which breaks under COOP and leaves "Connecting…" spinners that never end.
- **Impact:** a forged success marks an integration connected when it is not, or a forged error aborts a real one. Stuck spinners cause repeat attempts and duplicate connections.
- **Before:** `window.addEventListener('message', …)` with no origin check, plus a `setInterval` polling `popup.closed`.
- **Mitigation:** the completion page posts to one explicit target origin. The opener accepts a message only if `event.source` is the popup it opened, `event.origin` is allow-listed, and the `payloadId` matches the current attempt. Embedded Signup events are filtered against `ORIGIN_ALLOWLIST`, and dropped messages are logged with their origin only. Every path settles through success, error, cancel or timeout. There is no polling anywhere.
- **Residual risk:** without polling, an early close is inferred when focus returns with no message within 1.5 s. A user who clicks back to the app mid-consent sees "closed" and has to retry. A message from an allow-listed origin is trusted, so the allow-list has to stay short.

## Failure-mode catalogue

| ID | Failure mode | Test |
| --- | --- | --- |
| FM-01 | Callback without state | failure-modes (backend) |
| FM-02 | Login CSRF: attacker's callback in the victim's browser | failure-modes (backend) |
| FM-03 | State replay after success | failure-modes (backend) |
| FM-04 | State used after the 10-minute TTL | failure-modes (backend) |
| FM-05 | Authorization code redeemed twice | callback-page-flow |
| FM-06 | Completion page or lookup for an unissued `payloadId` | failure-modes (backend) |
| FM-07 | Credential placed in a URL by the SPA | failure-modes (frontend, buildOAuthUrl.test.ts) |
| FM-08 | Credentials on the query string to `/integration/pending` | failure-modes (backend) |
| FM-09 | Tampered vault ciphertext | failure-modes (backend) |
| FM-10 | Missing or malformed `DEMO_AES_KEY` | failure-modes (backend) |
| FM-11 | Page token reaching the browser | failure-modes (frontend, no-token-in-browser.test.ts) |
| FM-12 | Unknown provider or wrong pattern | failure-modes (backend) |
