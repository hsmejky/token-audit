const test = require('node:test');
const assert = require('node:assert/strict');
const { audit, fixture, tmpClaudeDir, turns } = require('./harness');

test('lines sharing one message.id count as one turn, priced once', () => {
  const r = audit(fixture('multiline-message'));
  assert.equal(r.all.msgs, 1);
  // opus: 200k input × $5 + 40k output × $25 (final streamed usage) = $2.00
  assert.equal(r.cur.cost.toFixed(6), '2.000000');
  // costPerMsg must use the deduped msg count (1), not the raw line count (3):
  // non-deduped would average the three lines' costs to ~1.33 instead of 2.00.
  assert.equal(r.cur.costPerMsg.toFixed(6), '2.000000');
});

test('rows without message.id are each counted, not dropped', () => {
  const r = audit(fixture('no-message-id'));
  assert.equal(r.all.msgs, 2);
  assert.equal(r.cur.cost.toFixed(6), '2.000000');
});

test('session stats and LONG_SESSION use deduped turns', () => {
  // 10 / 20 / 150 turns, each written as 3 lines (raw 30 / 60 / 450)
  const dir = tmpClaudeDir({
    'projects/p/s10.jsonl': turns(10, 'a', { lines: 3 }),
    'projects/p/s20.jsonl': turns(20, 'b', { lines: 3 }),
    'projects/p/s150.jsonl': turns(150, 'c', { lines: 3 }),
  });
  const r = audit(dir);
  const msgs = Object.fromEntries(r.cur.sessions.map(s => [s.sid, s.msgs]));
  assert.deepEqual(msgs, { s10: 10, s20: 20, s150: 150 });
  assert.equal(r.cur.medianMsgs, 20);
  assert.equal(r.cur.p90Msgs, 150);
  assert.ok(!r.flags.some(f => f.id === 'LONG_SESSION'), 'raw 450 lines must not trip ≥250');
});

test('an id recurring in another file is one response, kept with its first session', () => {
  const dir = tmpClaudeDir({
    'projects/p/first.jsonl': turns(2, 'x'),
    'projects/p/resumed.jsonl': [...turns(2, 'x'), ...turns(1, 'y')],
  });
  const r = audit(dir);
  assert.equal(r.all.msgs, 3);
  const msgs = Object.fromEntries(r.cur.sessions.map(s => [s.sid, s.msgs]));
  assert.deepEqual(msgs, { first: 2, resumed: 1 });
});
