// Phase A.5 — Deterministic excerpt verification.
// Pure helpers — no network, no model calls. See spec §EvidenceExcerpt.

import type { EvidenceExcerpt, SourceDocument } from "./schema";

/**
 * Normalize text for tolerant matching: collapse whitespace runs into a single
 * space, trim, case-fold. Used by normalized_span verification.
 */
export function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export type ExcerptCheckResult =
  | { ok: true; method: "exact_span" | "normalized_span" }
  | {
      ok: false;
      reason:
        | "missing_source"
        | "offsets_out_of_range"
        | "offsets_invalid"
        | "exact_mismatch"
        | "normalized_mismatch"
        | "paraphrase_not_found_in_source"
        | "text_too_short";
      detail?: string;
    };

/**
 * Verify a single excerpt against its cited source document.
 * Does NOT mutate inputs. Pure.
 */
export function verifyExcerpt(
  excerpt: EvidenceExcerpt,
  source: SourceDocument | undefined,
): ExcerptCheckResult {
  if (!source || source.id !== excerpt.source_document_id) {
    return { ok: false, reason: "missing_source" };
  }
  if (excerpt.text.length < 20) {
    return { ok: false, reason: "text_too_short" };
  }
  if (excerpt.char_start >= excerpt.char_end) {
    return { ok: false, reason: "offsets_invalid" };
  }
  const len = source.content_text.length;
  if (excerpt.char_start < 0 || excerpt.char_end > len) {
    return { ok: false, reason: "offsets_out_of_range" };
  }
  const slice = source.content_text.slice(excerpt.char_start, excerpt.char_end);

  if (excerpt.extraction_method === "exact_span" || excerpt.extraction_method === "manual") {
    if (slice === excerpt.text) {
      return { ok: true, method: "exact_span" };
    }
    // Fallback to normalized match for the same method? No — exact_span must
    // be exact. We mark it as exact_mismatch.
    return {
      ok: false,
      reason: "exact_mismatch",
      detail: `expected exact slice "${truncate(slice)}" === text "${truncate(excerpt.text)}"`,
    };
  }

  if (
    excerpt.extraction_method === "normalized_span" ||
    excerpt.extraction_method === "model_suggested_verified"
  ) {
    if (slice === excerpt.text) return { ok: true, method: "exact_span" };
    if (normalizeForMatch(slice) === normalizeForMatch(excerpt.text)) {
      return { ok: true, method: "normalized_span" };
    }
    // Paraphrase detection: if normalized excerpt text does not appear
    // anywhere in normalized source, reject as paraphrase.
    const normSource = normalizeForMatch(source.content_text);
    if (!normSource.includes(normalizeForMatch(excerpt.text))) {
      return { ok: false, reason: "paraphrase_not_found_in_source" };
    }
    return { ok: false, reason: "normalized_mismatch" };
  }

  return { ok: false, reason: "exact_mismatch" };
}

function truncate(s: string, n = 60): string {
  return s.length <= n ? s : `${s.slice(0, n)}...`;
}

/**
 * Verify many excerpts; returns per-excerpt result plus aggregate metrics
 * useful for the Spike B reliability harness.
 */
export function verifyExcerpts(
  excerpts: readonly EvidenceExcerpt[],
  sources: readonly SourceDocument[],
): {
  results: { excerpt_id: string; result: ExcerptCheckResult }[];
  total: number;
  exact_span_ok: number;
  normalized_span_ok: number;
  failed: number;
  exact_span_ratio: number;
  normalized_span_ratio: number;
  valid_ratio: number;
} {
  const sourceMap = new Map(sources.map((s) => [s.id, s]));
  const results = excerpts.map((ex) => ({
    excerpt_id: ex.id,
    result: verifyExcerpt(ex, sourceMap.get(ex.source_document_id)),
  }));
  const total = results.length;
  const exact_span_ok = results.filter(
    (r) => r.result.ok && r.result.method === "exact_span",
  ).length;
  const normalized_span_ok = results.filter(
    (r) => r.result.ok && r.result.method === "normalized_span",
  ).length;
  const failed = total - exact_span_ok - normalized_span_ok;
  return {
    results,
    total,
    exact_span_ok,
    normalized_span_ok,
    failed,
    exact_span_ratio: total === 0 ? 1 : exact_span_ok / total,
    normalized_span_ratio: total === 0 ? 1 : (exact_span_ok + normalized_span_ok) / total,
    valid_ratio: total === 0 ? 1 : (exact_span_ok + normalized_span_ok) / total,
  };
}

/**
 * Paraphrase rejection helper used by extractor tests: check whether a
 * candidate snippet exists in the source under exact or normalized match.
 * Returns false for paraphrases.
 */
export function snippetAppearsInSource(snippet: string, source: SourceDocument): boolean {
  if (source.content_text.includes(snippet)) return true;
  return normalizeForMatch(source.content_text).includes(normalizeForMatch(snippet));
}
