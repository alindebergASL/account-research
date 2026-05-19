import type { SectionRefWidget } from "../../../lib/canvas/schema";

// Stakeholder / persona map. A central Decision node sits in the middle;
// each persona becomes a satellite card. Edges between Decision and a
// persona are drawn only when the persona's `name` or `title` tokens
// appear (case-insensitive, word-boundary) in `buying_path`. Isolated
// nodes are honest: no inferred relationships.
//
// Data is sourced from `widget.evidence`:
//   - persona items carry tag === "persona" and store the persona as
//     "Name — Title" in `text`; `source` carries the persona's source.
//   - exactly one evidence entry with tag === "buying_path" carries the
//     buying-path text in `text`.

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with",
  "is", "are", "be", "by", "as", "at", "this", "that", "it", "its",
  "from", "but", "not", "found", "via",
]);

function tokenize(text: string): Set<string> {
  if (!text) return new Set();
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
  );
}

export type PersonaNode = { name: string; title: string };

function splitPersona(text: string): PersonaNode {
  // Adapter emits "<Name> — <Title>"; fall back to the whole string if
  // the separator is missing.
  const idx = text.indexOf("—");
  if (idx === -1) return { name: text.trim(), title: "" };
  return {
    name: text.slice(0, idx).trim(),
    title: text.slice(idx + 1).trim(),
  };
}

export function extractPersonas(
  widget: import("zod").infer<typeof SectionRefWidget>,
): PersonaNode[] {
  return widget.evidence
    .filter((ev) => ev.tag === "persona")
    .map((ev) => splitPersona(ev.text));
}

export function extractBuyingPath(
  widget: import("zod").infer<typeof SectionRefWidget>,
): string {
  const e = widget.evidence.find((ev) => ev.tag === "buying_path");
  return e?.text ?? "";
}

export function personaHasEdge(
  persona: PersonaNode,
  buyingPath: string,
): boolean {
  if (!buyingPath) return false;
  const path = tokenize(buyingPath);
  const personaT = new Set([...tokenize(persona.name), ...tokenize(persona.title)]);
  for (const t of personaT) {
    if (path.has(t)) return true;
  }
  return false;
}

function nodePosition(index: number, total: number): { x: number; y: number } {
  // Lay out personas evenly on a circle around the central Decision node.
  const angle = (2 * Math.PI * index) / Math.max(total, 1) - Math.PI / 2;
  const r = 36; // percentage of container
  const x = 50 + r * Math.cos(angle);
  const y = 50 + r * Math.sin(angle);
  return { x, y };
}

export function PersonaMapTile({
  widget,
}: {
  widget: import("zod").infer<typeof SectionRefWidget>;
}) {
  const personas = extractPersonas(widget);
  const buyingPath = extractBuyingPath(widget);
  const total = personas.length;

  return (
    <div data-testid="persona-map" className="space-y-2 min-w-0">
      {/*
        Mobile (< sm): list-first layout with a "Decision" chip at the top
        and a left-margin connector indicating which personas have
        buying_path evidence. Edges-as-SVG are hidden below sm.
      */}
      <div className="sm:hidden">
        <div className="flex items-center gap-2 pb-2">
          <span
            className="inline-flex items-center rounded-full bg-[var(--accent)] text-white text-[10px] font-semibold px-2 py-0.5"
            aria-label="Decision"
          >
            Decision
          </span>
          <span className="text-[10px] text-muted">
            Buying committee
          </span>
        </div>
        {personas.length === 0 ? (
          <p className="text-xs text-muted">
            Buying committee not yet identified — validate before action.
          </p>
        ) : (
          <ul
            data-testid="persona-list"
            className="border-l-2 border-[var(--line)] pl-3 space-y-1.5"
          >
            {personas.map((p, i) => {
              const linked = personaHasEdge(p, buyingPath);
              return (
                <li
                  key={`mlist-${i}`}
                  data-testid={linked ? "persona-list-linked" : "persona-list-isolated"}
                  className="relative text-xs leading-snug"
                  style={
                    linked
                      ? {
                          borderLeft: "2px solid var(--accent)",
                          marginLeft: "-14px",
                          paddingLeft: "12px",
                        }
                      : undefined
                  }
                >
                  <span className="font-medium">{p.name}</span>{" "}
                  <span className="text-muted">— {p.title}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {/* Spatial map (sm and above). */}
      <div
        className="hidden sm:block relative w-full"
        style={{ aspectRatio: "16 / 9", minHeight: 120 }}
      >
        <svg
          data-testid="persona-map-svg"
          className="absolute inset-0 w-full h-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {personas.map((p, i) => {
            if (!personaHasEdge(p, buyingPath)) return null;
            const pos = nodePosition(i, total);
            return (
              <line
                key={`edge-${i}`}
                data-testid="persona-map-edge"
                x1={50}
                y1={50}
                x2={pos.x}
                y2={pos.y}
                stroke="var(--line)"
                strokeWidth={0.5}
              />
            );
          })}
        </svg>
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--accent)] text-white text-[10px] font-semibold px-2 py-1"
          aria-label="Decision"
        >
          Decision
        </div>
        {personas.map((p, i) => {
          const pos = nodePosition(i, total);
          return (
            <div
              key={`node-${i}`}
              data-testid="persona-map-node"
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded-md border border-[var(--line)] bg-white px-1.5 py-0.5 text-[10px] leading-tight max-w-[36%] truncate"
              style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
              title={`${p.name} — ${p.title}`}
            >
              <div className="font-medium truncate">{p.name}</div>
              <div className="text-muted truncate">{p.title}</div>
            </div>
          );
        })}
        {personas.length === 0 && (
          <p className="absolute inset-0 flex items-center justify-center text-xs text-muted">
            Buying committee not yet identified — validate before action.
          </p>
        )}
      </div>
      <p className="text-[10px] text-muted">
        Edges only where the buying path mentions a persona by name or title.
      </p>
    </div>
  );
}

export function PersonaMapDetail({
  widget,
}: {
  widget: import("zod").infer<typeof SectionRefWidget>;
}) {
  const personas = extractPersonas(widget);
  const buyingPath = extractBuyingPath(widget);
  const isolated = personas.filter((p) => !personaHasEdge(p, buyingPath));
  const linked = personas.filter((p) => personaHasEdge(p, buyingPath));

  return (
    <div data-testid="persona-map" className="space-y-4 min-w-0">
      <p className="text-xs text-muted">
        Persona positions are decorative. Edges are drawn only when the
        buying path text mentions a persona by name or title.
      </p>
      <PersonaMapTile widget={widget} />
      <section>
        <div className="text-[10px] uppercase tracking-wider text-muted mb-2">
          Mentioned in the buying path
        </div>
        {linked.length === 0 ? (
          <p className="text-sm text-muted">
            No persona is mentioned in the buying path.
          </p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {linked.map((p, i) => (
              <li key={`linked-${i}`} className="leading-snug">
                <span className="font-medium">{p.name}</span>{" "}
                <span className="text-muted">— {p.title}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {isolated.length > 0 && (
        <section>
          <div className="text-[10px] uppercase tracking-wider text-muted mb-2">
            Not mentioned in the buying path
          </div>
          <ul className="space-y-1.5 text-sm">
            {isolated.map((p, i) => (
              <li key={`iso-${i}`} className="leading-snug">
                <span className="font-medium">{p.name}</span>{" "}
                <span className="text-muted">— {p.title}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
