export type BriefView = "brief" | "canvas" | "journal";
export type JournalWorkspace = "timeline" | "team" | "sources" | "tasks" | "review";
export type ReviewInboxTab = "pending" | "history";

export type JournalWorkspaceLocationState = {
  view: BriefView;
  workspace: JournalWorkspace;
  reviewInboxTab: ReviewInboxTab;
};

const VIEWS = new Set<BriefView>(["brief", "canvas", "journal"]);
const WORKSPACES = new Set<JournalWorkspace>([
  "timeline",
  "team",
  "sources",
  "tasks",
  "review",
]);
const REVIEW_TABS = new Set<ReviewInboxTab>(["pending", "history"]);

function normalizedSearch(params: URLSearchParams): string {
  const value = params.toString();
  return value ? `?${value}` : "";
}

export function buildJournalWorkspaceSearch(
  currentSearch: string,
  state: JournalWorkspaceLocationState,
): string {
  const params = new URLSearchParams(currentSearch);
  params.delete("view");
  params.delete("workspace");
  params.delete("review");

  if (state.view === "canvas") {
    params.set("view", "canvas");
  } else if (state.view === "journal") {
    params.set("view", "journal");
    if (state.workspace !== "timeline") params.set("workspace", state.workspace);
    if (state.workspace === "review" && state.reviewInboxTab === "history") {
      params.set("review", "history");
    }
  }

  return normalizedSearch(params);
}

export function parseJournalWorkspaceLocation(input: {
  search: string;
  hash: string;
  canvasAllowed?: boolean;
}): JournalWorkspaceLocationState & {
  canonicalSearch: string;
  needsNormalization: boolean;
} {
  const params = new URLSearchParams(input.search);
  const rawView = params.get("view");
  const rawWorkspace = params.get("workspace");
  const rawReview = params.get("review");

  let view: BriefView = rawView && VIEWS.has(rawView as BriefView)
    ? (rawView as BriefView)
    : "brief";
  if (view === "canvas" && input.canvasAllowed === false) view = "brief";

  let workspace: JournalWorkspace = "timeline";
  let reviewInboxTab: ReviewInboxTab = "pending";
  if (view === "journal") {
    workspace = rawWorkspace && WORKSPACES.has(rawWorkspace as JournalWorkspace)
      ? (rawWorkspace as JournalWorkspace)
      : "timeline";
    if (workspace === "review" && rawReview && REVIEW_TABS.has(rawReview as ReviewInboxTab)) {
      reviewInboxTab = rawReview as ReviewInboxTab;
    }
  }

  if (input.hash.startsWith("#journal-entry-")) {
    view = "journal";
    workspace = "timeline";
    reviewInboxTab = "pending";
  } else if (input.hash.startsWith("#comment-")) {
    view = "brief";
    workspace = "timeline";
    reviewInboxTab = "pending";
  }

  const state = { view, workspace, reviewInboxTab };
  const canonicalSearch = buildJournalWorkspaceSearch(input.search, state);
  return {
    ...state,
    canonicalSearch,
    needsNormalization: canonicalSearch !== input.search,
  };
}

export function hashForExplicitNavigation(
  currentHash: string,
  destination: Pick<JournalWorkspaceLocationState, "view" | "workspace">,
): string {
  if (currentHash.startsWith("#journal-entry-")) {
    return destination.view === "journal" && destination.workspace === "timeline"
      ? currentHash
      : "";
  }
  if (currentHash.startsWith("#comment-")) {
    return destination.view === "brief" ? currentHash : "";
  }
  return currentHash;
}
