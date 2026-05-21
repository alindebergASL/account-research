# Claude Code Web Prompt — Canvas v2 Strategic Workspace Phase 1

Use this prompt in the Claude Code Web workspace that has access to the production repo `alindebergASL/account-research`.

---

You are working in GitHub repo:

`alindebergASL/account-research`

Target base branch:

`main`

Create a new feature branch from latest `origin/main`:

`hermes/canvas-v2-strategic-workspace-phase-1`

Implement the saved plan:

`docs/plans/2026-05-15-canvas-v2-strategic-workspace-phase-1.md`

If the plan file is not present on your branch yet, create it using the content Hermes provided in the current conversation, or ask for it before implementation. Do not proceed from memory.

Goal:

Make Canvas feel closer to Brief-level professionalism while adding the first deterministic, AI-native strategic widgets:

1. Strategic Signal Radar
2. Opportunity / Risk Split
3. Momentum Strip
4. AI Takeaways Panel

Hard constraints:

- No production deployment.
- No DB migrations.
- No live Anthropic/OpenAI/provider/model calls.
- No background jobs or async refresh flows.
- No auth/authorization changes.
- No public share route exposure for Canvas.
- Do not touch Resend/email config.
- Keep Canvas read-only; all controls remain disabled.
- Every account-specific string must come from the saved `Brief` object or fixed labels. Do not invent facts.
- Do not import lab store/reducer/action queue/autonomous-agent behavior into production.
- Do not run `npm audit fix --force`.

Existing relevant files:

- `web/lib/canvas/schema.ts`
- `web/lib/canvas/fromBrief.ts`
- `web/lib/canvas/cockpit.ts`
- `web/lib/canvas/visualHelpers.ts`
- `web/lib/canvas/registry.tsx`
- `web/components/canvas/ReadOnlyCanvasView.tsx`
- `web/components/canvas/ExecutiveCockpit.tsx`
- `web/components/canvas/WidgetTile.tsx`
- `web/components/canvas/tiles.tsx`
- `web/components/canvas/details.tsx`
- `web/components/canvas/visuals.tsx`
- `tests/canvasBridge.test.ts`
- `tests/sample_brief.json`

Required implementation:

1. Use strict TDD.
   - Write failing tests first in `tests/canvasBridge.test.ts`.
   - Run `npx tsx tests/canvasBridge.test.ts` and verify failure for the expected reason.
   - Implement minimal code.
   - Re-run tests and verify pass.

2. Add pure derivation helpers:
   - Create `web/lib/canvas/strategicInsights.ts`.
   - Export:
     - `buildStrategicSignalRadar(brief)`
     - `buildOpportunityRiskSplit(brief)`
     - `buildMomentumStrip(brief)`
     - `buildAITakeaways(brief)`
   - Keep this module React-free and deterministic.
   - Do not throw on sparse/empty brief fields.

3. Extend Canvas schema:
   - Add widget kinds:
     - `strategic_signal_radar`
     - `opportunity_risk_split`
     - `momentum_strip`
     - `ai_takeaways`
   - Add Zod data schemas for the four data shapes.
   - Add tests proving `Canvas.parse` accepts these widgets.

4. Emit new widgets from `web/lib/canvas/fromBrief.ts`:
   - Stable IDs:
     - `insight-ai-takeaways`
     - `insight-signal-radar`
     - `insight-opportunity-risk`
     - `insight-momentum-strip`
   - Source should be consistent, preferably `hermes`.
   - All controls false.
   - Include `why_included` explaining deterministic derivation from saved brief.
   - Preserve existing widgets like `evidence-board`, `section-top-initiatives`, and `action-next`.

5. Add renderers and registry wiring:
   - Update `web/lib/canvas/registry.tsx`.
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
   - Keep UI professional and restrained, closer to Brief quality.
   - Avoid horizontal overflow.
   - Preserve existing card click/drill-in behavior.

6. Professional polish pass:
   - The first Canvas viewport should feel intentionally designed:
     - header
     - executive cockpit
     - strategic insight widgets
     - existing evidence/section grid
   - Use strong hierarchy, subtle borders/tints, readable contrast.
   - Keep the read-only/audit-ready posture visible.

Required verification before PR:

```bash
cd /home/ubuntu/account-research
npx tsx tests/canvasBridge.test.ts
cd web && npm run typecheck && npm run build
cd ..
git diff --check
git status --short
git log --oneline origin/main..HEAD
```

Expected:

- Canvas bridge tests pass.
- Typecheck passes.
- Build passes.
- `git diff --check` clean.
- Focused commits only.

Open a PR against `main` with title:

`feat: add Canvas v2 strategic workspace widgets`

PR body must include:

- Summary of new widgets.
- Safety/scope notes:
  - no migrations
  - no provider calls
  - no background jobs
  - no public share exposure
  - no production deploy
- Verification command results.
- Browser QA checklist for Hermes/user to perform after merge/deploy approval.

Report back with:

- Branch name.
- PR URL.
- Commit SHAs and subjects.
- Exact verification command output summary.
- Any caveats, skipped items, or known visual tradeoffs.
- Confirmation that no production deploy was performed.
