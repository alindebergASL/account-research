"use client";

import type {
  CanvasWidget,
  SectionRefWidget,
  EvidenceBoardWidget,
  ActionPanelWidget,
  OpenQuestionsWidget,
  MetricWidget,
} from "../../lib/canvas/schema";
import { ConfidenceChip, SourceLink } from "../DrillModal";

function Meta({
  why_included,
  confidence,
}: {
  why_included?: string;
  confidence?: string;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted">
      {confidence && <ConfidenceChip value={confidence} />}
      {why_included && <span>{why_included}</span>}
    </div>
  );
}

function Sources({ sources }: { sources: { title: string; url: string }[] }) {
  if (!sources || sources.length === 0) return null;
  return (
    <div className="mt-4">
      <div className="text-xs uppercase tracking-wider text-muted mb-2">
        Sources
      </div>
      <ul className="space-y-1 text-sm">
        {sources.map((s, i) => (
          <li key={i}>
            {s.url ? <SourceLink source={s.url} /> : <span>{s.title}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SectionRefDetail({
  widget,
}: {
  widget: import("zod").infer<typeof SectionRefWidget>;
}) {
  return (
    <div>
      <Meta
        why_included={widget.why_included}
        confidence={widget.confidence}
      />
      <div className="rounded-lg bg-[var(--bg)] border border-[var(--line)] px-3 py-2 text-xs text-muted mb-3">
        Derived from standard brief section: <code>{widget.data.section_key}</code>
      </div>
      <p className="text-sm whitespace-pre-line leading-relaxed">
        {widget.data.preview || "—"}
      </p>
      <Sources sources={widget.sources} />
    </div>
  );
}

export function EvidenceBoardDetail({
  widget,
}: {
  widget: import("zod").infer<typeof EvidenceBoardWidget>;
}) {
  return (
    <div>
      <Meta why_included={widget.why_included} />
      {widget.data.items.length === 0 ? (
        <p className="text-sm text-muted">No evidence available.</p>
      ) : (
        <ul className="space-y-3">
          {widget.data.items.map((it, i) => (
            <li
              key={i}
              className="rounded-lg border border-[var(--line)] p-3 text-sm"
            >
              <p className="leading-snug">{it.text}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                {it.confidence && <ConfidenceChip value={it.confidence} />}
                {it.source && <SourceLink source={it.source} />}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ActionPanelDetail({
  widget,
}: {
  widget: import("zod").infer<typeof ActionPanelWidget>;
}) {
  return (
    <div>
      <Meta why_included={widget.why_included} />
      <ul className="space-y-3">
        {widget.data.actions.map((a, i) => (
          <li
            key={i}
            className="rounded-lg border border-[var(--line)] p-3 text-sm"
          >
            <div className="font-medium">{a.label}</div>
            {a.detail && (
              <p className="mt-1 leading-snug text-muted whitespace-pre-line">
                {a.detail}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function OpenQuestionsDetail({
  widget,
}: {
  widget: import("zod").infer<typeof OpenQuestionsWidget>;
}) {
  return (
    <div>
      <Meta why_included={widget.why_included} />
      {widget.data.questions.length === 0 ? (
        <p className="text-sm text-muted">No open questions.</p>
      ) : (
        <ul className="space-y-2 list-disc pl-5 text-sm">
          {widget.data.questions.map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MetricDetail({
  widget,
}: {
  widget: import("zod").infer<typeof MetricWidget>;
}) {
  return (
    <div>
      <Meta why_included={widget.why_included} />
      <div className="rounded-lg border border-[var(--line)] p-4">
        <div className="font-display text-5xl tracking-tight">
          {widget.data.value}
        </div>
        {widget.data.helper && (
          <div className="text-sm text-muted mt-1">{widget.data.helper}</div>
        )}
        {widget.data.label && (
          <div className="text-xs uppercase tracking-wider text-muted mt-3">
            {widget.data.label}
          </div>
        )}
      </div>
    </div>
  );
}

export function UnknownDetail({ widget }: { widget: CanvasWidget }) {
  return (
    <p className="text-sm text-muted">Unknown widget kind: {widget.kind}</p>
  );
}
