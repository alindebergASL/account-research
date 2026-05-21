// Phase A.5 — Deterministic spike pipeline for fixture mode.
// Builds EvidenceExcerpts (Spike B) and an AccountGraphDocument (Spike A) from
// controlled fixtures without any network/model calls.

import {
  type AccountGraphDocument,
  type AccountObject,
  type Claim,
  type ClaimEvidence,
  type ConflictRecord,
  type EvidenceExcerpt,
  type GraphEdge,
  type SourceDocument,
} from "./schema";
import {
  NUEVA_ACCOUNT_REF,
  NUEVA_EXPECTED_EXCERPTS,
  NUEVA_SOURCES,
  type ExpectedExcerpt,
} from "./fixtures/nueva/sources";
import { normalizeForMatch, snippetAppearsInSource, verifyExcerpts } from "./excerpts";

const FIXED_NOW = "2026-05-20T12:00:00.000Z";

// -------------------- Spike B: excerpt extraction --------------------

export type ExtractionAttempt = {
  expected: ExpectedExcerpt;
  accepted: boolean;
  reason?:
    | "snippet_not_found"
    | "paraphrase_rejected"
    | "extraction_method_disagreement"
    | "too_short";
  excerpt?: EvidenceExcerpt;
};

export type SpikeBResult = {
  attempts: ExtractionAttempt[];
  excerpts: EvidenceExcerpt[];
  metrics: {
    expected_total: number;
    expected_matchable: number;
    expected_paraphrase: number;
    accepted: number;
    rejected_correctly: number;
    accepted_paraphrases: number;
    exact_span_ok: number;
    normalized_span_ok: number;
    exact_span_ratio: number; // of matchable
    normalized_span_ratio: number; // of matchable
    valid_excerpt_ratio: number; // of accepted
  };
};

/**
 * Deterministic extractor for fixture mode. For each expected excerpt:
 * - Look for the snippet verbatim in the source.
 * - If exact match found, emit exact_span excerpt with correct offsets.
 * - Else, normalize and look for normalized match; if found, emit
 *   normalized_span excerpt mapping to the original source slice.
 * - Else (paraphrase), reject — do NOT emit an excerpt.
 */
export function runSpikeB(
  sources: readonly SourceDocument[] = NUEVA_SOURCES,
  expected: readonly ExpectedExcerpt[] = NUEVA_EXPECTED_EXCERPTS,
): SpikeBResult {
  const sourceMap = new Map(sources.map((s) => [s.id, s]));
  const attempts: ExtractionAttempt[] = [];
  const excerpts: EvidenceExcerpt[] = [];

  for (const exp of expected) {
    const src = sourceMap.get(exp.source_id);
    if (!src) {
      attempts.push({ expected: exp, accepted: false, reason: "snippet_not_found" });
      continue;
    }

    // 1. Exact match
    const exactIdx = src.content_text.indexOf(exp.snippet);
    if (exactIdx >= 0) {
      const text = src.content_text.slice(exactIdx, exactIdx + exp.snippet.length);
      if (text.length < 20) {
        attempts.push({ expected: exp, accepted: false, reason: "too_short" });
        continue;
      }
      const excerpt: EvidenceExcerpt = {
        id: exp.id,
        source_document_id: src.id,
        text,
        char_start: exactIdx,
        char_end: exactIdx + text.length,
        extraction_method: "exact_span",
        captured_at: FIXED_NOW,
        metadata: { extractor: "fixture_deterministic" },
      };
      excerpts.push(excerpt);
      attempts.push({ expected: exp, accepted: true, excerpt });
      continue;
    }

    // 2. Normalized match: scan source for a window whose normalized form
    //    equals the normalized snippet.
    const normSnippet = normalizeForMatch(exp.snippet);
    const normSource = normalizeForMatch(src.content_text);
    if (normSource.includes(normSnippet)) {
      // Find the original slice that normalizes to normSnippet by scanning
      // start indices and growing end until normalized prefix matches.
      const found = findOriginalSliceMatchingNormalized(src.content_text, normSnippet);
      if (found) {
        const text = src.content_text.slice(found.start, found.end);
        if (text.length < 20) {
          attempts.push({ expected: exp, accepted: false, reason: "too_short" });
          continue;
        }
        const excerpt: EvidenceExcerpt = {
          id: exp.id,
          source_document_id: src.id,
          text,
          char_start: found.start,
          char_end: found.end,
          extraction_method: "normalized_span",
          captured_at: FIXED_NOW,
          metadata: { extractor: "fixture_deterministic" },
        };
        excerpts.push(excerpt);
        attempts.push({ expected: exp, accepted: true, excerpt });
        continue;
      }
    }

    // 3. Otherwise: rejected (paraphrase).
    if (!snippetAppearsInSource(exp.snippet, src)) {
      attempts.push({ expected: exp, accepted: false, reason: "paraphrase_rejected" });
    } else {
      attempts.push({ expected: exp, accepted: false, reason: "extraction_method_disagreement" });
    }
  }

  // Aggregate metrics
  const expected_matchable = expected.filter((e) => e.expected_match).length;
  const expected_paraphrase = expected.filter((e) => !e.expected_match).length;
  const accepted = attempts.filter((a) => a.accepted).length;
  // rejected_correctly: paraphrases that were rejected
  const rejected_correctly = attempts.filter(
    (a) => !a.accepted && !a.expected.expected_match,
  ).length;
  const accepted_paraphrases = attempts.filter(
    (a) => a.accepted && !a.expected.expected_match,
  ).length;

  const verify = verifyExcerpts(excerpts, sources);

  // Of the matchable ones, how many came through as exact vs normalized
  const matchableAttempts = attempts.filter((a) => a.expected.expected_match);
  const exact_ok = matchableAttempts.filter(
    (a) => a.accepted && a.excerpt?.extraction_method === "exact_span",
  ).length;
  const normalized_ok = matchableAttempts.filter(
    (a) => a.accepted && a.excerpt?.extraction_method === "normalized_span",
  ).length;

  return {
    attempts,
    excerpts,
    metrics: {
      expected_total: expected.length,
      expected_matchable,
      expected_paraphrase,
      accepted,
      rejected_correctly,
      accepted_paraphrases,
      exact_span_ok: exact_ok,
      normalized_span_ok: normalized_ok,
      exact_span_ratio: expected_matchable === 0 ? 1 : exact_ok / expected_matchable,
      normalized_span_ratio:
        expected_matchable === 0 ? 1 : (exact_ok + normalized_ok) / expected_matchable,
      valid_excerpt_ratio: verify.valid_ratio,
    },
  };
}

function findOriginalSliceMatchingNormalized(
  source: string,
  normSnippet: string,
): { start: number; end: number } | null {
  // Walk source; at each non-space char position attempt to grow a window
  // whose normalized form equals normSnippet.
  for (let start = 0; start < source.length; start++) {
    if (/\s/.test(source[start])) continue;
    let normSoFar = "";
    for (let end = start + 1; end <= source.length; end++) {
      normSoFar = normalizeForMatch(source.slice(start, end));
      if (normSoFar === normSnippet) {
        return { start, end };
      }
      if (normSoFar.length > normSnippet.length) break;
      if (!normSnippet.startsWith(normSoFar)) break;
    }
  }
  return null;
}

// -------------------- Spike A: graph assembly --------------------

export type SpikeAResult = {
  graph: AccountGraphDocument;
  trace: {
    source_id: string;
    excerpt_id: string;
    claim_id: string;
    object_id: string;
  };
};

/**
 * Deterministic graph assembly for fixture mode. Uses extracted excerpts from
 * Spike B as the canonical evidence layer, then constructs claims, account
 * objects, edges, and a conflict record covering the six qualitative
 * categories required by the spec.
 */
export function runSpikeA(
  sources: readonly SourceDocument[] = NUEVA_SOURCES,
  spikeB: SpikeBResult = runSpikeB(sources, NUEVA_EXPECTED_EXCERPTS),
): SpikeAResult {
  const acct = NUEVA_ACCOUNT_REF;
  const now = FIXED_NOW;
  const accepted = spikeB.excerpts;
  const exId = (id: string) => accepted.find((e) => e.id === id);

  const requireEx = (id: string): string => {
    const ex = exId(id);
    if (!ex) throw new Error(`Spike A relies on accepted excerpt ${id} but extractor rejected it.`);
    return ex.id;
  };

  // Claims — one per qualitative category, each grounded in evidence.
  const claims: Claim[] = [
    {
      id: "claim_account_snapshot",
      account_ref: acct,
      type: "fact",
      text:
        "Nueva School is an independent PK-12 school serving ~950 students across two SF Bay Area campuses.",
      origin: "hermes_graph_assembly",
      provenance_status: "verified",
      status: "ratified",
      confidence: "high",
      freshness: "fresh",
      created_at: now,
      updated_at: now,
      created_by: "hermes",
      tags: ["snapshot"],
      metadata: {},
    },
    {
      id: "claim_signal_ai_pilot",
      account_ref: acct,
      type: "signal",
      text:
        "Nueva announced a fall 2026 AI tutoring pilot for 6th-7th grade math classrooms.",
      origin: "hermes_graph_assembly",
      provenance_status: "verified",
      status: "proposed",
      confidence: "high",
      freshness: "fresh",
      created_at: now,
      updated_at: now,
      created_by: "hermes",
      tags: ["signal", "ai"],
      metadata: {},
    },
    {
      id: "claim_signal_contradiction",
      account_ref: acct,
      type: "signal",
      text:
        "Trade press reports the Nueva board paused the AI tutoring pilot pending further policy review.",
      origin: "hermes_graph_assembly",
      provenance_status: "verified",
      status: "proposed",
      confidence: "medium",
      confidence_rationale: "Single trade-press source; contradicts official announcement.",
      freshness: "fresh",
      created_at: now,
      updated_at: now,
      created_by: "hermes",
      tags: ["signal", "contradiction"],
      metadata: {},
    },
    {
      id: "claim_initiative_network_refresh",
      account_ref: acct,
      type: "fact",
      text:
        "Nueva is running an RFP for a campus-wide Wi-Fi 6E network refresh with proposals due May 30, 2026.",
      origin: "hermes_graph_assembly",
      provenance_status: "verified",
      status: "proposed",
      confidence: "high",
      freshness: "fresh",
      created_at: now,
      updated_at: now,
      created_by: "hermes",
      tags: ["initiative", "procurement"],
      metadata: {},
    },
    {
      id: "claim_stakeholder_director_edtech",
      account_ref: acct,
      type: "inference",
      text:
        "Nueva is hiring a Director of Educational Technology reporting to the Head of School to lead EdTech and AI integration.",
      origin: "hermes_graph_assembly",
      provenance_status: "verified",
      status: "proposed",
      confidence: "high",
      freshness: "fresh",
      created_at: now,
      updated_at: now,
      created_by: "hermes",
      tags: ["stakeholder"],
      meddpicc_field: "champion",
      metadata: {},
    },
    {
      id: "claim_risk_ethics_gate",
      account_ref: acct,
      type: "risk",
      text:
        "Classroom AI deployments at Nueva must clear the AI ethics committee, introducing approval risk for any pilot timelines.",
      origin: "hermes_graph_assembly",
      provenance_status: "verified",
      status: "proposed",
      confidence: "medium",
      freshness: "fresh",
      created_at: now,
      updated_at: now,
      created_by: "hermes",
      tags: ["risk"],
      meddpicc_field: "decision_process",
      metadata: {},
    },
    {
      id: "claim_open_question_pilot_status",
      account_ref: acct,
      type: "open_question",
      text:
        "Is the AI tutoring pilot proceeding for fall 2026 or paused — what is the current board status?",
      origin: "hermes_graph_assembly",
      provenance_status: "unverified",
      status: "proposed",
      confidence: "unknown",
      freshness: "fresh",
      created_at: now,
      updated_at: now,
      created_by: "hermes",
      tags: ["open_question"],
      metadata: {},
    },
    {
      id: "claim_opportunity_partner_refresh",
      account_ref: acct,
      type: "opportunity",
      text:
        "Network refresh RFP is an opportunity to propose AI-ready segmentation aligned with Nueva's 2030 modernization pillar.",
      origin: "hermes_graph_assembly",
      provenance_status: "verified",
      status: "proposed",
      confidence: "medium",
      freshness: "fresh",
      created_at: now,
      updated_at: now,
      created_by: "hermes",
      tags: ["opportunity"],
      meddpicc_field: "identify_pain",
      metadata: {},
    },
    {
      id: "claim_recommended_action_rfp",
      account_ref: acct,
      type: "recommendation",
      text:
        "Recommend responding to the Nueva network RFP before May 30, 2026 with AI-ready segmentation reference.",
      origin: "hermes_graph_assembly",
      provenance_status: "verified",
      status: "proposed",
      confidence: "medium",
      freshness: "fresh",
      created_at: now,
      updated_at: now,
      created_by: "hermes",
      tags: ["recommended_action"],
      metadata: {},
    },
  ];

  const claim_evidence: ClaimEvidence[] = [
    {
      id: "ce_snapshot_mission",
      claim_id: "claim_account_snapshot",
      evidence_excerpt_id: requireEx("ex_about_mission"),
      role: "supports",
      strength: "medium",
      rationale: "Official mission language supports the snapshot description.",
    },
    {
      id: "ce_snapshot_size",
      claim_id: "claim_account_snapshot",
      evidence_excerpt_id: requireEx("ex_about_size"),
      role: "supports",
      strength: "strong",
      rationale: "Official source quantifies enrollment and campus locations.",
    },
    {
      id: "ce_signal_pilot",
      claim_id: "claim_signal_ai_pilot",
      evidence_excerpt_id: requireEx("ex_news_pilot_announce"),
      role: "supports",
      strength: "strong",
      rationale: "News source describes the AI pilot directly.",
    },
    {
      id: "ce_signal_ethics",
      claim_id: "claim_risk_ethics_gate",
      evidence_excerpt_id: requireEx("ex_news_ethics_committee"),
      role: "supports",
      strength: "medium",
      rationale: "Source establishes ethics committee gate.",
    },
    {
      id: "ce_signal_contradiction",
      claim_id: "claim_signal_contradiction",
      evidence_excerpt_id: requireEx("ex_contradiction_delay"),
      role: "supports",
      strength: "medium",
      rationale: "Trade press source asserts pause.",
    },
    {
      id: "ce_signal_contradiction_vs_pilot",
      claim_id: "claim_signal_ai_pilot",
      evidence_excerpt_id: requireEx("ex_contradiction_delay"),
      role: "contradicts",
      strength: "medium",
      rationale: "Same excerpt contradicts the launch claim.",
    },
    {
      id: "ce_stakeholder_director",
      claim_id: "claim_stakeholder_director_edtech",
      evidence_excerpt_id: requireEx("ex_job_posting_director"),
      role: "supports",
      strength: "strong",
      rationale: "Job posting describes role and reporting line.",
    },
    {
      id: "ce_initiative_rfp_due",
      claim_id: "claim_initiative_network_refresh",
      evidence_excerpt_id: requireEx("ex_rfp_due_date"),
      role: "supports",
      strength: "strong",
      rationale: "RFP states proposal due date.",
    },
    {
      id: "ce_initiative_rfp_scope",
      claim_id: "claim_initiative_network_refresh",
      evidence_excerpt_id: requireEx("ex_rfp_scope"),
      role: "supports",
      strength: "strong",
      rationale: "RFP states scope including Wi-Fi 6E and AI workloads.",
    },
    {
      id: "ce_opportunity_strategic",
      claim_id: "claim_opportunity_partner_refresh",
      evidence_excerpt_id: requireEx("ex_strategic_plan_pillars"),
      role: "supports",
      strength: "medium",
      rationale: "Strategic plan modernization pillar aligns with refresh opportunity.",
    },
    {
      id: "ce_opportunity_rfp_scope",
      claim_id: "claim_opportunity_partner_refresh",
      evidence_excerpt_id: requireEx("ex_rfp_scope"),
      role: "partially_supports",
      strength: "medium",
      rationale: "RFP scope mentions AI workloads.",
    },
    {
      id: "ce_recommended_action",
      claim_id: "claim_recommended_action_rfp",
      evidence_excerpt_id: requireEx("ex_rfp_due_date"),
      role: "supports",
      strength: "medium",
      rationale: "Timing is anchored in RFP due date.",
    },
  ];

  const account_objects: AccountObject[] = [
    {
      id: "obj_account_snapshot",
      account_ref: acct,
      type: "account_snapshot",
      title: "Nueva School snapshot",
      body: "Independent PK-12 school, ~950 students, two Bay Area campuses.",
      status: "ratified",
      claim_ids: ["claim_account_snapshot"],
      origin: "hermes_graph_assembly",
      provenance_status: "verified",
      confidence: "high",
      freshness: "fresh",
      created_at: now,
      updated_at: now,
      created_by: "hermes",
      object_data: {},
      metadata: {},
    },
    {
      id: "obj_signal_ai_pilot",
      account_ref: acct,
      type: "signal",
      title: "AI tutoring pilot announced (with contradiction)",
      body: "Public news indicates a fall 2026 AI tutoring pilot; trade press reports a board pause.",
      status: "proposed",
      claim_ids: ["claim_signal_ai_pilot", "claim_signal_contradiction"],
      origin: "hermes_graph_assembly",
      provenance_status: "verified",
      confidence: "medium",
      freshness: "fresh",
      created_at: now,
      updated_at: now,
      created_by: "hermes",
      object_data: {},
      metadata: {},
    },
    {
      id: "obj_initiative_network_refresh",
      account_ref: acct,
      type: "initiative",
      title: "Campus network refresh RFP",
      status: "proposed",
      claim_ids: ["claim_initiative_network_refresh"],
      origin: "hermes_graph_assembly",
      provenance_status: "verified",
      confidence: "high",
      freshness: "fresh",
      created_at: now,
      updated_at: now,
      created_by: "hermes",
      object_data: {},
      metadata: {},
    },
    {
      id: "obj_stakeholder_director_edtech",
      account_ref: acct,
      type: "stakeholder",
      title: "Director of Educational Technology (open role)",
      status: "proposed",
      claim_ids: ["claim_stakeholder_director_edtech"],
      origin: "hermes_graph_assembly",
      provenance_status: "verified",
      confidence: "high",
      freshness: "fresh",
      created_at: now,
      updated_at: now,
      created_by: "hermes",
      object_data: { meddpicc_role: "champion" },
      metadata: {},
    },
    {
      id: "obj_risk_ethics_gate",
      account_ref: acct,
      type: "risk",
      title: "AI ethics committee approval gate",
      status: "proposed",
      claim_ids: ["claim_risk_ethics_gate"],
      origin: "hermes_graph_assembly",
      provenance_status: "verified",
      confidence: "medium",
      freshness: "fresh",
      created_at: now,
      updated_at: now,
      created_by: "hermes",
      object_data: {},
      metadata: {},
    },
    {
      id: "obj_open_question_pilot_status",
      account_ref: acct,
      type: "open_question",
      title: "Is the AI pilot still on for fall 2026?",
      status: "proposed",
      claim_ids: ["claim_open_question_pilot_status"],
      origin: "hermes_graph_assembly",
      provenance_status: "unverified",
      confidence: "unknown",
      freshness: "fresh",
      created_at: now,
      updated_at: now,
      created_by: "hermes",
      object_data: {},
      metadata: {},
    },
    {
      id: "obj_opportunity_refresh_partnership",
      account_ref: acct,
      type: "opportunity",
      title: "AI-ready network refresh partnership",
      status: "proposed",
      claim_ids: ["claim_opportunity_partner_refresh"],
      origin: "hermes_graph_assembly",
      provenance_status: "verified",
      confidence: "medium",
      freshness: "fresh",
      created_at: now,
      updated_at: now,
      created_by: "hermes",
      object_data: {},
      metadata: {},
    },
    {
      id: "obj_recommended_action_rfp",
      account_ref: acct,
      type: "recommended_action",
      title: "Respond to Nueva network RFP before May 30",
      status: "proposed",
      claim_ids: ["claim_recommended_action_rfp"],
      origin: "hermes_graph_assembly",
      provenance_status: "verified",
      confidence: "medium",
      freshness: "fresh",
      created_at: now,
      updated_at: now,
      created_by: "hermes",
      object_data: {},
      metadata: {},
    },
  ];

  const edges: GraphEdge[] = [
    {
      id: "edge_contradict_pilot",
      from_id: "claim_signal_contradiction",
      from_type: "claim",
      to_id: "claim_signal_ai_pilot",
      to_type: "claim",
      kind: "contradicts",
      rationale: "Trade press pause contradicts launch announcement.",
      created_at: now,
    },
    {
      id: "edge_recommended_supports_opportunity",
      from_id: "claim_recommended_action_rfp",
      from_type: "claim",
      to_id: "claim_opportunity_partner_refresh",
      to_type: "claim",
      kind: "supports",
      rationale: "The recommended action operationalizes the opportunity claim.",
      created_at: now,
    },
    {
      id: "edge_initiative_relates_opportunity",
      from_id: "obj_initiative_network_refresh",
      from_type: "account_object",
      to_id: "obj_opportunity_refresh_partnership",
      to_type: "account_object",
      kind: "relates_to",
      created_at: now,
    },
  ];

  const conflicts: ConflictRecord[] = [
    {
      id: "conflict_pilot_status",
      account_ref: acct,
      claim_ids: ["claim_signal_ai_pilot", "claim_signal_contradiction"],
      summary:
        "Pilot announcement vs trade-press report of board pause; status unresolved pending Nueva confirmation.",
      reconciliation_status: "unresolved",
      current_resolution: null,
      created_at: now,
      updated_at: now,
    },
  ];

  const graph: AccountGraphDocument = {
    schema_version: 1,
    graph_id: "graph_nueva_a5_spike",
    generated_at: now,
    account_ref: acct,
    source_documents: [...sources],
    evidence_excerpts: [...accepted],
    claims,
    claim_evidence,
    account_objects,
    edges,
    conflicts,
    metadata: { fixture: "nueva", mode: "fixture" },
  };

  return {
    graph,
    trace: {
      source_id: "srcdoc_procurement_rfp",
      excerpt_id: "ex_rfp_due_date",
      claim_id: "claim_initiative_network_refresh",
      object_id: "obj_initiative_network_refresh",
    },
  };
}
