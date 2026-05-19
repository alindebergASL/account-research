# Hermes Runtime Architecture

This document describes the **runtime Hermes** integration shape introduced in PR 1 of the Hermes runtime integration plan (`docs/plans/2026-05-19-hermes-runtime-integration.md`). It is the authoritative reference for operators deciding whether to enable Hermes-routed research, chat, or Canvas synthesis.

## What "runtime Hermes" is

Runtime Hermes is a future, **localhost-only / internal-only** HTTP service that the Next.js app will call when feature flags are enabled. Its job is to route brief research, brief chat, and Canvas synthesis across one or more model providers behind a stable contract owned by this repo.

- Default URL: `http://127.0.0.1:8787`
- Bind address: localhost only, never exposed via the public nginx surface.
- Transport: plain HTTP over the loopback interface, with an optional shared bearer token (`HERMES_SERVICE_TOKEN`) so PM2-managed worker / web tier can authenticate even on a single host.

Runtime Hermes is intentionally **not** an autonomous shell agent. It cannot reach outside its own process to make infrastructure changes.

## What runtime Hermes is *not*

Runtime Hermes is **distinct from "Operator Hermes"**, which is the existing deploy/control-plane Hermes that operators use to run admin tasks against the host. Operator Hermes keeps its own scope; runtime Hermes only ever services the three contract endpoints described below.

Runtime Hermes has **none** of the following authorities:

- No SSH access (no `ssh`, no `scp`, no remote shell into any host).
- No GitHub access (no PAT, no `gh`, no Git push/pull, no merge authority).
- No deploy authority (no PM2 restart, no nginx reload, no systemd interaction).
- No `sudo` and no general broad terminal.
- No write access to the production database other than the constrained inserts/updates the app server proxies through the contract.

If a future PR needs to grant runtime Hermes any of the above, that PR must be explicit, gated, and reviewed separately. **PR 1 introduces zero new authority.**

## Feature flags

All flags default OFF. Setting a flag back to `0` (or unsetting it) and restarting `web` + `worker` is a complete disable; **no database rollback is required** because migration 013 is purely additive.

| Flag                            | Default               | Meaning                                                                                              |
| ------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------- |
| `HERMES_RUNTIME_ENABLED`        | `0`                   | Master switch. When `1`, the runtime client makes HTTP calls to `HERMES_RUNTIME_URL`.                |
| `HERMES_RUNTIME_FAKE`           | `0`                   | Lab/CI-only. When `1`, the runtime client returns deterministic stub responses. No network calls.   |
| `HERMES_RUNTIME_URL`            | `http://127.0.0.1:8787` | Base URL of the runtime service. **Enforced loopback at runtime**: the client rejects any URL whose host is not `127.0.0.1`, `::1`, or `localhost` and refuses to send the request. Operator override requires a code change to `web/lib/hermes/config.ts`. |
| `HERMES_SERVICE_TOKEN`          | unset                 | Optional shared bearer token. Sent as `Authorization: Bearer <token>` only when set.                 |
| `HERMES_RESEARCH_ENABLED`       | `0`                   | Per-feature flag. When `1`, future PR 2 routes `runResearchPipeline()` through runtime Hermes.       |
| `HERMES_CHAT_ENABLED`           | `0`                   | Per-feature flag. When `1`, future PR 3 routes brief chat through runtime Hermes.                    |
| `HERMES_CANVAS_EVENTS_ENABLED`  | `0`                   | Per-feature flag. When `1`, the SSE event stream in future PR 3 is enabled.                          |

`HERMES_RUNTIME_FAKE=1` takes precedence over `HERMES_RUNTIME_ENABLED=1`. This is intentional: a lab operator can dry-run the wiring without ever risking an outbound call.

## DB substrate (migration 013)

Migration `013_hermes_runtime_events_and_canvas_state` adds three tables:

- `hermes_jobs` — durable record of every Hermes request (research, chat, or canvas synthesis). Includes a `fake` column so lab rows are distinguishable from production rows.
- `hermes_job_events` — append-only, ordered event log per job. `seq` is allocated transactionally; the unique `(job_id, seq)` index is the backstop.
- `canvas_states` — durable Canvas blob per brief, separate from `briefs.brief_json` so Hermes-driven Canvas updates have their own version history.

Writes are funneled through `web/lib/hermes/events.ts` and `web/lib/canvas/state.ts`. Both modules sanitize payloads at the write boundary (stripping `Bearer …`, `sk-…`, `Cookie:`, `set-cookie:`, `authorization:` patterns and dropping object keys like `authorization`, `cookie`, `headers`, `prompts`, `messages`, `input_json`, `provider_error_body`).

## Internal read API

`GET /api/briefs/[id]/hermes-events` (added in PR 1) is **auth-gated**:

- Requires a logged-in user.
- Requires `canReadBrief(user, briefId)`.
- Returns 404 for unauthorized callers so the existence of briefs they can't read isn't leaked.
- Allow-lists payload keys returned to the client; everything else is dropped.

Public share routes (`web/app/s/**`, `web/app/api/share/**`) do **not** call this endpoint and do **not** import its helpers. CI greps verify this remains true.

## Rollback procedure

1. Set every `HERMES_*` flag to `0` (or unset). Specifically:
   - `HERMES_RUNTIME_ENABLED=0`
   - `HERMES_RUNTIME_FAKE=0`
   - `HERMES_RESEARCH_ENABLED=0`
   - `HERMES_CHAT_ENABLED=0`
   - `HERMES_CANVAS_EVENTS_ENABLED=0`
2. Restart `web` and `worker` (PM2 reload). The direct Anthropic path remains intact and becomes the only execution path again.
3. **No DB rollback is required.** Migration 013 is additive; the tables can stay in place safely.

## Lab-first validation path

Operators should walk the runtime up in this exact order. Skipping a step risks live model spend or unbounded surface area.

1. **Step 0 — schema + plumbing (no spend).**
   `HERMES_RUNTIME_FAKE=1 npm run verify:hermes-foundation` in `web/`. Verifies migration 013 applies, fake jobs/events round-trip, sanitization works, Canvas state persists.

2. **Step 1 — localhost runtime + fake providers (no spend).**
   Stand up the lab-only runtime service on `127.0.0.1:8787` with `HERMES_RUNTIME_FAKE=1`. Set `HERMES_RUNTIME_ENABLED=1` only for the web/worker clients; keep all per-feature flags at `0` until the service health and contract verification pass. Smoke-test `/health`, bearer-token enforcement, `/v1/research`, `/v1/chat`, and `/v1/canvas-synthesis` with `npm run verify:hermes-runtime-service`.

   The service entrypoint is `web/scripts/hermes-runtime-service.ts`; PM2 lab-only wiring lives in `ecosystem.hermes-lab.config.js` so normal production web/worker reloads do not accidentally start a runtime process. Supported aliases are:
   - `GET /health`
   - `POST /v1/research` and `POST /v1/research/run`
   - `POST /v1/chat` and `POST /v1/chat/turn`
   - `POST /v1/canvas-synthesis` and `POST /v1/canvas/synthesize`

   The PR-4 implementation refuses non-loopback bind hosts and returns `503 runtime_live_mode_not_implemented` unless fake/no-spend mode is enabled.

3. **Step 2 — per-feature enablement, one at a time.**
   Flip `HERMES_RESEARCH_ENABLED=1` alone first and run a single low-stakes brief end-to-end. Verify direct Anthropic fallback still works when the flag is `0`. Repeat for `HERMES_CHAT_ENABLED` and `HERMES_CANVAS_EVENTS_ENABLED`.

4. **Step 3 — production.**
   Only after lab passes all of the above does any production enablement happen, and only behind explicit operator action — never as part of a code PR.

## Research adapter (PR 2)

`HERMES_RESEARCH_ENABLED=1` toggles dispatcher routing inside
`web/lib/researchPipeline.ts`. When the flag is **off** (the default),
`runResearchPipeline()` is byte-for-byte the existing direct Anthropic
path — no Hermes code is loaded, no `hermes_jobs` row is created.

When the flag is **on**, the dispatcher delegates to
`runResearchViaHermes()` in `web/lib/hermes/researchAdapter.ts`. That
adapter:

- Creates a `hermes_jobs` row (`kind="research"`, `fake=1` when
  `HERMES_RUNTIME_FAKE=1`).
- Emits an ordered `job.started` event whose payload contains only a
  sanitized `input_summary` (account name, mode, region, audience plus
  `has_goal` / `has_notes` booleans). Raw `notes` and any prompt text
  are never persisted.
- Calls `runHermesResearch()` from the runtime client (fake stub or
  loopback-only HTTP POST).
- On success, forwards any runtime-provided events, emits a
  `job.completed` event with a sanitized `result_summary`, marks the
  job `done`, and returns a value mapped into the existing
  `PipelineResult` shape. The public function signature of
  `runResearchPipeline()` is unchanged.
- On failure, emits a sanitized `job.failed` event, marks the job
  `failed` with a sanitized error string, and throws
  `HermesResearchAdapterError({jobId, kind, message})` — never a raw
  provider error.

### Fake-mode determinism

`HERMES_RUNTIME_FAKE=1` combined with `HERMES_RESEARCH_ENABLED=1`
produces deterministic adapter output suitable for verification. Run
`npm run verify:hermes-research-adapter` in `web/` to exercise the
fake path, dispatcher routing, and the failure path without any model
spend.

### Failure-mode policy

The dispatcher implements **fall back to direct Anthropic on real
Hermes runtime failure**:

- In `HERMES_RUNTIME_FAKE=1` mode, a thrown error is treated as a bug
  in the lab plumbing and is re-thrown — no fallback. This keeps fake
  verification honest.
- In real `HERMES_RUNTIME_ENABLED=1` mode, the dispatcher logs a
  sanitized `[hermes.research.fallback]` line and runs the existing
  direct Anthropic pipeline so a runtime hiccup never blocks a
  research job. The Hermes side already recorded a `job.failed` event
  and a sanitized error column for operator review.

This adapter introduces **no new public route**. Public share routes
(`web/app/s/**`, `web/app/api/share/**`) remain free of any Hermes
import — verified by repository grep.

## Guardrails restated

- No new public surface. The `hermes-events` route is authenticated.
- No live model calls from the runtime client (the client speaks only to localhost).
- No deploy authority granted to runtime Hermes.
- All flags default OFF.
- Direct Anthropic path is preserved as fallback.
