# Production dependency audit — 2026-06-12

Scope: `npm audit --omit=dev` for `web/` (runtime dependencies only). Captured
while adding Office (`exceljs`) support; this records what was fixed now and what
is deferred, with an exploitability read for each so the deferrals are a
deliberate decision rather than an oversight.

Starting state: **5 vulnerabilities (3 moderate, 2 high)**.
After this pass: **3 vulnerabilities (1 moderate, 2 high)** — all pre-existing
and requiring a major-version framework/library upgrade.

## Fixed now

### uuid `<11.1.1` (moderate, transitive via `exceljs`) — GHSA-w5hq-g745-h8pq
- **Introduced by:** the `exceljs` dependency added for `.xlsx` extraction.
- **Advisory:** missing buffer bounds check in uuid **v3/v5/v6 when a `buf`
  argument is provided**.
- **Reachability here:** not reachable. `exceljs` calls **`uuid.v4()` with no
  `buf`** (only in the conditional-formatting *write* path), and our use is
  read-only extraction inside the bounded child process. The vulnerable code
  path is never executed.
- **Fix applied:** scoped override `overrides.exceljs.uuid = "^11.1.1"` in
  `web/package.json`. `uuid` is pulled **only** by `exceljs`, and uuid 11 ships a
  CommonJS `require` entry, so `const {v4} = require('uuid')` keeps working.
  Verified with a write+read round-trip that exercises the `uuid.v4()` path and
  the full test suite (541/541). Clears both the `uuid` and dependent `exceljs`
  audit findings.

## Deferred (pre-existing, require breaking major upgrades)

These predate the Office/links work and each needs a dedicated, separately-tested
upgrade — out of scope for this fast-follow, recorded here so they are tracked.

### next `14.2.35` → fix `16.x` (high) + postcss (moderate, via next)
- **Advisories (14 against `next` in this audit, plus bundled postcss):**
  - Image Optimization / `next/image`: Image-Optimizer `remotePatterns` DoS
    (GHSA-9g9p-9gw9-jx7f), Image Optimization API DoS (GHSA-h64f-5h5j-jqjh),
    unbounded `next/image` disk-cache growth (GHSA-3x4c-7xq6-9pq8).
  - Server Components / RSC: HTTP request deserialization DoS
    (GHSA-h25m-26qc-wcjf), DoS with Server Components (GHSA-q4gf-8mx6-v5v3,
    GHSA-8h8q-6873-q5fj), RSC cache poisoning (GHSA-wfc6-r584-vfw7),
    cache-busting collision cache poisoning (GHSA-vfv6-92ff-j949).
  - Routing / proxy: HTTP request smuggling in rewrites (GHSA-ggv3-7p47-pfv8),
    Middleware/Proxy redirect cache poisoning (GHSA-3g8h-86w9-wvmq), Pages-Router
    i18n middleware bypass (GHSA-36qx-fr4f-26g5).
  - SSRF / XSS: SSRF via WebSocket upgrades (GHSA-c4j6-fc7j-m34r), App-Router CSP
    nonce XSS (GHSA-ffhc-5mcf-pf4q), `beforeInteractive` script XSS
    (GHSA-gx5p-jg67-6x7h).
  - Bundled **postcss** `</style>` stringify XSS (GHSA-qx2v-qp2m-jg93), resolved
    by the next bump.
  - For the authoritative current list, see `npm audit --omit=dev`; the grouping
    above is the inventory as of this audit, not a hand-maintained subset.
- **Read:** framework-level; concrete exposure depends on whether Image
  Optimization, i18n middleware, WebSocket upgrades, and CSP nonces are used in
  production.
- **Fix:** `next@16` is **two majors** from 14 — App-Router/runtime breaking
  changes. Needs a dedicated upgrade + full regression pass; do not fold into a
  dependency-audit PR. (postcss is resolved transitively by the next bump.)

### nodemailer `6.10.1` → fix `8.x` (high)
- **Advisories:** email to unintended domain via address-parser interpretation
  conflict (GHSA-mm7p-fcc7-pg87), addressparser DoS (GHSA-rcmh-qjqh-p98v), SMTP
  command injection via `envelope.size` (GHSA-c7w3-x93f-qmm8) and via CRLF in the
  transport `name`/EHLO/HELO (GHSA-vvjj-xcjg-gr5g).
- **Read (`web/lib/email.ts` + callers):** transport host/port/user/pass and
  `from` come **entirely from environment variables**, not user input, so the
  transport-name (EHLO/HELO) and `envelope.size` injection vectors are **not
  reachable**. Recipients vary by caller: magic-link/notification emails go to
  the authenticated user's own address, but the **share-link email**
  (`app/api/briefs/[id]/share-links/[linkId]/email/route.ts`) sends to a
  **manager-supplied `recipient` from the request body** — so the address-parser
  / unintended-domain advisories (GHSA-mm7p-fcc7-pg87, GHSA-rcmh-qjqh-p98v) are
  potentially reachable. That input is gated by `canManageBrief` and validated
  against an email regex before send, which narrows but does not formally
  eliminate the address-parser interpretation-conflict class. Treat as real.
- **Fix:** `nodemailer@8` is a major bump from 6.x; email is auth/notification
  critical-path. Upgrade in a dedicated change with mail-send verification.

## Scope note: runtime vs. dev

All counts above are for `npm audit --omit=dev` (runtime/production dependencies),
which is the surface that ships. A plain `npm audit` / `npm ci` includes dev
dependencies and reports more (6 total at the time of writing); those dev-only
findings are out of scope for this production pass.

## Re-checking

```
cd web && npm audit --omit=dev
```
