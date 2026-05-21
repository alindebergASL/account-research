// Phase A.6 — Deterministic decomposition: saved brief_json → account graph.
// Pure function, no network, no model calls. Implements docs §4 (section
// mapping) and §5 (provenance tiers). See
// docs/plans/2026-05-21-phase-a6-brief-json-graph-backfill-plan.md.
//
// HARD INVARIANT (plan §5): no Claim derived from unsourced legacy brief
// content may be marked `verified`. The validator enforces this; this mapper
// must never emit such a Claim. We do NOT fabricate EvidenceExcerpt records
// against external SourceDocuments from saved Brief prose.

import { createHash } from "node:crypto";
import { Brief as BriefSchema, type Brief } from "../schema";
import { classifySourceForIngestion } from "./allowlist";
import {
  AccountGraphDocument as AccountGraphDocumentSchema,
  type AccountGraphDocument,
  type AccountHierarchyReference,
  type AccountObject,
  type AccountObjectType,
  type Claim,
  type ClaimEvidence,
  type ClaimType,
  type ConfidenceLevel,
  type EvidenceExcerpt,
  type GraphEdge,
  type ProvenanceStatus,
  type SourceDocument,
  type SourceKind,
} from "./schema";

const FIXED_NOW = "2026-05-21T00:00:00.000Z";

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function shortHash(parts: (string | number)[]): string {
  return sha256(parts.map(String).join("|")).slice(0, 12);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "untitled";
}

function normalizeForJaccard(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function jaccard(a: string, b: string): number {
  const as = new Set(normalizeForJaccard(a).split(" ").filter(Boolean));
  const bs = new Set(normalizeForJaccard(b).split(" ").filter(Boolean));
  if (as.size === 0 && bs.size === 0) return 1;
  let inter = 0;
  for (const t of as) if (bs.has(t)) inter += 1;
  const union = new Set([...as, ...bs]).size;
  return union === 0 ? 0 : inter / union;
}

function mapConfidence(c: string | undefined): ConfidenceLevel {
  switch ((c || "").toLowerCase()) {
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    default:
      return "unknown";
  }
}

// ---------- Result types ----------

export type AmbiguousMapping = {
  section: string;
  reason: string;
  detail?: string;
};

export type UnmappedClaim = {
  section: string;
  text: string;
  reason: string;
};

export type FromBriefJsonOutcome =
  | { status: "ok"; graph: AccountGraphDocument; report: BackfillMappingReport }
  | { status: "skipped_malformed_json"; error: string }
  | { status: "skipped_unsupported_schema_variant"; error: string };

export type BackfillMappingReport = {
  account_name: string;
  account_id: string;
  brief_id: string;
  legacy_brief_source_id: string;
  ambiguous: AmbiguousMapping[];
  unmapped_claims: UnmappedClaim[];
  per_tier_counts: Record<string, number>;
  source_document_only_count: number;
  legacy_brief_only_count: number;
  inferred_count: number;
  chat_patch_count: number;
  verified_count: number;
  orphan_source_ids: string[];
  notes: string[];
};

// ---------- Builder ----------

type ClaimInput = {
  idSuffix: string;
  text: string;
  type: ClaimType;
  provenance: ProvenanceStatus;
  confidence?: ConfidenceLevel;
  section: string;
  // optional external source materialization
  sourceText?: string | null;
  sourceUrl?: string | null;
  summary?: string;
};

function isHttpUrl(s: string | null | undefined): boolean {
  if (!s) return false;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function detectSchemaVariant(input: unknown): "current" | "unsupported" {
  if (!input || typeof input !== "object") return "unsupported";
  const o = input as Record<string, unknown>;
  // Heuristic: current Brief Zod shape requires at minimum account_name,
  // recent_signals (array), and sources (array). Older variants without these
  // fields are flagged as unsupported (rather than failing parse loudly).
  if (typeof o.account_name !== "string") return "unsupported";
  if (!Array.isArray(o.recent_signals)) return "unsupported";
  if (!Array.isArray(o.sources)) return "unsupported";
  return "current";
}

export type FromBriefJsonInput = {
  brief_json: unknown;
  brief_id: string;
  account_id?: string; // optional — derived from account_name if absent
};

export function fromBriefJson(input: FromBriefJsonInput): FromBriefJsonOutcome {
  // 1. JSON validity (the runner will typically have already parsed; this
  //    function accepts either a string or an object).
  let candidate: unknown = input.brief_json;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch (err) {
      return {
        status: "skipped_malformed_json",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // 2. Schema variant detection (before strict Zod parse) so we can
  //    classify "older variant" vs "garbage" precisely.
  if (detectSchemaVariant(candidate) === "unsupported") {
    return {
      status: "skipped_unsupported_schema_variant",
      error: "brief_json does not match current Brief shape (missing account_name/recent_signals/sources)",
    };
  }

  const parsed = BriefSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      status: "skipped_unsupported_schema_variant",
      error: `Zod parse failed: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}:${i.message}`).join("; ")}`,
    };
  }
  const brief: Brief = parsed.data;

  return {
    status: "ok",
    ...buildGraph(brief, input.brief_id, input.account_id),
  };
}

function buildGraph(
  brief: Brief,
  brief_id: string,
  accountIdHint: string | undefined,
): { graph: AccountGraphDocument; report: BackfillMappingReport } {
  const account_id = accountIdHint || `acct_${slugify(brief.account_name)}`;
  const account_ref: AccountHierarchyReference = {
    account_id,
    account_name: brief.account_name,
    parent_account_id: null,
    scope: "unknown",
    scope_note: brief.segment || undefined,
  };

  const ambiguous: AmbiguousMapping[] = [];
  const unmapped: UnmappedClaim[] = [];
  const notes: string[] = [];

  const sourceDocs: SourceDocument[] = [];
  const excerpts: EvidenceExcerpt[] = [];
  const claims: Claim[] = [];
  const claimEvidence: ClaimEvidence[] = [];
  const objects: AccountObject[] = [];
  const edges: GraphEdge[] = [];

  // ---------- Synthetic legacy_brief_json SourceDocument ----------
  // Holds the whole saved Brief as a single document. content_text is a
  // canonical serialization so it always satisfies min(1) and content_sha256
  // is deterministic.
  const briefBlob = JSON.stringify(brief);
  const legacyBriefSourceId = `srcdoc_legacy_brief_${shortHash([brief_id, brief.account_name])}`;
  const legacyBriefSource: SourceDocument = {
    id: legacyBriefSourceId,
    kind: "internal_note",
    title: `Saved Brief (legacy_brief_json) — ${brief.account_name}`,
    url: null,
    publisher: null,
    captured_at: FIXED_NOW,
    published_at: null,
    fetched_at: null,
    content_sha256: sha256(briefBlob),
    content_text: briefBlob,
    allowed: true,
    allowlist_rule: "allow_synthetic_internal_note",
    pii_risk: "low",
    retention: "store_full_text_lab",
    metadata: {
      subtype: "legacy_brief_json",
      brief_id,
      account_name: brief.account_name,
      generated_at: brief.generated_at,
      audience: brief.audience,
      legacy: true,
    },
  };
  sourceDocs.push(legacyBriefSource);

  // ---------- Root account_snapshot object ----------
  const rootObjectId = `obj_account_${shortHash([account_id])}`;
  // Build first; claim_ids appended below.
  const rootObject: AccountObject = {
    id: rootObjectId,
    account_ref,
    type: "account_snapshot",
    title: brief.account_name,
    body: brief.snapshot || undefined,
    status: "proposed",
    claim_ids: [],
    origin: "legacy_backfill",
    provenance_status: "legacy_brief_json",
    confidence: "unknown",
    freshness: "unknown",
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
    created_by: "migration",
    object_data: {
      segment: brief.segment,
      generated_at: brief.generated_at,
      audience: brief.audience,
    },
    metadata: { brief_id, section: "account_root" },
  };
  objects.push(rootObject);

  // ---------- Helpers ----------

  // Materialize an external source from a free-text/URL `source` string.
  // Returns the SourceDocument id (caller is responsible for NOT creating an
  // EvidenceExcerpt against it from saved Brief prose — that would fabricate
  // evidence).
  const externalSourceCache = new Map<string, string>();
  function materializeExternalSource(
    sourceText: string | null | undefined,
    sectionLabel: string,
  ): string | null {
    if (!sourceText || !sourceText.trim()) return null;
    const trimmed = sourceText.trim();
    const cached = externalSourceCache.get(trimmed);
    if (cached) return cached;

    const hasUrl = isHttpUrl(trimmed);
    let url: string | null = null;
    let kind: SourceKind;
    let title: string;
    if (hasUrl) {
      url = trimmed;
      kind = "public_web";
      try {
        title = new URL(trimmed).hostname;
      } catch {
        title = trimmed.slice(0, 80);
      }
    } else {
      // Try to extract a URL embedded in the text
      const m = trimmed.match(/https?:\/\/[^\s)]+/);
      if (m) {
        url = m[0];
        kind = "public_web";
        title = trimmed.slice(0, 80);
      } else {
        kind = "unknown";
        title = trimmed.slice(0, 80) || "(unnamed source)";
      }
    }
    const cls = classifySourceForIngestion({ url, kind, title });
    const id = `srcdoc_ext_${shortHash([sectionLabel, trimmed])}`;
    const placeholder =
      `Source citation captured from saved Brief field. No external content was ` +
      `fetched. Original source string: "${trimmed}". This SourceDocument exists ` +
      `to anchor source_document_only provenance and MUST NOT have EvidenceExcerpt ` +
      `records derived from saved Brief prose.`;
    const sd: SourceDocument = {
      id,
      kind,
      title,
      url,
      publisher: null,
      captured_at: FIXED_NOW,
      published_at: null,
      fetched_at: null,
      content_sha256: sha256(placeholder),
      content_text: placeholder,
      allowed: cls.allowed,
      allowlist_rule: cls.allowlist_rule,
      pii_risk: cls.pii_risk,
      retention: cls.retention,
      metadata: {
        subtype: "external_citation_no_content",
        section: sectionLabel,
        original_source_string: trimmed,
      },
    };
    sourceDocs.push(sd);
    externalSourceCache.set(trimmed, id);
    return id;
  }

  // Add a Claim deterministically. If sourceText/url present, materialize an
  // external SourceDocument and set provenance to source_document_only — but
  // do NOT create an EvidenceExcerpt against it (that would fabricate
  // evidence). The claim has no ClaimEvidence in that case; the validator
  // emits a `claim_no_evidence` warning (intentional: legacy backfill is
  // honest about lack of verified evidence).
  function addClaim(c: ClaimInput): Claim {
    const id = `claim_${slugify(c.section)}_${shortHash([account_id, c.section, c.idSuffix])}`;
    // A.6 mapper never produces ClaimEvidence (we don't fabricate excerpts),
    // so the validator's `high_confidence_without_strong_evidence` rule would
    // fire for any claim with confidence=high. Per plan §7C/§12 we downgrade
    // brief-level `high` to `medium` in the graph and record the downgrade
    // in the parity report as a provenance gap. This is the honest A.6
    // representation: the brief may have asserted high confidence, but the
    // graph has no evidence to back it.
    const recordedConfidence = c.confidence ?? "unknown";
    const downgraded = recordedConfidence === "high" ? "medium" : recordedConfidence;
    if (downgraded !== recordedConfidence) {
      notes.push(
        `confidence downgrade [${c.section}] ${id}: brief=high → graph=medium (A.6 has no excerpt to back high confidence)`,
      );
    }
    const claim: Claim = {
      id,
      account_ref,
      type: c.type,
      text: c.text,
      summary: c.summary,
      origin: "legacy_backfill",
      provenance_status: c.provenance,
      status: "proposed",
      confidence: downgraded,
      freshness: "unknown",
      created_at: FIXED_NOW,
      updated_at: FIXED_NOW,
      created_by: "migration",
      tags: ["legacy_backfill", c.section],
      metadata: {
        brief_id,
        section: c.section,
        source_citation: c.sourceText ?? undefined,
        original_confidence: recordedConfidence,
        confidence_downgraded: downgraded !== recordedConfidence,
      },
    };
    claims.push(claim);
    if (c.sourceText && c.sourceText.trim()) {
      materializeExternalSource(c.sourceText, c.section);
      // NOTE: we deliberately do not create EvidenceExcerpt or ClaimEvidence
      // against the materialized external source. See plan §4/§5 and HARD
      // INVARIANT.
    }
    return claim;
  }

  function addObject(
    section: string,
    type: AccountObjectType,
    title: string,
    body: string | undefined,
    claimIds: string[],
    confidence: ConfidenceLevel = "unknown",
    provenance: ProvenanceStatus = "legacy_brief_json",
    extra: Record<string, unknown> = {},
  ): AccountObject {
    const id = `obj_${slugify(section)}_${shortHash([account_id, section, title])}`;
    const obj: AccountObject = {
      id,
      account_ref,
      type,
      title,
      body,
      status: "proposed",
      claim_ids: claimIds,
      origin: "legacy_backfill",
      provenance_status: provenance,
      confidence,
      freshness: "unknown",
      created_at: FIXED_NOW,
      updated_at: FIXED_NOW,
      created_by: "migration",
      object_data: extra,
      metadata: { brief_id, section },
    };
    objects.push(obj);
    return obj;
  }

  // ---------- §4 mapping ----------

  // Ambiguous prose sections (priority_summary, first_angle): no auto Claims.
  if (brief.priority_summary && brief.priority_summary.trim()) {
    ambiguous.push({
      section: "priority_summary",
      reason: "free-text prose; sentence-level decomposition deferred to a future PR per plan §4",
      detail: brief.priority_summary.slice(0, 200),
    });
  }
  if (brief.first_angle && brief.first_angle.trim()) {
    ambiguous.push({
      section: "first_angle",
      reason: "free-text recommendation; sentence-level decomposition deferred per plan §4",
      detail: brief.first_angle.slice(0, 200),
    });
  }
  if (brief.snapshot && brief.snapshot.trim()) {
    // Snapshot is stored on the rootObject.body already; recorded as unmapped
    // (Unsupported tag in plan): no Claims extracted from prose.
    unmapped.push({
      section: "snapshot",
      text: brief.snapshot.slice(0, 200),
      reason: "snapshot prose carried only on synthetic legacy_brief_json SourceDocument; no Claim extraction",
    });
  }

  // recent_signals[] — one Claim per signal, one signal AccountObject per claim.
  // Dedup near-duplicates via Jaccard >= 0.7 to mirror tests/briefMerge.test.ts.
  const seenSignals: { text: string }[] = [];
  brief.recent_signals.forEach((sig, i) => {
    if (seenSignals.some((s) => jaccard(s.text, sig.text) >= 0.7)) {
      notes.push(`recent_signals[${i}] deduped (Jaccard≥0.7 vs earlier signal): "${sig.text.slice(0, 80)}"`);
      return;
    }
    seenSignals.push({ text: sig.text });
    const hasSource = !!(sig.source && sig.source.trim());
    const provenance: ProvenanceStatus = hasSource
      ? "source_document_only"
      : "legacy_brief_json";
    const claim = addClaim({
      idSuffix: `${i}_${sig.text}`,
      text: sig.text,
      type: "signal",
      provenance,
      confidence: mapConfidence(sig.confidence),
      section: "recent_signals",
      sourceText: sig.source ?? null,
    });
    addObject(
      "signal",
      "signal",
      sig.text.slice(0, 120),
      sig.text,
      [claim.id],
      mapConfidence(sig.confidence),
      provenance,
      { ordinal: i },
    );
  });

  // ai_tech_maturity → one Claim attached to root.
  if (brief.ai_tech_maturity) {
    const c = addClaim({
      idSuffix: "ai_tech_maturity",
      text: `AI/tech maturity: ${brief.ai_tech_maturity.rating}/5 — ${brief.ai_tech_maturity.rationale}`,
      type: "inference",
      provenance: "inferred_from_brief_json",
      confidence: "unknown",
      section: "ai_tech_maturity",
    });
    rootObject.claim_ids.push(c.id);
  }

  // top_initiatives[]
  brief.top_initiatives.forEach((init, i) => {
    const hasSource = !!(init.source && init.source.trim());
    const provenance: ProvenanceStatus = hasSource
      ? "source_document_only"
      : "inferred_from_brief_json";
    const c = addClaim({
      idSuffix: `${i}_${init.title}`,
      text: init.detail,
      type: "fact",
      provenance,
      confidence: mapConfidence(init.confidence),
      section: "top_initiatives",
      sourceText: init.source ?? null,
      summary: init.title,
    });
    addObject(
      "initiative",
      "initiative",
      init.title,
      init.detail,
      [c.id],
      mapConfidence(init.confidence),
      provenance,
      { ordinal: i },
    );
  });

  // technical_footprint — many sub-fields, all legacy_brief_json provenance.
  const tf = brief.technical_footprint;
  const tfClaimIds: string[] = [];
  const addTechClaim = (sub: string, text: string, i: number) => {
    const c = addClaim({
      idSuffix: `${sub}_${i}_${text}`,
      text: `${sub}: ${text}`,
      type: "fact",
      provenance: "legacy_brief_json",
      confidence: "unknown",
      section: `technical_footprint.${sub}`,
    });
    tfClaimIds.push(c.id);
  };
  tf.ai_in_production.forEach((t, i) => addTechClaim("ai_in_production", t, i));
  tf.active_pilots.forEach((t, i) => addTechClaim("active_pilots", t, i));
  tf.cloud_platforms.forEach((t, i) => addTechClaim("cloud_platforms", t, i));
  if (tf.data_infrastructure) addTechClaim("data_infrastructure", tf.data_infrastructure, 0);
  if (tf.clinical_platforms) addTechClaim("clinical_platforms", tf.clinical_platforms, 0);
  if (tf.analytics_bi_stack) addTechClaim("analytics_bi_stack", tf.analytics_bi_stack, 0);
  if (tf.build_vs_buy_posture) addTechClaim("build_vs_buy_posture", tf.build_vs_buy_posture, 0);
  tf.competitive_incumbents.forEach((t, i) => addTechClaim("competitive_incumbents", t, i));
  if (tfClaimIds.length > 0) {
    addObject(
      "technical_footprint",
      "technical_footprint",
      `Technical footprint — ${brief.account_name}`,
      undefined,
      tfClaimIds,
      "unknown",
      "legacy_brief_json",
    );
  }

  // programs_procurement
  const pp = brief.programs_procurement;
  const ppGrantIds: string[] = [];
  pp.modernization_grants.forEach((t, i) => {
    const c = addClaim({
      idSuffix: `mg_${i}_${t}`,
      text: t,
      type: "fact",
      provenance: "legacy_brief_json",
      section: "programs_procurement.modernization_grants",
    });
    ppGrantIds.push(c.id);
  });
  pp.consortium_purchasing.forEach((t, i) => {
    const c = addClaim({
      idSuffix: `cp_${i}_${t}`,
      text: t,
      type: "fact",
      provenance: "legacy_brief_json",
      section: "programs_procurement.consortium_purchasing",
    });
    ppGrantIds.push(c.id);
  });
  pp.active_rfps_contracts.forEach((t, i) => {
    // Per plan §4: opportunity when implies procurement window; otherwise program.
    // We default to opportunity for active_rfps_contracts (procurement window is implicit).
    const c = addClaim({
      idSuffix: `rfp_${i}_${t}`,
      text: t,
      type: "opportunity",
      provenance: "legacy_brief_json",
      section: "programs_procurement.active_rfps_contracts",
    });
    addObject(
      "programs_procurement.active_rfps_contracts",
      "opportunity",
      t.slice(0, 120),
      t,
      [c.id],
      "unknown",
      "legacy_brief_json",
      { ordinal: i },
    );
  });
  if (pp.ai_governance_policy) {
    const c = addClaim({
      idSuffix: "ai_governance_policy",
      text: pp.ai_governance_policy,
      type: "fact",
      provenance: "legacy_brief_json",
      section: "programs_procurement.ai_governance_policy",
    });
    // Per plan §4: "decision deferred to implementation"; we attach to a
    // program AccountObject. This choice is documented in the ambiguous list.
    ambiguous.push({
      section: "programs_procurement.ai_governance_policy",
      reason: "plan §4 leaves attachment ambiguous between risk_or_open_question and program; mapper defaults to procurement_program",
    });
    addObject(
      "programs_procurement.ai_governance_policy",
      "procurement_program",
      "AI governance policy",
      pp.ai_governance_policy,
      [c.id],
      "unknown",
      "legacy_brief_json",
    );
  }
  pp.public_ai_use_cases.forEach((t, i) => {
    const c = addClaim({
      idSuffix: `puc_${i}_${t}`,
      text: t,
      type: "fact",
      provenance: "legacy_brief_json",
      section: "programs_procurement.public_ai_use_cases",
    });
    ppGrantIds.push(c.id);
  });
  if (ppGrantIds.length > 0) {
    addObject(
      "programs_procurement",
      "procurement_program",
      `Programs & procurement — ${brief.account_name}`,
      undefined,
      ppGrantIds,
      "unknown",
      "legacy_brief_json",
    );
  }

  // personas[]
  const personaNames = new Map<string, string>(); // name → object id (dedup)
  brief.personas.forEach((p, i) => {
    const key = (p.name || p.title).toLowerCase().trim();
    if (personaNames.has(key)) {
      notes.push(`personas[${i}] deduped (name match): ${p.name}`);
      return;
    }
    const hasSource = !!(p.source && p.source.trim());
    const provenance: ProvenanceStatus = hasSource
      ? "source_document_only"
      : "legacy_brief_json";
    const c = addClaim({
      idSuffix: `${i}_${p.name}`,
      text: p.opener,
      type: "fact",
      provenance,
      confidence: mapConfidence(p.confidence),
      section: "personas",
      sourceText: p.source ?? null,
      summary: `${p.name} — ${p.title}`,
    });
    const obj = addObject(
      "personas",
      "stakeholder",
      `${p.name} (${p.title})`,
      `${p.priority}\n\n${p.opener}`,
      [c.id],
      mapConfidence(p.confidence),
      provenance,
      { name: p.name, title: p.title, priority: p.priority, ordinal: i },
    );
    personaNames.set(key, obj.id);
  });

  // buying_path → one Claim on root.
  if (brief.buying_path && brief.buying_path.trim()) {
    const c = addClaim({
      idSuffix: "buying_path",
      text: brief.buying_path,
      type: "inference",
      provenance: "inferred_from_brief_json",
      section: "buying_path",
    });
    rootObject.claim_ids.push(c.id);
  }

  // risks[]
  brief.risks.forEach((r, i) => {
    const c = addClaim({
      idSuffix: `${i}_${r}`,
      text: r,
      type: "risk",
      provenance: "legacy_brief_json",
      section: "risks",
    });
    addObject("risks", "risk", r.slice(0, 120), r, [c.id], "unknown", "legacy_brief_json", { ordinal: i });
  });

  // competitive_signals[]
  brief.competitive_signals.forEach((s, i) => {
    const c = addClaim({
      idSuffix: `${i}_${s}`,
      text: s,
      type: "signal",
      provenance: "legacy_brief_json",
      section: "competitive_signals",
    });
    addObject(
      "competitive_signals",
      "competitor",
      s.slice(0, 120),
      s,
      [c.id],
      "unknown",
      "legacy_brief_json",
      { ordinal: i },
    );
  });

  // next_action
  if (brief.next_action && brief.next_action.trim()) {
    const c = addClaim({
      idSuffix: "next_action",
      text: brief.next_action,
      type: "recommendation",
      provenance: "inferred_from_brief_json",
      section: "next_action",
    });
    addObject(
      "next_action",
      "recommended_action",
      "Next action",
      brief.next_action,
      [c.id],
      "unknown",
      "inferred_from_brief_json",
    );
  }

  // extensions[]
  brief.extensions.forEach((ext, i) => {
    const sectionLabel = `extensions.${ext.kind}.${ext.id}`;
    if (ext.kind === "narrative") {
      ambiguous.push({
        section: sectionLabel,
        reason: "narrative extension; body stored on synthetic legacy_brief_json SourceDocument; no Claim extraction per plan §4",
        detail: ext.body?.slice(0, 200),
      });
      return;
    }
    // Source-tier mapping per plan §5:
    //   research → source_document_only
    //   model    → inferred_from_brief_json
    //   chat     → chat_patch_object_level
    let provenance: ProvenanceStatus;
    if (ext.source === "research") provenance = "source_document_only";
    else if (ext.source === "chat") provenance = "chat_patch_object_level";
    else provenance = "inferred_from_brief_json";

    // For research with source metadata, materialize ONE external
    // SourceDocument per extension (no per-row excerpts — would fabricate).
    if (ext.source === "research" && Array.isArray(ext.sources) && ext.sources.length > 0) {
      for (const s of ext.sources) {
        materializeExternalSource(s.url || s.title, sectionLabel);
      }
    }

    let bodyRows: string[] = [];
    if (ext.kind === "card") bodyRows = [ext.body];
    else if (ext.kind === "list")
      bodyRows = ext.items.map((it) => (typeof it === "string" ? it : it.heading ? `${it.heading}: ${it.text}` : it.text));
    else if (ext.kind === "table") bodyRows = ext.rows.map((r) => r.join(" | "));

    const claimIds: string[] = [];
    bodyRows.forEach((row, j) => {
      const c = addClaim({
        idSuffix: `${ext.id}_${j}`,
        text: row,
        type: "fact",
        provenance,
        confidence: mapConfidence(ext.confidence),
        section: sectionLabel,
      });
      claimIds.push(c.id);
    });
    if (claimIds.length > 0) {
      addObject(
        sectionLabel,
        ext.source === "chat" ? "open_question" : "opportunity",
        ext.title,
        ext.why_included,
        claimIds,
        mapConfidence(ext.confidence),
        provenance,
        { extension_kind: ext.kind, extension_id: ext.id, ordinal: i },
      );
    }
  });

  // sources[] — materialize each as an external SourceDocument. If no excerpt
  // references it later, the parity report flags it as an orphan source.
  brief.sources.forEach((s, i) => {
    materializeExternalSource(s.url || s.title, `sources[${i}]`);
  });

  // ---------- Tier counts ----------
  const tierCounts: Record<string, number> = {};
  for (const c of claims) {
    tierCounts[c.provenance_status] = (tierCounts[c.provenance_status] || 0) + 1;
  }

  // Orphan sources: any SourceDocument with no excerpt referencing it AND not
  // the synthetic legacy_brief_json doc.
  const referencedSourceIds = new Set(excerpts.map((e) => e.source_document_id));
  const orphanSourceIds = sourceDocs
    .filter(
      (s) =>
        !referencedSourceIds.has(s.id) &&
        (s.metadata as Record<string, unknown> | undefined)?.subtype !== "legacy_brief_json",
    )
    .map((s) => s.id);

  const report: BackfillMappingReport = {
    account_name: brief.account_name,
    account_id,
    brief_id,
    legacy_brief_source_id: legacyBriefSourceId,
    ambiguous,
    unmapped_claims: unmapped,
    per_tier_counts: tierCounts,
    source_document_only_count: tierCounts.source_document_only || 0,
    legacy_brief_only_count: tierCounts.legacy_brief_json || 0,
    inferred_count: tierCounts.inferred_from_brief_json || 0,
    chat_patch_count: tierCounts.chat_patch_object_level || 0,
    verified_count: tierCounts.verified || 0,
    orphan_source_ids: orphanSourceIds,
    notes,
  };

  const graphRaw = {
    schema_version: 1,
    graph_id: `graph_${brief_id}`,
    generated_at: FIXED_NOW,
    account_ref,
    source_documents: sourceDocs,
    evidence_excerpts: excerpts,
    claims,
    claim_evidence: claimEvidence,
    account_objects: objects,
    edges,
    conflicts: [],
    metadata: {
      origin: "phase_a6_legacy_brief_backfill",
      brief_id,
      brief_generated_at: brief.generated_at,
    },
  };
  // Parse to apply schema defaults (status, tags, claim_ids, metadata, etc.).
  const graph = AccountGraphDocumentSchema.parse(graphRaw);
  return { graph, report };
}
