"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

// Shared open/close state for header dropdowns (user menu, research tray,
// notifications bell): closes on outside mousedown or Escape while open.
// Attach `ref` to the wrapper that contains both the trigger and the panel.
export function useDismissable<T extends HTMLElement = HTMLDivElement>(): {
  open: boolean;
  setOpen: (v: boolean | ((cur: boolean) => boolean)) => void;
  ref: RefObject<T>;
} {
  const [open, setOpen] = useState(false);
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return { open, setOpen, ref };
}
