import {
  neutralizeSourceLegendMarkers,
  parseSourceLegendEntries,
} from "@/lib/journalSourceLegend";

export type CitationDocumentSource = {
  filename: string;
};

export function legendComparableText(text: string, max = 120): string {
  const normalized = neutralizeSourceLegendMarkers(text)
    .replace(/\[(?=(?:J|D)\d+\])/g, "\\u005b")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

export function sourceFilenameMatchesLegend(sourceFilename: string, legendText: string): boolean {
  const comparable = legendComparableText(sourceFilename);
  if (legendText === comparable) return true;
  if (legendText.endsWith("…")) {
    return comparable.startsWith(legendText.slice(0, -1));
  }
  return false;
}

export function resolveCitedDocumentSource<T extends CitationDocumentSource>(
  label: string,
  entryBody: string | null | undefined,
  sources: readonly T[],
): T | null {
  if (!label.startsWith("[D")) return null;
  const cited = parseSourceLegendEntries(entryBody ?? "").find(
    (legendEntry) => legendEntry.label === label && legendEntry.kind === "document",
  );
  if (!cited) return null;
  return sources.find((source) => sourceFilenameMatchesLegend(source.filename, cited.text)) ?? null;
}
