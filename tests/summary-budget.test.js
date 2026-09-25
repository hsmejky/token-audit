const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { audit, auditText, tmpClaudeDir, tmpUserConfig } = require('./harness');

// plan.md Slice 28 / design.md Q3: the summary (everything above DETAIL) stays
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
    // LONG_SESSION (≥250 msgs), POLLING (same command ≥20× in one session)
    'projects/C--proj-a/long.jsonl': [
      ...many(260, 'long'),
      ...many(25, 'poll', { commands: ['gh api repos/o/r/commits/abc/check-runs'] }),
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
  assert.deepEqual(ids, ['BIG_CTX', 'BOILERPLATE', 'CONCENTRATION', 'LONG_AGENT', 'LONG_SESSION', 'MULTIDAY',
    'OPUS_HEAVY', 'PLUGIN_BLOAT', 'POLLING', 'REGRESSION'], JSON.stringify(r.flags, null, 1));
  assert.deepEqual(r.securityFlags.map(f => f.id), ['NO_RETENTION']);
  assert.equal(r.unpriced.length, 3);
  assert.equal(r.config.mcpServers.length, 8);
  assert.equal(r.config.modelEffort.length, 3);
});

// HITL (Slice 28, variant B — design.md Q3): TOP SESSIONS dropped, WEEKS -> one
// TREND line, and FLAGS capped to the top FLAGS_SUMMARY_CAP (4) by dollar amount
// close most of the gap (58 -> 37 lines with FLAGS capped to 0), but do not reach
// 24 on this worst-case fixture: with every flag capped away entirely (0 shown)
// the summary still measures 37 lines, all from CONFIG (3-model effortLevel + 8
// MCP servers), UNPRICED, and the other fixed-width sections variant B did not
// touch. Real `--all --days 3650` data (4 `byFamily` rows, no MCP/plugin config)
// measures 33. Meeting 24 needs a design decision beyond variant B's three
// changes (see design.md Q3 "Open (not resolved by variant B)") -> still HITL.
test('summary ≤ 24 lines when every section fires at once', { todo: 'HITL: needs a design decision' }, () => {
  const out = auditText(everySection(), '--days', '7');
  const sum = summaryLines(out);
  assert.ok(sum.length <= 24, `summary is ${sum.length} lines:\n${sum.join('\n')}`);
});

// Unbounded-list caps (Slice 28): a list whose length is set by the machine's
// config/data (MCP servers, unknown models, heavy plugins) prints at most
// LIST_CAP rows in the text summary plus one `… +N more` line; --json keeps all.
const LIST_CAP = 3;
// Exact text of the shared cap line printCapped() emits (MCP servers, UNPRICED
// models, plugin rows) — matched verbatim, not a loose `includes()`, so it can't
// be satisfied by unrelated text that happens to contain the same "+N more"
// digits (e.g. the UNPRICED WARNING line's own "(+N more, see rows above /
// --json)" aside, a different phrase entirely). Indent varies by caller: '  '
// for UNPRICED, '    ' for CONFIG's plugin/MCP-server rows.
const CAP_MORE = (n, indent = '  ') => `${indent}… +${n} more (full list in --json)`;
const moreLine = (lines, n, indent) => lines.filter(l => l === CAP_MORE(n, indent));

test('CONFIG: 8 MCP servers print 3 rows + one "+5 more" line; --json keeps all 8', () => {
  const dir = everySection({ mcp: 8 });
  const sum = summaryLines(auditText(dir, '--days', '7'));
  const cfg = section(sum, /^CONFIG$/);
  assert.equal(cfg.filter(l => /^ {4}server-\d/.test(l)).length, LIST_CAP, sum.join('\n'));
  assert.equal(moreLine(cfg, 5, '    ').length, 1, sum.join('\n'));
  assert.equal(audit(dir, '--days', '7').config.mcpServers.length, 8);
});

// Boundary (Slice 28 review, finding d): exactly at the cap prints no "more"
// line at all; one over the cap prints exactly "+1 more".
test('CONFIG: exactly 3 MCP servers -> no "more" line', () => {
  const dir = everySection({ mcp: 3 });
  const cfg = section(summaryLines(auditText(dir, '--days', '7')), /^CONFIG$/);
  assert.equal(cfg.filter(l => /^ {4}server-\d/.test(l)).length, 3, cfg.join('\n'));
  assert.equal(cfg.filter(l => l.includes('more')).length, 0, cfg.join('\n'));
});

test('CONFIG: 4 MCP servers -> 3 rows + exactly "+1 more"', () => {
  const dir = everySection({ mcp: 4 });
  const cfg = section(summaryLines(auditText(dir, '--days', '7')), /^CONFIG$/);
  assert.equal(cfg.filter(l => /^ {4}server-\d/.test(l)).length, LIST_CAP, cfg.join('\n'));
  assert.equal(moreLine(cfg, 1, '    ').length, 1, cfg.join('\n'));
});

test('UNPRICED: 5 unknown models print 3 rows + "+2 more" + one WARNING naming models; --json keeps all 5', () => {
  const dir = everySection({ unknownModels: 5 });
  const sum = summaryLines(auditText(dir, '--days', '7'));
  const unp = section(sum, /^UNPRICED\b/);
  assert.equal(unp.filter(l => /^ {2}claude-zzz-\d/.test(l)).length, LIST_CAP, sum.join('\n'));
  assert.equal(moreLine(unp, 2).length, 1, sum.join('\n'));
  assert.equal(unp.filter(l => l.includes('WARNING')).length, 1, sum.join('\n'));
  // Slice 28 review, finding a: the WARNING now names models (not silent);
  // check it actually names the first 3 (within budget for this fixture).
  const warning = unp.find(l => l.includes('WARNING'));
  assert.match(warning, /claude-zzz-0.*claude-zzz-1.*claude-zzz-2/);
  const json = audit(dir, '--days', '7');
  assert.equal(json.unpriced.length, 5);
  // Slice 28 review, finding d: check the actual names of items 4 and 5, not
  // just the array length — a bug that dropped or reordered them would still
  // pass a length-only check.
  assert.equal(json.unpriced[3].model, 'claude-zzz-3');
  assert.equal(json.unpriced[4].model, 'claude-zzz-4');
});

// Boundary (Slice 28 review, finding d): exactly at the cap prints no "more"
// line; one over prints exactly "+1 more". --json keeps every entry either way.
test('UNPRICED: exactly 3 unknown models -> no "more" line', () => {
  const dir = everySection({ unknownModels: 3 });
  const unp = section(summaryLines(auditText(dir, '--days', '7')), /^UNPRICED\b/);
  assert.equal(unp.filter(l => /^ {2}claude-zzz-\d/.test(l)).length, 3, unp.join('\n'));
  assert.equal(unp.filter(l => l.includes('more')).length, 0, unp.join('\n'));
});

test('UNPRICED: 4 unknown models -> 3 rows + exactly "+1 more"; --json item 4 named', () => {
  const dir = everySection({ unknownModels: 4 });
  const unp = section(summaryLines(auditText(dir, '--days', '7')), /^UNPRICED\b/);
  assert.equal(unp.filter(l => /^ {2}claude-zzz-\d/.test(l)).length, LIST_CAP, unp.join('\n'));
  assert.equal(moreLine(unp, 1).length, 1, unp.join('\n'));
  const json = audit(dir, '--days', '7');
  assert.equal(json.unpriced.length, 4);
  assert.equal(json.unpriced[3].model, 'claude-zzz-3');
});

test('CONFIG: 5 plugins over the 200-tok row threshold print 3 rows + one "+2 more" line', () => {
  const files = { 'projects/p/s.jsonl': t('m1'), 'settings.json': { enabledPlugins: {} } };
  const desc = 'd'.repeat(1000);
  for (let p = 0; p < 5; p++) {
    files['settings.json'].enabledPlugins[`plug${p}@mkt`] = true;
    files[`plugins/cache/mkt/plug${p}/.claude-plugin/plugin.json`] = {};
  }
  const dir = tmpClaudeDir(files);
  // tmpClaudeDir JSON-encodes non-array content; agent .md files need raw text.
  for (let p = 0; p < 5; p++) {
    const f = path.join(dir, `plugins/cache/mkt/plug${p}/agents/a.md`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `---\nname: a\ndescription: ${desc}\n---\nbody`);
  }
  const cfg = section(summaryLines(auditText(dir)), /^CONFIG$/);
  assert.equal(cfg.filter(l => /^ {4}\S*plug\d/.test(l)).length, LIST_CAP, cfg.join('\n'));
  assert.equal(moreLine(cfg, 2, '    ').length, 1, cfg.join('\n'));
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
  const tier0 = r.flags.filter(x => ['REGRESSION', 'POLLING', 'BOILERPLATE'].includes(x.id))
    .sort((a, b) => b.amount - a.amount).map(x => x.id);
  const want = [...tier0, 'LONG_AGENT'];
  const moved = ['LONG_SESSION', 'MULTIDAY', 'OPUS_HEAVY', 'CONCENTRATION', 'BIG_CTX', 'PLUGIN_BLOAT'];
  const sum = summaryLines(auditText(dir, '--days', '7'));
  assert.deepEqual(flagRows(sum), want, sum.join('\n'));
  const more = `  … +6 more: ${moved.join(', ')}`;
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
