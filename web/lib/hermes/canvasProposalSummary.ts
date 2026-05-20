/**
 * Pure, side-effect-free helpers that distill Canvas proposal rows into
 * review-friendly summaries for the lab review UX.
 *
 * Phase B safety:
 * - No React imports, no IO, no DB access.
 * - Generated renderer source is NEVER executed; we only expose its length.
 */

import type { CanvasProposalRow, CanvasCapabilityProposalRow } from "../db";

export type ParsedCanvasProposalLike = CanvasProposalRow & {
  payload?: unknown;
  evidence?: unknown[];
};

export type ParsedCapabilityProposalLike = CanvasCapabilityProposalRow & {
  data_schema?: unknown;
  example_data?: unknown;
  primitive_fallback?: unknown;
  evidence?: unknown[];
};

export type CanvasProposalSummary = {
  id: string;
  status: CanvasProposalRow["status"];
  action_kind: string;
  action_layer: CanvasProposalRow["action_layer"];
  proposed_by: CanvasProposalRow["proposed_by"];
  confidence: string;
  rationale: string;
  rationale_preview: string;
  evidence_count: number;
  canvas_version_before: number;
  canvas_version_after: number | null;
  is_approvable: boolean;
  is_stale_candidate: boolean;
  display_title: string;
  created_at: number;
  decided_at: number | null;
  error: string | null;
};

export type CapabilityProposalSummary = {
  id: string;
  status: CanvasCapabilityProposalRow["status"];
  proposed_widget_kind: string;
  rationale: string;
  rationale_preview: string;
  evidence_count: number;
  has_renderer_source: boolean;
  source_length: number;
  viewer_href: string;
  proposed_at: number;
  promoted_widget_kind: string | null;
};

const DEFAULT_PREVIEW_MAX = 240;

export function previewText(value: unknown, max: number = DEFAULT_PREVIEW_MAX): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : String(value);
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

function payloadTitle(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { title?: unknown; node_id?: unknown; view_id?: unknown; section_id?: unknown };
  if (typeof p.title === "string" && p.title.trim()) return p.title.trim();
  if (typeof p.node_id === "string" && p.node_id.trim()) return p.node_id.trim();
  if (typeof p.view_id === "string" && p.view_id.trim()) return p.view_id.trim();
  if (typeof p.section_id === "string" && p.section_id.trim()) return p.section_id.trim();
  return null;
}

function evidenceCount(row: ParsedCanvasProposalLike | ParsedCapabilityProposalLike): number {
  if (Array.isArray(row.evidence)) return row.evidence.length;
  const raw = (row as { evidence_json?: unknown }).evidence_json;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

function parsedPayload(row: ParsedCanvasProposalLike): unknown {
  if (row.payload !== undefined) return row.payload;
  if (typeof row.action_payload_json === "string") {
    try {
      return JSON.parse(row.action_payload_json);
    } catch {
      return null;
    }
  }
  return null;
}

export function summarizeCanvasProposal(row: ParsedCanvasProposalLike, currentCanvasVersion?: number): CanvasProposalSummary {
  const payload = parsedPayload(row);
  const rationale = typeof row.rationale === "string" ? row.rationale : "";
  const evCount = evidenceCount(row);
  const titleFromPayload = payloadTitle(payload);
  const display_title = titleFromPayload ? `${row.action_kind}: ${titleFromPayload}` : row.action_kind;

  // Approvable iff still queued with a stored after-document.
  const is_approvable = row.status === "queued" && !!row.canvas_after_json;

  // Stale iff the canvas version has moved past the recorded before-version.
  let is_stale_candidate = false;
  if (typeof currentCanvasVersion === "number" && row.status === "queued") {
    is_stale_candidate = currentCanvasVersion !== row.canvas_version_before;
  }

  return {
    id: row.id,
    status: row.status,
    action_kind: row.action_kind,
    action_layer: row.action_layer,
    proposed_by: row.proposed_by,
    confidence: row.confidence,
    rationale,
    rationale_preview: previewText(rationale),
    evidence_count: evCount,
    canvas_version_before: row.canvas_version_before,
    canvas_version_after: row.canvas_version_after,
    is_approvable,
    is_stale_candidate,
    display_title,
    created_at: row.created_at,
    decided_at: row.decided_at,
    error: row.error,
  };
}

export function summarizeCapabilityProposal(row: ParsedCapabilityProposalLike, briefId: string): CapabilityProposalSummary {
  const source = typeof row.ts_renderer_source === "string" ? row.ts_renderer_source : "";
  const rationale = typeof row.rationale === "string" ? row.rationale : "";
  const params = new URLSearchParams({ briefId, capabilityProposalId: row.id });
  return {
    id: row.id,
    status: row.status,
    proposed_widget_kind: row.proposed_widget_kind,
    rationale,
    rationale_preview: previewText(rationale),
    evidence_count: evidenceCount(row),
    has_renderer_source: source.length > 0,
    source_length: source.length,
    viewer_href: `/lab/canvas/capability?${params.toString()}`,
    proposed_at: row.proposed_at,
    promoted_widget_kind: row.promoted_widget_kind,
  };
}
