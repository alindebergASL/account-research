// Phase A.5 — Prompt contracts for staged graph assembly.
// Pure builders. No network. Fixture mode never calls these; they exist so
// future --mode model has a documented contract per spec §Prompt contracts.

import type { AccountHierarchyReference, EvidenceExcerpt, SourceDocument } from "./schema";

export type ExcerptExtractionPromptInput = {
  account: AccountHierarchyReference;
  sources: readonly SourceDocument[];
};

export function buildExcerptExtractionPrompt(input: ExcerptExtractionPromptInput): string {
  const lines: string[] = [];
  lines.push("# Excerpt Extraction (Phase A.5)");
  lines.push("");
  lines.push(
    "Task: from each supplied source, propose candidate evidence excerpts. " +
      "You MUST copy text verbatim from source.content_text. You MUST NOT paraphrase. " +
      "You MUST NOT invent source IDs. Output candidates that will be deterministically verified.",
  );
  lines.push("");
  lines.push(`Account: ${input.account.account_name} (${input.account.account_id}); scope=${input.account.scope}`);
  lines.push("");
  for (const s of input.sources) {
    lines.push(`## Source ${s.id} — ${s.title}`);
    lines.push(`kind=${s.kind} url=${s.url ?? "(none)"} allowed=${s.allowed}`);
    lines.push("---");
    lines.push(s.content_text);
    lines.push("---");
  }
  lines.push("");
  lines.push(
    "Output JSON: { excerpts: [{ source_document_id, text, char_start, char_end, extraction_method, rationale }] }",
  );
  return lines.join("\n");
}

export type ClaimAssemblyPromptInput = {
  account: AccountHierarchyReference;
  sources: readonly SourceDocument[];
  excerpts: readonly EvidenceExcerpt[];
};

export function buildClaimAssemblyPrompt(input: ClaimAssemblyPromptInput): string {
  const validExcerptIds = input.excerpts.map((e) => e.id);
  const validSourceIds = input.sources.map((s) => s.id);
  const lines: string[] = [];
  lines.push("# Claim/Object Assembly (Phase A.5)");
  lines.push("");
  lines.push(
    "Rules:\n" +
      "- Claims may cite ONLY supplied evidence excerpt IDs.\n" +
      "- Claims may NOT cite raw URLs; they cite excerpts via ClaimEvidence.\n" +
      "- High confidence requires ≥1 strong supports ClaimEvidence.\n" +
      "- Contradictions => ClaimEvidence role=contradicts and/or GraphEdge kind=contradicts and optional ConflictRecord.\n" +
      "- Claims without evidence must have provenance_status=unverified and confidence in {low, unknown}, unless type=open_question.\n" +
      "- Do not output Brief or CanvasDocument JSON. Do not output UI.",
  );
  lines.push("");
  lines.push(`Account: ${input.account.account_name} (${input.account.account_id})`);
  lines.push(`Valid source IDs: ${validSourceIds.join(", ")}`);
  lines.push(`Valid excerpt IDs: ${validExcerptIds.join(", ")}`);
  lines.push("");
  lines.push("Excerpt previews:");
  for (const ex of input.excerpts) {
    lines.push(`- ${ex.id} (src=${ex.source_document_id}): "${ex.text.slice(0, 140)}"`);
  }
  lines.push("");
  lines.push("Output JSON: AccountGraphDocument shape minus source_documents/evidence_excerpts.");
  return lines.join("\n");
}

export const PROMPT_CONTRACT_NOTES = `
Phase A.5 prompt contracts (do not exercise in fixture mode):
- Excerpt extraction: verbatim spans only; deterministic verifier rejects paraphrase.
- Claim/object assembly: only supplied excerpt IDs; allowed enums; structured output.
- Repair pass (max 1): receives validation issues + allowed IDs only; cannot mint new IDs.
`.trim();
