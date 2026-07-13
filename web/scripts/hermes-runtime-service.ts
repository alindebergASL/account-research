// Lab-only lightweight Hermes runtime service.
//
// This is intentionally NOT a shell/deploy agent. It is a narrow,
// localhost-bound JSON service that implements the contract consumed by
// lib/hermes/client.ts. In this first PR it only supports deterministic
// fake/no-spend responses so the lab can prove app -> runtime -> Canvas
// plumbing without provider credentials or production authority.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadEnvConfig } from "@next/env";
import { buildReadOnlyCanvasFromBrief } from "../lib/canvas/fromBrief";
import {
  assertRuntimeServiceAuthConfigured,
  runtimeServiceAuthConfigFromEnv,
  runtimeServiceAuthorized,
} from "../lib/hermes/runtimeServiceAuth";

loadEnvConfig(process.cwd());
import type {
  HermesCanvasSynthesisRequest,
  HermesCanvasSynthesisResponse,
  HermesChatRequest,
  HermesChatResponse,
  HermesResearchRequest,
  HermesResearchResponse,
} from "../lib/hermes/types";

const SERVICE_NAME = "account-research-hermes-runtime";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 1_000_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

type JsonRecord = Record<string, unknown>;

function bindHost(): string {
  return process.env.HERMES_RUNTIME_BIND_HOST || DEFAULT_HOST;
}

function bindPort(): number {
  const raw = process.env.HERMES_RUNTIME_PORT || String(DEFAULT_PORT);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error("HERMES_RUNTIME_PORT must be a valid TCP port");
  }
  return parsed;
}

function fakeMode(): boolean {
  return process.env.HERMES_RUNTIME_FAKE === "1" || process.env.NODE_ENV !== "production";
}

function serviceToken(): string | null {
  const token = process.env.HERMES_SERVICE_TOKEN?.trim();
  return token && token.length > 0 ? token : null;
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization || "";
  const value = Array.isArray(header) ? header[0] || "" : header;
  return runtimeServiceAuthorized(runtimeServiceAuthConfigFromEnv(), value || undefined);
}

function sendJson(res: ServerResponse, status: number, body: JsonRecord): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function methodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, { ok: false, error: "method_not_allowed" });
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { ok: false, error: "not_found" });
}

function unauthorizedResponse(res: ServerResponse): void {
  sendJson(res, 401, { ok: false, error: "unauthorized" });
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text.length ? JSON.parse(text) : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
  });
}

function fakeResearch(req: HermesResearchRequest): HermesResearchResponse {
  const accountName = req.intake?.account ?? "Unknown";
  return {
    brief: {
      account_name: accountName,
      segment: req.intake?.segment ?? "Unknown",
      audience: "internal",
      generated_at: "1970-01-01",
      snapshot: `[runtime fake] Hermes runtime snapshot for ${accountName}.`,
      priority_summary: "[runtime fake] no live model was called.",
      recent_signals: [],
      ai_tech_maturity: { rating: 1, rationale: "[runtime fake]" },
      top_initiatives: [],
      technical_footprint: {
        ai_in_production: [],
        active_pilots: [],
        cloud_platforms: [],
        data_infrastructure: "[runtime fake]",
        clinical_platforms: "[runtime fake]",
        analytics_bi_stack: "[runtime fake]",
        build_vs_buy_posture: "[runtime fake]",
        competitive_incumbents: [],
      },
      programs_procurement: {
        modernization_grants: [],
        consortium_purchasing: [],
        active_rfps_contracts: [],
        ai_governance_policy: "[runtime fake]",
        public_ai_use_cases: [],
      },
      personas: [],
      buying_path: "[runtime fake]",
      first_angle: "[runtime fake]",
      risks: [],
      competitive_signals: [],
      next_action: "[runtime fake]",
      extensions: [],
      sources: [],
    },
    stages: [{ provider: "runtime-fake", model: "local-contract-1", input_tokens: 0, output_tokens: 0 }],
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
      { type: "job.started", title: "runtime fake research started" },
      { type: "research.completed", title: "runtime fake research completed" },
    ],
  };
}

function fakeChat(req: HermesChatRequest): HermesChatResponse {
  const canvas = req.can_write
    ? buildReadOnlyCanvasFromBrief({ briefId: req.brief_id, brief: req.brief })
    : undefined;
  return {
    reply: `[runtime fake] Hermes runtime received: "${String(req.message || "").slice(0, 64)}"`,
    patches_applied: [],
    patch_errors: [],
    canvas,
    events: [
      { type: "chat.message", title: "runtime fake chat reply" },
      ...(canvas
        ? [
            {
              type: "canvas.synthesis.started" as const,
              title: "runtime fake canvas synthesis",
              payload: { trigger: "chat", fake: true, service: SERVICE_NAME },
            },
          ]
        : []),
    ],
  };
}

function fakeCanvas(req: HermesCanvasSynthesisRequest): HermesCanvasSynthesisResponse {
  const canvas = buildReadOnlyCanvasFromBrief({ briefId: req.brief_id, brief: req.brief });
  return {
    canvas,
    events: [
      { type: "canvas.synthesis.started", title: "runtime fake canvas synthesis" },
      {
        type: "canvas.state.updated",
        title: "runtime fake canvas state updated",
        payload: { trigger: req.trigger, fake: true, service: SERVICE_NAME },
      },
    ],
  };
}

async function handlePost<T>(
  req: IncomingMessage,
  res: ServerResponse,
  fn: (body: T) => JsonRecord,
): Promise<void> {
  if (req.method !== "POST") return methodNotAllowed(res);
  if (!authorized(req)) return unauthorizedResponse(res);
  if (!fakeMode()) {
    // Until live providers/model routing land, refuse to pretend we did
    // real work. This keeps PR4 lab-only and no-spend by construction.
    return sendJson(res, 503, { ok: false, error: "runtime_live_mode_not_implemented" });
  }
  try {
    const body = (await readJson(req)) as T;
    sendJson(res, 200, fn(body));
  } catch (e: any) {
    sendJson(res, 400, { ok: false, error: e?.message === "request body too large" ? "body_too_large" : "bad_request" });
  }
}

function routePath(req: IncomingMessage): string {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  return url.pathname;
}

const host = bindHost();
if (!LOOPBACK_HOSTS.has(host)) {
  throw new Error("Hermes runtime service refuses to bind non-loopback host");
}
const port = bindPort();
assertRuntimeServiceAuthConfigured(runtimeServiceAuthConfigFromEnv());

const server = createServer(async (req, res) => {
  const path = routePath(req);
  if (path === "/health") {
    if (req.method !== "GET") return methodNotAllowed(res);
    if (!authorized(req)) return unauthorizedResponse(res);
    return sendJson(res, 200, {
      ok: true,
      service: SERVICE_NAME,
      bind: host,
      port,
      fake: fakeMode(),
      auth_required: Boolean(serviceToken()),
    });
  }

  if (path === "/v1/research" || path === "/v1/research/run") {
    return handlePost<HermesResearchRequest>(req, res, fakeResearch as unknown as (body: HermesResearchRequest) => JsonRecord);
  }
  if (path === "/v1/chat" || path === "/v1/chat/turn") {
    return handlePost<HermesChatRequest>(req, res, fakeChat as unknown as (body: HermesChatRequest) => JsonRecord);
  }
  if (path === "/v1/canvas-synthesis" || path === "/v1/canvas/synthesize") {
    return handlePost<HermesCanvasSynthesisRequest>(req, res, fakeCanvas as unknown as (body: HermesCanvasSynthesisRequest) => JsonRecord);
  }
  return notFound(res);
});

server.listen(port, host, () => {
  // Keep startup log non-secret; never print token/env values.
  // eslint-disable-next-line no-console
  console.log(`${SERVICE_NAME} listening on ${host}:${port} fake=${fakeMode()} auth=${Boolean(serviceToken())}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
