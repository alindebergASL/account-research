import type { SectionRefWidget } from "../../../lib/canvas/schema";

// Sequence-based timeline lane. Three swimlanes: signals / initiatives /
// procurement. Positions are derived from input order, never from
// absolute dates.
//
// The lane data is sourced from `widget.evidence`, with `tag` acting as
// the swimlane discriminator: "signal" / "initiative" / "procurement".
// Order within a swimlane is preserved exactly as the adapter emitted it
// (brief order). An optional small caption is rendered next to a dot if
// (and only if) an evidence item's `source` string contains a strict
// month-year token like "Feb 2026". The caption is decorative; it never
// drives position.

type SwimlaneItem = {
  text: string;
  caption?: string;
};

type Swimlane = {
  key: "signals" | "initiatives" | "procurement";
  label: string;
  items: SwimlaneItem[];
};

const MONTH_REGEX =
  /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\b/;

function captionForSource(source: string | undefined): string | undefined {
  if (!source) return undefined;
  const m = source.match(MONTH_REGEX);
  if (!m) return undefined;
  return m[0];
}

export function buildSwimlanesFromEvidence(
  widget: import("zod").infer<typeof SectionRefWidget>,
): Swimlane[] {
  const signals: SwimlaneItem[] = [];
  const initiatives: SwimlaneItem[] = [];
  const procurement: SwimlaneItem[] = [];
  for (const ev of widget.evidence) {
    const item: SwimlaneItem = {
      text: ev.text,
      caption: captionForSource(ev.source),
    };
    if (ev.tag === "signal") signals.push(item);
    else if (ev.tag === "initiative") initiatives.push(item);
    else if (ev.tag === "procurement") procurement.push(item);
  }
  const lanes: Swimlane[] = [
    { key: "signals", label: "Signals", items: signals },
    { key: "initiatives", label: "Initiatives", items: initiatives },
    { key: "procurement", label: "Procurement", items: procurement },
  ];
  return lanes.filter((l) => l.items.length > 0);
}

function Swim({ lane }: { lane: Swimlane }) {
  return (
    <div
      data-testid={`timeline-lane-row-${lane.key}`}
      className="min-w-0 py-1 flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2"
    >
      <div className="w-full sm:w-20 sm:shrink-0 text-[10px] uppercase tracking-wider text-muted">
        {lane.label}
      </div>
      <div className="flex flex-col gap-1 sm:flex-row sm:flex-1 sm:items-center sm:gap-3 sm:overflow-x-auto">
        {lane.items.map((item, i) => (
          <div
            key={`${lane.key}-${i}`}
            className="flex items-center gap-1.5 sm:shrink-0"
          >
            <span
              className="size-2 rounded-full bg-[var(--accent)]"
              aria-hidden="true"
            />
            <span className="text-xs leading-snug sm:max-w-[12rem] sm:truncate break-words">
              {item.text}
            </span>
            {item.caption && (
              <span className="text-[10px] text-muted">{item.caption}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function TimelineLaneTile({
  widget,
}: {
  widget: import("zod").infer<typeof SectionRefWidget>;
}) {
  const swimlanes = buildSwimlanesFromEvidence(widget);
  return (
    <div data-testid="timeline-lane" className="space-y-1 min-w-0">
      {swimlanes.length === 0 ? (
        <p className="text-xs text-muted">
          Source coverage missing — add cited evidence before action.
        </p>
      ) : (
        swimlanes.slice(0, 3).map((lane) => <Swim key={lane.key} lane={lane} />)
      )}
      <p className="text-[10px] text-muted mt-1">
        Order reflects brief sequence, not absolute dates.
      </p>
    </div>
  );
}

export function TimelineLaneDetail({
  widget,
}: {
  widget: import("zod").infer<typeof SectionRefWidget>;
}) {
  const swimlanes = buildSwimlanesFromEvidence(widget);
  return (
    <div data-testid="timeline-lane" className="space-y-3 min-w-0">
      <p className="text-xs text-muted">
        Sequence-anchored momentum lane. Order is taken from the brief; no
        absolute time axis is implied.
      </p>
      {swimlanes.length === 0 ? (
        <p className="text-sm text-muted">
          Source coverage missing — add cited evidence before action.
        </p>
      ) : (
        swimlanes.map((lane) => (
          <section
            key={lane.key}
            data-testid={`timeline-lane-detail-${lane.key}`}
            className="rounded-lg border border-[var(--line)] p-3"
          >
            <div className="text-[10px] uppercase tracking-wider text-muted mb-2">
              {lane.label}
            </div>
            <ol className="space-y-1.5 text-sm">
              {lane.items.map((item, i) => (
                <li
                  key={`${lane.key}-d-${i}`}
                  className="flex items-baseline gap-2"
                >
                  <span className="text-[10px] text-muted w-6 shrink-0">
                    #{i + 1}
                  </span>
                  <span className="leading-snug break-words flex-1">
                    {item.text}
                  </span>
                  {item.caption && (
                    <span className="text-[10px] text-muted shrink-0">
                      {item.caption}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </section>
        ))
      )}
      <p className="text-[10px] text-muted">
        Captions next to a dot come from a parseable month-year token in the
        source string. They are decorative; positions remain sequence-based.
      </p>
    </div>
  );
}
