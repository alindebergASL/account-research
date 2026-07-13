import { createHash } from "crypto";
import { ALLOWED_BRIEF_PATCH_FIELDS, applyPatches, type BriefPatch } from "./briefPatches";
import { insertReviewCandidate } from "./journalReviewCandidates";
import { Brief, type Brief as BriefT } from "./schema";

const MAX_CANDIDATES = 24;
const MAX_VALUE_BYTES = 1200;
const MAX_EVIDENCE_BYTES = 1200;
const MAX_PROVENANCE_BYTES = 1200;
const MAX_TOTAL_BYTES = 24 * 1024;

const BRIEF_UPDATE_TARGETS = new Set<keyof BriefT>(
  Array.from(ALLOWED_BRIEF_PATCH_FIELDS) as Array<keyof BriefT>,
);

export type BriefUpdateOrigin =
  | "direct_chat"
  | "hermes_chat"
  | "refresh"
  | "monitor";

export type BriefUpdateProposalContext = {
  origin: BriefUpdateOrigin;
  source: "anthropic" | "hermes" | "research_pipeline" | "monitor";
  jobId?: string | null;
  actorUserId: string;
  evidence?: string | null;
};

export type PreparedBriefUpdateCandidate = {
  title: string;
  proposedText: string;
  target: string;
  currentBaseline: string;
  evidence: string;
  provenance: string;
};

export class BriefUpdateProposalError extends Error {
  constructor(message = "AI update proposal could not be queued for review") {
    super(message);
    this.name = "BriefUpdateProposalError";
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string") throw new BriefUpdateProposalError(`${label} is invalid`);
  const trimmed = value.trim();
  if (!trimmed || byteLength(trimmed) > maxBytes) {
    throw new BriefUpdateProposalError(`${label} is invalid or too large`);
  }
  return trimmed;
}

function boundedId(value: string | null | undefined, label: string): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed || byteLength(trimmed) > 128 || /[\u0000-\u001f]/.test(trimmed)) {
    throw new BriefUpdateProposalError(`${label} is invalid`);
  }
  return trimmed;
}

function serializeValue(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new BriefUpdateProposalError("proposed value is not serializable");
  }
  if (serialized === undefined || byteLength(serialized) > MAX_VALUE_BYTES) {
    throw new BriefUpdateProposalError("proposed value is too large");
  }
  return serialized;
}

function normalizePatches(patches: BriefPatch[]): BriefPatch[] {
  if (!Array.isArray(patches) || patches.length === 0 || patches.length > MAX_CANDIDATES) {
    throw new BriefUpdateProposalError("proposal candidate count is invalid");
  }
  return patches.map((patch) => {
    if (!patch || (patch.op !== "set" && patch.op !== "append")) {
      throw new BriefUpdateProposalError("proposal operation is invalid");
    }
    if (typeof patch.field !== "string" || !BRIEF_UPDATE_TARGETS.has(patch.field as keyof BriefT)) {
      throw new BriefUpdateProposalError("proposal target is not allowed");
    }
    serializeValue(patch.value);
    return { op: patch.op, field: patch.field, value: patch.value };
  });
}

export function briefJsonSha256(briefJson: string): string {
  return createHash("sha256").update(briefJson, "utf8").digest("hex");
}

export function patchesFromWholeBrief(baseline: BriefT, proposed: unknown): BriefPatch[] {
  const parsed = Brief.safeParse(proposed);
  if (!parsed.success) throw new BriefUpdateProposalError("proposed brief is invalid");
  // Identity/audience metadata are not manually incorporable Brief fields.
  // generated_at is expected to differ on refresh and is deliberately ignored;
  // changes to the other protected fields make the whole-Brief result invalid.
  for (const field of ["account_name", "segment", "audience"] as const) {
    if (JSON.stringify(baseline[field]) !== JSON.stringify(parsed.data[field])) {
      throw new BriefUpdateProposalError("proposed brief changes a protected field");
    }
  }
  const patches: BriefPatch[] = [];
  for (const target of BRIEF_UPDATE_TARGETS) {
    const baselineValue = baseline[target];
    const proposedValue = parsed.data[target];
    if (JSON.stringify(baselineValue) === JSON.stringify(proposedValue)) continue;
    if (Array.isArray(baselineValue) && Array.isArray(proposedValue)) {
      const exactPrefix = proposedValue.length >= baselineValue.length
        && baselineValue.every((item, index) => (
          JSON.stringify(item) === JSON.stringify(proposedValue[index])
        ));
      if (!exactPrefix) {
        throw new BriefUpdateProposalError("proposed array does not preserve the baseline prefix");
      }
      for (const value of proposedValue.slice(baselineValue.length)) {
        patches.push({ op: "append", field: target, value });
      }
      continue;
    }
    patches.push({ op: "set", field: target, value: proposedValue });
  }
  // Whole-Brief adapters must fail before any transaction begins when the
  // proposed delta exceeds the same per-value or candidate-count bounds used
  // by the durable review boundary.
  return patches.length > 0 ? normalizePatches(patches) : [];
}

export function prepareBriefUpdateCandidates(args: {
  baselineJson: string;
  baseline: BriefT;
  patches: BriefPatch[];
  context: BriefUpdateProposalContext;
}): PreparedBriefUpdateCandidate[] {
  const patches = normalizePatches(args.patches);
  const actorUserId = boundedId(args.context.actorUserId, "actor")!;
  const jobId = boundedId(args.context.jobId, "job");
  const evidence = args.context.evidence == null
    ? `AI proposal source: ${args.context.source}`
    : boundedString(args.context.evidence, "evidence", MAX_EVIDENCE_BYTES);
  const provenance = JSON.stringify({
    schema: "brief_update_provenance_v1",
    origin: args.context.origin,
    source: args.context.source,
    job_id: jobId,
    actor_user_id: actorUserId,
  });
  if (byteLength(provenance) > MAX_PROVENANCE_BYTES) {
    throw new BriefUpdateProposalError("proposal provenance is too large");
  }

  // Validate the complete proposed result in memory. Nothing below persists or
  // mutates the Brief; the patches become field-level review cards only.
  let proposed = args.baseline;
  try {
    for (const patch of patches) proposed = applyPatches(proposed, [patch]);
  } catch {
    throw new BriefUpdateProposalError("proposal patch is invalid");
  }
  if (!Brief.safeParse(proposed).success) {
    throw new BriefUpdateProposalError("proposed brief fails validation");
  }

  const currentBaseline = briefJsonSha256(args.baselineJson);
  const candidates = patches.map((patch) => {
    const proposedText = JSON.stringify({ op: patch.op, value: patch.value });
    if (byteLength(proposedText) > MAX_VALUE_BYTES) {
      throw new BriefUpdateProposalError("proposed text is too large");
    }
    return {
      title: `Proposed ${patch.op} for ${patch.field}`,
      proposedText,
      target: patch.field,
      currentBaseline,
      evidence,
      provenance,
    };
  });
  const total = candidates.reduce((sum, candidate) => sum + byteLength(JSON.stringify(candidate)), 0);
  if (total > MAX_TOTAL_BYTES) {
    throw new BriefUpdateProposalError("proposal set is too large");
  }
  return candidates;
}

export function insertPreparedBriefUpdateCandidates(args: {
  briefId: string;
  actorUserId: string;
  candidates: PreparedBriefUpdateCandidate[];
}): string[] {
  return args.candidates.map((candidate) => insertReviewCandidate({
    briefId: args.briefId,
    userId: args.actorUserId,
    candidate_type: "brief_update",
    title: candidate.title,
    proposed_text: candidate.proposedText,
    target: candidate.target,
    current_baseline: candidate.currentBaseline,
    evidence: candidate.evidence,
    confidence: null,
    risk: candidate.provenance,
    source_entry_id: null,
  }).id);
}

export const BRIEF_UPDATE_REVIEW_LIMITS = Object.freeze({
  maxCandidates: MAX_CANDIDATES,
  maxValueBytes: MAX_VALUE_BYTES,
  maxEvidenceBytes: MAX_EVIDENCE_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
});
