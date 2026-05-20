// Hermes chat adapter.
//
// Routes brief chat through the Hermes runtime client behind
// HERMES_CHAT_ENABLED=1 while preserving the existing Anthropic route as
// fallback. This adapter owns Hermes job/event persistence and durable
// Canvas state writes returned by the runtime. It never makes direct model
// calls; fake mode is deterministic and no-spend via client.ts.

import { saveCanvasState } from "../canvas/state";
import { ingestCanvasResponse } from "./canvasGenerativeGateway";
import { applyPatches, type BriefPatch } from "../briefPatches";
import { Brief, type Brief as BriefT } from "../schema";
import { hermesCanvasProposalsEnabled, hermesChatEnabled, hermesRuntimeFake } from "./config";
import {
  HermesRuntimeDisabledError,
  HermesRuntimeError,
  runHermesChat,
} from "./client";
import {
  appendHermesEvent,
  createHermesJob,
  updateHermesJob,
} from "./events";
import { redactSensitiveString } from "./sanitize";
import type {
  HermesChatMessage,
  HermesChatRequest,
  HermesChatResponse,
  HermesRuntimeEventInput,
} from "./types";

export type ChatProviderResult = {
  reply: string;
  patches_applied: BriefPatch[];
  patch_errors: string[];
  brief?: BriefT;
  canvas_version?: number;
};

export type HermesChatAdapterContext = {
  brief_id: string;
  user_id: string;
  brief: BriefT;
  history: HermesChatMessage[];
  message: string;
  can_write: boolean;
};

export class HermesChatAdapterError extends Error {
  readonly jobId: string;
  readonly kind: "runtime_disabled" | "runtime_error" | "unknown";
  constructor(jobId: string, kind: HermesChatAdapterError["kind"], message: string) {
    super(message);
    this.name = "HermesChatAdapterError";
    this.jobId = jobId;
    this.kind = kind;
  }
}

function classifyError(err: unknown): {
  kind: HermesChatAdapterError["kind"];
  message: string;
} {
  if (err instanceof HermesRuntimeDisabledError) {
    return { kind: "runtime_disabled", message: "Hermes runtime not enabled" };
  }
  if (err instanceof HermesRuntimeError) {
    return {
      kind: "runtime_error",
      message: redactSensitiveString(err.message || "Hermes runtime error"),
    };
  }
  const raw = err instanceof Error ? err.message : String(err);
  return { kind: "unknown", message: redactSensitiveString(raw || "unknown error") };
}

function appendRuntimeEvents(
  jobId: string,
  briefId: string,
  actorUserId: string,
  events: HermesRuntimeEventInput[] | undefined,
): void {
  if (!events || events.length === 0) return;
  for (const ev of events) {
    try {
      appendHermesEvent({
        job_id: jobId,
        brief_id: briefId,
        actor_user_id: actorUserId,
        kind: ev.type,
        title: ev.title,
        summary: ev.summary ?? null,
        payload: ev.payload ?? null,
      });
    } catch {
      // Event recording must never crash chat.
    }
  }
}

function safePatchCount(resp: HermesChatResponse): number {
  return Array.isArray(resp.patches_applied) ? resp.patches_applied.length : 0;
}

function validateWritableResponse(
  baseBrief: BriefT,
  resp: HermesChatResponse,
): { brief?: BriefT; patches: BriefPatch[]; errors: string[] } {
  const errors = Array.isArray(resp.patch_errors) ? [...resp.patch_errors] : [];
  const patches = Array.isArray(resp.patches_applied) ? resp.patches_applied : [];

  if (resp.brief) {
    const parsed = Brief.safeParse(resp.brief);
    if (parsed.success) return { brief: parsed.data, patches, errors };
    errors.push("Hermes returned invalid brief JSON");
    return { patches: [], errors };
  }

  if (patches.length > 0) {
    try {
      const patched = applyPatches(baseBrief, patches);
      const parsed = Brief.safeParse(patched);
      if (!parsed.success) throw new Error("schema validation failed");
      return { brief: parsed.data, patches, errors };
    } catch (e: any) {
      errors.push(`Hermes patches rejected: ${e?.message ?? String(e)}`);
      return { patches: [], errors };
    }
  }

  return { patches, errors };
}

export async function runChatViaHermes(
  ctx: HermesChatAdapterContext,
): Promise<ChatProviderResult> {
  const fake = hermesRuntimeFake();
  const jobId = createHermesJob({
    kind: "chat",
    user_id: ctx.user_id,
    brief_id: ctx.brief_id,
    fake,
    status: "running",
  });
  updateHermesJob(jobId, { started_at: Date.now() });

  appendHermesEvent({
    job_id: jobId,
    brief_id: ctx.brief_id,
    actor_user_id: ctx.user_id,
    kind: "chat.started",
    title: "chat started",
    payload: {
      can_write: ctx.can_write,
      history_count: ctx.history.length,
      fake,
    },
  });

  const req: HermesChatRequest = {
    job_id: jobId,
    brief_id: ctx.brief_id,
    user_id: ctx.user_id,
    brief: ctx.brief,
    history: ctx.history,
    message: ctx.message,
    can_write: ctx.can_write,
  };

  try {
    const resp = await runHermesChat(req);
    appendRuntimeEvents(jobId, ctx.brief_id, ctx.user_id, resp.events);

    const result: ChatProviderResult = {
      reply: resp.reply || "(no reply)",
      patches_applied: [],
      patch_errors: [],
    };

    if (ctx.can_write) {
      const writable = validateWritableResponse(ctx.brief, resp);
      result.patches_applied = writable.patches;
      result.patch_errors = writable.errors;
      if (writable.brief) result.brief = writable.brief;

      if (hermesCanvasProposalsEnabled()) {
        ingestCanvasResponse(
          {
            briefId: ctx.brief_id,
            userId: ctx.user_id,
            jobId,
            proposedBy: "hermes",
            canWrite: ctx.can_write,
            requestId: jobId,
          },
          resp,
        );
      } else if (resp.canvas && typeof resp.canvas === "object") {
        const saved = saveCanvasState({
          briefId: ctx.brief_id,
          canvas: resp.canvas,
          source: fake ? "fake" : "hermes",
          jobId,
        });
        result.canvas_version = saved.version;
        appendHermesEvent({
          job_id: jobId,
          brief_id: ctx.brief_id,
          actor_user_id: ctx.user_id,
          kind: "canvas.state.updated",
          title: "canvas state updated",
          payload: { version: saved.version, fake },
        });
      }
    } else {
      // Read-only sharees/viewers may chat, but Hermes output is constrained
      // to text only at this boundary even if a runtime misbehaves.
      result.patch_errors = [];
      result.patches_applied = [];
    }

    appendHermesEvent({
      job_id: jobId,
      brief_id: ctx.brief_id,
      actor_user_id: ctx.user_id,
      kind: "job.completed",
      title: "chat completed",
      payload: {
        patch_count: result.patches_applied.length || safePatchCount(resp),
        canvas_version: result.canvas_version ?? null,
        fake,
      },
    });
    updateHermesJob(jobId, { status: "done", finished_at: Date.now() });
    return result;
  } catch (err) {
    const { kind, message } = classifyError(err);
    appendHermesEvent({
      job_id: jobId,
      brief_id: ctx.brief_id,
      actor_user_id: ctx.user_id,
      kind: "job.failed",
      title: "chat failed",
      payload: { error_kind: kind, error_message: message },
    });
    updateHermesJob(jobId, {
      status: "failed",
      finished_at: Date.now(),
      error: message,
    });
    throw new HermesChatAdapterError(jobId, kind, message);
  }
}

export function selectChatPath(): "hermes" | "direct" {
  return hermesChatEnabled() ? "hermes" : "direct";
}
