export const SOURCE_LEGEND_MARKER = "[[JOURNAL_SOURCE_LEGEND_V1]]";
export const SOURCE_LEGEND_HEADING = "Sources for this reply:";
export const SOURCE_LEGEND_BLOCK_PREFIX = `\n\n---\n${SOURCE_LEGEND_MARKER}\n${SOURCE_LEGEND_HEADING}\n`;

export function neutralizeSourceLegendMarkers(text: string): string {
  return text
    .replaceAll(SOURCE_LEGEND_MARKER, "[journal-source-legend-marker]")
    .replaceAll(SOURCE_LEGEND_HEADING, "Sources for this reply﹕");
}

export function findSourceLegendBlockStart(body: string): number {
  return body.lastIndexOf(SOURCE_LEGEND_BLOCK_PREFIX);
}

export function formatSourceLegendBlock(lines: string[]): string {
  if (lines.length === 0) return "";
  return `${SOURCE_LEGEND_BLOCK_PREFIX}${lines.join("\n")}`;
}
