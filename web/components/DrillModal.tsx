"use client";

import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { useEffect } from "react";

export default function DrillModal({
  open,
  title,
  subtitle,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 bg-ink/40 backdrop-blur-sm z-40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
          />
          <motion.div
            className="fixed inset-x-0 bottom-0 md:inset-0 md:flex md:items-center md:justify-center z-50 px-4 pb-4 md:p-6 pointer-events-none"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="bg-white rounded-2xl shadow-2xl w-full md:max-w-2xl max-h-[85vh] overflow-hidden flex flex-col pointer-events-auto"
              initial={{ y: 30, scale: 0.98 }}
              animate={{ y: 0, scale: 1 }}
              exit={{ y: 30, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
            >
              <div className="flex items-start justify-between px-6 py-5 border-b border-[var(--line)]">
                <div>
                  <h2 className="font-display text-2xl tracking-tight">{title}</h2>
                  {subtitle && (
                    <p className="text-sm text-muted mt-0.5">{subtitle}</p>
                  )}
                </div>
                <button
                  onClick={onClose}
                  className="p-2 -mr-2 -mt-1 text-muted hover:text-ink rounded-lg hover:bg-[var(--bg)] transition-colors"
                  aria-label="Close"
                >
                  <X className="size-5" />
                </button>
              </div>
              <div className="overflow-y-auto px-6 py-5 flex-1">{children}</div>
            </motion.div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export function ConfidenceChip({ value }: { value: string }) {
  const v = (value || "").toLowerCase();
  const cls =
    v === "high"
      ? "chip-high"
      : v === "medium"
        ? "chip-med"
        : v === "low"
          ? "chip-low"
          : "chip-na";
  return <span className={`chip ${cls}`}>{value || "—"}</span>;
}

export function SourceLink({ source }: { source: string }) {
  if (!source) return <span className="text-muted">—</span>;
  if (source.startsWith("http")) {
    return (
      <a
        href={source}
        target="_blank"
        rel="noreferrer noopener"
        className="text-accent hover:underline break-all"
      >
        {source}
      </a>
    );
  }
  return <span className="text-muted">{source}</span>;
}
