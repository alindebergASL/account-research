"use client";

import type {
  CanvasWidget,
  SectionRefWidget,
  EvidenceBoardWidget,
  ActionPanelWidget,
  OpenQuestionsWidget,
  MetricWidget,
} from "../../lib/canvas/schema";
import { ConfidenceChip } from "../DrillModal";

function Header({
  title,
  confidence,
}: {
  title: string;
  confidence?: string;
}) {
  return (
    <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted mb-3">
      <span className="flex-1">{title}</span>
      {confidence && <ConfidenceChip value={confidence} />}
    </div>
  );
}

export function SectionRefTile({
  widget,
}: {
  widget: import("zod").infer<typeof SectionRefWidget>;
}) {
  return (
    <div>
      <Header title={widget.title} confidence={widget.confidence} />
      <p className="text-sm text-ink whitespace-pre-line line-clamp-6 leading-snug">
        {widget.data.preview || "—"}
      </p>
    </div>
  );
}

export function EvidenceBoardTile({
  widget,
}: {
  widget: import("zod").infer<typeof EvidenceBoardWidget>;
}) {
  const items = widget.data.items.slice(0, 3);
  return (
    <div>
      <Header title={widget.title} />
      <ul className="space-y-2 text-sm">
        {items.map((it, i) => (
          <li key={i} className="pl-3 border-l-2 border-[var(--line)]">
            <span className="line-clamp-2">{it.text}</span>
          </li>
        ))}
        {widget.data.items.length === 0 && (
          <li className="text-muted">No evidence available.</li>
        )}
      </ul>
      {widget.data.items.length > items.length && (
        <p className="text-xs text-muted mt-2">
          +{widget.data.items.length - items.length} more · open to view
        </p>
      )}
    </div>
  );
}

export function ActionPanelTile({
  widget,
}: {
  widget: import("zod").infer<typeof ActionPanelWidget>;
}) {
  const first = widget.data.actions[0];
  return (
    <div>
      <Header title={widget.title} />
      {first ? (
        <p className="text-sm leading-snug line-clamp-5">
          {first.detail || first.label}
        </p>
      ) : (
        <p className="text-sm text-muted">No actions.</p>
      )}
    </div>
  );
}

export function OpenQuestionsTile({
  widget,
}: {
  widget: import("zod").infer<typeof OpenQuestionsWidget>;
}) {
  return (
    <div>
      <Header title={widget.title} />
      {widget.data.questions.length === 0 ? (
        <p className="text-sm text-muted">No open questions.</p>
      ) : (
        <ul className="space-y-1 text-sm list-disc pl-5">
          {widget.data.questions.slice(0, 3).map((q, i) => (
            <li key={i} className="line-clamp-2">
              {q}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MetricTile({
  widget,
}: {
  widget: import("zod").infer<typeof MetricWidget>;
}) {
  return (
    <div>
      <Header title={widget.title} />
      <div className="flex items-baseline gap-2">
        <span className="font-display text-4xl tracking-tight">
          {widget.data.value}
        </span>
        {widget.data.helper && (
          <span className="text-xs text-muted">{widget.data.helper}</span>
        )}
      </div>
      {widget.data.label && (
        <p className="text-xs text-muted mt-1">{widget.data.label}</p>
      )}
    </div>
  );
}

export function UnknownTile({ widget }: { widget: CanvasWidget }) {
  return (
    <div>
      <Header title={widget.title} />
      <p className="text-sm text-muted">Unknown widget kind: {widget.kind}</p>
    </div>
  );
}
