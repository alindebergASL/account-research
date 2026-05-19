// Typed Hermes runtime contract.
//
// Pure types. No runtime code, no side effects. This file is the
// authoritative shape of the JSON exchanged between the app server and
// the future runtime Hermes service. Defining it before any service
// exists lets us iterate on the contract (and the fake client) without
// blocking on infra.

import type { Brief, BriefExtension } from "../schema";
import type { Canvas } from "../canvas/schema";
import type { BriefPatch } from "../briefPatches";
import type { Intake, ResearchMode } from "../researchPipeline";

// ---- Jobs / events ---------------------------------------------------------

export type HermesJobKind = "research" | "chat" | "canvas_synthesis";

export type HermesJobStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

// Event kinds we persist. Keep this list explicit so the read API and
// future SSE adapter can validate against a closed set.
export type HermesEventKind =
  | "job.started"
  | "job.progress"
  | "job.completed"
  | "job.failed"
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
  | "canvas.state.updated";

export type HermesJob = {
  id: string;
  kind: HermesJobKind;
  status: HermesJobStatus;
  user_id: string | null;
  brief_id: string | null;
  research_job_id: string | null;
  provider: string | null;
  model: string | null;
  fake: boolean;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
};

export type HermesJobEvent = {
  id: string;
  job_id: string;
  brief_id: string | null;
  actor_user_id: string | null;
  seq: number;
  kind: HermesEventKind | string;
  title: string;
  summary: string | null;
  payload: Record<string, unknown> | null;
  created_at: number;
};

export type HermesRuntimeEventInput = {
  type: HermesEventKind;
  title: string;
  summary?: string;
  payload?: Record<string, unknown>;
};

export type HermesUsage = {
  provider?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd_cents?: number;
};

// ---- Research --------------------------------------------------------------

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

// ---- Chat ------------------------------------------------------------------

export type HermesChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type HermesChatRequest = {
  job_id?: string;
  brief_id: string;
  user_id: string;
  brief: Brief;
  history: HermesChatMessage[];
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

// ---- Canvas synthesis ------------------------------------------------------

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

// ---- Canvas persisted state ------------------------------------------------

// Shape of the JSON blob stored in `canvas_states.state_json`. The
// Canvas schema itself lives in `lib/canvas/schema.ts`; this wrapper
// just records the source-of-truth canvas plus a small provenance tag.
export type CanvasStateSource = "deterministic" | "hermes" | "fake";

export type CanvasState = {
  canvas: Canvas;
  source: CanvasStateSource;
  job_id?: string | null;
};
