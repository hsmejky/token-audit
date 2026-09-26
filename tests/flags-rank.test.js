const test = require('node:test');
const assert = require('node:assert/strict');
const { rankFlags, flagLines, flagsMoreLine, continuedFlagLines, trendLine } =
  require('../plugin/skills/token-audit/scripts/token-audit.js');

// Slice 28 (design decision Q-B, docs/decisions.md): FLAGS rank by extra cost where that decision
// defines one (REGRESSION, POLLING, BOILERPLATE: tier 0, by $ desc), then a fixed
// priority for flags whose $ is only the flagged spend ($ = tie-break within a
// tier): LONG_AGENT > LONG_SESSION, MULTIDAY > OPUS_HEAVY, CONCENTRATION >
// BIG_CTX, PLUGIN_BLOAT > CLEAN.
const f = (id, amount = 0, text = 'x') => ({ id, text, amount });

test('rankFlags: extra-cost flags first by $, then fixed priority with $ as tie-break', () => {
  const fl = [f('BIG_CTX'), f('CONCENTRATION', 50), f('OPUS_HEAVY', 90), f('LONG_AGENT', 10),
    f('REGRESSION', 5), f('POLLING', 8), f('MULTIDAY', 30), f('LONG_SESSION', 40), f('PLUGIN_BLOAT'),
    f('BOILERPLATE', 1)];
  assert.deepEqual(rankFlags(fl).map(x => x.id), ['POLLING', 'REGRESSION', 'BOILERPLATE', 'LONG_AGENT',
    'LONG_SESSION', 'MULTIDAY', 'OPUS_HEAVY', 'CONCENTRATION', 'BIG_CTX', 'PLUGIN_BLOAT']);
  // does not mutate the caller's (--json) order
  assert.equal(fl[0].id, 'BIG_CTX');
});

test('rankFlags: a huge OPUS_HEAVY $ does not jump the fixed priority (it is not extra cost)', () => {
  assert.deepEqual(rankFlags([f('OPUS_HEAVY', 1e6), f('LONG_AGENT', 1)]).map(x => x.id),
    ['LONG_AGENT', 'OPUS_HEAVY']);
});

test('flagsMoreLine: names the moved IDs and where to find them', () => {
  const moved = [f('PLUGIN_BLOAT'), f('BIG_CTX'), f('MULTIDAY')];
  assert.equal(flagsMoreLine(moved, true), '  … +3 more: PLUGIN_BLOAT, BIG_CTX, MULTIDAY (DETAIL / --json)');
  assert.equal(flagsMoreLine(moved, false), '  … +3 more: PLUGIN_BLOAT, BIG_CTX, MULTIDAY (--json)');
  assert.equal(flagsMoreLine([], true), null);
});

test('flagsMoreLine: a long ID list is cut to fit 120 chars', () => {
  const moved = Array.from({ length: 20 }, (_, i) => f(`SOME_LONG_ID_${i}`));
  const line = flagsMoreLine(moved, true);
  assert.ok([...line].length <= 120, line);
  assert.match(line, /^ {2}… \+20 more: SOME_LONG_ID_0, .*, … \(DETAIL \/ --json\)$/);
});

test('continuedFlagLines: everything fits -> header + one line per flag, no "more" line', () => {
  const moved = [f('A'), f('B'), f('C')];
  const out = continuedFlagLines(moved, 4);
  assert.equal(out.length, 4);
  assert.match(out[0], /^FLAGS \(continued/);
  assert.ok(!out.some(l => l.includes('more:')));
});

test('continuedFlagLines: short on room -> as many as fit + "+N more: IDs (--json)", never over room', () => {
  const out = continuedFlagLines([f('A'), f('B'), f('C')], 3);
  assert.equal(out.length, 3);
  assert.equal(out[2], '  … +2 more: B, C (--json)');
});

test('continuedFlagLines: a wrapped (2-line) flag counts as 2 lines; no room -> nothing', () => {
  const long = f('A', 0, 'word '.repeat(30).trim());
  assert.equal(flagLines(long).length, 2);
  assert.deepEqual(continuedFlagLines([long, f('B')], 3), []);
  assert.deepEqual(continuedFlagLines([f('A')], 1), []);
  assert.deepEqual(continuedFlagLines([], 10), []);
});

// Review finding 8: TREND for 0/1 week, zero costs, sign, and the span wording.
const wk = (week, costPerMsg) => ({ week, sessions: 1, cost: costPerMsg * 10, avgCtx: 0, costPerMsg });

test('trendLine: no weeks -> "no data"', () => {
  assert.equal(trendLine([]), 'TREND        no data');
});

test('trendLine: one week -> no "W → W", no % change', () => {
  const l = trendLine([wk('2026-09-21', 0.12)]);
  assert.ok(!l.includes('→'), l);
  assert.ok(!l.includes('%'), l);
  assert.match(l, /2026-09-21/);
  assert.match(l, /only/);
});

test('trendLine: span counts calendar weeks first..last, plus how many had data; sign on change', () => {
  const up = trendLine([wk('2026-09-07', 0.10), wk('2026-09-21', 0.12)]);
  assert.match(up, /2026-09-07 .* → 2026-09-21 .*\+20%/);
  assert.match(up, /span 3 wk \(2 with data\)/);
  const down = trendLine([wk('2026-09-14', 0.10), wk('2026-09-21', 0.05)]);
  assert.match(down, / -50%/);
  assert.match(down, /span 2 wk \(2 with data\)/);
});

test('trendLine: zero first-week cost -> n/a instead of a % (no divide by zero)', () => {
  const l = trendLine([wk('2026-09-14', 0), wk('2026-09-21', 0.1)]);
  assert.match(l, /n\/a/);
  assert.ok(!/Infinity|NaN/.test(l), l);
});
