import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeBriefs } from '../web/lib/briefMerge';
import type { Brief } from '../web/lib/schema';

const base: Brief = {
  account_name: 'Acme', segment: 'Healthcare', generated_at: '2026-01-01', audience: 'internal',
  snapshot: 'old snapshot', priority_summary: 'old priority',
  recent_signals: [
    { text: 'Acme opened a new AI lab in Boston', source: 'u1', confidence: 'High' },
    { text: 'Legacy signal that disappears', source: 'u2', confidence: 'Medium' },
  ],
  ai_tech_maturity: { rating: 3, rationale: 'old' },
  top_initiatives: [
    { title: 'Cloud EHR', detail: 'old detail', confidence: 'High', source: 'u3' },
    { title: 'Legacy Initiative', detail: 'old legacy', confidence: 'Low', source: 'u4' },
  ],
  technical_footprint: { ai_in_production: ['old ai'], active_pilots: [], cloud_platforms: ['AWS'], data_infrastructure: 'old data', clinical_platforms: 'Epic', analytics_bi_stack: 'old bi', build_vs_buy_posture: 'old posture', competitive_incumbents: ['Vendor A'] },
  programs_procurement: { modernization_grants: ['old grant'], consortium_purchasing: [], active_rfps_contracts: [], ai_governance_policy: 'old gov', public_ai_use_cases: [] },
  personas: [
    { name: 'Jane Doe', title: 'CIO', priority: 'old p', opener: 'old o', confidence: 'High', source: 'u5' },
    { name: 'Test Persona Charlie', title: 'VP', priority: 'chat p', opener: 'chat o', confidence: 'Medium', source: 'chat' },
  ],
  buying_path: 'old buying', first_angle: 'old angle', risks: ['Risk A'], competitive_signals: ['Signal A'], next_action: 'old next',
  extensions: [
    { kind: 'narrative', id: 'chat-note', title: 'Chat note', source: 'chat', created_at: '2026-01-01', why_included: 'chat', confidence: 'High', sources: [], body: 'keep me' },
    { kind: 'card', id: 'old-card', title: 'Old card', source: 'model', created_at: '2026-01-01', why_included: 'old', confidence: 'Low', sources: [], body: 'old body' },
  ],
  sources: [{ title: 'One', url: 'https://one.test', accessed: '2026-01-01' }],
};

const next: Brief = {
  ...base,
  generated_at: '2026-02-01', snapshot: 'new snapshot', priority_summary: 'new priority',
  recent_signals: [{ text: 'Acme opened new AI lab in Boston', source: 'u1b', confidence: 'High' }],
  top_initiatives: [{ title: 'Cloud EHR', detail: 'new detail', confidence: 'Medium', source: 'u3b' }],
  technical_footprint: { ...base.technical_footprint, data_infrastructure: 'new data' },
  programs_procurement: { ...base.programs_procurement, ai_governance_policy: 'new gov' },
  personas: [{ name: 'Jane Doe', title: 'CIO', priority: 'new p', opener: 'new o', confidence: 'Medium', source: 'u5b' }],
  risks: ['Risk A', 'Risk B'], competitive_signals: ['Signal A', 'Signal B'],
  extensions: [{ kind: 'table', id: 'new-table', title: 'New table', source: 'model', created_at: '2026-02-01', why_included: 'new', confidence: 'High', sources: [], columns: ['A'], rows: [['B']] }],
  sources: [{ title: 'One newer', url: 'https://one.test', accessed: '2026-02-01' }, { title: 'Two', url: 'https://two.test', accessed: '2026-02-01' }],
};

test('mergeBriefs retains unmatched previous items as previously_found and preserves chat extensions', () => {
  const merged = mergeBriefs(base, next);
  assert.equal(merged.snapshot, 'new snapshot');
  assert.equal(merged.technical_footprint.data_infrastructure, 'new data');
  assert.deepEqual(merged.risks, ['Risk A', 'Risk B']);
  assert.equal(merged.sources.length, 2);
  assert.equal(merged.top_initiatives.find(i => i.title === 'Cloud EHR')?.detail, 'new detail');
  assert.equal(merged.top_initiatives.find(i => i.title === 'Legacy Initiative')?.previously_found, true);
  assert.equal(merged.personas.find(p => p.name === 'Test Persona Charlie')?.source, 'chat');
  assert.equal(merged.personas.find(p => p.name === 'Test Persona Charlie')?.previously_found, undefined);
  assert.ok(merged.extensions.some(e => e.id === 'chat-note' && e.source === 'chat' && !('previously_found' in e)));
  assert.equal(merged.extensions.find(e => e.id === 'old-card')?.previously_found, true);
});
