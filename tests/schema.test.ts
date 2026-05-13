import assert from 'node:assert/strict';
import test from 'node:test';
import { Brief, BriefExtension } from '../web/lib/schema';
import { applyPatches } from '../web/lib/briefPatches';

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

// ---- extensions backward-compat / PR-A spec --------------------------------

const baseExt = {
  id: 'pricing-model',
  title: 'Pricing model',
  created_at: '2026-05-13',
  why_included: 'Useful comparison.',
  confidence: 'High' as const,
  sources: [{ title: 'A', url: 'https://a', accessed: '2026-05-13' }],
};

test('extension source accepts legacy "model"', () => {
  const ext = BriefExtension.parse({
    ...baseExt,
    kind: 'card',
    source: 'model',
    body: 'legacy card',
  });
  assert.equal(ext.source, 'model');
});

test('extension source accepts new "research"', () => {
  const ext = BriefExtension.parse({
    ...baseExt,
    kind: 'card',
    source: 'research',
    body: 'new card',
  });
  assert.equal(ext.source, 'research');
});

test('extension source rejects unknown values', () => {
  assert.throws(() =>
    BriefExtension.parse({ ...baseExt, kind: 'card', source: 'agent', body: 'x' }),
  );
});

test('card extension without badges parses and defaults badges to []', () => {
  const ext = BriefExtension.parse({
    ...baseExt,
    kind: 'card',
    source: 'research',
    body: 'no badges',
  });
  if (ext.kind === 'card') {
    assert.deepEqual(ext.badges, []);
  } else {
    assert.fail('expected card');
  }
});

test('card extension with badges parses verbatim', () => {
  const ext = BriefExtension.parse({
    ...baseExt,
    kind: 'card',
    source: 'research',
    body: 'with badges',
    badges: ['Q3-2026', 'tier-1'],
  });
  if (ext.kind === 'card') {
    assert.deepEqual(ext.badges, ['Q3-2026', 'tier-1']);
  } else {
    assert.fail('expected card');
  }
});

test('list extension accepts legacy string items', () => {
  const ext = BriefExtension.parse({
    ...baseExt,
    kind: 'list',
    source: 'model',
    items: ['one', 'two', 'three'],
  });
  if (ext.kind === 'list') {
    assert.equal(ext.items.length, 3);
    assert.equal(ext.items[0], 'one');
  } else {
    assert.fail('expected list');
  }
});

test('list extension accepts PR-A {heading?, text} object items', () => {
  const ext = BriefExtension.parse({
    ...baseExt,
    kind: 'list',
    source: 'research',
    items: [
      { heading: 'Heading', text: 'body' },
      { text: 'no-heading' },
    ],
  });
  if (ext.kind === 'list') {
    const first = ext.items[0];
    const second = ext.items[1];
    assert.equal(typeof first === 'object' && first.heading, 'Heading');
    assert.equal(typeof second === 'object' && second.text, 'no-heading');
  } else {
    assert.fail('expected list');
  }
});

test('table extension preserves columns and rows', () => {
  const ext = BriefExtension.parse({
    ...baseExt,
    kind: 'table',
    source: 'research',
    columns: ['Vendor', 'Model'],
    rows: [
      ['Acme', 'Enterprise'],
      ['Beta', 'Mid-market'],
    ],
  });
  if (ext.kind === 'table') {
    assert.deepEqual(ext.columns, ['Vendor', 'Model']);
    assert.equal(ext.rows.length, 2);
    assert.equal(ext.rows[1][1], 'Mid-market');
  } else {
    assert.fail('expected table');
  }
});

test('extension without sources parses and defaults sources to []', () => {
  const { sources, ...withoutSources } = baseExt;
  const ext = BriefExtension.parse({
    ...withoutSources,
    kind: 'card',
    source: 'research',
    body: 'no sources field',
  });
  assert.deepEqual(ext.sources, []);
});

test('invalid extension kind is rejected', () => {
  assert.throws(() =>
    BriefExtension.parse({ ...baseExt, kind: 'bogus' as any, body: 'x' }),
  );
});

test('Brief.parse accepts a brief carrying one extension of each kind', () => {
  const exts = [
    { ...baseExt, id: 'c1', kind: 'card', source: 'research', body: 'card', badges: ['a'] },
    {
      ...baseExt,
      id: 't1',
      kind: 'table',
      source: 'research',
      columns: ['A', 'B'],
      rows: [['1', '2']],
    },
    {
      ...baseExt,
      id: 'l1',
      kind: 'list',
      source: 'research',
      items: ['plain', { heading: 'H', text: 't' }],
    },
    {
      ...baseExt,
      id: 'n1',
      kind: 'narrative',
      source: 'research',
      body: 'long prose body.',
    },
  ];
  const parsed = Brief.parse({ ...legacyBrief, extensions: exts });
  assert.equal(parsed.extensions.length, 4);
});

// ---- chat patch behavior ---------------------------------------------------

test('chat append stamps source="chat" when model omits source', () => {
  const briefWithExt = Brief.parse({ ...legacyBrief });
  const updated = applyPatches(briefWithExt, [
    {
      op: 'append',
      field: 'extensions',
      value: {
        ...baseExt,
        id: 'chat-only',
        kind: 'card',
        body: 'from chat',
        // source omitted
      },
    },
  ]);
  assert.equal(updated.extensions.length, 1);
  assert.equal(updated.extensions[0].source, 'chat');
});

test('chat append FORCES source="chat" even when model claims research/model', () => {
  const briefWithExt = Brief.parse({ ...legacyBrief });
  for (const claimed of ['research', 'model'] as const) {
    const updated = applyPatches(briefWithExt, [
      {
        op: 'append',
        field: 'extensions',
        value: {
          ...baseExt,
          id: `forced-${claimed}`,
          kind: 'card',
          source: claimed,
          body: 'from chat',
        },
      },
    ]);
    assert.equal(updated.extensions[0].source, 'chat');
  }
});

test('chat set accepts a mixed array including legacy "model"-sourced entries', () => {
  const briefWithExt = Brief.parse({ ...legacyBrief });
  const updated = applyPatches(briefWithExt, [
    {
      op: 'set',
      field: 'extensions',
      value: [
        { ...baseExt, id: 'legacy', kind: 'card', source: 'model', body: 'legacy' },
        { ...baseExt, id: 'new', kind: 'card', source: 'research', body: 'new' },
        { ...baseExt, id: 'chatty', kind: 'card', source: 'chat', body: 'chat' },
      ],
    },
  ]);
  assert.equal(updated.extensions.length, 3);
  assert.equal(updated.extensions[0].source, 'model');
  assert.equal(updated.extensions[1].source, 'research');
  assert.equal(updated.extensions[2].source, 'chat');
});

test('chat append rejects malformed extension', () => {
  const briefWithExt = Brief.parse({ ...legacyBrief });
  assert.throws(() =>
    applyPatches(briefWithExt, [
      {
        op: 'append',
        field: 'extensions',
        value: { kind: 'card', body: 'missing fields' },
      },
    ]),
  );
});
