const test = require('node:test');
const assert = require('node:assert/strict');
const { rankFlags, flagLines, flagsMoreLine, continuedFlagLines, trendLine, sparkline } =
  require('../plugin/skills/token-audit/scripts/token-audit.js');

// Design decision Q-B (docs/decisions.md): FLAGS rank by extra cost where that decision
// defines one (REGRESSION, POLLING, BOILERPLATE, GH_POLLING: tier 0, by $ desc), then a fixed
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

// AC 5 (docs/roadmap.md "Docs & fun"): a block-character sparkline, printed inline in the
// TREND line by the script itself, not as a separate line.
test('sparkline: scaling — evenly spaced values hit every level low to high', () => {
  assert.equal(sparkline([0, 1, 2, 3, 4, 5, 6, 7]), '▁▂▃▄▅▆▇█');
  assert.equal(sparkline([0, 10]), '▁█');
  assert.equal(sparkline([10, 0]), '█▁');
});

test('sparkline: flat series (no variation) -> one mid-level bar per point, not a crash', () => {
  assert.equal(sparkline([5, 5, 5]), '▄▄▄');
  assert.equal(sparkline([0, 0, 0]), '▄▄▄'); // all-zero is flat too, not a divide-by-zero
});

test('sparkline: empty -> empty string (no bars, no crash)', () => {
  assert.equal(sparkline([]), '');
});

test('sparkline: single point -> one bar, same flat treatment as a flat series', () => {
  assert.equal(sparkline([0.5]), '▄');
});

test('trendLine: multi-week output carries a sparkline inline, no extra line', () => {
  const l = trendLine([wk('2026-08-31', 0.05), wk('2026-09-07', 0.10), wk('2026-09-14', 0.20),
    wk('2026-09-21', 0.12)]);
  assert.ok(!l.includes('\n'), l);
  assert.match(l, /^TREND {8}[▁▂▃▄▅▆▇█]+ /);
});

test('trendLine: single week also carries a one-bar sparkline inline', () => {
  const l = trendLine([wk('2026-09-21', 0.12)]);
  assert.match(l, /^TREND {8}[▁▂▃▄▅▆▇█] /);
});

test('trendLine: no data -> no sparkline at all', () => {
  assert.equal(trendLine([]), 'TREND        no data');
});

// Review finding: withSpark() used to scale the shown bars against just the trailing slice it
// renders, not the full series — a flat run at the tail of a series with a wide overall range
// printed unchanged mid-level bars instead of the lowest level. These extract the bar run from
// TREND's sparkline (everything between the label and the first plain-text field) to check it.
const sparkOf = line => line.match(/^TREND {8}([▁▂▃▄▅▆▇█]+) /)[1];
const weeklyDates = (n, start = '2026-01-05') => Array.from({ length: n }, (_, i) => {
  const d = new Date(Date.parse(`${start}T00:00:00Z`) + i * 7 * 86400000);
  return d.toISOString().slice(0, 10);
});

test('withSpark: a flat low tail after a high spike shows the lowest level, not a flat mid bar', () => {
  const dates = weeklyDates(20);
  const wks = dates.map((d, i) => wk(d, i < 8 ? 1.00 : 0.01));
  const bars = sparkOf(trendLine(wks));
  assert.equal(bars, '▁'.repeat(bars.length));
  assert.ok(bars.length >= 1, bars);
});

test('withSpark: never shows more than MAX_SPARK_POINTS (12) bars, whatever the history length', () => {
  const dates = weeklyDates(60);
  const wks = dates.map((d, i) => wk(d, (i % 7) + 1));
  const bars = sparkOf(trendLine(wks));
  assert.ok(bars.length <= 12, bars.length);
});

const SPARK_LEVELS_FOR_TEST = '▁▂▃▄▅▆▇█';
test('withSpark: shows the most recent weeks, scaled against the full series (not the tail alone)', () => {
  const dates = weeklyDates(20);
  const wks = dates.map((d, i) => wk(d, i)); // costPerMsg 0..19, monotonically increasing
  const bars = sparkOf(trendLine(wks));
  const n = bars.length;
  const tail = Array.from({ length: n }, (_, i) => 20 - n + i); // the last n week indices, in order
  const expected = tail.map(v => SPARK_LEVELS_FOR_TEST[Math.round((v - 0) / (19 - 0) * 7)]).join('');
  assert.equal(bars, expected);
});

test('trendLine: sparkline never pushes the line over the 120-char budget, however much history', () => {
  // A long span, many weeks with data, and large costPerMsg swings (wide money() output) —
  // the worst case for the fixed 120-char line budget.
  const wks = Array.from({ length: 60 }, (_, i) => {
    const d = new Date(Date.UTC(2020, 0, 1 + i * 7));
    return wk(d.toISOString().slice(0, 10), i % 2 ? 12.34 : 0.5);
  });
  const l = trendLine(wks);
  assert.ok([...l].length <= 120, `line is ${[...l].length} chars:\n${l}`);
});
