# oauth-security-demo

Connecting a product to thirteen third-party apps means thirteen OAuth and credential flows, and every one is a chance to get four things wrong. **Login CSRF:** a callback that doesn't verify `state` lets an attacker attach *their* account to a victim's workspace. **Token exposure:** a page or access token that reaches the browser can be read by any script on the page. **Credentials in URLs:** an API key in a query string ends up in browser history, `Referer` headers and proxy logs. **Spoofable completion:** a popup flow that trusts any `postMessage`, or polls `popup.closed`, can be completed by a hostile window or get stuck. This repository reproduces the four mitigations for those threats, applies them across all 13 integrations, and ships a test suite and a metrics script so that each claim below can be re-run, not just read.

> **Live demo:** [live demo](placeholder) · **Repo:** [github.com/hafiz475/oauth-security-demo](https://github.com/hafiz475/oauth-security-demo)

## Run it yourself

Requires Node 20.12+ and pnpm 9 (`npm i -g pnpm@9`).

```bash
pnpm install
pnpm test      # 68 tests across both packages
pnpm metrics   # re-runs the suite, greps the source, prints the table below
```

To click through it: `pnpm dev`, then open <http://localhost:5173>. The first run writes `.env` with a freshly generated `DEMO_AES_KEY`. Every provider points at a local mock identity provider, so no real credentials are needed.

## Architecture

```
 Browser (React SPA, :5173)                         Backend (Fastify, :3000)                  Mock IdP (/mock-oauth)
 ─────────────────────────                          ────────────────────────                  ──────────────────────
                                                    session cookie (HttpOnly) binds every flow
 Pattern 1 · popup (8 providers)
  ConnectButton ─POST /oauth/popup/:p/start──────▶  oauth_flows row: state, PKCE  [M1]
  useOAuthPopup ─window.open(launchUrl)─────────▶  302 ───────────────────────────────────▶  consent ─▶ ?code&state
                                                    /callback: claim(session,state)  [M1]
                                                    code ─▶ token exchange (server-to-server)
                                                    token ─▶ AES-256-GCM  [M2]
     ◀──── postMessage({status,payloadId}, APP_ORIGIN) ── completion page  [M4]
  checks event.origin + event.source + payloadId  [M4]   (no polling, no timers on the popup)

 Pattern 2 · Meta redirect (3)    Pattern 4 · Instagram callback page (1)
  RedirectButton ─POST …/start {tabNonce}──────────▶  state = server.tabNonce  [M1]
  location.assign(authUrl) ──────────────────────────────────────────────────────────────▶  ?code&state
  CallbackPage: strip code from URL (replaceState),
   check tab nonce, POST verify-state ─────────────▶  peek(session,state)  [M1]
   POST exchange {code,state} ─────────────────────▶  claim + exchange; page tokens ─▶ vault  [M2]

 Pattern 3 · WhatsApp Embedded Signup (1)
  POST …/config ──────────────────────────────────▶  state + ORIGIN_ALLOWLIST
  embeddedSignup listener ◀── WA_EMBEDDED_SIGNUP postMessage (allow-listed origins only)  [M4]
  POST …/complete {state,code,wabaId,…} ──────────▶  claim + exchange  [M1, M2]

 Credential apps (no OAuth)
  POST /integration/pending {credentials} ────────▶  encrypt ─▶ pending_connections  [M2, M3]
  ◀── {pendingId}  (opaque, single use, 5 min)
  popup /integration/connect?pendingId ──────────▶  atomic UPDATE … RETURNING  [M3]

 Meta pages: GET /meta/pages → {pageId,name,category,tasks}. Forms/fields: page id in, token resolved server-side  [M2]
```

## The four mitigations

### M1. Verified `state` on every flow

- **Threat closed:** login CSRF. An attacker finishes their own OAuth consent, then gets the victim's browser to load the callback URL, and the victim's workspace is now connected to the attacker's account.
- **Before:** the callback accepted any `code`, or compared `state` against a value the attacker could also supply.
- **After:** every flow stores a random `state` server-side, bound to the browser session that started it; the callback compares it in constant time and consumes it once, within 10 minutes.
- **Implemented in:** [state.ts](packages/backend/src/state.ts), [oauth-flow.ts](packages/backend/src/oauth-flow.ts), [oauthState.ts](packages/frontend/src/lib/oauthState.ts)
- **Proved by:** [state.test.ts](packages/backend/tests/state.test.ts), [all-providers.test.ts](packages/backend/tests/all-providers.test.ts), [failure-modes.test.ts](packages/backend/tests/failure-modes.test.ts) (FM-01 to FM-04)
- **See it pass:** `pnpm test state all-providers failure-modes`

### M2. Tokens never reach the browser

- **Threat closed:** token theft by any script running in the page (XSS, a compromised dependency, a browser extension).
- **Before:** the page list came back from the API with each page's `access_token`, and the browser passed it back to load forms.
- **After:** tokens are encrypted with AES-256-GCM (random 12-byte IV, auth tag checked) in a server-side vault; the browser works in page ids, and every route maps through `toPublicPage`.
- **Implemented in:** [page-token-vault.ts](packages/backend/src/page-token-vault.ts), [crypto.ts](packages/backend/src/crypto.ts), [meta-pages.ts](packages/backend/src/routes/meta-pages.ts), [MetaPagesDemo.tsx](packages/frontend/src/pages/MetaPagesDemo.tsx)
- **Proved by:** [page-token-vault.test.ts](packages/backend/tests/page-token-vault.test.ts), [no-token-in-browser.test.ts](packages/frontend/tests/no-token-in-browser.test.ts) (renders the real page against the real backend, then searches the DOM, storage, cookies, query cache and every response for the issued tokens)
- **See it pass:** `pnpm test page-token-vault no-token-in-browser`

### M3. No credentials in URLs

- **Threat closed:** secrets leaking through browser history, `Referer` headers, server and proxy access logs.
- **Before:** the connect link carried the API key or secret as a query parameter.
- **After:** credentials go in a POST body and are swapped for an opaque, single-use, five-minute `pendingId` bound to the same business and member; the SPA's only URL builder throws on credential-shaped keys; logs record paths without query strings.
- **Implemented in:** [pending-connection.ts](packages/backend/src/pending-connection.ts), [integration-pending.ts](packages/backend/src/routes/integration-pending.ts), [buildOAuthUrl.ts](packages/frontend/src/lib/buildOAuthUrl.ts), [redacting-logger.ts](packages/backend/src/redacting-logger.ts)
- **Proved by:** [pending-connection.test.ts](packages/backend/tests/pending-connection.test.ts), [buildOAuthUrl.test.ts](packages/frontend/tests/buildOAuthUrl.test.ts), [redaction.test.ts](packages/backend/tests/redaction.test.ts), plus the URL checks in [all-providers.test.ts](packages/backend/tests/all-providers.test.ts)
- **See it pass:** `pnpm test pending-connection buildOAuthUrl redaction`

### M4. Origin-checked `postMessage` completion

- **Threat closed:** a hostile window completing or failing a flow with a forged message, and flows that hang because completion was detected by polling `popup.closed`.
- **Before:** the opener listened for any `message` and polled `popup.closed` on an interval to guess the outcome.
- **After:** the completion page posts to one explicit target origin; the opener accepts a message only from the popup it opened, from an allow-listed origin, carrying the expected `payloadId`; Embedded Signup events are filtered against `ORIGIN_ALLOWLIST`, and every path settles.
- **Implemented in:** [useOAuthPopup.ts](packages/frontend/src/hooks/useOAuthPopup.ts), [completion-page.ts](packages/backend/src/completion-page.ts), [embeddedSignup.ts](packages/frontend/src/lib/embeddedSignup.ts)
- **Proved by:** [useOAuthPopup.test.ts](packages/frontend/tests/useOAuthPopup.test.ts) (group `popup-completion`), [embedded-flow.test.ts](packages/backend/tests/embedded-flow.test.ts)
- **See it pass:** `pnpm test useOAuthPopup embedded-flow`

## Metrics

Output of `pnpm metrics`, pasted by the script itself between the markers below, so it cannot drift from what the script prints.

<!-- metrics:start -->
| Metric | Value | Method | Class |
| --- | --- | --- | --- |
| Flows with verified state | 13 / 13 | providers whose `all-providers` case passed (flow completes; tampered state refused) / registry size | Verified |
| Credential fields in URLs | 0 | `searchParams.set/append` with a credential-shaped key, or `?token=`-style literals, in `packages/*/src` | Verified |
| Page tokens in browser | 0 | `access_token` / `fetch…access_token` in frontend src, `metaData.access_token` anywhere; plus the FM-11 DOM/storage test | Verified |
| popup.closed usages | 0 | `.closed` property reads in `packages/*/src` | Verified |
| setInterval usages (connect area) | 0 | `setInterval(` in `packages/*/src` (whole tree, a superset of the connect area) | Verified |
| Hard-coded provider IDs | 0 | quoted literals assigned to client/app/config/solution/tenant ids, or 9+ digit quoted numbers, in `packages/*/src` | Verified |
| alert() usages | 0 | `alert(` in `packages/*/src` | Verified |
| Connect-layer LOC | 1100 | non-blank lines in 15 src files whose name matches `oauth\|pending\|page-token\|state\|redact` | Verified |
| Test cases | 68 | vitest JSON reporter, both packages | Verified |
| Tests passing | 68 / 68 | vitest JSON reporter, both packages | Verified |
| Production connect success rate | not claimed | needs production telemetry; this repo has no production traffic | Note |
| Time-to-connect / latency | not claimed | needs real-user timing; a local mock IdP says nothing about it | Note |
| Support-ticket volume | not claimed | needs a ticketing system; out of scope | Note |

| Test group | Pinned | Actual | Passing |
| --- | --- | --- | --- |
| state | 4 | 4 | 4 |
| pending-connection | 9 | 9 | 9 |
| page-token-vault | 7 | 7 | 7 |
| popup-completion | 6 | 6 | 6 |
| redirect-flow | 5 | 5 | 5 |
| embedded-flow | 4 | 4 | 4 |
| callback-page-flow | 5 | 5 | 5 |
| redaction | 4 | 4 | 4 |
| all-providers | 13 | 13 | 13 |
| failure-modes | 11 | 11 | 11 |
<!-- metrics:end -->

## What this demo does NOT claim

- **No production success rate.** There is no production traffic here. A pass rate against a local mock says nothing about real users.
- **No latency or time-to-connect figures.** The mock IdP answers in microseconds, so any timing would be fiction.
- **No support-ticket, incident or conversion numbers.** Nothing here measures them.
- **No claim that the mock behaves like each real provider.** It is a strict generic IdP: registered redirect origins, single-use codes, exact `redirect_uri` match, PKCE S256. Real providers add quirks that a real deployment must handle.

What the repository does claim is structural and security facts that it proves itself: every flow verifies its state, tokens stay server-side, no credential enters a URL, and completion messages are origin-checked. Each is a test or a grep you can re-run.

## Provider coverage

| Provider | Pattern | state verified | token custody | credential handle |
| --- | --- | --- | --- | --- |
| Google Calendar | popup (+PKCE) | ✅ | ✅ server vault | ✅ opaque `payloadId` |
| Google Sheets | popup (+PKCE) | ✅ | ✅ server vault | ✅ opaque `payloadId` |
| Zoho CRM | popup | ✅ | ✅ server vault | ✅ opaque `payloadId` |
| Zoho Bigin | popup | ✅ | ✅ server vault | ✅ opaque `payloadId` |
| Zoho Books | popup | ✅ | ✅ server vault | ✅ opaque `payloadId` |
| HubSpot | popup | ✅ | ✅ server vault | ✅ opaque `payloadId` |
| Zoom | popup | ✅ | ✅ server vault | ✅ opaque `payloadId` |
| Razorpay | popup | ✅ | ✅ server vault | ✅ opaque `payloadId` |
| Facebook Lead Ads | redirect | ✅ | ✅ server vault (user + page tokens) | ✅ page ids only |
| Meta Conversions API | redirect | ✅ | ✅ server vault | ✅ opaque `payloadId` |
| Meta Catalogue | redirect | ✅ | ✅ server vault | ✅ opaque `payloadId` |
| WhatsApp Embedded Signup | embedded | ✅ | ✅ server vault | ✅ code in POST body |
| Instagram | callback | ✅ | ✅ server vault | ✅ code stripped from URL, POST body |

Every row is one case in [all-providers.test.ts](packages/backend/tests/all-providers.test.ts). Each case runs the provider's real flow against the mock IdP, checks that a tampered state is refused, checks that no URL carries a credential-shaped parameter, and checks that the tokens actually issued appear in no URL and no browser-visible response.

## How I built this

This is a clean-room reimplementation: no employer code, comments, constants, schemas or tests were copied or imported. Every file was written from scratch from the design described above. The same design runs in a private production codebase at 13-integration scale; this repository exists so the approach can be inspected and verified in public.

---

### Implementation notes

- **SQLite via sql.js (WebAssembly).** This avoids a native build: better-sqlite3 has no prebuilt binary for every Node version (for example Node 23.3 on Windows), so `pnpm install` would need Python and MSVC. [db/index.ts](packages/backend/src/db/index.ts) exposes the same `prepare().run/get/all` shape.
- **Early-close detection without polling.** When focus returns to the app and no completion message arrives within 1.5 s, the flow counts as abandoned. Returning to the popup cancels the countdown. A user who clicks back to the app mid-consent has to press Connect again. See [docs/threat-model.md](docs/threat-model.md).
- **Demo sign-in.** `POST /session/demo` stands in for a real auth layer by issuing an HttpOnly session cookie. The mitigations depend only on having a server-side session id.
- **Threat model:** [docs/threat-model.md](docs/threat-model.md). **Metrics:** [docs/metrics.md](docs/metrics.md).
