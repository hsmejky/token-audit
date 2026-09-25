const test = require('node:test');
const assert = require('node:assert/strict');
const { audit, tmpClaudeDir, turn } = require('./harness');

test('Fable rows are priced and shown as their own family in SPEND', () => {
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': turn({
      id: 'f1', model: 'claude-fable-5-1',
      usage: { input_tokens: 1000, output_tokens: 1000 },
    }),
  });
  const r = audit(dir);
  // fable: 1000 in * $10/MTok + 1000 out * $50/MTok = 10,000 + 50,000 = 60,000 -> $0.06
  assert.equal(r.cur.cost.toFixed(6), '0.060000');
  assert.deepEqual(Object.keys(r.cur.byFamily), ['Fable']);
});

test('unknown model rows are counted under UNPRICED, not dropped', () => {
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': turn({
      id: 'u1', model: 'claude-unknown-9',
      usage: { input_tokens: 500, output_tokens: 200 },
    }),
  });
  const r = audit(dir);
  assert.equal(r.cur.msgs, 0, 'unpriced row must not be counted as a priced turn');
  assert.deepEqual(r.unpriced, [{ model: 'claude-unknown-9', rows: 1, tokens: 700 }]);
});

test('unpriced rows from several models are all kept, tokens not lost', () => {
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': [
      ...turn({ id: 'u1', model: 'claude-unknown-9', usage: { input_tokens: 100, output_tokens: 0 } }),
      ...turn({ id: 'u2', model: 'claude-unknown-9', usage: { input_tokens: 300, output_tokens: 0 } }),
      ...turn({ id: 'u3', model: 'claude-mystery-1', usage: { input_tokens: 50, output_tokens: 5 } }),
    ],
  });
  const r = audit(dir);
  const byModel = Object.fromEntries(r.unpriced.map(u => [u.model, u]));
  assert.deepEqual(byModel['claude-unknown-9'], { model: 'claude-unknown-9', rows: 2, tokens: 400 });
  assert.deepEqual(byModel['claude-mystery-1'], { model: 'claude-mystery-1', rows: 1, tokens: 55 });
});

test('fable-5 prices differently from fable-5-1 (fable-5 cache read is $1, not $0.25)', () => {
  const dir = tmpClaudeDir({
    'projects/p/a.jsonl': turn({
      id: 'a', model: 'claude-fable-5',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1e6 },
    }),
    'projects/p/b.jsonl': turn({
      id: 'b', model: 'claude-fable-5-1',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1e6 },
    }),
  });
  const r = audit(dir);
  const bySid = Object.fromEntries(r.cur.sessions.map(s => [s.sid, s.cost]));
  assert.equal(bySid.a.toFixed(2), '1.00'); // Fable 5: cache read $1/MTok
  assert.equal(bySid.b.toFixed(2), '0.25'); // Fable 5.1: cache read $0.25/MTok
  // both still roll up into one "Fable" family bucket in SPEND
  assert.deepEqual(Object.keys(r.cur.byFamily), ['Fable']);
});

test('opus-5-5 prices differently from opus-5 (verified against source, row split)', () => {
  const dir = tmpClaudeDir({
    'projects/p/a.jsonl': turn({ id: 'a', model: 'claude-opus-5', usage: { input_tokens: 1e6, output_tokens: 0 } }),
    'projects/p/b.jsonl': turn({ id: 'b', model: 'claude-opus-5-5', usage: { input_tokens: 1e6, output_tokens: 0 } }),
  });
  const r = audit(dir);
  const bySid = Object.fromEntries(r.cur.sessions.map(s => [s.sid, s.cost]));
  assert.equal(bySid.a.toFixed(2), '5.00'); // Opus 5: $5/MTok input
  assert.equal(bySid.b.toFixed(2), '4.00'); // Opus 5.5: $4/MTok input (cheaper, per source)
  // both still roll up into one "Opus" family bucket in SPEND
  assert.deepEqual(Object.keys(r.cur.byFamily), ['Opus']);
});

test('UNPRICED is filtered by the --days window, matching SPEND', () => {
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': [
      ...turn({
        id: 'u1', model: 'claude-unknown-9', ts: new Date().toISOString(),
        usage: { input_tokens: 500, output_tokens: 200 },
      }),
      ...turn({
        id: 'u2', model: 'claude-unknown-9', ts: '2020-01-01T00:00:00.000Z',
        usage: { input_tokens: 999, output_tokens: 999 },
      }),
    ],
  });
  const r = audit(dir, '--days', '7');
  assert.deepEqual(r.unpriced, [{ model: 'claude-unknown-9', rows: 1, tokens: 700 }],
    'the 2020 row is outside the 7-day window and must not be counted');
});
