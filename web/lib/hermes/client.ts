// Hermes runtime client.
//
// Selects between three modes based on env (see `./config.ts`):
//   - "fake":   deterministic stub responses. NO network, NO model calls.
//               Used by the lab verification script and PR-2/3 worker tests.
//   - "hermes": POST JSON to a localhost-only runtime service. Bearer
//               token is included ONLY when `HERMES_SERVICE_TOKEN` is set.
//               Per-call timeout via AbortController. All error strings
//               are sanitized so headers / tokens / cookies cannot leak
//               into logs or events.
//   - "direct": throws. Direct-provider fallback is the job of the
//               per-feature provider wrappers (research / chat), not
//               this client.
//
// This module makes NO live model calls in any mode. The "hermes" mode
// only ever talks to `HERMES_RUNTIME_URL` (default 127.0.0.1:8787),
// which is a future internal service — not a public API.
import { buildReadOnlyCanvasFromBrief } from "../canvas/fromBrief";
import {
  getHermesRuntimeUrlChecked,
  hermesRuntimeMode,
  hermesServiceToken,
} from "./config";
import { redactSensitiveString } from "./sanitize";
import type {
  HermesCanvasSynthesisRequest,
  HermesCanvasSynthesisResponse,
  HermesChatRequest,
  HermesChatResponse,
  HermesResearchRequest,
  HermesResearchResponse,
} from "./types";

const RESEARCH_TIMEOUT_MS = 60_000;
const CHAT_TIMEOUT_MS = 30_000;
const CANVAS_TIMEOUT_MS = 60_000;

let testChatRunner: ((req: HermesChatRequest) => Promise<HermesChatResponse>) | null = null;

export function __setTestHermesChatRunner(
  runner: ((req: HermesChatRequest) => Promise<HermesChatResponse>) | null,
): void {
  testChatRunner = runner;
}

export class HermesRuntimeDisabledError extends Error {
  constructor() {
    super(
      "Hermes runtime not enabled. Set HERMES_RUNTIME_ENABLED=1 (or HERMES_RUNTIME_FAKE=1 for lab use).",
    );
    this.name = "HermesRuntimeDisabledError";
  }
}

export class HermesRuntimeError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "HermesRuntimeError";
  }
}

// Strip anything that could carry a token / cookie / header out of an
// error string before it bubbles up to logs or event payloads. Shared
// with the write/read sanitizers via `./sanitize`.
const sanitizeErr = redactSensitiveString;

async function postJson<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  // Loopback-only enforcement: refuse to issue a runtime fetch if the
  // configured URL is not on 127.0.0.1 / ::1 / localhost. Throws a
  // typed, fixed-string error — the env value is NOT interpolated.
  const base = getHermesRuntimeUrlChecked();
  const url = `${base}${path}`;
  const token = hermesServiceToken();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      // Don't surface response body — it may contain provider headers /
      // upstream tokens. Operators see status + path in our logs only.
      throw new HermesRuntimeError(
        `Hermes runtime returned status ${res.status} for ${path}`,
        res.status,
      );
    }
    const data = (await res.json()) as T;
    return data;
  } catch (e: any) {
    if (e instanceof HermesRuntimeError) throw e;
    const raw = typeof e?.message === "string" ? e.message : String(e);
    if (e?.name === "AbortError") {
      throw new HermesRuntimeError(`Hermes runtime timeout for ${path}`);
    }
    throw new HermesRuntimeError(
      `Hermes runtime call failed for ${path}: ${sanitizeErr(raw)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

// ---- fake responses --------------------------------------------------------
//
// Deterministic stubs. Same input -> same output. Tiny fixed strings, no
// model spend, no network. Sufficient to prove plumbing in lab and CI.

function fakeResearch(req: HermesResearchRequest): HermesResearchResponse {
  const accountName = req.intake?.account ?? "Unknown";
  return {
    brief: {
      account_name: accountName,
      segment: req.intake?.segment ?? "Unknown",
      audience: "internal",
      generated_at: "1970-01-01",
      snapshot: `[fake] Hermes runtime snapshot for ${accountName}.`,
      priority_summary: "[fake] no live model was called.",
      recent_signals: [],
      ai_tech_maturity: { rating: 1, rationale: "[fake]" },
      top_initiatives: [],
      technical_footprint: {
        ai_in_production: [],
        active_pilots: [],
        cloud_platforms: [],
        data_infrastructure: "[fake]",
        clinical_platforms: "[fake]",
        analytics_bi_stack: "[fake]",
        build_vs_buy_posture: "[fake]",
        competitive_incumbents: [],
      },
      programs_procurement: {
        modernization_grants: [],
        consortium_purchasing: [],
        active_rfps_contracts: [],
        ai_governance_policy: "[fake]",
        public_ai_use_cases: [],
      },
      personas: [],
      buying_path: "[fake]",
      first_angle: "[fake]",
      risks: [],
      competitive_signals: [],
      next_action: "[fake]",
      extensions: [],
      sources: [],
    } satisfies HermesResearchResponse["brief"],
    stages: [{ provider: "fake", model: "fake-1", input_tokens: 0, output_tokens: 0 }],
    quality: {
      filled: 0,
      total: 0,
      low: true,
      repaired: false,
      research_attempts: 0,
      source_candidates: 0,
      mode: req.mode,
    },
    events: [
      { type: "job.started", title: "fake research started" },
      { type: "research.completed", title: "fake research completed" },
    ],
  };
}

function fakeChat(req: HermesChatRequest): HermesChatResponse {
  const canvas = req.can_write
    ? buildReadOnlyCanvasFromBrief({ briefId: req.brief_id, brief: req.brief })
    : undefined;
  return {
    reply: `[fake] Hermes chat received: "${req.message.slice(0, 64)}"`,
    patches_applied: [],
    patch_errors: [],
    canvas,
    events: [
      { type: "chat.message", title: "fake chat reply" },
      ...(canvas
        ? [
            {
              type: "canvas.synthesis.started" as const,
              title: "fake canvas synthesis",
              payload: { trigger: "chat", fake: true },
            },
          ]
        : []),
    ],
  };
}

function fakeCanvas(req: HermesCanvasSynthesisRequest): HermesCanvasSynthesisResponse {
  return {
    // Empty-shaped canvas. The real Canvas schema (lib/canvas/schema.ts)
    // accepts {widgets: []} as a valid minimal state.
    canvas: { widgets: [] } as unknown as HermesCanvasSynthesisResponse["canvas"],
    events: [
      { type: "canvas.synthesis.started", title: "fake canvas synthesis" },
      {
        type: "canvas.state.updated",
        title: "fake canvas state updated",
        payload: { trigger: req.trigger },
      },
    ],
  };
}

// ---- public API ------------------------------------------------------------

export async function runHermesResearch(
  req: HermesResearchRequest,
): Promise<HermesResearchResponse> {
  const mode = hermesRuntimeMode();
  if (mode === "fake") return fakeResearch(req);
  if (mode === "hermes")
    return postJson<HermesResearchResponse>("/v1/research", req, RESEARCH_TIMEOUT_MS);
  throw new HermesRuntimeDisabledError();
}

export async function runHermesChat(
  req: HermesChatRequest,
): Promise<HermesChatResponse> {
  if (testChatRunner) return testChatRunner(req);
  const mode = hermesRuntimeMode();
  if (mode === "fake") return fakeChat(req);
  if (mode === "hermes")
    return postJson<HermesChatResponse>("/v1/chat", req, CHAT_TIMEOUT_MS);
  throw new HermesRuntimeDisabledError();
}

export async function runHermesCanvasSynthesis(
  req: HermesCanvasSynthesisRequest,
): Promise<HermesCanvasSynthesisResponse> {
  const mode = hermesRuntimeMode();
  if (mode === "fake") return fakeCanvas(req);
  if (mode === "hermes")
    return postJson<HermesCanvasSynthesisResponse>(
      "/v1/canvas-synthesis",
      req,
      CANVAS_TIMEOUT_MS,
    );
  throw new HermesRuntimeDisabledError();
}
