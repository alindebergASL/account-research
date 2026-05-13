"use client";

import { ListChecks, MessageSquarePlus, Quote, Sparkles, Table2 } from "lucide-react";
import type { BriefExtension, ExtensionListItem } from "@/lib/schema";
import { ConfidenceChip, SourceLink } from "../DrillModal";

// Normalise both list-item shapes (legacy string, PR-A {heading?, text})
// into a single render shape so the renderer can stay simple.
function normalizeListItem(item: ExtensionListItem): { heading?: string; text: string } {
  if (typeof item === "string") return { text: item };
  return { heading: item.heading, text: item.text };
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-muted mb-0.5">
      {children}
    </div>
  );
}

export function extensionKindLabel(kind: BriefExtension["kind"]) {
  return {
    card: "Card",
    table: "Table",
    list: "List",
    narrative: "Narrative",
  }[kind];
}

export function extensionIcon(kind: BriefExtension["kind"]) {
  if (kind === "table") return <Table2 className="size-4" />;
  if (kind === "list") return <ListChecks className="size-4" />;
  if (kind === "narrative") return <Quote className="size-4" />;
  return <Sparkles className="size-4" />;
}

export function AddedInChatChip() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent normal-case tracking-normal">
      <MessageSquarePlus className="size-3" /> Added in chat
    </span>
  );
}

export function ExtensionPreview({ extension }: { extension: BriefExtension }) {
  if (extension.kind === "table") {
    return (
      <div className="overflow-hidden rounded-lg border border-[var(--line)] text-xs">
        <div
          className="grid bg-[var(--bg)]"
          style={{ gridTemplateColumns: `repeat(${Math.min(extension.columns.length, 3)}, minmax(0, 1fr))` }}
        >
          {extension.columns.slice(0, 3).map((column) => (
            <div key={column} className="px-2 py-1 font-medium truncate">
              {column}
            </div>
          ))}
        </div>
        {extension.rows.slice(0, 2).map((row, i) => (
          <div
            key={i}
            className="grid border-t border-[var(--line)]"
            style={{ gridTemplateColumns: `repeat(${Math.min(extension.columns.length, 3)}, minmax(0, 1fr))` }}
          >
            {row.slice(0, 3).map((cell, j) => (
              <div key={j} className="px-2 py-1 text-muted truncate">
                {cell}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }
  if (extension.kind === "list") {
    return (
      <ul className="space-y-1.5">
        {extension.items.slice(0, 3).map((raw, i) => {
          const it = normalizeListItem(raw);
          return (
            <li key={i} className="flex gap-2 text-sm">
              <span className="text-accent shrink-0">•</span>
              <span className="line-clamp-1">
                {it.heading ? <strong>{it.heading}: </strong> : null}
                {it.text}
              </span>
            </li>
          );
        })}
      </ul>
    );
  }
  if (extension.kind === "card") {
    return (
      <div>
        <p className="text-sm leading-relaxed text-muted line-clamp-3">{extension.body}</p>
        {extension.badges.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {extension.badges.slice(0, 4).map((b, i) => (
              <span
                key={i}
                className="rounded-full bg-[var(--bg)] border border-[var(--line)] px-2 py-0.5 text-[10px] text-muted"
              >
                {b}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }
  // narrative
  return <p className="text-sm leading-relaxed text-muted line-clamp-3">{extension.body}</p>;
}

export function ExtensionDetail({ extension }: { extension: BriefExtension }) {
  return (
    <div className="space-y-5">
      {extension.source === "chat" && (
        <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent">
          <MessageSquarePlus className="size-3.5" /> Added in chat
        </span>
      )}
      {extension.kind === "table" && <ExtensionTable extension={extension} />}
      {extension.kind === "list" && (
        <ul className="space-y-2">
          {extension.items.map((raw, i) => {
            const it = normalizeListItem(raw);
            return (
              <li key={i} className="flex gap-3">
                <span className="text-accent shrink-0 mt-0.5">•</span>
                <span>
                  {it.heading ? <strong>{it.heading}: </strong> : null}
                  {it.text}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {extension.kind === "card" && (
        <div className="rounded-xl border border-[var(--line)] bg-[var(--bg)] p-4">
          <p className="leading-relaxed">{extension.body}</p>
          {extension.badges.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {extension.badges.map((b, i) => (
                <span
                  key={i}
                  className="rounded-full bg-white border border-[var(--line)] px-2 py-0.5 text-xs text-muted"
                >
                  {b}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {extension.kind === "narrative" && (
        <p className="leading-relaxed">{extension.body}</p>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-[var(--line)] pt-4 text-sm">
        <div>
          <Label>Why included</Label>
          <p>{extension.why_included}</p>
        </div>
        <div>
          <Label>Confidence</Label>
          <ConfidenceChip value={extension.confidence} />
        </div>
        <div>
          <Label>Created</Label>
          <p className="text-muted">{extension.created_at}</p>
        </div>
        <div>
          <Label>Sources</Label>
          {extension.sources.length === 0 ? (
            <p className="text-muted">No extension-specific sources.</p>
          ) : (
            <ul className="space-y-1">
              {extension.sources.map((source, i) => (
                <li key={i}>
                  <SourceLink source={source.url || source.title} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function ExtensionTable({ extension }: { extension: Extract<BriefExtension, { kind: "table" }> }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--line)]">
      <table className="min-w-full text-sm">
        <thead className="bg-[var(--bg)]">
          <tr>
            {extension.columns.map((column) => (
              <th key={column} className="px-3 py-2 text-left font-medium border-b border-[var(--line)]">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {extension.rows.map((row, i) => (
            <tr key={i} className="odd:bg-white even:bg-[var(--bg)]/50">
              {extension.columns.map((_, j) => (
                <td key={j} className="px-3 py-2 align-top border-b border-[var(--line)] last:border-b-0">
                  {row[j] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
