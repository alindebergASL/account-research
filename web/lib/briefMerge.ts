import type { Brief, BriefExtension, Initiative, Persona, Signal, Source } from "./schema";

type Flagged<T> = T & { previously_found?: boolean };

function normalize(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleKey(s: string): string {
  return normalize(s);
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = normalize(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function jaccard(a: string, b: string): number {
  const as = new Set(normalize(a).split(" ").filter(Boolean));
  const bs = new Set(normalize(b).split(" ").filter(Boolean));
  if (as.size === 0 && bs.size === 0) return 1;
  let intersection = 0;
  for (const token of as) if (bs.has(token)) intersection++;
  const union = new Set([...as, ...bs]).size;
  return union === 0 ? 0 : intersection / union;
}

function markPreviouslyFound<T extends object>(item: T): Flagged<T> {
  return { ...item, previously_found: true };
}

function mergeByTitle<T extends { title: string }>(prev: T[], next: T[]): Flagged<T>[] {
  const nextKeys = new Set(next.map((item) => titleKey(item.title)));
  const retained = prev
    .filter((item) => !nextKeys.has(titleKey(item.title)))
    .map(markPreviouslyFound);
  return [...next, ...retained];
}

function markPreviouslyFoundUnlessChat<T extends { source?: string }>(item: T): Flagged<T> {
  return item.source === "chat" ? { ...item } : { ...item, previously_found: true };
}

function mergePersonas(prev: Persona[], next: Persona[]): Flagged<Persona>[] {
  const keyFor = (p: Persona) => titleKey(p.name || p.title);
  const nextKeys = new Set(next.map(keyFor));
  const retained = prev.filter((p) => !nextKeys.has(keyFor(p))).map(markPreviouslyFoundUnlessChat);
  return [...next, ...retained];
}

function mergeSignals(prev: Signal[], next: Signal[]): Flagged<Signal>[] {
  const retained = prev
    .filter((old) => !next.some((fresh) => jaccard(old.text, fresh.text) >= 0.7))
    .map(markPreviouslyFound);
  return [...next, ...retained];
}

function mergeSources(prev: Source[], next: Source[]): Source[] {
  const byUrl = new Map<string, Source>();
  for (const source of prev) byUrl.set(source.url, source);
  for (const source of next) byUrl.set(source.url, source);
  return Array.from(byUrl.values()).filter((source) => source.url);
}

function mergeExtensions(prev: BriefExtension[], next: BriefExtension[]): Array<BriefExtension & { previously_found?: boolean }> {
  const nextIds = new Set(next.map((extension) => extension.id));
  const retained = prev
    .filter((extension) => !nextIds.has(extension.id))
    .map((extension) =>
      extension.source === "chat" ? extension : { ...extension, previously_found: true },
    );
  return [...next, ...retained];
}

export function mergeBriefs(prev: Brief, next: Brief): Brief {
  return {
    ...next,
    top_initiatives: mergeByTitle<Initiative>(prev.top_initiatives ?? [], next.top_initiatives ?? []),
    recent_signals: mergeSignals(prev.recent_signals ?? [], next.recent_signals ?? []),
    technical_footprint: next.technical_footprint,
    programs_procurement: next.programs_procurement,
    personas: mergePersonas(prev.personas ?? [], next.personas ?? []),
    risks: dedupeStrings([...(next.risks ?? []), ...(prev.risks ?? [])]),
    competitive_signals: dedupeStrings([
      ...(next.competitive_signals ?? []),
      ...(prev.competitive_signals ?? []),
    ]),
    sources: mergeSources(prev.sources ?? [], next.sources ?? []),
    extensions: mergeExtensions(prev.extensions ?? [], next.extensions ?? []),
  };
}
