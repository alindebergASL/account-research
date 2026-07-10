// Ring classes applied briefly to a deep-link target (journal entry or
// comment) after scrolling to it. Shared so both sections highlight the same
// way. `ring-accent` is the theme utility from tailwind.config — the earlier
// arbitrary `ring-[var(--accent,...)]` literal was never generated into the
// built CSS, so the highlight silently fell back to the default ring color.
// Kept as a tuple for spread into classList.add/remove.
export const DEEP_LINK_RING = ["ring-2", "ring-accent", "ring-offset-2"] as const;
