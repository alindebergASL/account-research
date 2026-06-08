export const SOURCE_LEGEND_MARKER = "[[JOURNAL_SOURCE_LEGEND_V1]]";
export const SOURCE_LEGEND_HEADING = "Sources for this reply:";
export const SOURCE_LEGEND_BLOCK_PREFIX = `\n\n---\n${SOURCE_LEGEND_MARKER}\n${SOURCE_LEGEND_HEADING}\n`;

export type SourceLegendEntry = {
  label: string;
  kind: "journal" | "document";
  text: string;
};

export function neutralizeSourceLegendMarkers(text: string): string {
  return text
    .replaceAll(SOURCE_LEGEND_MARKER, "[journal-source-legend-marker]")
    .replaceAll(SOURCE_LEGEND_HEADING, "Sources for this reply﹕");
}

export function findSourceLegendBlockStart(body: string): number {
  return body.lastIndexOf(SOURCE_LEGEND_BLOCK_PREFIX);
}

export function parseSourceLegendEntries(body: string): SourceLegendEntry[] {
  const start = findSourceLegendBlockStart(body);
  if (start < 0) return [];
  const legendText = body.slice(start + SOURCE_LEGEND_BLOCK_PREFIX.length);
  const entries: SourceLegendEntry[] = [];
  for (const rawLine of legendText.split("\n")) {
    const line = rawLine.trim();
    const match = line.match(/^(\[(J|D)\d+\])\s+(.+)$/);
    if (!match) continue;
    entries.push({
      label: match[1],
      kind: match[2] === "D" ? "document" : "journal",
      text: match[3].trim(),
    });
  }
  return entries;
}

export function formatSourceLegendBlock(lines: string[]): string {
  if (lines.length === 0) return "";
  return `${SOURCE_LEGEND_BLOCK_PREFIX}${lines.join("\n")}`;
}
