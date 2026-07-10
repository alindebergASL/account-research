// Request ordering for the journal feed. The feed is fetched with or without
// the server-side "Mentions me" scope (?mentions=me); requests can overlap
// (rapid filter toggles, deep-link-triggered refetches), responses can land
// out of order, and a response must never be applied over the state of a
// NEWER request (last-write-wins). Kept pure so the ordering rules — the part
// that raced in acceptance review — are directly testable without React.

export type JournalFeedRequest = {
  sequence: number;
  /** The scope this request was issued for. */
  mentionsOnly: boolean;
};

export type JournalFeedSequencer = {
  /** Register a new in-flight request; it becomes the current one. */
  begin(mentionsOnly: boolean): JournalFeedRequest;
  /**
   * True while `req` is still the newest request. A response (success OR
   * failure) whose request is no longer current must be discarded entirely —
   * a stale filtered response may not overwrite a newer unfiltered one, and a
   * stale failure may not clobber a newer success's error state.
   */
  isCurrent(req: JournalFeedRequest): boolean;
};

export function createJournalFeedSequencer(): JournalFeedSequencer {
  let current = 0;
  return {
    begin(mentionsOnly: boolean): JournalFeedRequest {
      current += 1;
      return { sequence: current, mentionsOnly };
    },
    isCurrent(req: JournalFeedRequest): boolean {
      return req.sequence === current;
    },
  };
}

// Deep-link hashes may only be processed against a feed that (a) is not being
// replaced right now and (b) was produced by the CURRENTLY selected scope.
// Otherwise the handler can validate a target against entries about to
// disappear (filter enabled, filtered response still in flight) — scrolling
// and marking the hash handled just before the target is removed — or judge
// "absent" against a stale scope. `loadedMentionsOnly` is null until the
// first feed lands. A failed refetch leaves the scopes mismatched, which
// keeps this false: the hash stays unhandled and the flow retryable.
export function journalFeedMatchesSelection(s: {
  loading: boolean;
  loadedMentionsOnly: boolean | null;
  selectedMentionsOnly: boolean;
}): boolean {
  return !s.loading && s.loadedMentionsOnly === s.selectedMentionsOnly;
}
