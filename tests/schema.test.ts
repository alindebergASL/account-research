import assert from 'node:assert/strict';
import test from 'node:test';
import { Brief } from '../web/lib/schema';

const legacyBrief = {
  account_name: 'Legacy',
  segment: 'Healthcare',
  generated_at: '2026-01-01',
  audience: 'internal',
  snapshot: 'snapshot',
  priority_summary: 'priority',
  recent_signals: [{ text: 'signal', source: 'source', confidence: 'High' }],
  ai_tech_maturity: { rating: 3, rationale: 'rationale' },
  top_initiatives: [{ title: 'initiative', detail: 'detail', confidence: 'Medium', source: 'source' }],
  technical_footprint: {
    ai_in_production: [],
    active_pilots: [],
    cloud_platforms: [],
    data_infrastructure: 'data',
    clinical_platforms: 'clinical',
    analytics_bi_stack: 'bi',
    build_vs_buy_posture: 'posture',
    competitive_incumbents: [],
  },
  programs_procurement: {
    modernization_grants: [],
    consortium_purchasing: [],
    active_rfps_contracts: [],
    ai_governance_policy: 'policy',
    public_ai_use_cases: [],
  },
  personas: [{ name: 'Pat', title: 'CIO', priority: 'priority', opener: 'opener', confidence: 'High', source: 'source' }],
  buying_path: 'path',
  first_angle: 'angle',
  risks: [],
  competitive_signals: [],
  next_action: 'next',
  sources: [{ title: 'Source', url: 'https://example.com', accessed: '2026-01-01' }],
};

test('Brief schema tolerates legacy briefs and defaults extensions', () => {
  const parsed = Brief.parse(legacyBrief);
  assert.deepEqual(parsed.extensions, []);
});

test('Brief schema tolerates previously_found flags on mergeable items', () => {
  const parsed = Brief.parse({
    ...legacyBrief,
    recent_signals: [{ text: 'signal', source: 'source', confidence: 'High', previously_found: true }],
    top_initiatives: [{ title: 'initiative', detail: 'detail', confidence: 'Medium', source: 'source', previously_found: true }],
    personas: [{ name: 'Pat', title: 'CIO', priority: 'priority', opener: 'opener', confidence: 'High', source: 'source', previously_found: true }],
  });
  assert.equal(parsed.recent_signals[0]?.previously_found, true);
  assert.equal(parsed.top_initiatives[0]?.previously_found, true);
  assert.equal(parsed.personas[0]?.previously_found, true);
});
