"use client";

import type { Source } from "@/lib/canvas/schema";
import { isSafePrimitiveHref, type PrimitiveNode, type PrimitiveSurfaceSpec } from "@/lib/canvas/primitive";

function renderNode(node: PrimitiveNode, sources: Source[] = []): React.ReactNode {
  switch (node.p) {
    case "stack":
      return <div className={node.direction === "row" ? "flex flex-row flex-wrap" : "flex flex-col"} style={{ gap: node.gap ?? 8 }}>{node.children.map((child, i) => <div key={i}>{renderNode(child, sources)}</div>)}</div>;
    case "heading": {
      const cls = "font-semibold text-slate-100";
      if (node.level === 1) return <h1 className={`text-2xl ${cls}`}>{node.text}</h1>;
      if (node.level === 2) return <h2 className={`text-xl ${cls}`}>{node.text}</h2>;
      if (node.level === 3) return <h3 className={`text-lg ${cls}`}>{node.text}</h3>;
      return <h4 className={cls}>{node.text}</h4>;
    }
    case "text":
      return <p className={node.emphasis === "muted" ? "text-slate-400" : node.emphasis === "bold" ? "font-semibold text-slate-100" : "text-slate-200"}>{node.text}</p>;
    case "kv":
      return <dl className="grid grid-cols-1 gap-2">{node.items.map((item, i) => <div key={i} className="rounded border border-slate-700 p-2"><dt className="text-xs uppercase text-slate-500">{item.key}</dt><dd className="text-sm text-slate-100">{item.value}</dd></div>)}</dl>;
    case "list": {
      const Tag = node.ordered ? "ol" : "ul";
      return <Tag className={node.ordered ? "list-decimal pl-5 text-slate-200" : "list-disc pl-5 text-slate-200"}>{node.items.map((item, i) => <li key={i}>{item}</li>)}</Tag>;
    }
    case "table":
      return <div className="overflow-auto"><table className="min-w-full text-left text-sm"><thead><tr>{node.columns.map((c) => <th key={c} className="border-b border-slate-700 px-2 py-1 text-slate-300">{c}</th>)}</tr></thead><tbody>{node.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} className="border-b border-slate-800 px-2 py-1 text-slate-200">{cell}</td>)}</tr>)}</tbody></table></div>;
    case "badge":
      return <span className="inline-flex rounded-full border border-slate-600 px-2 py-0.5 text-xs text-slate-200">{node.text}</span>;
    case "link":
      return isSafePrimitiveHref(node.href) ? <a className="text-sky-300 underline" href={node.href} rel="noopener noreferrer" target={node.href.startsWith("/") ? undefined : "_blank"}>{node.text}</a> : <span>{node.text}</span>;
    case "evidence_ref": {
      const src = sources[node.source_idx];
      return src ? <span className="text-xs text-slate-400">Evidence: {src.title}</span> : null;
    }
    case "metric":
      return <div><div className="text-xs uppercase text-slate-500">{node.label}</div><div className="text-2xl font-semibold text-slate-100">{node.value}</div>{node.delta ? <div className="text-xs text-slate-400">{node.delta}</div> : null}</div>;
    case "spacer":
      return <div style={{ height: node.size === "lg" ? 24 : node.size === "sm" ? 8 : 16 }} />;
    case "divider":
      return <hr className="border-slate-700" />;
    default:
      return null;
  }
}

export function PrimitiveSurfaceRenderer({ spec, sources = [] }: { spec: PrimitiveSurfaceSpec; sources?: Source[] }) {
  return <div className="space-y-2">{renderNode(spec.root, sources)}</div>;
}
