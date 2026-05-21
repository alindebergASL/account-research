// Phase A.5 — Account graph validator.
// Pure function, no network. See spec §Validator rejection logic and
// §Failure-and-recovery cascade rules.

import {
  AccountGraphDocument as AccountGraphDocumentSchema,
  type AccountGraphDocument,
  type AccountObject,
  type Claim,
  type ClaimEvidence,
  type EvidenceExcerpt,
  type SourceDocument,
} from "./schema";
import { verifyExcerpt, verifyExcerpts } from "./excerpts";

export type ValidationIssueSeverity = "error" | "warning";

export type ValidationIssue = {
  code: string;
  severity: ValidationIssueSeverity;
  message: string;
  ref?: string;
};

export type AccountGraphValidationReport = {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  metrics: {
    source_count: number;
    excerpt_count: number;
    claim_count: number;
    account_object_count: number;
    claim_evidence_count: number;
    valid_excerpt_ratio: number;
    exact_span_ratio: number;
    normalized_span_ratio: number;
    claims_with_evidence_ratio: number;
    high_confidence_claims_without_strong_evidence: number;
    invented_reference_count: number;
    contradiction_count: number;
    conflict_count: number;
  };
};

function pushDuplicateIdErrors(
  errors: ValidationIssue[],
  collectionName: string,
  ids: string[],
): void {
  const seen = new Map<string, number>();
  for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
  for (const [id, count] of seen) {
    if (count > 1) {
      errors.push({
        code: "duplicate_id",
        severity: "error",
        message: `Duplicate id "${id}" in ${collectionName} (x${count})`,
        ref: id,
      });
    }
  }
}

export function validateAccountGraph(input: unknown): AccountGraphValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const parsed = AccountGraphDocumentSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({
        code: "zod_parse_error",
        severity: "error",
        message: `${issue.path.join(".") || "<root>"}: ${issue.message}`,
      });
    }
    return {
      ok: false,
      errors,
      warnings,
      metrics: {
        source_count: 0,
        excerpt_count: 0,
        claim_count: 0,
        account_object_count: 0,
        claim_evidence_count: 0,
        valid_excerpt_ratio: 0,
        exact_span_ratio: 0,
        normalized_span_ratio: 0,
        claims_with_evidence_ratio: 0,
        high_confidence_claims_without_strong_evidence: 0,
        invented_reference_count: 0,
        contradiction_count: 0,
        conflict_count: 0,
      },
    };
  }

  const graph: AccountGraphDocument = parsed.data;

  // Duplicate IDs
  pushDuplicateIdErrors(
    errors,
    "source_documents",
    graph.source_documents.map((s) => s.id),
  );
  pushDuplicateIdErrors(
    errors,
    "evidence_excerpts",
    graph.evidence_excerpts.map((e) => e.id),
  );
  pushDuplicateIdErrors(errors, "claims", graph.claims.map((c) => c.id));
  pushDuplicateIdErrors(
    errors,
    "claim_evidence",
    graph.claim_evidence.map((ce) => ce.id),
  );
  pushDuplicateIdErrors(
    errors,
    "account_objects",
    graph.account_objects.map((o) => o.id),
  );
  pushDuplicateIdErrors(errors, "edges", graph.edges.map((e) => e.id));
  pushDuplicateIdErrors(errors, "conflicts", graph.conflicts.map((c) => c.id));

  const sourceMap = new Map<string, SourceDocument>(
    graph.source_documents.map((s) => [s.id, s]),
  );
  const excerptMap = new Map<string, EvidenceExcerpt>(
    graph.evidence_excerpts.map((e) => [e.id, e]),
  );
  const claimMap = new Map<string, Claim>(graph.claims.map((c) => [c.id, c]));
  const objectMap = new Map<string, AccountObject>(
    graph.account_objects.map((o) => [o.id, o]),
  );

  let inventedReferenceCount = 0;

  // EvidenceExcerpt → SourceDocument referential integrity + verification.
  for (const ex of graph.evidence_excerpts) {
    const src = sourceMap.get(ex.source_document_id);
    if (!src) {
      inventedReferenceCount += 1;
      errors.push({
        code: "invented_source_reference",
        severity: "error",
        message: `Evidence excerpt ${ex.id} references unknown source ${ex.source_document_id}`,
        ref: ex.id,
      });
      continue;
    }
    const r = verifyExcerpt(ex, src);
    if (!r.ok) {
      errors.push({
        code: "excerpt_verification_failed",
        severity: "error",
        message: `Excerpt ${ex.id} failed verification: ${r.reason}${r.detail ? " — " + r.detail : ""}`,
        ref: ex.id,
      });
    }
  }

  // ClaimEvidence referential integrity
  for (const ce of graph.claim_evidence) {
    if (!claimMap.has(ce.claim_id)) {
      inventedReferenceCount += 1;
      errors.push({
        code: "invented_claim_reference",
        severity: "error",
        message: `ClaimEvidence ${ce.id} references unknown claim ${ce.claim_id}`,
        ref: ce.id,
      });
    }
    if (!excerptMap.has(ce.evidence_excerpt_id)) {
      inventedReferenceCount += 1;
      errors.push({
        code: "invented_excerpt_reference",
        severity: "error",
        message: `ClaimEvidence ${ce.id} references unknown excerpt ${ce.evidence_excerpt_id}`,
        ref: ce.id,
      });
    }
  }

  // Index claim_evidence by claim
  const evidenceByClaim = new Map<string, ClaimEvidence[]>();
  for (const ce of graph.claim_evidence) {
    if (!evidenceByClaim.has(ce.claim_id)) evidenceByClaim.set(ce.claim_id, []);
    evidenceByClaim.get(ce.claim_id)!.push(ce);
  }

  // Claim-level checks
  let claimsWithEvidence = 0;
  let highConfWithoutStrong = 0;
  for (const claim of graph.claims) {
    const links = evidenceByClaim.get(claim.id) ?? [];
    const supportingLinks = links.filter(
      (l) => l.role === "supports" || l.role === "partially_supports",
    );
    if (supportingLinks.length > 0) claimsWithEvidence += 1;

    if (claim.provenance_status === "verified") {
      // Phase A.6 HARD INVARIANT (plan §5): no high-confidence graph claim
      // derived from unsupported or unsourced legacy brief text may be
      // marked `verified`. If the only supporting excerpts trace to a
      // synthetic `legacy_brief_json` / `chat_patch_event` / `user_edit_event`
      // SourceDocument, fail hard.
      const isLegacyBackedOnly =
        supportingLinks.length > 0 &&
        supportingLinks.every((l) => {
          const ex = excerptMap.get(l.evidence_excerpt_id);
          if (!ex) return false;
          const src = sourceMap.get(ex.source_document_id);
          if (!src) return false;
          const subtype = (src.metadata as Record<string, unknown> | undefined)
            ?.subtype;
          return (
            subtype === "legacy_brief_json" ||
            subtype === "chat_patch_event" ||
            subtype === "user_edit_event"
          );
        });
      if (isLegacyBackedOnly) {
        errors.push({
          code: "verified_from_legacy_brief_only",
          severity: "error",
          message:
            `Claim ${claim.id} has provenance_status=verified but its only supporting ` +
            `evidence traces back to a synthetic legacy_brief_json / chat_patch_event / ` +
            `user_edit_event SourceDocument. The A.6 HARD INVARIANT forbids this.`,
          ref: claim.id,
        });
      }
      const hasValidSupport = supportingLinks.some((l) => {
        const ex = excerptMap.get(l.evidence_excerpt_id);
        if (!ex) return false;
        const src = sourceMap.get(ex.source_document_id);
        if (!src) return false;
        if (!src.allowed) return false;
        const subtype = (src.metadata as Record<string, unknown> | undefined)
          ?.subtype;
        if (
          subtype === "legacy_brief_json" ||
          subtype === "chat_patch_event" ||
          subtype === "user_edit_event"
        ) {
          return false;
        }
        const r = verifyExcerpt(ex, src);
        return r.ok;
      });
      if (!hasValidSupport) {
        errors.push({
          code: "verified_without_evidence",
          severity: "error",
          message: `Claim ${claim.id} has provenance_status=verified but lacks valid supporting evidence from an allowed source`,
          ref: claim.id,
        });
      }
      // disallowed source supporting verified claim
      for (const l of supportingLinks) {
        const ex = excerptMap.get(l.evidence_excerpt_id);
        if (!ex) continue;
        const src = sourceMap.get(ex.source_document_id);
        if (src && !src.allowed) {
          errors.push({
            code: "disallowed_source_supports_verified_claim",
            severity: "error",
            message: `Verified claim ${claim.id} supported by disallowed source ${src.id}`,
            ref: claim.id,
          });
        }
      }
    }

    if (claim.confidence === "high") {
      const hasStrongOrMedium = supportingLinks.some(
        (l) => l.strength === "strong" || l.strength === "medium",
      );
      if (!hasStrongOrMedium) {
        highConfWithoutStrong += 1;
        errors.push({
          code: "high_confidence_without_strong_evidence",
          severity: "error",
          message: `Claim ${claim.id} has confidence=high but no strong/medium supporting evidence`,
          ref: claim.id,
        });
      }
    }

    if (claim.confidence === "medium") {
      const hasNonWeak = supportingLinks.some(
        (l) => l.strength === "strong" || l.strength === "medium",
      );
      if (supportingLinks.length > 0 && !hasNonWeak) {
        warnings.push({
          code: "medium_confidence_weak_only",
          severity: "warning",
          message: `Claim ${claim.id} has medium confidence backed only by weak evidence`,
          ref: claim.id,
        });
      }
    }

    if (
      supportingLinks.length === 0 &&
      claim.type !== "open_question" &&
      claim.type !== "recommendation"
    ) {
      warnings.push({
        code: "claim_no_evidence",
        severity: "warning",
        message: `Claim ${claim.id} has no supporting evidence and is not an open_question/recommendation`,
        ref: claim.id,
      });
    }

    if (claim.freshness === "stale" || claim.freshness === "unknown") {
      warnings.push({
        code: "freshness_low",
        severity: "warning",
        message: `Claim ${claim.id} freshness is ${claim.freshness}`,
        ref: claim.id,
      });
    }
  }

  // AccountObject checks
  for (const obj of graph.account_objects) {
    for (const claimId of obj.claim_ids) {
      if (!claimMap.has(claimId)) {
        inventedReferenceCount += 1;
        errors.push({
          code: "invented_claim_reference",
          severity: "error",
          message: `AccountObject ${obj.id} references unknown claim ${claimId}`,
          ref: obj.id,
        });
      }
    }
    if (obj.claim_ids.length === 0) {
      warnings.push({
        code: "object_without_claims",
        severity: "warning",
        message: `AccountObject ${obj.id} has zero claim_ids`,
        ref: obj.id,
      });
    }
  }

  // GraphEdge endpoint integrity
  for (const e of graph.edges) {
    const known = (kind: string, id: string) => {
      switch (kind) {
        case "claim":
          return claimMap.has(id);
        case "account_object":
          return objectMap.has(id);
        case "source_document":
          return sourceMap.has(id);
        case "evidence_excerpt":
          return excerptMap.has(id);
      }
      return false;
    };
    if (!known(e.from_type, e.from_id)) {
      inventedReferenceCount += 1;
      errors.push({
        code: "edge_missing_endpoint",
        severity: "error",
        message: `Edge ${e.id} from ${e.from_type}:${e.from_id} not found`,
        ref: e.id,
      });
    }
    if (!known(e.to_type, e.to_id)) {
      inventedReferenceCount += 1;
      errors.push({
        code: "edge_missing_endpoint",
        severity: "error",
        message: `Edge ${e.id} to ${e.to_type}:${e.to_id} not found`,
        ref: e.id,
      });
    }
  }

  // Conflict claim_ids referential integrity
  for (const conf of graph.conflicts) {
    for (const cid of conf.claim_ids) {
      if (!claimMap.has(cid)) {
        inventedReferenceCount += 1;
        errors.push({
          code: "invented_claim_reference",
          severity: "error",
          message: `Conflict ${conf.id} references unknown claim ${cid}`,
          ref: conf.id,
        });
      }
    }
  }

  // PII / retention warnings
  for (const src of graph.source_documents) {
    if (src.pii_risk === "medium" || src.pii_risk === "high") {
      warnings.push({
        code: "source_pii_risk",
        severity: "warning",
        message: `Source ${src.id} pii_risk=${src.pii_risk}`,
        ref: src.id,
      });
    }
    if (src.retention === "do_not_store" && src.content_text.length > 0) {
      warnings.push({
        code: "retention_do_not_store_with_text",
        severity: "warning",
        message: `Source ${src.id} retention=do_not_store but content_text present`,
        ref: src.id,
      });
    }
  }

  const verify = verifyExcerpts(graph.evidence_excerpts, graph.source_documents);

  const contradictionCount =
    graph.claim_evidence.filter((ce) => ce.role === "contradicts").length +
    graph.edges.filter((e) => e.kind === "contradicts").length;

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    metrics: {
      source_count: graph.source_documents.length,
      excerpt_count: graph.evidence_excerpts.length,
      claim_count: graph.claims.length,
      account_object_count: graph.account_objects.length,
      claim_evidence_count: graph.claim_evidence.length,
      valid_excerpt_ratio: verify.valid_ratio,
      exact_span_ratio: verify.exact_span_ratio,
      normalized_span_ratio: verify.normalized_span_ratio,
      claims_with_evidence_ratio:
        graph.claims.length === 0 ? 1 : claimsWithEvidence / graph.claims.length,
      high_confidence_claims_without_strong_evidence: highConfWithoutStrong,
      invented_reference_count: inventedReferenceCount,
      contradiction_count: contradictionCount,
      conflict_count: graph.conflicts.length,
    },
  };
}

// -------------------- Cascade impact --------------------

export type GraphCorrectionEvent =
  | { type: "claim_marked_wrong"; claim_id: string }
  | { type: "source_marked_unreliable"; source_id: string }
  | { type: "evidence_excerpt_invalidated"; excerpt_id: string }
  | { type: "account_object_marked_wrong"; object_id: string };

export type CascadeImpact = {
  event: GraphCorrectionEvent;
  affected_claim_ids: string[];
  affected_object_ids: string[];
  affected_excerpt_ids: string[];
  affected_claim_evidence_ids: string[];
  affected_conflict_ids: string[];
  notes: string[];
};

export function computeCascadeImpact(
  graph: AccountGraphDocument,
  event: GraphCorrectionEvent,
): CascadeImpact {
  const notes: string[] = [];
  const affected_claim_ids = new Set<string>();
  const affected_object_ids = new Set<string>();
  const affected_excerpt_ids = new Set<string>();
  const affected_claim_evidence_ids = new Set<string>();
  const affected_conflict_ids = new Set<string>();

  const claimsForObject = (objectId: string): string[] => {
    const o = graph.account_objects.find((x) => x.id === objectId);
    return o ? o.claim_ids : [];
  };

  const objectsReferencingClaim = (claimId: string): string[] =>
    graph.account_objects.filter((o) => o.claim_ids.includes(claimId)).map((o) => o.id);

  const evidenceForExcerpt = (excerptId: string): string[] =>
    graph.claim_evidence.filter((ce) => ce.evidence_excerpt_id === excerptId).map((ce) => ce.id);

  const claimsForExcerpt = (excerptId: string): string[] =>
    Array.from(
      new Set(
        graph.claim_evidence
          .filter((ce) => ce.evidence_excerpt_id === excerptId)
          .map((ce) => ce.claim_id),
      ),
    );

  if (event.type === "claim_marked_wrong") {
    affected_claim_ids.add(event.claim_id);
    notes.push(`Claim ${event.claim_id} marked_wrong; status should become marked_wrong.`);
    const objs = objectsReferencingClaim(event.claim_id);
    for (const oid of objs) {
      affected_object_ids.add(oid);
      const allClaims = claimsForObject(oid);
      if (allClaims.length === 1) {
        notes.push(
          `Object ${oid} depends solely on claim ${event.claim_id}; downgrade to marked_wrong.`,
        );
      } else {
        notes.push(
          `Object ${oid} loses claim ${event.claim_id} (had ${allClaims.length}); confidence downgrade + review.`,
        );
      }
    }
    // claim-to-claim derived/supports edges
    for (const e of graph.edges) {
      if (
        (e.from_id === event.claim_id || e.to_id === event.claim_id) &&
        (e.kind === "supports" || e.kind === "derived_from")
      ) {
        const otherId = e.from_id === event.claim_id ? e.to_id : e.from_id;
        const otherType = e.from_id === event.claim_id ? e.to_type : e.from_type;
        if (otherType === "claim") {
          affected_claim_ids.add(otherId);
          notes.push(`Claim ${otherId} flagged due to ${e.kind} relationship with ${event.claim_id}.`);
        }
      }
    }
    // conflicts referencing claim
    for (const c of graph.conflicts) {
      if (c.claim_ids.includes(event.claim_id)) affected_conflict_ids.add(c.id);
    }
  } else if (event.type === "source_marked_unreliable") {
    const impactedExcerpts = graph.evidence_excerpts.filter(
      (e) => e.source_document_id === event.source_id,
    );
    for (const ex of impactedExcerpts) {
      affected_excerpt_ids.add(ex.id);
      for (const ceid of evidenceForExcerpt(ex.id)) affected_claim_evidence_ids.add(ceid);
      for (const cid of claimsForExcerpt(ex.id)) {
        // Claims supported only by impacted evidence
        const supportingLinks = graph.claim_evidence.filter(
          (ce) => ce.claim_id === cid && (ce.role === "supports" || ce.role === "partially_supports"),
        );
        const onlyImpacted = supportingLinks.every((l) => {
          const lEx = graph.evidence_excerpts.find((x) => x.id === l.evidence_excerpt_id);
          return lEx && lEx.source_document_id === event.source_id;
        });
        if (onlyImpacted && supportingLinks.length > 0) {
          affected_claim_ids.add(cid);
          notes.push(
            `Claim ${cid} supported only by source ${event.source_id}; downgrade and review.`,
          );
        } else {
          affected_claim_ids.add(cid);
          notes.push(`Claim ${cid} loses some evidence from source ${event.source_id}; review.`);
        }
      }
    }
    for (const c of graph.conflicts) {
      if (c.claim_ids.some((cid) => affected_claim_ids.has(cid))) {
        affected_conflict_ids.add(c.id);
      }
    }
  } else if (event.type === "evidence_excerpt_invalidated") {
    affected_excerpt_ids.add(event.excerpt_id);
    for (const ceid of evidenceForExcerpt(event.excerpt_id)) affected_claim_evidence_ids.add(ceid);
    for (const cid of claimsForExcerpt(event.excerpt_id)) {
      affected_claim_ids.add(cid);
      notes.push(`Claim ${cid} affected by invalidated excerpt ${event.excerpt_id}.`);
    }
  } else if (event.type === "account_object_marked_wrong") {
    affected_object_ids.add(event.object_id);
    const cids = claimsForObject(event.object_id);
    if (cids.length === 1) {
      affected_claim_ids.add(cids[0]);
      notes.push(
        `Object ${event.object_id} is a single-claim wrapper; its claim ${cids[0]} is also flagged.`,
      );
    } else {
      notes.push(
        `Object ${event.object_id} marked wrong; its ${cids.length} claims are NOT automatically wrong, but related recommended actions should be reviewed.`,
      );
    }
    // Flag recommended_action / opportunity objects relating to the marked object
    for (const e of graph.edges) {
      if (e.from_id === event.object_id || e.to_id === event.object_id) {
        const otherId = e.from_id === event.object_id ? e.to_id : e.from_id;
        const otherType = e.from_id === event.object_id ? e.to_type : e.from_type;
        if (otherType === "account_object") {
          affected_object_ids.add(otherId);
          notes.push(`Related object ${otherId} flagged review-needed.`);
        }
      }
    }
  }

  return {
    event,
    affected_claim_ids: Array.from(affected_claim_ids),
    affected_object_ids: Array.from(affected_object_ids),
    affected_excerpt_ids: Array.from(affected_excerpt_ids),
    affected_claim_evidence_ids: Array.from(affected_claim_evidence_ids),
    affected_conflict_ids: Array.from(affected_conflict_ids),
    notes,
  };
}
