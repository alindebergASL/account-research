import {
  neutralizeSourceLegendMarkers,
  parseSourceLegendEntries,
} from "@/lib/journalSourceLegend";

export type CitationDocumentSource = {
  filename: string;
};

export type CitationJournalEntry = {
  body: string | null | undefined;
};

export type CitationBriefSource = {
  title?: string | null;
  url?: string | null;
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

function comparableTextMatchesLegend(actualText: string | null | undefined, legendText: string): boolean {
  const comparable = legendComparableText(actualText ?? "");
  const legendComparable = legendComparableText(legendText);
  if (!legendComparable) return false;
  if (comparable === legendComparable) return true;
  if (legendComparable.endsWith("…")) {
    return comparable.startsWith(legendComparable.slice(0, -1));
  }
  return comparable.startsWith(legendComparable);
}

function journalLegendSnippet(legendText: string): string {
  const separator = " — ";
  const separatorIndex = legendText.indexOf(separator);
  if (separatorIndex < 0) return legendText;
  return legendText.slice(separatorIndex + separator.length).trim();
}

export function sourceFilenameMatchesLegend(sourceFilename: string, legendText: string): boolean {
  return comparableTextMatchesLegend(sourceFilename, legendText);
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

export function resolveCitedBriefSource<T extends CitationBriefSource>(
  label: string,
  entryBody: string | null | undefined,
  sources: readonly T[],
): T | null {
  if (!label.startsWith("[D")) return null;
  const cited = parseSourceLegendEntries(entryBody ?? "").find(
    (legendEntry) => legendEntry.label === label && legendEntry.kind === "document",
  );
  if (!cited) return null;
  return (
    sources.find(
      (source) =>
        comparableTextMatchesLegend(source.title, cited.text) ||
        comparableTextMatchesLegend(source.url, cited.text),
    ) ?? null
  );
}

export function resolveCitedJournalEntry<T extends CitationJournalEntry>(
  label: string,
  entryBody: string | null | undefined,
  entries: readonly T[],
): T | null {
  if (!label.startsWith("[J")) return null;
  const cited = parseSourceLegendEntries(entryBody ?? "").find(
    (legendEntry) => legendEntry.label === label && legendEntry.kind === "journal",
  );
  if (!cited) return null;
  const snippet = journalLegendSnippet(cited.text);
  return entries.find((entry) => comparableTextMatchesLegend(entry.body, snippet)) ?? null;
}
