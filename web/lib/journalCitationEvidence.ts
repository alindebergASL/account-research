import { parseSourceLegendEntries } from "@/lib/journalSourceLegend";

function journalLegendSnippet(legendText: string): string {
  const separator = " — ";
  const separatorIndex = legendText.indexOf(separator);
  if (separatorIndex < 0) return legendText.trim();
  return legendText.slice(separatorIndex + separator.length).trim();
}

export function citationEvidenceSnippet(
  label: string,
  assistantReplyBody: string | null | undefined,
): string | null {
  const cited = parseSourceLegendEntries(assistantReplyBody ?? "").find(
    (entry) => entry.label === label,
  );
  if (!cited) return null;
  const snippet = cited.kind === "journal" ? journalLegendSnippet(cited.text) : cited.text;
  return snippet.trim() || null;
}
