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

// HITL (Slice 28): not reachable by caps/moves to DETAIL alone. With every flag
// firing, FLAGS (11) + SECURITY (3) + banner already take 15 lines; TOP SESSIONS,
// WEEKS, ALL-TIME etc. are summary sections design.md Q3 doesn't name, DETAIL is
// already at 36 of its 40-line budget, so fitting 24 means dropping or redefining
// sections — a design decision. Measured 58 lines after the list caps below.
test('summary ≤ 24 lines when every section fires at once', { todo: 'HITL: needs a design decision' }, () => {
  const out = auditText(everySection(), '--days', '7');
  const sum = summaryLines(out);
  assert.ok(sum.length <= 24, `summary is ${sum.length} lines:\n${sum.join('\n')}`);
});

// Unbounded-list caps (Slice 28): a list whose length is set by the machine's
// config/data (MCP servers, unknown models, heavy plugins) prints at most
// LIST_CAP rows in the text summary plus one `… +N more` line; --json keeps all.
const LIST_CAP = 3;
const moreLine = (lines, n) => lines.filter(l => l.includes(`+${n} more`));

test('CONFIG: 8 MCP servers print 3 rows + one "+5 more" line; --json keeps all 8', () => {
  const dir = everySection({ mcp: 8 });
  const sum = summaryLines(auditText(dir, '--days', '7'));
  assert.equal(sum.filter(l => /^ {4}server-\d/.test(l)).length, LIST_CAP, sum.join('\n'));
  assert.equal(moreLine(sum, 5).length, 1, sum.join('\n'));
  assert.equal(audit(dir, '--days', '7').config.mcpServers.length, 8);
});

test('UNPRICED: 5 unknown models print 3 rows + "+2 more" + one WARNING; --json keeps all 5', () => {
  const dir = everySection({ unknownModels: 5 });
  const sum = summaryLines(auditText(dir, '--days', '7'));
  assert.equal(sum.filter(l => /^ {2}claude-zzz-\d/.test(l)).length, LIST_CAP, sum.join('\n'));
  assert.equal(moreLine(sum, 2).length, 1, sum.join('\n'));
  assert.equal(sum.filter(l => l.includes('WARNING')).length, 1, sum.join('\n'));
  assert.equal(audit(dir, '--days', '7').unpriced.length, 5);
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
  const sum = summaryLines(auditText(dir));
  assert.equal(sum.filter(l => /^ {4}\S*plug\d/.test(l)).length, LIST_CAP, sum.join('\n'));
  assert.equal(moreLine(sum, 2).length, 1, sum.join('\n'));
  assert.equal(audit(dir).config.plugins.length, 5);
});
