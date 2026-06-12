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
- **Advisories:** Image Optimization DoS (GHSA-h64f-5h5j-jqjh), SSRF via
  WebSocket upgrades (GHSA-c4j6-fc7j-m34r), RSC cache poisoning
  (GHSA-wfc6-r584-vfw7), Pages-Router i18n middleware bypass
  (GHSA-36qx-fr4f-26g5); postcss `</style>` stringify XSS (GHSA-qx2v-qp2m-jg93,
  bundled under next).
- **Read:** framework-level; concrete exposure depends on whether Image
  Optimization, i18n middleware, and WebSocket upgrades are used in production.
- **Fix:** `next@16` is **two majors** from 14 — App-Router/runtime breaking
  changes. Needs a dedicated upgrade + full regression pass; do not fold into a
  dependency-audit PR. (postcss is resolved transitively by the next bump.)

### nodemailer `6.10.1` → fix `8.x` (high)
- **Advisories:** email to unintended domain via address-parser interpretation
  conflict (GHSA-mm7p-fcc7-pg87), addressparser DoS (GHSA-rcmh-qjqh-p98v), SMTP
  command injection via `envelope.size` (GHSA-c7w3-x93f-qmm8) and via CRLF in the
  transport `name`/EHLO/HELO (GHSA-vvjj-xcjg-gr5g).
- **Read (`web/lib/email.ts`):** transport host/port/user/pass and `from` come
  **entirely from environment variables**, not user input, so the transport-name
  and `envelope.size` injection vectors are not reachable. The recipient (`to`)
  is the authenticated user's own address. Practical exposure is low, but these
  are still high-severity CVEs.
- **Fix:** `nodemailer@8` is a major bump from 6.x; email is auth/notification
  critical-path. Upgrade in a dedicated change with mail-send verification.

## Re-checking

```
cd web && npm audit --omit=dev
```
