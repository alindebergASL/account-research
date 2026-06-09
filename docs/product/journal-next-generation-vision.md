# Next-Generation Journal Vision

Status: product direction / living implementation guide
Last updated: 2026-06-09

This note captures the product research and brainstorming for evolving the account-research Journal from notes plus AI replies into a production-ready, next-generation team account-intelligence workspace.

The agreed starting path is:

1. Journal Workspaces + Source Library
2. Brief Update Queue + Action/Decision extraction
3. Account Intelligence Cockpit built on structured source/action/decision/question data

## Current implementation status

This document started as a product reference note in PR #81. Since then, PRs #82-#100 have shipped the first production slices of the path above. The Journal is no longer only a brainstorm; it now has a workspace shell, source library, review workflow, advisory intelligence surface, click-to-source citation context, source health controls, assistant-to-candidate drafting, evidence snippets, structured review boards, Journal search/source-scoped recall, first-pass reviewed cockpit cards, and dedicated catch-up windows for recent account changes.

Current production baseline on `main`:

| Area | Status | Shipped in | Notes |
| --- | --- | --- | --- |
| Journal document uploads | Shipped | #78, #79 | Uploads extract text and can be used by Journal AI; workflow polish followed the first upload PR. |
| Intelligence panel / advisory prompts | First production pass shipped | #80, #91, #96, #98, #100 | Users can ask for digests, brief-update candidates, follow-ups, open questions, search-scoped recall, reviewed cockpit summaries, and dedicated catch-up windows. Cached/durable rollups remain future work. |
| Product direction note | Shipped | #81, #90; updated by #95, #99 | This file became the guiding reference for subsequent Journal PRs and is kept current after shipped batches. |
| Workspaces + source library | First production pass shipped | #82, #84, #86, #87, #93 | Tabs exist for Team Room, Timeline, Sources, Intelligence, and Review Queue. Sources combine uploaded Journal documents with Brief baseline sources, expose include/exclude controls, and show first-pass health labels. |
| Brief-grounded review queue | First production pass shipped | #83, #84, #85, #91, #94 | Review candidate cards exist for brief updates, actions, decisions, and open questions; assistant replies can draft candidates; structured board lanes now group candidate types. No automatic brief mutation. |
| Team Room separation | Shipped | #86 | General teammate discussion is separated from source-grounded Timeline evidence and made the default workspace. |
| Citation/source trust layer | First production pass shipped | #78-#89, #92 | Journal assistant answers can include server-formatted source legends and `[J]`/`[D]` labels, source link rendering is hardened, spoofed legend blocks are ignored, citation chips open source context, and trusted legend entries can produce evidence snippets. True passage-level highlighting and exact-quote extraction are still future polish. |
| Account Intelligence Cockpit | First production pass shipped | #80, #85, #94, #98 | The UI has an Intelligence surface, review workflow, structured review boards, and reviewed-only cockpit cards. A durable cached summary/read model, source-change rollups, and lifecycle metadata remain future work. |

### Shipped foundation

- Journal Workspaces: Team Room, Timeline, Sources, Intelligence, and Review Queue.
- Team Room is the default collaboration space and is separate from evidence/timeline entries.
- Source Library shows uploaded Journal documents plus Brief baseline sources.
- Source previews exist for uploaded documents.
- Uploaded sources can scope assistant questions and can be excluded from assistant context.
- Source Library shows first-pass source health labels for current, stale, duplicate, superseded, and conflicting uploads.
- Review Queue stores human-review candidates without silently editing the Brief.
- Assistant replies can draft review candidates while preserving trusted evidence labels.
- Candidate status supports New, Reviewing, Accepted, Sent to brief chat, Applied, and Dismissed.
- Structured Actions, Decisions, Open Questions, and Brief Updates boards group review candidates into human-reviewed lanes.
- Safe source-link rendering is shared and rejects deceptive URLs containing username/password userinfo.
- Server-formatted source legends are parsed defensively; spoofed user-authored marker blocks are ignored.
- Citation chips on assistant answers open source context for resolvable `[J]` and `[D]` labels without relying on the current global source list order.
- Trusted source legend entries can produce evidence snippets/copyable source context for cited labels.
- Journal search filters Timeline entries, uploaded sources, and Review Queue candidates, then supports source-scoped recall without leaking excluded uploads.
- The first Account Intelligence Cockpit pass shows reviewed-only cards from accepted, sent-to-brief-chat, or applied candidates.
- Dedicated Journal catch-up prompts cover 24-hour, 7-day, and all-history windows, pass `journal_context_since` into the assistant route, and preserve the advisory/no-brief-mutation boundary.

### Still partial / future

- True passage-level highlighting and exact-quote extraction beyond trusted legend snippets.
- Source health controls remain first-pass heuristics; no durable source-resolution lifecycle or user-confirmed conflict status yet.
- Structured boards do not yet support owner, due-date, priority, CRM sync, reminders, or official decision/action lifecycle metadata.
- Durable cached Account Intelligence cockpit/read model built from accepted evidence, actions, decisions, questions, source changes, and recent catch-up/cockpit synthesis.
- Durable accepted-candidate rollups that distinguish draft/reviewed/applied account facts from general notes.
- Catch-up remains advisory and request-time only; caching/invalidation of repeated catch-up summaries is still future work after the durable cockpit read model exists.

### Recommended next implementation slice

Build the durable Account Intelligence Cockpit read model next. Search/source-scoped recall (#96), the first reviewed-only cockpit (#98), and dedicated catch-up windows (#100) are now shipped. The next bottleneck is persistence and repeatability: users should see a stable cockpit projection derived from reviewed evidence and source changes, without treating draft assistant output as official account truth.

Scope for that next slice:

1. Define a read model or cache layer for cockpit sections such as account update, what changed, risks, open questions, recommended next actions, accepted brief-update candidates, active decisions/actions, and recent source changes.
2. Build the projection only from reviewed/accepted/applied evidence where facts become durable; preserve pending/reviewing candidates as advisory inputs, not official account state.
3. Preserve provenance: every rollup item should retain candidate/source/journal references and evidence labels where available.
4. Add invalidation rules for changed candidate status, new accepted/applied evidence, source include/exclude changes, new Journal entries, and brief baseline/version changes.
5. Keep the human-review boundary: the cockpit read model must not edit the Brief, silently create candidates, mark actions official, or settle decisions.
6. Add regression tests for status separation, provenance retention, invalidation behavior, source-exclusion safety, and no durable brief mutation.

After the durable cockpit read model, the following slice should consider catch-up summary caching on top of that read model. Cached catch-up should reuse the same invalidation/provenance rules and remain advisory: it can save repeated 24-hour/7-day synthesis, but candidate existence alone must still not make an action official or a decision settled.

## High-level thesis

The Journal should evolve from “notes + AI replies” into a team account-intelligence cockpit: a shared operating layer where signals, documents, conversations, decisions, action items, risks, monitor updates, and AI-generated insight all converge — with source grounding, permissions, review flows, and clear handoff to brief edits, CRM, and team action.

Core product concept:

> Every account has a living Journal that tells the team what happened, why it matters, what changed, what needs action, and what evidence supports it.

The Journal should become the account team’s living intelligence workspace — not just a notes feed, not just chat, and not just document storage.

The unique angle for account-research is a shared account cockpit where humans, documents, monitors, meetings, and AI all contribute evidence, and the team turns that evidence into decisions, next steps, brief updates, and account strategy.

## Research inspirations

- NotebookLM: source panel, grounded answers, exact citations, generated study/report artifacts, “sources → chat → studio/output” workflow.
  - https://notebooklm.google/
- Notion AI Meeting Notes: meeting-type templates, transcript citations, action items, custom summary instructions, shared meeting database.
  - https://www.notion.com/help/ai-meeting-notes
- Linear: comment threads, resolved-thread summaries, AI-generated discussion summaries with citations, @agent in-context.
  - https://linear.app/docs/comment-on-issues
- Slack: huddle notes into canvases, channel recaps, AI search across messages/files/apps, Activity tab.
  - https://slack.com/help/articles/31377193680019-Use-AI-to-take-huddle-notes-in-Slack
- Granola: human-in-the-loop enhanced notes, shared folders, CRM sync, cross-meeting chat, source-linked action items.
- Clay: signal feeds, enriched account triggers, prioritization, “act on signal” workflows.
  - https://www.clay.com/signals
- Gong / Clari: account boards, deal risk, revenue cadences, next-best-action guidance, account console.
- Atlassian Rovo: teamwork graph, cross-tool context, governed agents, audit trails.
- Reflect / networked notes: backlinks, daily notes, similar notes, semantic recall.

## Recommendation

Do not make the Journal just “better chat.” Make it a structured team memory and action system.

The winning product path is:

1. Start with Journal Workspaces + Source Library.
2. Then add a Brief Update Queue plus Action/Decision extraction.
3. Then evolve the Account Intelligence Cockpit once structured source/action/decision/question data exists underneath it.

This avoids building a flashy AI panel on top of unstructured notes only. It creates a durable product foundation.

## Potential Journal sections / modes

### 1. Timeline

The familiar chronological feed, but smarter.

Contains:

- Human notes
- Assistant replies
- Uploaded documents
- Monitor updates
- Brief version changes
- Decisions
- Action item updates
- External signals
- Meeting summaries
- System/import events

Key UX:

- Filter by type: Notes, Docs, AI, Monitor, Decisions, Tasks, Risks, Signals
- Collapse/expand noisy entries
- “What changed since last time?” summary
- “Catch me up” button
- Threaded replies under user prompts
- Reactions / acknowledgements from teammates

Why it matters:

Keeps the current mental model but turns it into a readable account history. This remains the canonical audit trail.

### 2. Sources

NotebookLM-style source workspace.

Contains:

- Uploaded documents
- Extracted text previews
- Web sources
- Monitor sources
- Brief source references
- Meeting transcripts
- Email/call notes later
- CRM/customer records later

Key UX:

- Source cards with type, date, uploader, confidence
- “Included in AI context” toggles
- “Ask about this”
- “Summarize”
- “Find brief updates”
- “Compare with brief”
- “Show all citations using this source”
- Source health: stale, duplicate, superseded, conflicting

Why it matters:

Trust. Users should know what the AI is using, and should be able to narrow it.

### 3. Intelligence

The new “wow” surface. Not a feed; a dashboard of synthesized account insight.

Sections:

- Account update
- What changed
- Why it matters
- Key risks
- Open questions
- Recommended next actions
- Brief update candidates
- Stakeholder intelligence
- Competitive signals
- Timeline / procurement signals
- Expansion / renewal signals, if relevant

Key UX:

- Generated cards, each with evidence
- Confidence / evidence strength
- “Pin to top”
- “Dismiss”
- “Ask follow-up”
- “Send to brief chat”
- “Create action item”
- “Share with team”

Why it matters:

This turns the Journal from passive archive into an active analyst.

### 4. Actions

A structured action-item section.

Fields:

- Task
- Owner
- Due date
- Status
- Source
- Confidence
- Related journal entry/document
- Brief section affected
- Optional external target later: Slack, Linear, CRM

AI can extract:

- Explicit commitments
- Follow-up requests
- Missing owners
- Undated tasks
- Repeated unresolved asks

Key UX:

- “Extract action items from recent entries”
- “Review suggested actions”
- “Assign”
- “Mark done”
- “Remind me”
- “Create Linear issue” later
- “Push to CRM task” later

Important principle:

Human review should remain the default before creating durable tasks.

### 5. Decisions

A decision log inside the Journal.

This is underrated. Team journals get messy because decisions are buried in threads.

Fields:

- Decision
- Date
- Owner / decider
- Rationale
- Evidence
- Alternatives considered
- Reversal conditions
- Linked sources / discussion

AI can suggest:

- “This looks like a decision — save it?”
- “Decision changed since prior note”
- “This contradicts an earlier decision”

Why it matters:

For account teams, the difference between “we discussed procurement risk” and “we decided procurement risk is the top blocker” is huge.

Example decisions:

- We are prioritizing the CIO persona first.
- We are not leading with price.
- Procurement risk is the top blocker.
- Security review is likely gating.

### 6. Questions / Unknowns

A dedicated open-questions board.

Types:

- Account strategy
- Stakeholders
- Technical fit
- Procurement
- Budget/timing
- Competitors
- Security/legal
- Next meeting prep

Key UX:

- AI extracts open questions
- Link each question to evidence
- Mark as answered
- Convert answer into brief update candidate
- “Questions to ask on next call”
- “Questions blocking outreach”

Why it matters:

Open questions are often the most valuable output from account research. Incomplete knowledge is often the main problem.

### 7. Signals

Clay/Gong/monitor-style signal feed.

Signals could include:

- Monitor findings
- New source found
- Company news
- Website changes
- Hiring changes
- Funding / procurement / security / compliance signal
- Competitor mention
- New stakeholder found
- Product usage / CRM signal later
- Document upload with important extracted claims

Key UX:

- Signal severity: hot / warm / informational
- Signal freshness
- Evidence
- Suggested action
- “Bundle related signals”
- “Ignore similar”
- “Watch this topic”
- “Add to brief”

Each signal should answer:

- What happened?
- Why does it matter?
- Is this new?
- What action should the team consider?
- Which brief fields might change?

Why it matters:

This makes the Journal proactive instead of just a place users write things.

### 8. Brief Update Candidates

A review queue, not direct mutation.

Each candidate:

- Target brief section
- Proposed text
- Evidence
- Confidence
- Risk of applying
- Conflicts with current brief?
- Source freshness
- Suggested reviewer

Actions:

- Send to brief chat
- Copy as prompt
- Dismiss
- Save for later
- Mark as already reflected
- Eventually: apply with review/versioning

Why it matters:

This bridges Journal → Brief safely. The Journal discovers; brief chat applies.

### 9. People / Stakeholders

Account relationship memory.

Fields:

- Name
- Role
- Company
- Influence
- Concerns
- Last mentioned
- Related notes/docs
- Open asks
- Follow-up history
- Buying role / technical role / procurement role

AI can:

- Extract new stakeholders from notes/docs
- Update stakeholder summaries
- Flag unknown roles
- Draft stakeholder-specific follow-ups

Why it matters:

For account research, “who said what, when, and why” is central.

### 10. Team Room

Collaboration layer.

Features:

- @mentions
- Assign/reassign
- “Needs review”
- “FYI”
- “Decision needed”
- Reactions
- Threaded comments
- Private draft vs shared note
- “Ask teammate for input”
- Read receipts, maybe later

Team use cases:

- SDR uploads discovery notes
- AE asks AI for account update
- Solutions engineer adds technical risk
- Manager reviews open questions
- Research monitor posts new signal
- Assistant proposes brief updates
- Team approves which updates go to brief chat

Why it matters:

Production-ready means it supports more than one user’s private workflow.

## Team roles and jobs-to-be-done

Different people use the Journal differently.

### Account owner / AE

- What should I do next?
- What changed since I last looked?
- Draft follow-up.
- Prep me for the next meeting.
- What is the deal/account risk?

### Sales manager

- What accounts are stale?
- Where are next steps missing?
- Which account has strong signals but no follow-up?
- Show me risk across this account.

### Researcher / analyst

- Upload documents.
- Add evidence.
- Mark open questions.
- Propose brief updates.
- Trace claims to sources.

### Customer success

- Renewal/expansion signals.
- Support issues.
- Stakeholder health.
- Product gaps.
- Commitments and follow-ups.

### Executive

- One-screen account summary.
- What matters?
- What changed?
- What needs a decision?
- Where are we exposed?

### AI / monitor / agents

- Add structured observations.
- Propose updates.
- Flag stale assumptions.
- Suggest next actions.
- Never silently mutate high-trust artifacts.

## UX concept: three-panel Journal

Inspired by NotebookLM and Linear.

### Left: Sources / Sections

- Sources
- Timeline filters
- Actions
- Decisions
- Questions
- Brief update candidates

### Center: Journal Feed

- Human notes
- Assistant responses
- Monitor updates
- Document cards
- Threaded replies
- Resolved discussions
- Citation chips
- Inline actions: create action, mark decision, propose brief update

### Right: Intelligence Panel

- Current summary
- Risks
- Open questions
- Suggested actions
- Recent source changes
- Ask about this account
- Generate update
- Prep for meeting
- Compare to brief
- What changed since last week?

This would make the Journal feel like a workspace rather than a comment feed.

## Team collaboration ideas

### Threaded discussions

Borrow from Linear:

- Reply to any entry.
- Resolve a thread.
- AI summarizes resolved threads.
- Final answer / decision can be marked.

### Mentions

- @teammate on notes/actions/questions.
- Needs input from @teammate.
- Mentioned people get notified later if notification system exists.

### Reactions / lightweight status

- 👍 useful
- 👀 reviewing
- ✅ resolved
- ⚠ risk
- 📌 pin

### Pin important entries

Pinned entries become team memory:

- Key decision
- Important doc
- Risk
- Current strategy
- Next meeting prep

### Shared templates

Journal templates by account workflow:

- Discovery call
- Security review
- Procurement update
- Renewal risk
- Competitive displacement
- Executive briefing
- Post-meeting debrief
- Research dump
- Account strategy review

### Human vs AI provenance

Granola-style clarity:

- Human-authored text
- AI-enhanced text
- AI-suggested fields
- Server-generated citations
- Monitor-generated signals

The UI should make provenance obvious.

## Meeting-centric workflows

A Journal becomes dramatically more useful if it can absorb meetings.

Potential future meeting flow:

1. Add meeting note.
2. Paste transcript or notes.
3. Choose template:
   - Sales call
   - Discovery
   - Procurement
   - Implementation
   - Renewal
   - Internal account review
4. AI extracts:
   - Summary
   - Decisions
   - Objections
   - Action items
   - Stakeholder signals
   - Brief update candidates
   - Direct quotes

Nice touch:

- Original user notes remain visually distinct from AI enhancement.
- Like Granola: “your notes” vs “AI added context.”

## Next-generation AI behaviors

### 1. Catch-up modes

Buttons:

- Catch me up
- What changed since my last visit?
- What changed since last brief version?
- What changed this week?
- What needs my attention?
- What is blocked?
- What should we ask next?

### 2. Meeting-prep mode

Before a call:

- Latest account state
- Recent changes
- Open questions
- Stakeholder notes
- Risks to clarify
- Suggested agenda
- Suggested talk track
- Likely objections
- Evidence pack

### 3. Post-meeting mode

After a note/doc/meeting summary:

- Summarize
- Extract decisions
- Extract action items
- Extract brief updates
- Extract stakeholder changes
- Extract risks
- Draft follow-up
- Update open questions

### 4. Intelligence recipes

Granola/Notion-style saved templates.

Examples:

- Sales discovery summary
- Security review summary
- Procurement update
- Executive briefing
- Renewal risk review
- Competitive displacement review
- Technical validation checklist
- Board/account status update
- What would I tell the AE?
- What would I tell the CTO?

### 5. Source-grounded Q&A

NotebookLM-style:

- Ask all sources
- Ask selected docs
- Ask only journal notes
- Ask only monitor updates
- Ask only since a date
- Ask only unresolved items
- Ask only user-authored notes, excluding AI replies

### 6. Conflict detection

AI flags:

- New note contradicts brief.
- Document contradicts previous assumption.
- Two sources disagree.
- User asks to rely on stale source.
- Brief says one thing, latest evidence says another.

This is a major trust/wow feature.

### 7. Memory graph

Reflect/Atlassian-inspired:

- Related notes
- Similar accounts
- Related risks
- Related stakeholders
- Related sources
- This looks like the same issue we saw in another account.
- This source supports several brief sections.

### 8. Proactive nudges

Useful but must be restrained:

- This looks like a brief update candidate.
- This note contains an action item with no owner.
- This question has been open for 14 days.
- The latest source is stronger than the current brief source.
- This account has three hot signals this week.
- No one has acknowledged this monitor update.

## Source-grounded intelligence principle

Everything important should have evidence.

For every generated recommendation, show:

- Source labels
- Exact quote/snippet if possible
- Confidence
- Whether the source is:
  - Uploaded document
  - Journal note
  - Meeting transcript
  - Monitor result
  - Brief field
  - External web research

This is the difference between “AI says so” and “the account record supports this.”

## “What changed?” as a first-class workflow

For account work, change detection may be more valuable than static summaries.

Useful buttons:

- What changed since last visit?
- What changed since the brief was last edited?
- What changed this week?
- What changed since the last monitor run?
- What changed in uploaded docs?
- What changed in stakeholder understanding?
- What changed that affects outreach?

Outputs:

- New facts
- Changed assumptions
- Stale brief fields
- New risks
- New opportunities
- Recommended next action

## Journal as bridge between messy evidence and clean brief

The brief is the polished artifact.
The Journal is the messy, collaborative, source-grounded workbench.

The best flow is not:

- AI edits brief automatically.

The better flow is:

1. Journal gathers evidence.
2. AI proposes structured updates.
3. Team reviews.
4. Brief chat applies accepted changes with version history.

Possible Brief Update Queue statuses:

- New
- Reviewing
- Accepted
- Sent to brief chat
- Applied
- Dismissed

This preserves trust while making the workflow faster.

## Account strategy surfaces

### Current Account Hypothesis

- What we believe about the account
- Evidence
- Confidence
- Last updated
- Contradicting evidence

### Buying Committee Map

- Stakeholders
- Influence
- Sentiment
- Role in decision
- Evidence trail

### Deal / Opportunity Risk

- No next step
- No economic buyer
- Procurement unknown
- Security blocker
- Competitor present
- Budget unclear
- Timeline slipping
- Evidence / source

### Mutual Action Plan

- Account milestone
- Owner
- Customer owner
- Date
- Status
- Evidence

### Competitive Battlecard

Generated from journal + docs:

- Competitor mentioned
- Competitor’s likely angle
- Our counter-positioning
- Proof points
- Open questions

## AI actions that would feel genuinely useful

### Daily / weekly

- Account morning brief
- What changed?
- What needs attention?
- Summarize since I last visited

### Before meetings

- Prep for next call
- Likely objections
- Questions to ask
- Stakeholder-specific talk track
- What do we still not know?

### After meetings

- Extract action items
- Draft follow-up
- Update stakeholder map
- Find brief update candidates
- Identify new risks
- Compare notes to current brief

### For managers

- Find missing next steps
- Assess account health
- What would you coach the rep on?
- What needs escalation?

### For research

- Find contradictions
- What claims lack evidence?
- What should we research next?
- Group evidence by brief section

### For team alignment

- Create decision summary
- Create exec briefing
- Turn this into a Slack update
- Turn this into a customer-facing follow-up

## Production-readiness principles

### 1. Source provenance everywhere

Every AI claim should answer:

- Where did this come from?
- Who added it?
- When?
- Is it still current?
- Is it user-provided, system-imported, monitor-generated, or AI-generated?

### 2. Human-in-the-loop for durable changes

AI can propose:

- Tasks
- Brief updates
- Decisions
- CRM updates
- Follow-ups

Humans approve before:

- Updating brief
- Assigning teammates
- Sending external messages
- Syncing CRM
- Marking a decision official

### 3. Clear separation of artifact types

Avoid one giant blob feed. Different things need different UI:

- Timeline entries
- Sources
- Actions
- Decisions
- Questions
- Signals
- Brief update candidates

### 4. Trust tiers

Not all content is equal.

Possible badges:

- Human note
- AI-generated
- Monitor-generated
- Verified source
- User-uploaded document
- Stale
- Superseded
- Needs review
- Approved

### 5. Permissions and audit

For teams:

- Who can upload docs?
- Who can ask AI?
- Who can see sensitive docs?
- Who can approve update candidates?
- Who can delete?
- Who can export?
- Who can sync to external systems?

Every action should have an audit trail.

### 6. Noise management

The more powerful the Journal gets, the bigger the risk of becoming cluttered.

Need:

- Smart filters
- Digest mode
- Pinning
- Collapse generated content
- Only show unresolved
- Only show what changed
- Priority scoring

### 7. Fast and bounded

Production journal will grow.

Need eventually:

- Pagination
- Search
- Source indexing
- Context selection
- Cost limits
- Async AI jobs for heavier synthesis
- Cached/generated intelligence panels
- Update only changed sections

### 8. Data retention

Meeting transcripts and docs may need deletion policies.

- Summaries can remain while raw transcripts expire.
- Similar to Notion’s transcript deletion model.

### 9. Notification hygiene

Not every AI note should notify everyone.

Notify only on:

- Mentions
- Assigned actions
- Decisions
- High-priority risks
- Accepted updates

### 10. Trust controls

- Disable/enable AI per brief/org.
- Show when sources were excluded.
- Let users choose source scope.
- Require confirmation before any durable mutation.

## Possible section taxonomy

If we wanted a clean IA, propose these top-level tabs:

1. Feed — everything, chronological, threaded.
2. Intelligence — current AI-generated account cockpit.
3. Sources — documents, meetings, monitor snapshots, external evidence.
4. Actions — tasks, commitments, owners, due dates.
5. Decisions — decision log and rationale.
6. Questions — open unknowns and research gaps.
7. Brief Updates — review queue of proposed brief changes.
8. People — stakeholders, relationships, mentions, commitments.

Maybe not all at once, but this is the shape.

## Design vibe

The Journal should feel:

- Calm
- Evidence-first
- Collaborative
- Alive
- Not like a chatbot bolted onto a form

Good mental models:

- A war room for one account.
- A living account notebook.
- A source-grounded strategy cockpit.
- A team memory layer between raw research and polished brief.

Visual ideas:

- Cards, not walls of text
- Timeline with semantic icons
- Source chips
- Confidence badges
- “New since last visit” markers
- Collapsible AI sections
- Pinned decisions/actions
- Split-pane source preview
- One-click copy/send/apply workflows
- Soft visual distinction for AI-suggested vs human-confirmed

## Product direction options

### Option A: Journal as Account Command Center

Best for sales/account research.

Primary sections:

- Timeline
- Intelligence
- Actions
- Sources
- Brief Updates
- Signals

This makes it feel like Gong/Clay/NotebookLM for account teams.

### Option B: Journal as Team Memory

Best for collaboration.

Primary sections:

- Notes
- Decisions
- Questions
- Tasks
- People
- Search

This makes it feel like Notion/Linear/Slack for account work.

### Option C: Journal as Research Studio

Best for source-heavy analysis.

Primary sections:

- Sources
- Chat with sources
- Artifacts
- Evidence table
- Reports
- Brief handoff

This makes it feel like NotebookLM but account-specific.

### Option D: Journal as Agent Workspace

Best for next-generation AI workflows.

Primary sections:

- Human feed
- Agent runs
- Proposed actions
- Review queue
- Audit log
- Skills/recipes

This makes it feel like Linear Agent / Rovo / Slackbot, but grounded in the account.

Product instinct:

Combine A + C first: Account Command Center with NotebookLM-grade source trust.

Then add B collaboration patterns.
Then add D agent/workflow automation once the human review loop is proven.

## Potential “wow” experiences

### 1. Upload a PDF

Within seconds the Journal shows:

- Summary
- Key account facts
- Stakeholders mentioned
- Risks
- Action items
- Brief update candidates
- Open questions
- All with source citations

### 2. “Prep me for tomorrow’s account call”

Output:

- 5-bullet account state
- What changed since last call
- Stakeholder notes
- Risks to clarify
- Suggested questions
- Suggested follow-up language
- Evidence pack

### 3. “What should the team do next?”

Output:

- Ranked next actions
- Owners if implied
- Why it matters
- Deadline if known
- Evidence
- Confidence

### 4. “What changed since version 12 of the brief?”

Output:

- New evidence
- Old assumptions challenged
- Suggested brief updates
- Sources
- Unresolved questions

### 5. “Turn this messy thread into team-ready intelligence”

Output:

- Decision log
- Action list
- Brief update candidates
- Follow-up draft
- Risks / open questions

### 6. “Show me account risk”

Output:

- Deal/account risks
- Source evidence
- Trend direction
- Recommended mitigation
- Owner/action

## Concrete feature buckets after PR #90-#94

### First-pass shipped; remaining polish

- Journal filters by entry type: shipped for Timeline notes/assistant/documents; monitor-specific filtering remains future.
- Better assistant reply grouping: partially addressed through citation chips, evidence snippets, and candidate drafting; richer threading remains future.
- Catch me up action: shipped as an advisory prompt; durable “what changed since…” recall remains future.
- Source preview drawer/card: first pass shipped for uploaded documents and citation context; deeper extracted-text browsing remains future.
- Citation click-to-source: first pass shipped for trusted `[J]`/`[D]` legends; true passage highlighting remains future.
- Open questions/action/decision extraction: first pass shipped as assistant-to-review-candidate drafting and structured boards; lifecycle metadata remains future.
- Source library panel: first pass shipped as the Sources workspace with baseline plus uploaded sources, health badges, and include/exclude controls.
- Brief update candidate queue: first pass shipped as human-review Review Queue cards and brief-chat handoff.

### Next high-leverage PRs

- Dedicated “what changed since…” catch-up summaries over recent Journal windows.
- Durable cached Account Intelligence cockpit/read-model cards built from accepted/reviewed data only.
- Source-change rollups inside the cockpit.
- Pin important entries.
- Mark entry as decision/action/question directly from Timeline where appropriate.
- Owner, due date, priority, and status lifecycle metadata for structured board cards.
- Team mentions / notifications.

### Large / next-generation

- Cross-account memory / similar account retrieval
- CRM sync
- Slack/Linear integration
- Full source graph
- Agent workflows with approval gates
- Meeting transcript ingestion
- Account risk scoring
- Multi-signal monitor orchestration
- Role-specific views

## Original first step: Journal Workspaces + Source Library

This section is historical. The first-pass workspace/source foundation has now shipped across PRs #82, #84, #86, #87, #93, and #94. Keep it as context for why the Journal started with durable information architecture before deeper workflow mutation.

Initial scoped direction:

- Add a workspace-oriented Journal layout.
- Make section navigation visible without overbuilding all sections.
- Prioritize Feed/Timeline and Sources first.
- Keep existing Journal behavior intact.
- Make source cards and source preview easier to understand.
- Prepare the information architecture for Actions, Decisions, Questions, Brief Updates, People, and Signals without implementing all of those data models immediately.
- Preserve source-grounding and prompt-injection hardening from the existing Journal document/AI implementation.
- Keep outputs advisory; no automatic brief mutation.

Possible first implementation PR themes:

1. Journal Workspaces shell:
   - section tabs or sidebar
   - Feed and Sources active
   - future sections visible as disabled/empty-state concepts only if useful
2. Source Library MVP:
   - uploaded document list
   - source cards
   - preview drawer/panel
   - summarize / ask / find brief updates actions where already supported
3. Timeline filters:
   - all
   - notes
   - assistant
   - documents
   - monitor
4. UX polish:
   - source/citation language
   - empty states
   - clearer provenance badges
   - no schema migration unless absolutely needed

Non-goals for the first PR:

- Full action-item database
- Decision database
- CRM sync
- Slack/Linear integration
- Meeting transcript ingestion
- Cross-account memory
- Automatic brief mutation
- Agent automation

## Open product questions

- Given the first-pass workspace/source foundation is shipped, should the Journal now keep tabs, move toward a left sidebar, or evolve into a three-panel cockpit layout within current brief page constraints?
- Should Sources remain a tab, become a persistent side panel, or appear contextually beside search/recall results?
- Which future sections should stay visible as shipped structured boards versus hidden until lifecycle metadata exists?
- How durable should source inclusion/exclusion become: session-only UI state, saved user preference, or source-resolution workflow state?
- What conflict-resolution lifecycle is needed for stale, duplicate, superseded, and conflicting source health labels?
- Should “Catch me up” live in Feed, Intelligence, search results, or all three?
- Should source previews expose extracted text directly, bounded snippets only, or server-side searched excerpts?
- What is the cleanest handoff from Search/Source → Review Candidate → Brief Chat → applied Brief update?
- For the cockpit, which statuses count as reviewed enough to roll up: accepted, sent_to_brief_chat, applied, or a new explicit official state?
