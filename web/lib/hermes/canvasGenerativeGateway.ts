import { db, type CanvasCapabilityProposalRow, type CanvasProposalRow } from "../db";
import { newId } from "../password";
import { createBriefEvent } from "../briefEvents";
import { getCanvasState, saveCanvasState } from "../canvas/state";
import { isCanvasDocument, isLegacyCanvas, legacyCanvasToDocument } from "../canvas/legacy";
import { CanvasDocument, type CanvasDocument as CanvasDocumentType } from "../canvas/document";
import { CanvasAction, WidgetCapabilityProposal, actionLayer, canSourcePropose, isAutoApplyAction, type CanvasAction as CanvasActionType, type WidgetCapabilityProposal as WidgetCapabilityProposalType } from "../canvas/actions";
import { reduceCanvasAction } from "../canvas/reducer";
import { hermesGenerativeCanvasEnabled } from "./config";
import { appendHermesEvent } from "./events";
import type { HermesCanvasSynthesisResponse, HermesChatResponse } from "./types";

export type ProposalStatus = CanvasProposalRow["status"];

export type CanvasGatewayContext = {
  briefId: string;
  userId?: string | null;
  jobId?: string | null;
  proposedBy?: "hermes" | "user" | "system";
  canWrite?: boolean;
  requestId?: string | null;
};

type ParsedProposal = CanvasProposalRow & { payload: unknown; evidence: unknown[] };
type ParsedCapabilityProposal = CanvasCapabilityProposalRow & { data_schema: unknown; example_data: unknown; primitive_fallback: unknown; evidence: unknown[] };

function json(value: unknown): string {
  return JSON.stringify(value);
}

function confidenceFor(action: CanvasActionType): string {
  const p = action.payload as { confidence?: string };
  return p.confidence ?? "Medium";
}

function rationaleFor(action: CanvasActionType): string {
  const p = action.payload as { rationale?: string };
  return p.rationale ?? "";
}

function evidenceFor(action: CanvasActionType): unknown[] {
  const p = action.payload as { evidence?: unknown[] };
  return Array.isArray(p.evidence) ? p.evidence : [];
}

export function getCurrentCanvasDocument(briefId: string): { document: CanvasDocumentType; stateVersion: number; raw: unknown } {
  const state = getCanvasState(briefId);
  if (state?.canvas && isCanvasDocument(state.canvas)) return { document: state.canvas, stateVersion: state.version, raw: state.canvas };
  if (state?.canvas && isLegacyCanvas(state.canvas)) {
    return { document: legacyCanvasToDocument(state.canvas, briefId), stateVersion: state.version, raw: state.canvas };
  }
  const at = new Date().toISOString();
  return {
    stateVersion: state?.version ?? 0,
    raw: state?.canvas ?? null,
    document: CanvasDocument.parse({
      schema_version: 1,
      document_id: `empty-${briefId}`,
      brief_id: briefId,
      version: state?.version ?? 0,
      generated_at: at,
      generated_by: { kind: "system", at },
      nodes: [],
      edges: [],
      sections: [],
      layout: { mode: "grid", grid: { cols: 12, cells: [] } },
      views: [],
      rationale: [],
      meta: {},
    }),
  };
}

function appendDecisionEvent(ctx: CanvasGatewayContext, kind: Parameters<typeof appendHermesEvent>[0]["kind"], title: string, payload: Record<string, unknown>): void {
  if (!ctx.jobId) return;
  appendHermesEvent({ job_id: ctx.jobId, brief_id: ctx.briefId, actor_user_id: ctx.userId ?? null, kind, title, payload });
}

function duplicateProposalId(briefId: string, requestId: string, requestActionIndex: number): string | null {
  const row = db().prepare(
    `SELECT id FROM canvas_proposals WHERE brief_id = ? AND request_id = ? AND request_action_index = ?`,
  ).get(briefId, requestId, requestActionIndex) as { id: string } | undefined;
  return row?.id ?? null;
}

function insertCapabilityProposal(ctx: CanvasGatewayContext, proposal: WidgetCapabilityProposalType): void {
  const parsed = WidgetCapabilityProposal.parse(proposal);
  db().prepare(
    `INSERT OR IGNORE INTO canvas_capability_proposals
     (id, brief_id, proposed_widget_kind, rationale, data_schema_json, ts_renderer_source, example_data_json, primitive_fallback_json, evidence_json, status, proposed_at, proposed_by_job_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
  ).run(
    parsed.id,
    ctx.briefId,
    parsed.proposed_widget_kind,
    parsed.rationale,
    json(parsed.data_schema),
    parsed.ts_renderer_source,
    json(parsed.example_data),
    json(parsed.primitive_fallback),
    json(parsed.evidence ?? []),
    Date.parse(parsed.proposed_at) || Date.now(),
    ctx.jobId ?? null,
  );
  appendDecisionEvent(ctx, "canvas_capability.proposed", "Canvas capability proposed", { capability_proposal_id: parsed.id, proposed_widget_kind: parsed.proposed_widget_kind, ts_renderer_source_length: parsed.ts_renderer_source.length, has_primitive_fallback: true });
}

function insertProposal(ctx: CanvasGatewayContext, action: CanvasActionType, requestActionIndex: number | null, status: ProposalStatus, before: CanvasDocumentType, after: CanvasDocumentType | null, error: string | null = null): string {
  if (ctx.requestId && requestActionIndex !== null) {
    const existing = duplicateProposalId(ctx.briefId, ctx.requestId, requestActionIndex);
    if (existing) return existing;
  }
  const id = newId();
  const layer = actionLayer(action.kind);
  const now = Date.now();
  db().prepare(
    `INSERT INTO canvas_proposals
     (id, brief_id, job_id, request_id, request_action_index, action_kind, action_layer, proposed_by, action_payload_json, rationale, evidence_json, confidence, status, canvas_version_before, canvas_version_after, canvas_before_json, canvas_after_json, error, capability_proposal_id, lab_only, created_at, decided_at, decided_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(
    id,
    ctx.briefId,
    ctx.jobId ?? null,
    ctx.requestId ?? null,
    requestActionIndex,
    action.kind,
    layer,
    ctx.proposedBy ?? "hermes",
    json(action.payload),
    rationaleFor(action),
    json(evidenceFor(action)),
    confidenceFor(action),
    status,
    before.version,
    after?.version ?? null,
    json(before),
    after ? json(after) : null,
    error,
    action.kind.startsWith("capability.") ? ((action.payload as { capability_proposal_id?: string }).capability_proposal_id ?? null) : null,
    now,
    status === "queued" || status === "failed" ? null : now,
    status === "queued" || status === "failed" ? null : (ctx.userId ?? null),
  );
  const eventKind = status === "auto_applied" ? "canvas_proposal.auto_applied" : status === "queued" ? "canvas_proposal.queued" : status === "failed" ? "canvas_proposal.failed" : "canvas_proposal.rejected";
  appendDecisionEvent(ctx, eventKind, `Canvas proposal ${status}`, { proposal_id: id, action_kind: action.kind, action_layer: layer, request_id: ctx.requestId ?? null, request_action_index: requestActionIndex, confidence: confidenceFor(action), evidence_count: evidenceFor(action).length, error_code: error ?? undefined });
  return id;
}

export function ingestCanvasResponse(ctx: CanvasGatewayContext, response: HermesChatResponse | HermesCanvasSynthesisResponse): { proposal_ids: string[]; capability_proposal_ids: string[] } {
  if (!hermesGenerativeCanvasEnabled() || !ctx.canWrite) return { proposal_ids: [], capability_proposal_ids: [] };
  const out = { proposal_ids: [] as string[], capability_proposal_ids: [] as string[] };
  for (const proposal of response.widget_capability_proposals ?? []) {
    insertCapabilityProposal(ctx, proposal);
    out.capability_proposal_ids.push(proposal.id);
  }
  let actions: CanvasActionType[] = [];
  if (response.canvas_actions?.length) actions = response.canvas_actions;
  else if (response.canvas_document) {
    const { document } = getCurrentCanvasDocument(ctx.briefId);
    actions = [{ kind: "document.replace", payload: { next_document: response.canvas_document, prior_version: document.version, rationale: "Hermes supplied a full CanvasDocument" } }];
  }
  let current = getCurrentCanvasDocument(ctx.briefId).document;
  actions.forEach((raw, idx) => {
    const parsed = CanvasAction.safeParse(raw);
    if (!parsed.success) {
      const fallback = { kind: "propose_refresh", payload: { reason: "invalid action" } } as CanvasActionType;
      out.proposal_ids.push(insertProposal(ctx, fallback, idx, "failed", current, null, "action_schema_invalid"));
      return;
    }
    const action = parsed.data;
    if (!canSourcePropose(ctx.proposedBy ?? "hermes", action.kind)) {
      out.proposal_ids.push(insertProposal(ctx, action, idx, "failed", current, null, "source_not_allowed"));
      return;
    }
    if (action.kind === "capability.propose") {
      insertCapabilityProposal(ctx, action.payload);
      out.capability_proposal_ids.push(action.payload.id);
      return;
    }
    const reduced = reduceCanvasAction(current, action);
    if (!reduced.ok) {
      out.proposal_ids.push(insertProposal(ctx, action, idx, "failed", current, null, reduced.error_code));
      return;
    }
    if (isAutoApplyAction(action)) {
      const saved = saveCanvasState({ briefId: ctx.briefId, canvas: reduced.document, source: "hermes", jobId: ctx.jobId ?? null, expectedVersion: current.version === 0 ? undefined : current.version });
      const after = { ...reduced.document, version: saved.version };
      out.proposal_ids.push(insertProposal(ctx, action, idx, "auto_applied", current, after));
      createBriefEvent({ brief_id: ctx.briefId, job_id: ctx.jobId ?? null, actor_user_id: ctx.userId ?? null, actor_type: "hermes", event_type: "canvas_proposal.auto_applied", title: "Canvas proposal auto-applied", metadata: { action_kind: action.kind } });
      current = after;
    } else {
      out.proposal_ids.push(insertProposal(ctx, action, idx, "queued", current, reduced.document));
    }
  });
  return out;
}

function parseProposal(row: CanvasProposalRow): ParsedProposal {
  return { ...row, payload: JSON.parse(row.action_payload_json), evidence: JSON.parse(row.evidence_json) };
}

export function listProposals(_ctx: Pick<CanvasGatewayContext, "briefId">, filter?: { status?: string; layer?: string }): ParsedProposal[] {
  const clauses = ["brief_id = ?"];
  const args: unknown[] = [_ctx.briefId];
  if (filter?.status) { clauses.push("status = ?"); args.push(filter.status); }
  if (filter?.layer) { clauses.push("action_layer = ?"); args.push(filter.layer); }
  const rows = db().prepare(`SELECT * FROM canvas_proposals WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT 200`).all(...args) as CanvasProposalRow[];
  return rows.map(parseProposal);
}

export function approveProposal(ctx: CanvasGatewayContext, proposalId: string): void {
  if (!hermesGenerativeCanvasEnabled() || !ctx.canWrite) throw new Error("generative_canvas_disabled_or_readonly");
  const row = db().prepare(`SELECT * FROM canvas_proposals WHERE id = ? AND brief_id = ?`).get(proposalId, ctx.briefId) as CanvasProposalRow | undefined;
  if (!row || row.status !== "queued" || !row.canvas_after_json) throw new Error("proposal_not_approvable");
  const current = getCurrentCanvasDocument(ctx.briefId);
  if (current.document.version !== row.canvas_version_before || current.stateVersion !== row.canvas_version_before) throw new Error("proposal_version_stale");
  const parsedAfter = CanvasDocument.parse(JSON.parse(row.canvas_after_json));
  const after = { ...parsedAfter, version: current.stateVersion + 1 };
  const saved = saveCanvasState({ briefId: ctx.briefId, canvas: after, source: "hermes", jobId: ctx.jobId ?? row.job_id, expectedVersion: current.stateVersion });
  db().prepare(`UPDATE canvas_proposals SET status = 'applied', canvas_version_after = ?, decided_at = ?, decided_by = ? WHERE id = ?`).run(saved.version, Date.now(), ctx.userId ?? null, proposalId);
  appendDecisionEvent(ctx, "canvas_proposal.applied", "Canvas proposal applied", { proposal_id: proposalId, action_kind: row.action_kind });
  createBriefEvent({ brief_id: ctx.briefId, job_id: ctx.jobId ?? row.job_id, actor_user_id: ctx.userId ?? null, actor_type: "user", event_type: "canvas_proposal.applied", title: "Canvas proposal applied", metadata: { proposal_id: proposalId, action_kind: row.action_kind } });
}

export function rejectProposal(ctx: CanvasGatewayContext, proposalId: string, reason: string): void {
  if (!ctx.canWrite) throw new Error("readonly");
  db().prepare(`UPDATE canvas_proposals SET status = 'rejected', error = ?, decided_at = ?, decided_by = ? WHERE id = ? AND brief_id = ? AND status = 'queued'`).run(reason, Date.now(), ctx.userId ?? null, proposalId, ctx.briefId);
  appendDecisionEvent(ctx, "canvas_proposal.rejected_by_user", "Canvas proposal rejected", { proposal_id: proposalId });
}

export function listCapabilityProposals(ctx: Pick<CanvasGatewayContext, "briefId">): ParsedCapabilityProposal[] {
  const rows = db().prepare(`SELECT * FROM canvas_capability_proposals WHERE brief_id = ? ORDER BY proposed_at DESC LIMIT 200`).all(ctx.briefId) as CanvasCapabilityProposalRow[];
  return rows.map((r) => ({ ...r, data_schema: JSON.parse(r.data_schema_json), example_data: JSON.parse(r.example_data_json), primitive_fallback: JSON.parse(r.primitive_fallback_json), evidence: JSON.parse(r.evidence_json) }));
}

export function getCapabilityProposal(ctx: Pick<CanvasGatewayContext, "briefId">, id: string): ParsedCapabilityProposal | null {
  const row = db().prepare(`SELECT * FROM canvas_capability_proposals WHERE brief_id = ? AND id = ?`).get(ctx.briefId, id) as CanvasCapabilityProposalRow | undefined;
  return row ? { ...row, data_schema: JSON.parse(row.data_schema_json), example_data: JSON.parse(row.example_data_json), primitive_fallback: JSON.parse(row.primitive_fallback_json), evidence: JSON.parse(row.evidence_json) } : null;
}

export function withdrawCapabilityProposal(ctx: CanvasGatewayContext, capabilityProposalId: string, reason: string): void {
  if (!ctx.canWrite) throw new Error("readonly");
  db().prepare(`UPDATE canvas_capability_proposals SET status = 'withdrawn' WHERE brief_id = ? AND id = ?`).run(ctx.briefId, capabilityProposalId);
  appendDecisionEvent(ctx, "canvas_capability.withdrawn", "Canvas capability withdrawn", { capability_proposal_id: capabilityProposalId, reason });
}

export function markCapabilityPromoted(ctx: CanvasGatewayContext, capabilityProposalId: string, registeredWidgetKind: string): void {
  if (!hermesGenerativeCanvasEnabled() || !ctx.canWrite) throw new Error("generative_canvas_disabled_or_readonly");
  const info = db().prepare(`UPDATE canvas_capability_proposals SET status = 'promoted', promoted_widget_kind = ?, promoted_at = ?, promoted_by = ? WHERE brief_id = ? AND id = ? AND status IN ('proposed', 'under_review')`).run(registeredWidgetKind, Date.now(), ctx.userId ?? null, ctx.briefId, capabilityProposalId);
  if (info.changes !== 1) throw new Error("capability_proposal_not_promotable");
  appendDecisionEvent(ctx, "canvas_capability.promoted", "Canvas capability promoted", { capability_proposal_id: capabilityProposalId, registered_widget_kind: registeredWidgetKind });
}

export function retryProposal(): never { throw new Error("retryProposal is deferred beyond Phase A"); }
export function undoProposal(): never { throw new Error("undoProposal is deferred beyond Phase A"); }
