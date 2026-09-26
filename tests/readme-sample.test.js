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
// table byte-for-byte reproducible on any day. It does NOT make the TOKEN AUDIT header's
// window and TREND's two week-start dates reproducible — those are calendar dates derived
// from whatever day the suite happens to run on (TREND's Monday-aligned week buckets can
// even shift which bucket a fixed day-offset lands in depending on today's weekday). So
// this test normalizes dates out of both sides before comparing those two lines, and
// compares DETAIL (no dates in it) exactly.

const DAY = 86400000;

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
  const statusCheck = i => `sleep 2 && curl -s http://localhost:4000/jobs/${100 + i}/status`;
  const files = {
    // current window (last 7 days)
    'projects/demo-webapp/sess-polling.jsonl': session('poll', now - 2 * DAY, 25, 'claude-opus-5-5',
      { ctx0: 20000, step: 3000, input: 600, output: 250, spacingMs: 45000, toolCmd: statusCheck }),
    'projects/demo-webapp/sess-build.jsonl': session('build', now - 4 * DAY, 34, 'claude-sonnet-5',
      { ctx0: 6000, step: 5000, input: 1200, output: 700, spacingMs: 120000 }),
    'projects/demo-webapp/sess-quick.jsonl': session('quick', now - 6 * DAY, 9, 'claude-opus-5-5',
      { ctx0: 5000, step: 4000, input: 800, output: 400, spacingMs: 100000 }),
    // previous window (7-14 days ago) — cheaper baseline, for REGRESSION
    'projects/demo-webapp/sess-prev.jsonl': session('prev', now - 10 * DAY, 22, 'claude-opus-5-5',
      { ctx0: 3000, step: 1200, input: 500, output: 250, spacingMs: 100000 }),
    // older history, so TREND has more than one week of data
    'projects/demo-webapp/sess-w3.jsonl': session('w3', now - 17 * DAY, 14, 'claude-sonnet-5',
      { ctx0: 3000, step: 1500, input: 500, output: 300, spacingMs: 100000 }),
    'projects/demo-webapp/sess-w5.jsonl': session('w5', now - 31 * DAY, 16, 'claude-opus-5-5',
      { ctx0: 3000, step: 2000, input: 600, output: 300, spacingMs: 100000 }),
    'settings.json': { cleanupPeriodDays: 30 },
  };
  return tmpClaudeDir(files);
}

// Pulls the fenced code block under "## Sample report" out of README.md.
function readmeSampleBlock() {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const section = readme.split('## Sample report')[1];
  const fence = section.match(/```\n([\s\S]*?)```/);
  assert.ok(fence, 'README.md "Sample report" must contain a fenced code block');
  return fence[1].replace(/\n$/, '').split('\n');
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
  assert.ok(r.flags.some(f => f.id === 'CONCENTRATION'), 'fixture must also fire CONCENTRATION (shown in FLAGS)');

  // DO NEXT #1 says "55%" for REGRESSION's share of window spend.
  const regressionShare = Math.round(100 * regression.amount / r.cur.cost);
  assert.equal(regressionShare, 55);

  // DO NEXT #2 says "30%" for POLLING's share of window spend.
  const pollingShare = Math.round(100 * polling.amount / r.cur.cost);
  assert.equal(pollingShare, 30);

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
});
