# Canvas v2 strategic workspace — Phase 1

## Goal

Move Canvas closer to Brief-level professionalism while adding the
first deterministic, AI-native strategic widgets:

1. Strategic Signal Radar
2. Opportunity / Risk Split
3. Momentum Strip
4. AI Takeaways Panel

All widgets are derived deterministically from the saved Brief
object. No live model calls. No new data plumbing in the API tier.
No DB migrations. Canvas remains read-only with all controls
disabled and remains gated behind the admin-only canvas preview
flag (no public-share exposure).

## Hard constraints

- No production deployment.
- No DB migrations.
- No live Anthropic / OpenAI / provider / model calls.
- No background jobs or async refresh flows.
- No auth / authorization changes.
- No public share route exposure for Canvas.
- Do not touch Resend / email config.
- Keep Canvas read-only; all controls remain disabled.
- Every account-specific string must come from the saved Brief or
  from fixed labels. Do not invent facts.
- Do not import lab store / reducer / action queue / autonomous-
  agent behaviour into production.
- Do not run `npm audit fix --force`.

## Strict TDD ordering

1. Write the failing tests first in `tests/canvasBridge.test.ts`.
2. Run `npx tsx tests/canvasBridge.test.ts` and confirm they fail
   for the expected reason (missing module / missing widget / etc.).
3. Implement the minimal code that makes them pass.
4. Re-run tests and confirm green.

## Pure derivation helpers (new module)

Create `web/lib/canvas/strategicInsights.ts`. React-free,
deterministic. No throws on sparse / empty brief fields.

Exports:

- `buildStrategicSignalRadar(brief): StrategicSignalRadarData`
- `buildOpportunityRiskSplit(brief): OpportunityRiskSplitData`
- `buildMomentumStrip(brief): MomentumStripData`
- `buildAITakeaways(brief): AITakeawaysData`

### Strategic Signal Radar

Buckets `brief.recent_signals` + `brief.competitive_signals` into
four quadrants by keyword match on the signal text:

- **Strategy** — strategy / strategic / priority / transformation /
  modernization / vision / plan / roadmap / mandate
- **Tech & AI** — ai / ml / cloud / platform / data / infrastructure /
  digital / automation / analytics
- **Procurement** — rfp / contract / procurement / grant / consortium /
  cooperative / purchasing / award
- **Leadership** — ceo / cio / cto / ciso / cmio / cdo / appointed /
  named / hired / hire / chief

For each quadrant: `{ key, label, count, confidence?, sample? }`,
where `confidence` is the highest-confidence value among contributing
signals and `sample` is the first matched signal text. Quadrants with
zero matches still appear (count=0) so the radar always has four
cells.

### Opportunity / Risk Split

Side-by-side opportunity vs risk read:

- `opportunities`: `{ count: brief.top_initiatives.length, top: ... }`
  where `top` is the first initiative `{ text: title, confidence,
  tag: detail }` or `null`.
- `risks`: `{ count: brief.risks.length, top: ... }` where `top` is
  the first risk string or `null`.
- `balance`: `"opportunity-heavy" | "risk-heavy" | "balanced"`. Tie
  → balanced. Empty both → balanced.

### Momentum Strip

Segments derived from brief metadata:

- `signals` = `brief.recent_signals.length`
- `initiatives` = `brief.top_initiatives.length`
- `pilots` = `brief.technical_footprint.active_pilots.length`
- `programs` = `brief.programs_procurement.active_rfps_contracts.length`

Total = sum of segments.
`velocity_label`:
- total >= 8 → `"High momentum"`
- total >= 4 → `"Steady"`
- total >= 1 → `"Low momentum"`
- total === 0 → `"Quiet"`

### AI Takeaways Panel

3–5 deterministic takeaways. Each:
`{ headline, detail, source_field }`. `source_field` names the brief
field the takeaway is derived from (so the drill-in can cite
provenance).

Inputs used:
- `ai_tech_maturity` → "Maturity rating <N>/5" + interpretation
  (1=no AI; 2=exploring; 3=piloting; 4=deploying; 5=scaling)
- `top_initiatives[0]` → "Top initiative: <title>"
- `risks[0]` → "Top watch-out: <text>"
- `buying_path` → "Buying path"
- `next_action` → "Recommended next action"

If a source field is empty / missing, that takeaway is skipped.

## Schema extension

Add to `web/lib/canvas/schema.ts`:

- `WidgetKind` gains: `strategic_signal_radar`,
  `opportunity_risk_split`, `momentum_strip`, `ai_takeaways`.
- Zod data shapes per widget kind.
- Each kind extended into a `BaseWidget` variant and added to the
  `CanvasWidget` discriminated union.
- Tests assert `Canvas.parse` accepts each new widget shape.

## Adapter emission

`web/lib/canvas/fromBrief.ts` emits one of each strategic widget
with stable IDs:

- `insight-ai-takeaways`
- `insight-signal-radar`
- `insight-opportunity-risk`
- `insight-momentum-strip`

All four:
- `source: "hermes"`
- `controls`: all false
- `status: "fresh"`
- `why_included` explaining deterministic derivation from the saved
  brief.

Layout: placed near the top of the grid (after snapshot + maturity)
so they appear in the first viewport below the Executive Cockpit.

Existing widgets are preserved: `evidence-board`,
`section-top-initiatives`, `action-next`, etc.

## Registry + renderers

- Update `web/lib/canvas/registry.tsx` with descriptors for the four
  new kinds.
- Add tile exports in `web/components/canvas/tiles.tsx`:
  - `StrategicSignalRadarTile`
  - `OpportunityRiskSplitTile`
  - `MomentumStripTile`
  - `AITakeawaysTile`
- Add detail exports in `web/components/canvas/details.tsx`:
  - `StrategicSignalRadarDetail`
  - `OpportunityRiskSplitDetail`
  - `MomentumStripDetail`
  - `AITakeawaysDetail`

Visual treatment:
- Professional, restrained, Brief-quality.
- No horizontal overflow.
- Existing card click + drill-in behaviour preserved (no new
  interactive handlers; the existing `WidgetTile` chrome wraps each
  tile).
- Use existing primitives: `ConfidenceBar`, `ConfidenceChip`,
  `ToneIcon`, `SeverityChip`, tone CSS variables.
- Read-only / audit-ready posture remains visible (status chip,
  source badge, controls disabled).

## Verification

```
cd /home/user/account-research
npx tsx tests/canvasBridge.test.ts
cd web && npm run typecheck && npm run build
cd ..
git diff --check
git status --short
git log --oneline origin/main..HEAD
```

All must succeed. Focused commits only.

## PR

Title: `feat: add Canvas v2 strategic workspace widgets`. PR body
must include:
- Summary of new widgets
- Safety / scope notes (no migrations, no provider calls, no
  background jobs, no public share exposure, no production deploy)
- Verification command results
- Browser QA checklist for Hermes / user after merge / deploy
  approval.
