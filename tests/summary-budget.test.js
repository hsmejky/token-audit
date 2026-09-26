const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { audit, auditText, tmpClaudeDir, tmpUserConfig } = require('./harness');
const { fitFlags, flagsMoreLine, continuedFlagLines, appendFlagsMore, familyLine, renderDetail,
  GH_POLL_MIN_CALLS } =
  require('../plugin/skills/token-audit/scripts/token-audit.js');

// Slice 28 / design decision Q3: the summary (everything above DETAIL) stays
// ≤ 24 lines. The fixture below fires every section at once: all cost flags,
// UNPRICED (several unknown models), CONFIG with many MCP servers + plugins +
// 3-model effortLevel, SECURITY.

const DAY = 864e5;
const NOW = Date.now();
const iso = ms => new Date(ms).toISOString();

// One assistant turn, optionally carrying Bash tool_use calls (one line per call).
function t(id, { ts = NOW - DAY, model = 'claude-opus-5-5', input = 200e3, commands = [] } = {}) {
  const usage = { input_tokens: 0, cache_read_input_tokens: input, output_tokens: 0 };
  const base = { type: 'assistant', timestamp: iso(ts) };
  if (!commands.length) return [{ ...base, message: { id, model, role: 'assistant', content: [], usage } }];
  return commands.map((command, i) => ({ ...base, message: { id, model, role: 'assistant', usage,
    content: [{ type: 'tool_use', id: `${id}-tu${i}`, name: 'Bash', input: { command } }] } }));
}
const many = (n, prefix, opts = {}) => Array.from({ length: n }, (_, i) => t(`${prefix}-${i}`,
  typeof opts === 'function' ? opts(i) : opts)).flat();

const CRED = String.raw`TOKEN=$(printf 'protocol=https\nhost=github.com\n' | git credential fill)`;
const credCurl = i => `${CRED} && curl -s https://api.github.com/repos/o/r/pulls/${100 + i}`;

function everySection({ mcp = 8, unknownModels = 3 } = {}) {
  const files = {
    // LONG_SESSION (≥250 msgs), POLLING (same command ≥20× in one session), GH_POLLING (Slice 31:
    // one GitHub endpoint shape ≥ GH_POLL_MIN_CALLS calls in the window, whatever that threshold is)
    'projects/C--proj-a/long.jsonl': [
      ...many(260, 'long'),
      ...many(Math.max(25, GH_POLL_MIN_CALLS), 'poll', { commands: ['gh api repos/o/r/commits/abc/check-runs'] }),
    ],
    // MULTIDAY (span >1 day)
    'projects/C--proj-a/multi.jsonl': [...t('md-0', { ts: NOW - 5 * DAY }), ...t('md-1', { ts: NOW - DAY })],
    // LONG_AGENT (subagent >150 turns)
    'projects/C--proj-a/long/subagents/agent-a1.jsonl': many(160, 'sub'),
    // REGRESSION: previous window was cheap per message
    'projects/C--proj-a/old.jsonl': many(20, 'old', { ts: NOW - 10 * DAY, input: 1e3 }),
    'settings.json': {
      enabledPlugins: { 'big@mkt': true },
      modelSettings: {
        'claude-opus-5': { effortLevel: 'high' },
        'claude-opus-5-5': { effortLevel: 'high' },
        'claude-fable-5-1': { effortLevel: 'high' },
      },
    },
    'plugins/cache/mkt/big/.claude-plugin/plugin.json': {},
  };
  // BOILERPLATE: same setup prefix in 6 sessions
  for (let s = 0; s < 6; s++) files[`projects/C--proj-a/b${s}.jsonl`] = many(2, `b${s}`, { commands: [credCurl(s)] });
  // UNPRICED: unknown models
  for (let m = 0; m < unknownModels; m++)
    files[`projects/C--proj-a/u${m}.jsonl`] = many(2, `u${m}`, { model: `claude-zzz-${m}`, input: 1e3 });
  // PLUGIN_BLOAT: 21 agent definitions
  for (let i = 0; i < 21; i++) files[`plugins/cache/mkt/big/agents/a${i}.md`] = `---\nname: a${i}\n---\nbody`;
  const dir = tmpClaudeDir(files);
  const servers = Object.fromEntries(Array.from({ length: mcp }, (_, i) => [`server-${i}`, { command: 'x' }]));
  tmpUserConfig(dir, { mcpServers: servers });
  return dir;
}

const summaryLines = out => {
  const lines = out.replace(/\n$/, '').split('\n');
  const end = lines.indexOf('DETAIL');
  return end === -1 ? lines : lines.slice(0, end);
};

// Slice 28 review, finding e: a section-scoped slice, from a header line matching
// `headerRe` up to (not including) the next blank line — so a "+N more" check
// against one section's cap line can't be satisfied by an unrelated line (a
// different section's own cap line, or free text that happens to contain the
// same digits) elsewhere in the summary.
function section(lines, headerRe) {
  const start = lines.findIndex(l => headerRe.test(l));
  if (start === -1) return [];
  const end = lines.indexOf('', start + 1);
  return lines.slice(start, end === -1 ? lines.length : end);
}

test('fixture fires every section: all cost flags, UNPRICED, MCP, 3-model effortLevel, NO_RETENTION', () => {
  const r = audit(everySection(), '--days', '7');
  const ids = r.flags.map(f => f.id).sort();
  assert.deepEqual(ids, ['BIG_CTX', 'BOILERPLATE', 'CONCENTRATION', 'GH_POLLING', 'LONG_AGENT', 'LONG_SESSION',
    'MULTIDAY', 'OPUS_HEAVY', 'PLUGIN_BLOAT', 'POLLING', 'REGRESSION'], JSON.stringify(r.flags, null, 1));
  assert.deepEqual(r.securityFlags.map(f => f.id), ['NO_RETENTION']);
  assert.equal(r.unpriced.length, 3);
  assert.equal(r.config.mcpServers.length, 8);
  assert.equal(r.config.modelEffort.length, 3);
});

// Slice 28 (design decision Q3, HITL D): CONFIG, UNPRICED and the SPEND family split
// print one line each; full lists live in --json only. With variant B (TOP
// SESSIONS dropped, WEEKS -> TREND, FLAGS top 4) the worst-case fixture fits
// the 24-line summary budget.
test('summary ≤ 24 lines when every section fires at once (with and without DETAIL)', () => {
  const out = auditText(everySection(), '--days', '7');
  const sum = summaryLines(out);
  assert.ok(sum.length <= 24, 'summary is ' + sum.length + ' lines:\n' + sum.join('\n'));
  const compact = auditText(everySection(), '--days', '7', '--no-detail').replace(/\n$/, '').split('\n');
  assert.ok(compact.length <= 24, '--no-detail is ' + compact.length + ' lines:\n' + compact.join('\n'));
  for (const l of out.split('\n')) assert.ok([...l].length <= 120, 'line over 120: ' + l);
});

test('CONFIG: one line (model, 3-model effort, plugin/mcp counts, prefix, retention); --json keeps all', () => {
  const dir = everySection({ mcp: 8 });
  const sum = summaryLines(auditText(dir, '--days', '7'));
  const cfg = section(sum, /^CONFIG /);
  assert.equal(cfg.length, 1, sum.join('\n'));
  // retention= is left out while unset (SECURITY's NO_RETENTION already says so)
  assert.match(cfg[0],
    /^CONFIG {7}model=\S.* effort=fable-5-1:high,opus-5:high,opus-5-5:high plugins=1 mcp=8 prefix≈[\d.]+k$/);
  assert.ok(!sum.some(l => /server-\d/.test(l)), sum.join('\n'));
  const json = audit(dir, '--days', '7');
  assert.equal(json.config.mcpServers.length, 8);
  assert.equal(json.config.modelEffort.length, 3);
});

test('CONFIG: no MCP servers -> no mcp= field', () => {
  const cfg = section(summaryLines(auditText(everySection({ mcp: 0 }), '--days', '7')), /^CONFIG /);
  assert.equal(cfg.length, 1);
  assert.ok(!cfg[0].includes(' mcp='), cfg[0]);
});

test('UNPRICED: one line naming what fits + "+N more (--json)"; --json keeps all 5', () => {
  const dir = everySection({ unknownModels: 5 });
  const sum = summaryLines(auditText(dir, '--days', '7'));
  const unp = section(sum, /^UNPRICED\b/);
  assert.equal(unp.length, 1, sum.join('\n'));
  assert.ok([...unp[0]].length <= 120, unp[0]);
  assert.match(unp[0], /^UNPRICED {5}5 model\(s\) [\d.]+M tok: claude-zzz-0, claude-zzz-1, /);
  assert.match(unp[0], /, \+\d more \(--json\) -- add prices to PRICES \+ REFERENCE\.md$/);
  const json = audit(dir, '--days', '7');
  assert.equal(json.unpriced.length, 5);
  assert.equal(json.unpriced[3].model, 'claude-zzz-3');
  assert.equal(json.unpriced[4].model, 'claude-zzz-4');
});

test('UNPRICED: 3 unknown models -> all named on the one line, no "more"', () => {
  const unp = section(summaryLines(auditText(everySection({ unknownModels: 3 }), '--days', '7')), /^UNPRICED\b/);
  assert.equal(unp.length, 1, unp.join('\n'));
  assert.match(unp[0], /claude-zzz-0, claude-zzz-1, claude-zzz-2 -- add/);
  assert.ok(!unp[0].includes('more'), unp[0]);
});

test('SPEND: model families on one line, then main/subagents', () => {
  const dir = tmpClaudeDir({ 'projects/p/s.jsonl': [...t('a', { model: 'claude-opus-5-5' }),
    ...t('b', { model: 'claude-fable-5-1' })] });
  const sum = summaryLines(auditText(dir));
  const i = sum.findIndex(l => l.startsWith('SPEND'));
  assert.match(sum[i + 1], /^ {2}(Opus|Fable) \$[\d.]+ [\d.]+% {3}(Opus|Fable) \$[\d.]+ [\d.]+%$/, sum.join('\n'));
  assert.match(sum[i + 2], /^ {2}main /, sum.join('\n'));
});

test('CONFIG: 5 heavy plugins -> counted on the one CONFIG line, no per-plugin rows; --json keeps all', () => {
  const files = { 'projects/p/s.jsonl': t('m1'), 'settings.json': { enabledPlugins: {} } };
  const desc = 'd'.repeat(1000);
  for (let p = 0; p < 5; p++) {
    files['settings.json'].enabledPlugins['plug' + p + '@mkt'] = true;
    files['plugins/cache/mkt/plug' + p + '/.claude-plugin/plugin.json'] = {};
  }
  const dir = tmpClaudeDir(files);
  for (let p = 0; p < 5; p++) {
    const f = path.join(dir, 'plugins/cache/mkt/plug' + p + '/agents/a.md');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '---\nname: a\ndescription: ' + desc + '\n---\nbody');
  }
  const sum = summaryLines(auditText(dir));
  const cfg = section(sum, /^CONFIG /);
  assert.equal(cfg.length, 1, sum.join('\n'));
  assert.ok(cfg[0].includes(' plugins=5 '), cfg[0]);
  assert.ok(!sum.some(l => /plug\d/.test(l)), sum.join('\n'));
  assert.equal(audit(dir).config.plugins.length, 5);
});

// Slice 28 (HITL Q-B): REGRESSION's amount is the extra cost vs the previous
// window's cost/message: cur.cost - prev.costPerMsg * cur.msgs (clamped >= 0).
test('--json flags: REGRESSION amount = extra cost vs previous cost/msg', () => {
  const r = audit(everySection(), '--days', '7');
  const reg = r.flags.find(x => x.id === 'REGRESSION');
  const want = Math.max(0, r.cur.cost - r.prev.costPerMsg * r.cur.msgs);
  assert.ok(Math.abs(reg.amount - want) < 1e-9, `${reg.amount} vs ${want}`);
  assert.ok(reg.amount < r.cur.cost, 'extra cost, not the whole window cost');
});

// Slice 28 (HITL Q-B/Q-C): summary shows the top 4 in rank order; the rest are
// named on one "+N more" line pointing at DETAIL (or --json under --no-detail).
const flagRows = lines => section(lines, /^FLAGS$/).slice(1).filter(l => /^ {2}[A-Z_]+ /.test(l))
  .map(l => l.trim().split(/\s+/)[0]);
test('summary FLAGS: top 4 by rank, "+N more" names the rest (DETAIL / --json vs --json)', () => {
  const dir = everySection();
  const r = audit(dir, '--days', '7');
  const tier0 = r.flags.filter(x => ['REGRESSION', 'POLLING', 'BOILERPLATE', 'GH_POLLING'].includes(x.id))
    .sort((a, b) => b.amount - a.amount || (a.id < b.id ? -1 : 1)).map(x => x.id); // rankFlags() order
  // Slice 31: GH_POLLING joined tier 0, so the 4 rows are all tier 0 and LONG_AGENT moves too.
  const ranked = [...tier0, 'LONG_AGENT', 'LONG_SESSION', 'MULTIDAY', 'OPUS_HEAVY', 'CONCENTRATION', 'BIG_CTX',
    'PLUGIN_BLOAT'];
  const want = ranked.slice(0, 4);
  const moved = ranked.slice(4);
  // Review finding 8: explicit assert alongside the computed `ranked` order above — tier 0
  // now has 4 members (REGRESSION/POLLING/BOILERPLATE/GH_POLLING) in this fixture, filling
  // every top-4 slot, so LONG_AGENT is pushed out to "+N more" (the comment above).
  assert.ok(!want.includes('LONG_AGENT') && moved.includes('LONG_AGENT'), want.join(','));
  const sum = summaryLines(auditText(dir, '--days', '7'));
  assert.deepEqual(flagRows(sum), want, sum.join('\n'));
  const more = `  … +${moved.length} more: ${moved.join(', ')}`;
  assert.ok(sum.includes(`${more} (DETAIL / --json)`), sum.join('\n'));
  const compact = auditText(dir, '--days', '7', '--no-detail').split('\n');
  assert.ok(compact.includes(`${more} (--json)`), compact.join('\n'));
});

// Review finding 1 (ff55682): FLAGS (continued) counts against DETAIL's 40 lines.
test('DETAIL incl. FLAGS (continued) stays <= 40 lines when every section fires', () => {
  const lines = auditText(everySection(), '--days', '7').replace(/\n$/, '').split('\n');
  const detail = lines.slice(lines.indexOf('DETAIL'));
  assert.ok(detail.length <= 40, `DETAIL is ${detail.length} lines:\n${detail.join('\n')}`);
  assert.ok(detail.some(l => l.startsWith('FLAGS (continued')), detail.join('\n'));
});

// Slice 28 review, finding 1: fitFlags() is the hard guard behind both the
// summary's FLAGS block and DETAIL's "FLAGS (continued)" — it must never hand
// back more rows (+ the "+N more" marker, if any are left over) than `room`,
// however many flags or how long their (possibly wrapped) text is. SECURITY
// itself never goes through fitFlags(); main() reserves its lines first by
// computing `room` from what SECURITY (and everything else fixed) already
// cost, so a fitFlags() that respects `room` by construction is what keeps
// SECURITY from ever being displaced.
test('fitFlags(): never exceeds room, whatever N or how many lines each item wraps to', () => {
  for (let n = 0; n <= 8; n++) {
    // mix of 1-line and artificially wrapped (2-line) synthetic flags
    const items = Array.from({ length: n }, (_, i) => ({
      id: `F${i}`, text: i % 3 === 0 ? 'word '.repeat(40) : 'short text', amount: n - i,
    }));
    for (let room = 0; room <= 10; room++) {
      const { rows, moved } = fitFlags(items, room);
      // Callers only spend a line on "+N more" when one is actually left
      // (see main()'s `flagRoom > flagRows.length` guard) — at room=0 not even
      // that fits, so nothing is printed at all.
      const total = rows.length + (moved.length && room > rows.length ? 1 : 0);
      assert.ok(total <= room, `n=${n} room=${room}: used ${total} lines (rows ${rows.length} + more?)`);
      // shown items are exactly a prefix of the ranked list; nothing is lost
      // or duplicated between rows and moved.
      const shownCount = items.length - moved.length;
      assert.deepEqual(moved, items.slice(shownCount), `n=${n} room=${room}`);
    }
  }
});

// Slice 28 review, finding 1/2: with exactly 4 (or fewer) flags and normal room,
// all show and there is no "+N more" line at all (nothing left to name).
test('fitFlags(): N <= room shows every flag, no "+N more" line', () => {
  const items = ['A', 'B', 'C', 'D'].map(id => ({ id, text: 'x', amount: 1 }));
  const { rows, moved } = fitFlags(items, 24);
  assert.equal(rows.length, 4);
  assert.equal(moved.length, 0);
});

// Slice 28 review, finding 2: with 5 flags and room for all 5, every one shows —
// summarizing the 5th as "+1 more" would cost the same one line as just
// printing it, so fitFlags() prints it instead (no pointless "+1 more").
test('fitFlags(): 5 flags with room for all 5 print all 5, not "top 4 + 1 more"', () => {
  const items = ['A', 'B', 'C', 'D', 'E'].map(id => ({ id, text: 'x', amount: 1 }));
  const { rows, moved } = fitFlags(items, 5);
  assert.equal(rows.length, 5, rows.join('\n'));
  assert.equal(moved.length, 0);
});

// Slice 28 review, finding 2: DETAIL on, but continuedFlagLines() has no room at
// all for even one flag -> the summary's "+N more" must still say "(--json)",
// not "(DETAIL / --json)" (nothing actually landed in DETAIL to point at).
test('flagsMoreLine: DETAIL on but no room for continued flags -> "(--json)" not "(DETAIL / --json)"', () => {
  const moved = ['X', 'Y'].map(id => ({ id, text: 'x', amount: 1 }));
  const contFlags = continuedFlagLines(moved, 0);
  assert.deepEqual(contFlags, []);
  assert.equal(flagsMoreLine(moved, contFlags.length > 0), '  … +2 more: X, Y (--json)');
});

// Slice 28 review, finding 2: POLLING/BOILERPLATE carry a real `amount` (the
// cost of the flagged turns) in --json, same as every other cost-driven flag.
test('--json flags: POLLING/BOILERPLATE amount = the $ figure printed in their own text', () => {
  const r = audit(everySection(), '--days', '7');
  for (const id of ['POLLING', 'BOILERPLATE']) {
    const f = r.flags.find(x => x.id === id);
    const want = Number(f.text.match(/= \$([\d.]+),/)[1]);
    assert.ok(f.amount > 0, `${id}.amount should be > 0, got ${f.amount}`);
    assert.ok(Math.abs(f.amount - want) < 0.01, `${id}: amount ${f.amount} vs text $${want}`);
  }
});

// Slice 28 re-review, finding 3: end-to-end through main() — a smaller SECURITY
// block (retention configured, so NO_RETENTION doesn't fire, "SECURITY ...
// none" is one line) leaves fitFlags() more room than a bigger one
// (NO_RETENTION's own line), so at least as many FLAGS rows show with
// retention configured as without, on the same fixture.
test('summary FLAGS: retention configured (smaller SECURITY) shows at least as many flags as unset', () => {
  const withRetention = everySection();
  const settingsPath = path.join(withRetention, 'settings.json');
  const settings = { ...JSON.parse(fs.readFileSync(settingsPath)), cleanupPeriodDays: 30 };
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  const shown = dir => flagRows(summaryLines(auditText(dir, '--days', '7')));
  const withRet = shown(withRetention);
  const withoutRet = shown(everySection());
  assert.ok(!summaryLines(auditText(withRetention, '--days', '7')).some(l => l.includes('NO_RETENTION')));
  assert.ok(summaryLines(auditText(everySection(), '--days', '7')).some(l => l.includes('NO_RETENTION')));
  assert.ok(withRet.length >= withoutRet.length,
    `retention configured showed ${withRet.length} flags, unset showed ${withoutRet.length}`);
});

// Slice 28 re-review, finding 3: renderDetail()'s own hard guard (finding 1,
// review of ff55682) — a synthetic `d` whose WORK UNITS section alone is far
// past DETAIL_MAX_LINES must be cut down to DETAIL_MAX_LINES - 1 real lines
// plus the "… DETAIL truncated" marker, never left over budget.
test('renderDetail(): a section that alone overflows DETAIL_MAX_LINES is cut with a truncation marker', () => {
  const units = Array.from({ length: 60 }, (_, i) => ({
    key: `s${i}`, project: 'p', mainCost: 1, subCost: 0, agents: 0, turns: 1, peakCtx: 1000,
    span: 0, cost: 1, subShare: 0,
  }));
  const d = { units, topSubagents: [], distribution: { count: 0 }, activity: [] };
  const lines = renderDetail(d);
  assert.equal(lines.length, 40, lines.join('\n'));
  assert.equal(lines[lines.length - 1], '… DETAIL truncated, full data in --json');
});

// Slice 28 re-review, finding 3: familyLine(cur) returns null for a window
// with no byFamily entries (Slice 28 review, finding 3 in the source) — main()
// must skip the line entirely rather than print a blank one.
test('familyLine(cur) === null for an empty byFamily map, and main() prints no family line', () => {
  assert.equal(familyLine({ byFamily: {}, cost: 0 }), null);
  // A transcript exists (so main() doesn't bail on "no transcripts found"),
  // but it's 10 years outside the default window, so `cur` (the window) has
  // no cost and an empty byFamily, while `all` (all-time) still isn't empty.
  const dir = tmpClaudeDir({ 'projects/p/old.jsonl': t('old', { ts: NOW - 3650 * DAY }) });
  const sum = summaryLines(auditText(dir, '--days', '7'));
  const i = sum.findIndex(l => l.startsWith('SPEND'));
  assert.ok(i !== -1, sum.join('\n'));
  // The line right after SPEND is the main/subagents split, not a family line
  // (no "  <ModelName> $" line in between).
  assert.match(sum[i + 1], /^ {2}main /, sum.join('\n'));
});

// Slice 28 re-review, finding 6: appendFlagsMore() is the exact function
// main() calls after fitFlags() to decide the "+N more" marker — exercised
// here with room=0 (what flagRoom clamps to when preLen + postLen + 1 exceeds
// SUMMARY_MAX_LINES, an artificially large pre/post main() itself never
// builds today) to prove the marker still shows instead of a dangling header.
test('appendFlagsMore(): still names moved flags when flagRoom was clamped to 0 (huge pre/post)', () => {
  const items = ['A', 'B', 'C'].map(id => ({ id, text: 'x', amount: 1 }));
  const { rows, moved } = fitFlags(items, 0); // room=0 <=> preLen + postLen + 1 >= SUMMARY_MAX_LINES
  assert.deepEqual(rows, []);
  assert.deepEqual(moved, items);
  const flagRows = appendFlagsMore(rows, moved, false);
  assert.deepEqual(flagRows, ['  … +3 more: A, B, C (--json)']);
});
