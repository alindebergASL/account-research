# Hermes Runtime Integration Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Replace direct product-facing Anthropic calls with a Hermes runtime abstraction that can route across multiple models, power brief research/chat, and update Canvas through durable real-time events.

**Architecture:** Add a narrow app-to-Hermes contract first, then switch research/chat behind feature flags. The Next.js app remains the authority for users, permissions, brief persistence, Canvas state, and audit. Hermes becomes a constrained runtime service reachable via server-side local/internal API, not a broad production shell agent.

**Tech Stack:** Next.js 14 App Router, TypeScript, better-sqlite3, existing PM2 web/worker model, future localhost Hermes runtime service, SSE for live Canvas events.

---

## Current repo baseline verified before writing this plan

- Repo: `alindebergASL/account-research`
- Planning worktree: `/home/ubuntu/account-research-hermes-runtime-plan`
- Base branch/commit: `origin/main` at `c0161b4 feat: add Canvas visual grammar foundation (#26)`
- Existing direct Anthropic call sites:
  - `web/lib/researchPipeline.ts`
  - `web/app/api/briefs/[id]/chat/route.ts`
- Existing queue/worker foundation:
  - `web/lib/researchWorker.ts`
  - `web/scripts/research-worker.ts`
  - `research_jobs` migration `008_research_jobs_and_email_prefs`
- Existing audit/event foundation:
  - `brief_events` migration `012_brief_events`
  - `web/lib/briefEvents.ts`
- Existing Canvas foundation:
  - `web/lib/canvas/fromBrief.ts`
  - `web/lib/canvas/schema.ts`
  - `web/components/canvas/ReadOnlyCanvasView.tsx`
  - `web/components/BriefChat.tsx`

## Non-negotiable guardrails

1. Do not install a full autonomous shell agent on production in this implementation.
2. Do not grant runtime Hermes GitHub, SSH, deploy, broad terminal, or sudo authority.
3. Runtime Hermes must be called through a narrow server-side API contract.
4. Production rollout must be dark by default behind env flags.
5. Preserve the existing Anthropic path as fallback until Hermes runtime is proven.
6. Preserve `RESEARCH_WORKER_FAKE_PROVIDER` behavior for local/lab verification with no model spend.
7. Public share routes must not expose internal Hermes job/event payloads.
8. Canvas updates must be persisted and auditable; the browser should never treat ephemeral stream data as the source of truth.
9. No production deploy from this plan PR; deployment is a separate operator step after review/merge.

## Proposed rollout sequence

### PR 1: Hermes contract, DB event substrate, and no-op/fake runtime client

Purpose: create the app-side foundation without requiring a live Hermes service.

Deliverables:
- typed Hermes request/response contracts
- env flag parsing
- runtime client with `direct`, `hermes`, and `fake` modes
- DB tables for generic Hermes jobs/events and persisted Canvas state
- server-side event writer/reader helpers
- tests for schema, migration, event ordering, fake runtime responses

No live production behavior change unless flags are enabled.

### PR 2: Research pipeline adapter

Purpose: route `runResearchPipeline()` through Hermes when enabled while preserving the current Anthropic implementation as fallback.

Deliverables:
- `ResearchProvider` abstraction
- `DirectAnthropicResearchProvider` wrapping current code
- `HermesResearchProvider` using the new runtime client
- feature flag: `HERMES_RESEARCH_ENABLED=1`
- event emission for source discovery, synthesis progress, completion/failure
- worker verification with fake Hermes runtime

### PR 3: Chat adapter and Canvas event stream

Purpose: make brief chat use Hermes as the bot and let chat-driven brief/canvas changes stream into the UI.

Deliverables:
- `ChatProvider` abstraction
- `DirectAnthropicChatProvider` wrapping current code
- `HermesChatProvider` using runtime client
- feature flag: `HERMES_CHAT_ENABLED=1`
- SSE route for brief-level Hermes/Canvas events
- `BriefChat` subscribes to events while drawer is open
- `ReadOnlyCanvasView` can refresh/update when durable Canvas state changes

### PR 4: Lightweight Hermes runtime service, lab first

Purpose: run a constrained service in lab that implements the contract.

Deliverables:
- `web/scripts/hermes-runtime.ts` or separate service package, depending on final Hermes SDK/CLI integration shape
- localhost-only bind by default
- `GET /health`
- `POST /v1/research/run`
- `POST /v1/chat/turn`
- `POST /v1/canvas/synthesize`
- provider/model routing configuration
- PM2 lab config only

### PR 5: Production enablement behind explicit operator flag

Purpose: deploy the runtime service to production with narrow scope only after lab validation.

Deliverables:
- production env additions, no secrets in repo
- PM2/systemd process for runtime service
- nginx not exposed publicly; localhost only
- healthcheck script
- rollback instructions to disable Hermes flags and fall back to direct Anthropic

---

## PR 1 detailed implementation tasks

### Task 1: Add Hermes env/config helper

**Objective:** Centralize Hermes feature flags and runtime URL/token validation.

**Files:**
- Create: `web/lib/hermes/config.ts`
- Test: `web/lib/hermes/config.test.ts` if the repo adds a test runner later; for now add pure exported functions and cover through TypeScript/build plus a verification script in Task 7.

**Implementation notes:**

Create a small helper with no side effects beyond reading `process.env`:

```ts
export type HermesRuntimeMode = "direct" | "fake" | "hermes";

export function hermesRuntimeMode(): HermesRuntimeMode {
  if (process.env.HERMES_RUNTIME_FAKE === "1") return "fake";
  if (process.env.HERMES_RUNTIME_ENABLED === "1") return "hermes";
  return "direct";
}

export function hermesRuntimeUrl(): string {
  return process.env.HERMES_RUNTIME_URL || "http://127.0.0.1:8787";
}

export function hermesServiceToken(): string | null {
  return process.env.HERMES_SERVICE_TOKEN || null;
}

export function hermesResearchEnabled(): boolean {
  return process.env.HERMES_RESEARCH_ENABLED === "1";
}

export function hermesChatEnabled(): boolean {
  return process.env.HERMES_CHAT_ENABLED === "1";
}

export function hermesCanvasEventsEnabled(): boolean {
  return process.env.HERMES_CANVAS_EVENTS_ENABLED === "1";
}
```

**Verification:**

Run:

```bash
cd web
npm run typecheck
```

Expected: TypeScript passes.

### Task 2: Add typed Hermes runtime contract

**Objective:** Define the JSON contract between the app and Hermes before any service exists.

**Files:**
- Create: `web/lib/hermes/types.ts`

**Types to include:**

```ts
import type { Brief, BriefExtension } from "@/lib/schema";
import type { Canvas } from "@/lib/canvas/schema";
import type { BriefPatch } from "@/lib/briefPatches";
import type { Intake, ResearchMode } from "@/lib/researchPipeline";

export type HermesJobKind = "research" | "chat" | "canvas_synthesis";
export type HermesJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export type HermesEventType =
  | "job.started"
  | "source.discovered"
  | "source.rejected"
  | "claim.extracted"
  | "research.progress"
  | "research.completed"
  | "chat.started"
  | "chat.message"
  | "brief.patch.proposed"
  | "brief.patch.applied"
  | "canvas.synthesis.started"
  | "canvas.widget.created"
  | "canvas.widget.updated"
  | "canvas.recommendation.proposed"
  | "canvas.state.updated"
  | "job.completed"
  | "job.failed";

export type HermesUsage = {
  provider?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd_cents?: number;
};

export type HermesResearchRequest = {
  job_id?: string;
  user_id: string;
  intake: Intake;
  mode: ResearchMode;
  brief_id?: string;
  callback_url?: string;
};

export type HermesResearchResponse = {
  brief: Brief;
  stages: HermesUsage[];
  quality: {
    filled: number;
    total: number;
    low: boolean;
    repaired: boolean;
    research_attempts: number;
    source_candidates: number;
    mode: ResearchMode;
  };
  events?: HermesRuntimeEventInput[];
};

export type HermesChatRequest = {
  job_id?: string;
  brief_id: string;
  user_id: string;
  brief: Brief;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  message: string;
  can_write: boolean;
};

export type HermesChatResponse = {
  reply: string;
  patches_applied: BriefPatch[];
  patch_errors: string[];
  brief?: Brief;
  canvas?: Canvas;
  events?: HermesRuntimeEventInput[];
};

export type HermesCanvasSynthesisRequest = {
  job_id?: string;
  brief_id: string;
  user_id: string;
  brief: Brief;
  trigger: "research_completed" | "chat_patch" | "manual_refresh";
};

export type HermesCanvasSynthesisResponse = {
  canvas: Canvas;
  extensions?: BriefExtension[];
  events?: HermesRuntimeEventInput[];
};

export type HermesRuntimeEventInput = {
  type: HermesEventType;
  title: string;
  summary?: string;
  payload?: Record<string, unknown>;
};
```

**Verification:**

Run:

```bash
cd web
npm run typecheck
```

Expected: TypeScript passes.

### Task 3: Add DB migration 013 for generic Hermes jobs/events and Canvas state

**Objective:** Persist Hermes runtime jobs/events and durable Canvas state separately from static brief JSON.

**Files:**
- Modify: `web/lib/db.ts`
- Add exported row types near existing DB row types if present later in the file.

**Migration:**

Add migration after `012_brief_events`:

```ts
{
  id: "013_hermes_runtime_events_and_canvas_state",
  up: (c) =>
    c.exec(`
      CREATE TABLE IF NOT EXISTS hermes_jobs (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL,
        status          TEXT NOT NULL,
        user_id         TEXT,
        brief_id        TEXT,
        research_job_id TEXT,
        provider        TEXT,
        model           TEXT,
        input_json      TEXT,
        result_json     TEXT,
        error           TEXT,
        created_at      INTEGER NOT NULL,
        started_at      INTEGER,
        finished_at     INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (brief_id) REFERENCES briefs(id) ON DELETE CASCADE,
        FOREIGN KEY (research_job_id) REFERENCES research_jobs(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hermes_jobs_brief_created
        ON hermes_jobs(brief_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_hermes_jobs_user_created
        ON hermes_jobs(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_hermes_jobs_status_created
        ON hermes_jobs(status, created_at);

      CREATE TABLE IF NOT EXISTS hermes_job_events (
        id              TEXT PRIMARY KEY,
        job_id          TEXT NOT NULL,
        brief_id        TEXT,
        actor_user_id   TEXT,
        seq             INTEGER NOT NULL,
        event_type      TEXT NOT NULL,
        title           TEXT NOT NULL,
        summary         TEXT,
        payload_json    TEXT,
        created_at      INTEGER NOT NULL,
        FOREIGN KEY (job_id) REFERENCES hermes_jobs(id) ON DELETE CASCADE,
        FOREIGN KEY (brief_id) REFERENCES briefs(id) ON DELETE CASCADE,
        FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
        UNIQUE(job_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_hermes_events_brief_created
        ON hermes_job_events(brief_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_hermes_events_job_seq
        ON hermes_job_events(job_id, seq);

      CREATE TABLE IF NOT EXISTS canvas_states (
        brief_id        TEXT PRIMARY KEY,
        canvas_json     TEXT NOT NULL,
        source          TEXT NOT NULL,
        version         INTEGER NOT NULL DEFAULT 1,
        updated_at      INTEGER NOT NULL,
        updated_by_job_id TEXT,
        FOREIGN KEY (brief_id) REFERENCES briefs(id) ON DELETE CASCADE,
        FOREIGN KEY (updated_by_job_id) REFERENCES hermes_jobs(id) ON DELETE SET NULL
      );
    `),
}
```

**Important:** Use the repo's existing inline migration style. Do not create separate SQL migration files.

**Verification:**

Run a local migration smoke against a temp DB:

```bash
cd web
BRIEF_DB_PATH=/tmp/account-research-hermes-plan.sqlite ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='TempPass123!' node -e "require('./node_modules/tsx/dist/cli.cjs');" 2>/dev/null || true
```

If direct tsx invocation is awkward, create the Task 7 verification script and use that instead.

### Task 4: Add Hermes job/event persistence helpers

**Objective:** Provide safe server-only helpers for creating jobs, recording ordered events, and reading brief events for SSE/polling.

**Files:**
- Create: `web/lib/hermes/events.ts`

**Functions:**

```ts
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import type { HermesJobKind, HermesJobStatus, HermesRuntimeEventInput } from "./types";

export function createHermesJob(input: {
  id?: string;
  kind: HermesJobKind;
  userId?: string;
  briefId?: string;
  researchJobId?: string;
  status?: HermesJobStatus;
  provider?: string;
  model?: string;
  request?: unknown;
}): string { ... }

export function updateHermesJob(input: {
  jobId: string;
  status: HermesJobStatus;
  provider?: string;
  model?: string;
  result?: unknown;
  error?: string;
}): void { ... }

export function appendHermesEvent(input: {
  jobId: string;
  briefId?: string;
  actorUserId?: string;
  event: HermesRuntimeEventInput;
}): void { ... }

export function listHermesEventsForBrief(input: {
  briefId: string;
  after?: number;
  limit?: number;
}): Array<{
  id: string;
  job_id: string;
  seq: number;
  event_type: string;
  title: string;
  summary: string | null;
  payload: unknown;
  created_at: number;
}> { ... }
```

**Safety requirements:**
- Sanitize/truncate `error` to 4 KB.
- Do not store raw provider headers, tokens, prompts, or cookies in `payload_json`.
- `appendHermesEvent` should compute `seq = max(seq)+1` for the job inside a transaction.
- `listHermesEventsForBrief` must cap `limit` to a safe max, e.g. 200.

**Verification:**

Run:

```bash
cd web
npm run typecheck
```

Expected: TypeScript passes.

### Task 5: Add Hermes runtime client with fake mode

**Objective:** Add a server-side client that can call a future Hermes service, while fake mode allows verification today.

**Files:**
- Create: `web/lib/hermes/client.ts`

**Core API:**

```ts
export async function runHermesResearch(req: HermesResearchRequest): Promise<HermesResearchResponse>;
export async function runHermesChat(req: HermesChatRequest): Promise<HermesChatResponse>;
export async function runHermesCanvasSynthesis(req: HermesCanvasSynthesisRequest): Promise<HermesCanvasSynthesisResponse>;
```

**Behavior:**
- If `hermesRuntimeMode() === "fake"`, return deterministic fake responses using existing fake-provider style.
- If mode is `"hermes"`, POST JSON to:
  - `${HERMES_RUNTIME_URL}/v1/research/run`
  - `${HERMES_RUNTIME_URL}/v1/chat/turn`
  - `${HERMES_RUNTIME_URL}/v1/canvas/synthesize`
- Include `Authorization: Bearer ${HERMES_SERVICE_TOKEN}` only if token is present.
- Timeout each call with `AbortController`.
- Return friendly errors; do not leak tokens/headers.
- If mode is `"direct"`, throw a clear error because direct fallback belongs in provider wrappers, not inside this client.

**Verification:**

Run:

```bash
cd web
npm run typecheck
```

Expected: TypeScript passes.

### Task 6: Add Canvas state persistence helpers

**Objective:** Persist and retrieve the latest durable Canvas JSON for a brief.

**Files:**
- Create: `web/lib/canvas/state.ts`

**Functions:**

```ts
import type { Canvas } from "./schema";

export function getCanvasState(briefId: string): Canvas | null { ... }

export function saveCanvasState(input: {
  briefId: string;
  canvas: Canvas;
  source: "deterministic" | "hermes" | "fake";
  jobId?: string;
}): void { ... }
```

**Behavior:**
- Validate minimal object shape before persisting.
- Increment `version` on update.
- Store JSON only after `JSON.stringify` succeeds.

**Verification:**

Run:

```bash
cd web
npm run typecheck
```

Expected: TypeScript passes.

### Task 7: Add local verification script for Hermes foundation

**Objective:** Provide a no-provider-spend verification command that proves migration, fake client, event persistence, and Canvas state work.

**Files:**
- Create: `web/scripts/verify-hermes-foundation.ts`
- Modify: `web/package.json` to add:

```json
"verify:hermes-foundation": "tsx scripts/verify-hermes-foundation.ts"
```

**Script behavior:**
- Set/use a temp `BRIEF_DB_PATH` if not supplied.
- Initialize DB.
- Insert a temporary user and brief or use existing helper patterns.
- Create a Hermes fake research job.
- Append at least three ordered events:
  - `job.started`
  - `canvas.widget.created`
  - `job.completed`
- Save a deterministic/fake Canvas state.
- Read events back with `after` pagination.
- Assert no raw token-looking values are present in persisted JSON.
- Print only non-secret summary:

```text
hermes_foundation_ok job=<id> events=3 canvas_version=1 db=<path>
```

**Verification:**

Run:

```bash
cd web
npm run verify:hermes-foundation
npm run typecheck
npm run build
```

Expected:
- verification script prints `hermes_foundation_ok`
- typecheck passes
- production build passes

### Task 8: Add an internal read API for brief Hermes events

**Objective:** Let the app/server and later SSE route read sanitized events for an authorized brief.

**Files:**
- Create: `web/app/api/briefs/[id]/hermes-events/route.ts`

**GET behavior:**
- Require authenticated user.
- Require `canReadBrief(user, params.id)`.
- Accept optional `after` query param as integer timestamp or event sequence cursor.
- Return JSON:

```json
{
  "events": [
    {
      "id": "...",
      "job_id": "...",
      "seq": 1,
      "event_type": "canvas.widget.created",
      "title": "...",
      "summary": "...",
      "payload": {},
      "created_at": 123
    }
  ]
}
```

**Security:**
- Unauthorized users get `401` or `404` consistent with existing brief APIs.
- Public share tokens do not use this route.
- Never return `input_json`, raw prompts, service tokens, or provider error bodies.

**Verification:**

Run:

```bash
cd web
npm run typecheck
npm run build
```

Expected: passes.

### Task 9: Documentation for runtime deployment shape

**Objective:** Record the intended production/lab architecture so implementers do not install a broad shell agent.

**Files:**
- Create: `docs/hermes-runtime-architecture.md`

**Must include:**
- Runtime Hermes is localhost/internal only.
- Operator Hermes remains external control plane for deploys.
- Runtime Hermes has no SSH/GitHub/deploy authority.
- Runtime service env vars:
  - `HERMES_RUNTIME_ENABLED`
  - `HERMES_RUNTIME_URL`
  - `HERMES_SERVICE_TOKEN`
  - `HERMES_RESEARCH_ENABLED`
  - `HERMES_CHAT_ENABLED`
  - `HERMES_CANVAS_EVENTS_ENABLED`
- Rollback: set flags to `0`, restart web/worker, direct Anthropic path remains intact.
- Lab-first validation path.

**Verification:**

Run:

```bash
git diff --check
cd web && npm run typecheck && npm run build && npm run verify:hermes-foundation
```

Expected: all pass.

---

## PR 2 detailed implementation outline: research provider adapter

Implement after PR 1 lands.

### Task 1: Split current `researchPipeline.ts`

**Files:**
- Modify: `web/lib/researchPipeline.ts`
- Create: `web/lib/research/providers.ts`
- Create: `web/lib/research/directAnthropicProvider.ts`
- Create: `web/lib/research/hermesProvider.ts`

Move the existing Anthropic logic into `DirectAnthropicResearchProvider` with minimal behavior change.

Keep exported function:

```ts
export async function runResearchPipeline(intake: Intake): Promise<PipelineResult>
```

but make it select provider:

```ts
if (process.env.RESEARCH_WORKER_FAKE_PROVIDER) return fake path;
if (hermesResearchEnabled()) return new HermesResearchProvider().run(intake);
return new DirectAnthropicResearchProvider().run(intake);
```

### Task 2: Emit Hermes events from the worker

**Files:**
- Modify: `web/lib/researchWorker.ts`

When a research job starts, create a `hermes_jobs` row linked to `research_jobs.id` and append events as stages progress.

Minimum events:
- `job.started`
- `research.progress` for source scout complete
- `research.completed` or `job.failed`
- `canvas.state.updated` if Canvas state is generated

### Task 3: Fake Hermes research E2E

Run:

```bash
cd web
HERMES_RUNTIME_FAKE=1 HERMES_RESEARCH_ENABLED=1 RESEARCH_WORKER_FAKE_PROVIDER= npm run verify:hermes-foundation
npm run typecheck
npm run build
```

Expected: fake Hermes path works without Anthropic spend.

---

## PR 3 detailed implementation outline: chat provider + live Canvas

Implement after PR 2 lands.

### Task 1: Extract chat providers from route

**Files:**
- Modify: `web/app/api/briefs/[id]/chat/route.ts`
- Create: `web/lib/chat/providers.ts`
- Create: `web/lib/chat/directAnthropicProvider.ts`
- Create: `web/lib/chat/hermesProvider.ts`

Route keeps auth, permission checks, history persistence, and final DB writes. Providers return structured output only.

### Task 2: Add SSE route

**Files:**
- Create: `web/app/api/briefs/[id]/hermes-events/stream/route.ts`

Behavior:
- Require auth and `canReadBrief`.
- Use `ReadableStream` to emit `event: hermes-event` chunks.
- Poll `hermes_job_events` every 1-2 seconds initially. Upgrade to push later only if needed.
- End stream on client disconnect.

### Task 3: Subscribe from `BriefChat` and Canvas view

**Files:**
- Modify: `web/components/BriefChat.tsx`
- Modify: `web/app/brief/[id]/page.tsx`
- Possibly modify: `web/components/canvas/ReadOnlyCanvasView.tsx`

Behavior:
- When Canvas mode or chat drawer is open, subscribe to SSE if `canvas_preview` is true.
- Show lightweight progress messages in chat for Hermes events.
- When `canvas.state.updated` arrives, fetch latest brief/canvas state.
- Do not trust event payload as authoritative state.

### Task 4: Verify no execution affordances

Browser/DOM assertions after implementation:
- No visible buttons/labels: `Run`, `Execute`, `Approve`, `Dismiss` unless a later explicit execution rails PR adds them.
- Canvas remains suggestion-only.

---

## PR 4 detailed implementation outline: lightweight runtime service, lab first

Implementation depends on the exact Hermes runtime mechanism chosen at that point. The service should satisfy the app contract, not expose generic agent capabilities.

### Preferred runtime shape

- Separate process from web and worker.
- Bind to `127.0.0.1:8787`.
- Shared secret bearer token from env.
- PM2 name in lab: `account-brief-hermes-runtime`.
- No public nginx route.
- No GitHub token.
- No SSH key.
- No deploy scripts.
- No direct broad DB shell mutation.

### Minimum routes

- `GET /health`
- `POST /v1/research/run`
- `POST /v1/chat/turn`
- `POST /v1/canvas/synthesize`

### Model-routing policy file

A config file or env mapping should route by capability, not by hard-coded app calls:

```json
{
  "source_scout": { "provider": "fast_search_capable", "quality": "fast" },
  "research_synthesis": { "provider": "strong_reasoning", "quality": "high" },
  "chat": { "provider": "balanced", "quality": "interactive" },
  "canvas_synthesis": { "provider": "strong_structured", "quality": "high" },
  "json_repair": { "provider": "cheap_structured", "quality": "fast" }
}
```

The app should never need to know provider names.

---

## Required PR report-back fields

For each implementation PR, report:

- Branch name
- Commit SHA
- PR URL
- Files changed
- Feature flags added/changed
- DB migrations added/changed
- Verification commands run with exact results
- Whether any live model/provider calls were made
- Whether public routes or public-share behavior changed
- Rollback path
- Known caveats/blockers

## Final acceptance criteria for the full program

The architecture is complete when:

1. New research can run through Hermes runtime with `HERMES_RESEARCH_ENABLED=1`.
2. Brief chat can run through Hermes runtime with `HERMES_CHAT_ENABLED=1`.
3. Canvas can update from durable Hermes events/state without a page reload.
4. Direct Anthropic fallback still works when Hermes flags are off.
5. Fake/no-spend verification path works in CI/local/lab.
6. Runtime Hermes is not publicly exposed.
7. Runtime Hermes has no deploy/GitHub/SSH/sudo authority.
8. Production operator deploy reports include both app health and Hermes runtime health.
9. Suggested actions remain suggestion-only until separate approval/audit/execution rails are built.
