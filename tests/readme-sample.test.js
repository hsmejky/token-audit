const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { audit, auditText, tmpClaudeDir } = require('./harness');

// README.md's "Sample report" shows the FULL rendered report a user sees after
// /token-audit — Claude's banner + DO NEXT on top of the script's own text — not just the
// script's raw output. Two different provenances, two different sync guarantees:
//
//   - script-printed (TOKEN AUDIT header line, TREND line, everything from DETAIL down):
//     literal script output. This test rebuilds the exact fixture below, runs the real
//     script against it and diffs those lines against README.md verbatim (mod the run's own
//     calendar date, see NOW-DEPENDENCE below) — it fails if the script's line format drifts.
//   - Claude-drawn (the banner box and the SPEND/HABIT/CONFIG/SECURITY/DO NEXT block): no
//     code renders this, so there is nothing to run and diff. Instead this test asserts the
//     *numbers* the README hand-wrote for that block against the script's real --json output
//     (flag amounts, shares, session ids) — it fails if the underlying numbers drift even
//     though no formatter would ever catch it.
//
// NOW-DEPENDENCE: the script has no way to pin "now" (no --now flag, no NOW env var — see
// docs/testing.md), so every timestamp below is built relative to Date.now() at test time,
// not a fixed calendar date. That keeps every dollar figure, share, count and the DETAIL
// table byte-for-byte reproducible on any day.
//
// It does NOT make the TOKEN AUDIT header's window dates reproducible — those are literal
// calendar dates derived from whatever day the suite happens to run on — so this test
// normalizes dates out of both sides before comparing the header line.
//
// TREND is trickier: token-audit.js buckets it into Monday-aligned, UTC calendar weeks
// (`weeks()`, day = (getUTCDay()+6)%7). A session placed at a fixed day-offset from `now`
// (e.g. "now - 6*DAY") lands in a *different* week bucket depending on what weekday `now`
// is — the offset crosses a Monday-00:00-UTC boundary on some days but not others — which
// silently changes which rows a bucket aggregates and therefore its $/msg, so the TREND
// line's numbers (not just its dates) used to drift with the weekday the suite ran on. To
// make TREND's numbers reproducible on every weekday, every session below is anchored to
// `thisMonday` (this UTC week's Monday, computed the same way the script computes it) or to
// `week(n)` (n weeks before that), not to a fixed offset from `now`:
//   - the "current window" sessions sit inside thisMonday's own week: any timestamp in
//     [thisMonday, thisMonday+7d) is *always* within the --days 7 window too (thisMonday is
//     at most 6 days before `now`, see `week()` below), so this satisfies both the window
//     filter and a single, stable TREND bucket regardless of weekday.
//   - the "previous window" session sits early in week(1) (last week), safely before
//     `curFrom` on every weekday, and the older TREND-history sessions (w3, w5) sit early in
//     week(2) and mid-week in week(4), safely before `prevFrom`/away from any bucket edge.
// week(3) is left empty on purpose — the gap that produces TREND's "(4 with data)".
//
// This was verified by patching Date.now() (both in this process and in the script's child
// process, via NODE_OPTIONS=--require) to noon UTC on each of the 7 weekdays and confirming
// the TREND line, SPEND, PER MESSAGE and the flags are byte-identical across all 7 runs. It
// isn't a mathematical guarantee for every instant (a run in the first few hours after
// Monday 00:00 UTC has a vanishingly small window where the margins above shrink toward
// zero), but it is stable for any realistic test run.

const DAY = 86400000;
const HOUR = 3600000;

function turn(id, ts, model, usage, toolCmd) {
  return { type: 'assistant', timestamp: ts, message: { id, model, role: 'assistant', usage,
    content: toolCmd ? [{ type: 'tool_use', id: `${id}-tu`, name: 'Bash', input: { command: toolCmd } }] : [] } };
}
// n turns starting at startMs, cache_read_input_tokens ramping ctx0, ctx0+step, ... (simulates
// a session's context growing turn by turn) so PER MESSAGE/HABIT's ctx figures are non-zero.
function session(prefix, startMs, n, model, { ctx0, step, input, output, spacingMs, toolCmd = null }) {
  return Array.from({ length: n }, (_, i) => turn(`${prefix}-${i}`, new Date(startMs + i * spacingMs).toISOString(),
    model, { input_tokens: input, cache_read_input_tokens: ctx0 + i * step, output_tokens: output },
    toolCmd ? toolCmd(i) : null));
}

function buildFixture() {
  const now = Date.now();
  // thisMonday: this UTC week's Monday 00:00, computed the same way token-audit.js's weeks()
  // does (day = (getUTCDay()+6)%7, Monday = 0) — see the NOW-DEPENDENCE comment above.
  const nowDate = new Date(now);
  const dow = (nowDate.getUTCDay() + 6) % 7;
  const thisMonday = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate() - dow);
  const week = n => thisMonday - n * 7 * DAY; // Monday 00:00 UTC, n weeks before this one
  const statusCheck = i => `sleep 2 && curl -s http://localhost:4000/jobs/${100 + i}/status`;
  const files = {
    // current window (last 7 days): anywhere in [thisMonday, thisMonday+7d) is always inside
    // both the --days 7 window and a single, stable TREND bucket, on any weekday.
    'projects/demo-webapp/sess-polling.jsonl': session('poll', week(0) + 3 * DAY + 9 * HOUR, 25, 'claude-opus-5-5',
      { ctx0: 20000, step: 3000, input: 600, output: 250, spacingMs: 45000, toolCmd: statusCheck }),
    'projects/demo-webapp/sess-build.jsonl': session('build', week(0) + 1 * DAY + 9 * HOUR, 34, 'claude-sonnet-5',
      { ctx0: 6000, step: 5000, input: 1200, output: 700, spacingMs: 120000 }),
    'projects/demo-webapp/sess-quick.jsonl': session('quick', week(0) + 5 * DAY + 9 * HOUR, 9, 'claude-opus-5-5',
      { ctx0: 5000, step: 4000, input: 800, output: 400, spacingMs: 100000 }),
    // previous window (7-14 days ago) — cheaper baseline, for REGRESSION. Early in week(1), well
    // before curFrom on any weekday, so it never leaks into the current window or bucket.
    'projects/demo-webapp/sess-prev.jsonl': session('prev', week(1) + 6 * HOUR, 22, 'claude-opus-5-5',
      { ctx0: 3000, step: 1200, input: 500, output: 250, spacingMs: 100000 }),
    // older history, so TREND has more than one week of data. Early in week(2), well before
    // prevFrom on any weekday, so it never leaks into the previous window's totals.
    'projects/demo-webapp/sess-w3.jsonl': session('w3', week(2) + 2 * HOUR, 14, 'claude-sonnet-5',
      { ctx0: 3000, step: 1500, input: 500, output: 300, spacingMs: 100000 }),
    // week(3) is left empty on purpose — the gap that makes TREND's "span 5 wk (4 with data)".
    // week(4) is far enough back (prevFrom never reaches past ~2 weeks) that mid-week is safe.
    'projects/demo-webapp/sess-w5.jsonl': session('w5', week(4) + 3 * DAY + 9 * HOUR, 16, 'claude-opus-5-5',
      { ctx0: 3000, step: 2000, input: 600, output: 300, spacingMs: 100000 }),
    'settings.json': { cleanupPeriodDays: 30 },
  };
  return tmpClaudeDir(files);
}

// Pulls the fenced code block under "## Sample report" out of README.md. Tolerates CRLF line
// endings (core.autocrlf=true checks README.md out with \r\n on Windows, and there's no
// .gitattributes forcing LF) the same way tests/identity.test.js:123 does, so this doesn't
// break just because of how the working tree line-ends.
function readmeSampleBlock() {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const section = readme.split('## Sample report')[1];
  const fence = section.match(/```\r?\n([\s\S]*?)```/);
  assert.ok(fence, 'README.md "Sample report" must contain a fenced code block');
  return fence[1].replace(/\r?\n$/, '').split(/\r?\n/);
}

const DATE_RE = /\d{4}-\d{2}-\d{2}/g;
const normalizeDates = s => s.replace(DATE_RE, '<date>');

test('README "Sample report": DETAIL block matches the script\'s real output exactly', () => {
  const dir = buildFixture();
  const fresh = auditText(dir, '--all', '--days', '7').replace(/\n$/, '').split('\n');
  const freshDetailIdx = fresh.findIndex(l => l === 'DETAIL');
  assert.ok(freshDetailIdx >= 0, 'fresh script output must contain a DETAIL block');
  const freshDetail = fresh.slice(freshDetailIdx);

  const sample = readmeSampleBlock();
  const sampleDetailIdx = sample.findIndex(l => l === 'DETAIL');
  assert.ok(sampleDetailIdx >= 0, 'README sample must contain a DETAIL block');
  const sampleDetail = sample.slice(sampleDetailIdx);

  // No dates in DETAIL (span is relative, "0.0d"/"<1d") — exact match, no normalization.
  // This is the part of the test that fails if the script's DETAIL line format changes.
  assert.deepEqual(sampleDetail, freshDetail,
    'README\'s DETAIL block is stale — regenerate it from the fixture in this test');
});

test('README "Sample report": TOKEN AUDIT header and TREND line match the script, dates aside', () => {
  const dir = buildFixture();
  const fresh = auditText(dir, '--all', '--days', '7').split('\n');
  const sample = readmeSampleBlock();

  const freshHeader = fresh.find(l => l.startsWith('TOKEN AUDIT'));
  const sampleHeader = sample.find(l => l.startsWith('TOKEN AUDIT'));
  assert.ok(freshHeader && sampleHeader, 'both outputs must have a TOKEN AUDIT header line');
  assert.equal(normalizeDates(sampleHeader), normalizeDates(freshHeader));

  const freshTrend = fresh.find(l => l.startsWith('TREND'));
  const sampleTrend = sample.find(l => l.startsWith('TREND'));
  assert.ok(freshTrend && sampleTrend, 'both outputs must have a TREND line');
  assert.equal(normalizeDates(sampleTrend), normalizeDates(freshTrend));
});

test('README "Sample report": the hand-drawn banner/DO NEXT numbers match the script\'s --json flags', () => {
  const dir = buildFixture();
  const r = audit(dir, '--all', '--days', '7');

  // Banner: "REGRESSION" verdict — the window's cost/message must actually be up >25%.
  const regression = r.flags.find(f => f.id === 'REGRESSION');
  assert.ok(regression, 'fixture must fire REGRESSION (banner in the sample says REGRESSION)');

  const polling = r.flags.find(f => f.id === 'POLLING');
  assert.ok(polling, 'fixture must fire POLLING (DO NEXT #2 in the sample is the poll loop)');
  // CONCENTRATION fires too, but isn't ranked into the sample's DO NEXT — which only shows
  // 2 of its top-3 slots here (REGRESSION and POLLING already tie for the highest tier, and
  // outrank CONCENTRATION's lower tier — see FLAG_TIER) — so it's asserted here for
  // completeness, not because the rendered sample shows it anywhere.
  assert.ok(r.flags.some(f => f.id === 'CONCENTRATION'), 'fixture must also fire CONCENTRATION');

  // DO NEXT #1 says "55%" for REGRESSION's share of window spend.
  const regressionShare = Math.round(100 * regression.amount / r.cur.cost);
  assert.equal(regressionShare, 55);

  // DO NEXT #1 also says "cost/msg +122% vs last window ($0.84 extra)".
  const regressionPct = Math.round(100 * (r.cur.costPerMsg / r.prev.costPerMsg - 1));
  assert.equal(regressionPct, 122);
  assert.equal(regression.amount.toFixed(2), '0.84');

  // DO NEXT #2 says "30%" for POLLING's share of window spend.
  const pollingShare = Math.round(100 * polling.amount / r.cur.cost);
  assert.equal(pollingShare, 30);

  // DO NEXT #2 also says "25x poll loop in sess-polling" — the top polling group's call count.
  assert.equal(polling.groups[0].count, 25);

  // SPEND row: "$1.52 / 7d (+585%)  Opus 40% Sonnet 60%  main 100% sub 0%"
  assert.equal(r.cur.cost.toFixed(2), '1.52');
  assert.equal(Math.round(100 * ((r.cur.byFamily.Opus || 0) / r.cur.cost)), 40);
  assert.equal(Math.round(100 * ((r.cur.byFamily.Sonnet || 0) / r.cur.cost)), 60);
  const prevToCur = Math.round(100 * (r.cur.cost / r.prev.cost - 1));
  assert.equal(prevToCur, 585);

  // HABIT row: "worst: sess-build $0.92, <1d span, 34 msgs"
  const worst = r.cur.sessions[0];
  assert.equal(worst.sid, 'sess-build');
  assert.equal(worst.cost.toFixed(2), '0.92');
  assert.equal(worst.msgs, 34);

  // HABIT row also says "ctx/msg 68k (16k)" — cur.avgCtx and prev.avgCtx, k()-rounded the
  // same way the script's own k() does ((n/1e3).toFixed(0) + 'k').
  assert.equal((r.cur.avgCtx / 1e3).toFixed(0), '68');
  assert.equal((r.prev.avgCtx / 1e3).toFixed(0), '16');
});
