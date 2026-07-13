// Hermes research adapter.
//
// Routes a research request through the Hermes runtime client and
// persists a `hermes_jobs` row + sanitized event trail. Lives behind
// `HERMES_RESEARCH_ENABLED=1`: the dispatcher in `researchPipeline.ts`
// only calls into this module when the flag is on.
//
// In `HERMES_RUNTIME_FAKE=1` mode the client returns deterministic
// data with no network and no model spend. In real ("hermes") mode the
// client enforces a loopback URL. In any failure path the caller
// (researchPipeline dispatcher) decides whether to fall back to the
// direct Anthropic path.
//
// NEVER persists raw prompts, raw provider response bodies, provider
// headers, cookies, or bearer tokens — only sanitized summaries flow
// into `hermes_jobs` / `hermes_job_events`.

import { hermesRuntimeFake } from "./config";
import {
  HermesRuntimeDisabledError,
  HermesRuntimeError,
  runHermesResearch,
} from "./client";
import {
  appendHermesEvent,
  createHermesJob,
  updateHermesJob,
} from "./events";
import { redactSensitiveString } from "./sanitize";
import type {
  HermesResearchRequest,
  HermesResearchResponse,
  HermesRuntimeEventInput,
} from "./types";
import { assertProviderCallsEnabled } from "../providerAccess";
import type {
  Intake,
  PipelineResult,
  ResearchMode,
} from "../researchPipeline";

export type HermesResearchAdapterContext = {
  brief_id?: string | null;
  user_id: string;
};

export class HermesResearchAdapterError extends Error {
  readonly jobId: string;
  readonly kind: "runtime_disabled" | "runtime_error" | "unknown";
  constructor(jobId: string, kind: HermesResearchAdapterError["kind"], message: string) {
    super(message);
    this.name = "HermesResearchAdapterError";
    this.jobId = jobId;
    this.kind = kind;
  }
}

function resolveMode(intake: Intake): ResearchMode {
  return intake.mode === "quick" || intake.mode === "deep" ? intake.mode : "standard";
}

// Build a sanitization-friendly summary of the intake. Never includes
// `notes` (which can contain sensitive internal text) or raw prompts.
function inputSummary(intake: Intake, mode: ResearchMode): Record<string, unknown> {
  return {
    account_name: intake.account,
    segment: intake.segment ?? null,
    region: intake.region ?? null,
    audience: intake.audience ?? "internal",
    mode,
    has_goal: Boolean(intake.goal && intake.goal.trim().length > 0),
    has_notes: Boolean(intake.notes && intake.notes.trim().length > 0),
  };
}

function resultSummary(resp: HermesResearchResponse): Record<string, unknown> {
  const stages = Array.isArray(resp.stages) ? resp.stages : [];
  return {
    mode: resp.quality?.mode ?? null,
    filled: resp.quality?.filled ?? null,
    total: resp.quality?.total ?? null,
    low: resp.quality?.low ?? null,
    repaired: resp.quality?.repaired ?? null,
    research_attempts: resp.quality?.research_attempts ?? null,
    source_candidates: resp.quality?.source_candidates ?? null,
    stage_count: stages.length,
    // intentionally do NOT include raw stage usage objects beyond count
  };
}

function classifyError(err: unknown): {
  kind: HermesResearchAdapterError["kind"];
  message: string;
} {
  if (err instanceof HermesRuntimeDisabledError) {
    return { kind: "runtime_disabled", message: "Hermes runtime not enabled" };
  }
  if (err instanceof HermesRuntimeError) {
    return {
      kind: "runtime_error",
      message: redactSensitiveString(err.message ?? "Hermes runtime error"),
    };
  }
  const raw = err instanceof Error ? err.message : String(err);
  return { kind: "unknown", message: redactSensitiveString(raw || "unknown error") };
}

// Map a HermesResearchResponse into the existing PipelineResult shape.
// The pipeline-public Brief shape and quality block are preserved
// verbatim from the runtime response. Stages are mapped to `StageUsage`-
// compatible objects; the `usage` field is best-effort (the foundation
// types only expose input/output tokens).
function toPipelineResult(resp: HermesResearchResponse): PipelineResult {
  const stages = (resp.stages ?? []).map((s, i) => ({
    name: `hermes_${i}`,
    model: s.model ?? "hermes",
    usage: {
      input_tokens: s.input_tokens ?? 0,
      output_tokens: s.output_tokens ?? 0,
    } as any,
  }));
  return {
    brief: resp.brief,
    stages,
    quality: resp.quality,
  };
}

function appendRuntimeEvents(
  jobId: string,
  briefId: string | null | undefined,
  events: HermesRuntimeEventInput[] | undefined,
): void {
  if (!events || events.length === 0) return;
  for (const ev of events) {
    try {
      appendHermesEvent({
        job_id: jobId,
        brief_id: briefId ?? null,
        kind: ev.type,
        title: ev.title,
        summary: ev.summary ?? null,
        payload: ev.payload ?? null,
      });
    } catch {
      // Event recording must never crash the research path.
    }
  }
}

export async function runResearchViaHermes(
  input: Intake,
  ctx: HermesResearchAdapterContext,
): Promise<PipelineResult> {
  assertProviderCallsEnabled();
  const mode = resolveMode(input);
  const fake = hermesRuntimeFake();

  const jobId = createHermesJob({
    kind: "research",
    user_id: ctx.user_id,
    brief_id: ctx.brief_id ?? null,
    fake,
    status: "running",
  });
  const startedAt = Date.now();
  updateHermesJob(jobId, { started_at: startedAt });

  appendHermesEvent({
    job_id: jobId,
    brief_id: ctx.brief_id ?? null,
    actor_user_id: ctx.user_id,
    kind: "job.started",
    title: "research started",
    payload: { input_summary: inputSummary(input, mode) },
  });

  const req: HermesResearchRequest = {
    job_id: jobId,
    user_id: ctx.user_id,
    intake: input,
    mode,
    brief_id: ctx.brief_id ?? undefined,
  };

  try {
    const resp = await runHermesResearch(req);
    if (Buffer.byteLength(JSON.stringify(resp.brief ?? null), "utf8") > 512 * 1024) {
      throw new Error("Hermes research output exceeded the allowed size");
    }

    // Forward sanitized runtime events (e.g. fake "research.completed").
    appendRuntimeEvents(jobId, ctx.brief_id ?? null, resp.events);

    appendHermesEvent({
      job_id: jobId,
      brief_id: ctx.brief_id ?? null,
      kind: "job.completed",
      title: "research completed",
      payload: { result_summary: resultSummary(resp) },
    });
    updateHermesJob(jobId, {
      status: "done",
      finished_at: Date.now(),
    });

    return toPipelineResult(resp);
  } catch (err) {
    const { kind, message } = classifyError(err);
    appendHermesEvent({
      job_id: jobId,
      brief_id: ctx.brief_id ?? null,
      kind: "job.failed",
      title: "research failed",
      payload: { error_kind: kind, error_message: message },
    });
    updateHermesJob(jobId, {
      status: "failed",
      finished_at: Date.now(),
      error: message,
    });
    throw new HermesResearchAdapterError(jobId, kind, message);
  }
}

// Pure helper exposed for verification: returns which research path
// the dispatcher would select for the current env, WITHOUT calling
// either provider. Keeps the "disabled-flag" verification branch from
// touching Anthropic at all.
export function selectResearchPath(): "hermes" | "direct" {
  return process.env.HERMES_RESEARCH_ENABLED === "1" ? "hermes" : "direct";
}
