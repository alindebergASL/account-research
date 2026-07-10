import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createJournalFeedSequencer,
  journalFeedMatchesSelection,
} = require("../web/lib/journalFeedSequence") as typeof import("../web/lib/journalFeedSequence");

// Minimal model of the component's feed state, driven exactly like load():
// begin() on issue, and apply/fail only when the request is still current.
function makeFeed() {
  const seq = createJournalFeedSequencer();
  const state = {
    entries: null as string[] | null,
    loadedMentionsOnly: null as boolean | null,
    error: null as string | null,
    loading: false,
  };
  return {
    state,
    issue(mentionsOnly: boolean) {
      const req = seq.begin(mentionsOnly);
      state.loading = true;
      return {
        succeed(entries: string[]) {
          if (!seq.isCurrent(req)) return;
          state.entries = entries;
          state.loadedMentionsOnly = req.mentionsOnly;
          state.error = null;
          state.loading = false;
        },
        fail(message: string) {
          if (!seq.isCurrent(req)) return;
          state.error = message;
          state.loading = false;
        },
      };
    },
    hashProcessable(selectedMentionsOnly: boolean) {
      return journalFeedMatchesSelection({
        loading: state.loading,
        loadedMentionsOnly: state.loadedMentionsOnly,
        selectedMentionsOnly,
      });
    },
  };
}

test("enabling Mentions me blocks hash processing until the filtered response lands", () => {
  const feed = makeFeed();
  // Unfiltered feed loaded, target mounted.
  feed.issue(false).succeed(["target", "other"]);
  assert.equal(feed.hashProcessable(false), true, "baseline: idle + matching scope processes");

  // User enables "Mentions me": the filtered request is in flight and the
  // loaded entries belong to the OLD scope. Clicking a notification now must
  // not validate the target against entries about to be replaced.
  const filtered = feed.issue(true);
  assert.equal(feed.hashProcessable(true), false, "in-flight + stale scope: blocked");

  // The delayed filtered response lands and removes the target; only now may
  // the hash be judged — against the real filtered feed, where the absence
  // triggers clear-mentions instead of a false 'scroll + handled'.
  filtered.succeed(["other"]);
  assert.equal(feed.hashProcessable(true), true);
  assert.deepEqual(feed.state.entries, ["other"]);
});

test("a stale filtered response cannot overwrite a newer unfiltered response", () => {
  const feed = makeFeed();
  const slow = feed.issue(true); // filtered request, slow network
  const fast = feed.issue(false); // user flips back; unfiltered wins the race

  fast.succeed(["target", "other"]);
  assert.deepEqual(feed.state.entries, ["target", "other"]);
  assert.equal(feed.state.loadedMentionsOnly, false);
  assert.equal(feed.state.loading, false);

  // The out-of-order filtered response arrives afterwards: fully discarded.
  slow.succeed(["other"]);
  assert.deepEqual(feed.state.entries, ["target", "other"], "stale response discarded");
  assert.equal(feed.state.loadedMentionsOnly, false, "scope not clobbered");
  assert.equal(feed.hashProcessable(false), true);
});

test("a stale failure cannot clobber a newer success", () => {
  const feed = makeFeed();
  const slow = feed.issue(false);
  const fast = feed.issue(false);
  fast.succeed(["target"]);
  slow.fail("network error");
  assert.equal(feed.state.error, null, "stale failure discarded");
  assert.equal(feed.state.loading, false);
});

test("a failed unfiltered refetch stays retryable and never lets the hash be mis-handled", () => {
  const feed = makeFeed();
  // Filtered feed loaded (target absent) — clear-mentions flips selection to
  // unfiltered and the awaited full-feed request starts.
  feed.issue(true).succeed(["other"]);
  const refetch = feed.issue(false);
  assert.equal(feed.hashProcessable(false), false, "refetch pending: blocked");

  // The awaited request FAILS: scopes stay mismatched, so processing (and
  // therefore give-up / mark-handled) remains blocked — but the error is
  // surfaced and nothing is stuck in a loading state.
  refetch.fail("HTTP 500");
  assert.equal(feed.state.error, "HTTP 500", "load error surfaced");
  assert.equal(feed.state.loading, false, "not wedged in loading");
  assert.equal(feed.hashProcessable(false), false, "hash still unprocessable, not mis-marked");

  // A fresh notification click issues a new unfiltered request; on success
  // the scope matches and the normal deep-link sequence can proceed.
  const retry = feed.issue(false);
  retry.succeed(["target", "other"]);
  assert.equal(feed.state.error, null);
  assert.equal(feed.hashProcessable(false), true, "retry recovers processing");
  assert.deepEqual(feed.state.entries, ["target", "other"]);
});

test("initial load failure: entries stays null but a notification event can retry", () => {
  const feed = makeFeed();
  // The very FIRST journal request fails: no feed has ever loaded.
  const first = feed.issue(false);
  first.fail("HTTP 500");
  assert.equal(feed.state.entries, null, "no entries after the initial failure");
  assert.equal(feed.state.error, "HTTP 500", "error surfaced");
  assert.equal(feed.state.loading, false, "not wedged in loading");

  // The onHashChange retry condition — idle + loaded scope differs from the
  // selected scope — must hold in this state (loaded scope is still null),
  // so a repeated same-hash notification event issues a fresh request. This
  // is why the listener must register even while entries is null.
  const retryCondition =
    !feed.state.loading && feed.state.loadedMentionsOnly !== false;
  assert.equal(retryCondition, true, "notification click reaches the retry path");
  assert.equal(feed.hashProcessable(false), false, "hash not processed against a null feed");

  // The retried unfiltered request succeeds: scope recorded, error cleared,
  // and normal hash processing is enabled.
  const retry = feed.issue(false);
  retry.succeed(["target", "other"]);
  assert.equal(feed.state.error, null);
  assert.equal(feed.state.loadedMentionsOnly, false, "unfiltered scope recorded");
  assert.equal(feed.hashProcessable(false), true, "hash processing enabled after recovery");
});

test("journalFeedMatchesSelection requires both idle and scope match", () => {
  assert.equal(
    journalFeedMatchesSelection({ loading: false, loadedMentionsOnly: false, selectedMentionsOnly: false }),
    true,
  );
  assert.equal(
    journalFeedMatchesSelection({ loading: true, loadedMentionsOnly: false, selectedMentionsOnly: false }),
    false,
    "loading blocks even when scopes match",
  );
  assert.equal(
    journalFeedMatchesSelection({ loading: false, loadedMentionsOnly: false, selectedMentionsOnly: true }),
    false,
    "scope mismatch blocks even when idle",
  );
  assert.equal(
    journalFeedMatchesSelection({ loading: false, loadedMentionsOnly: null, selectedMentionsOnly: false }),
    false,
    "no feed loaded yet blocks",
  );
});
