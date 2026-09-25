const test = require('node:test');
const assert = require('node:assert/strict');
const { audit, auditText, tmpClaudeDir, turn } = require('./harness');
const { commandKey, shellSegments, activityCategory } = require('../skills/token-audit/scripts/token-audit.js');

// One API response that makes tool calls, as Claude Code writes it: one JSONL
// line per content part (here one per tool_use), all sharing message.id + usage.
// Each call is [name, input]. input_tokens 1M on Opus 5.5 = $4 per turn.
const USAGE = { input_tokens: 1e6, output_tokens: 0 };
function toolTurn(id, calls, { usage = USAGE, ts = '2026-09-01T10:00:00.000Z' } = {}) {
  return calls.map(([name, input], i) => ({
    type: 'assistant', timestamp: ts,
    message: { id, model: 'claude-opus-5-5', role: 'assistant', usage,
      content: [{ type: 'tool_use', id: `${id}-tu${i}`, name, input }] },
  }));
}
const byCat = activity => Object.fromEntries(activity.map(a => [a.category, a]));

test('commandKey: check-runs polling on different PR numbers, behind `cd x &&`, gives the same key', () => {
  const url = pr => `https://api.github.com/repos/o/r/pulls/${pr}/check-runs`;
  const a = commandKey(`cd /c/Users/me/proj && curl -s ${url(123)}`);
  const b = commandKey(`cd "C:\\Users\\me\\proj-2" && curl -s ${url(456)}`);
  assert.equal(a, b);
  assert.equal(a, 'curl -s https://api.github.com/repos/o/r/pulls/N/check-runs');
});

test('commandKey strips env-var prefixes but keeps a standalone assignment (BOILERPLATE needs it)', () => {
  assert.equal(commandKey('PYTHONIOENCODING=utf-8 CI=1 pnpm vitest run'), 'pnpm vitest run');
  assert.equal(commandKey('NODE_OPTIONS="--max-old-space-size=4096" node x.js'), 'node x.js');
  const cred = 'TOKEN=$(printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill | ' +
    'sed -n \'s/^password=//p\')';
  const key = commandKey(cred + '; curl -s x');
  assert.ok(key.startsWith('TOKEN=$(printf'), key);
});

test('commandKey replaces quoted paths and hex/uuid ids, keeps other quoted text', () => {
  const win = 'tail -2 "C:\\Users\\x\\tasks\\b5nj.output"';
  assert.equal(commandKey(win), commandKey("tail -5 '/tmp/other file.log'"));
  assert.equal(commandKey(win), 'tail -N <path>');
  assert.equal(commandKey('git show 3b046aa --stat'), commandKey('git show 5039300ab --stat'));
  assert.equal(commandKey('git show 3b046aa --stat'), 'git show <id> --stat');
  assert.equal(commandKey('ls tasks/9f3a1c2e-7b44-4a90-9e21-6f5d8c3b0a17'), 'ls tasks/<id>');
  assert.equal(commandKey('grep -n "deadbeef" x'), 'grep -n "deadbeef" x',
    'quoted non-path text and pure-letter hex words stay');
  assert.notEqual(commandKey('grep -n "foo" a'), commandKey('grep -n "bar" a'));
});

test('commandKey: a heredoc body becomes a short stable hash — distinct bodies, distinct keys', () => {
  const py = body => commandKey(`python - <<'PY'\n${body}\nPY\n`);
  const a = py('import io\nprint(1)');
  assert.match(a, /^python - <<'PY' \[heredoc [0-9a-f]{8}\]$/);
  assert.equal(py('import io\nprint(1)'), a, 'same body -> same key');
  assert.notEqual(py('import re\nprint(re)'), a);
  const commit = msg => commandKey(`git add -A && git commit -F - <<'EOF'\n${msg}\nEOF`);
  assert.notEqual(commit('feat: a'), commit('fix: b'));
  assert.match(commandKey('cat > x.ts <<EOF\nlet a = 1;\nEOF\ngit add x.ts'),
    /^cat > x\.ts <<EOF \[heredoc [0-9a-f]{8}\] ; git add x\.ts$/);
  assert.match(commandKey('cat <<-EOF\n\tx\n\tEOF\ngit status'), / ; git status$/,
    '<<- closing tag may be tab-indented');
});

test('commandKey keeps sed -n line ranges (reading a file in chunks is not a repeated command)', () => {
  assert.notEqual(commandKey("sed -n '1,80p' src/a.ts"), commandKey("sed -n '81,160p' src/a.ts"));
  assert.equal(commandKey('sed -n 120,180p src/a.ts'), 'sed -n 120,180p src/a.ts');
  assert.equal(commandKey('tail -5 a.log'), commandKey('tail -20 a.log'), 'other numbers still -> N');
});

test('commandKey drops cd / Set-Location segments anywhere; an env prefix never spans a newline', () => {
  const key = commandKey('SCR="/c/x/s.mjs"\ncd /c/r\nnode $SCR');
  assert.equal(key, 'SCR=<path> ; node $SCR');
  assert.equal(commandKey('Set-Location C:\\r; git status'), 'git status');
  assert.equal(commandKey('Set-Location "C:\\Users\\x"\ngit status'), 'git status');
  assert.equal(commandKey('git status && cd /c/other && ls'), 'git status && ls');
  assert.equal(commandKey('pnpm build && CI=1 pnpm test'), 'pnpm build && pnpm test');
});

test('commandKey / shellSegments: separators inside quotes and $(…) are not split or respaced', () => {
  assert.equal(commandKey('grep -E "error|git" log'), 'grep -E "error|git" log');
  assert.equal(commandKey("rg 'foo;gh api' src"), "rg 'foo;gh api' src");
  assert.equal(commandKey('git commit -m "a\nb" && git push'), 'git commit -m "a b" && git push');
  const cred = 'TOKEN=$(printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill | ' +
    'sed -n \'s/^password=//p\')';
  const segs = shellSegments(commandKey(`${cred}\ncurl -s -H "Authorization: token $TOKEN" x`));
  assert.deepEqual(segs.map(s => s.sep), [';', '']);
  assert.equal(segs[0].text, cred, 'first segment = the whole $(…) assignment (BOILERPLATE prefix)');
  assert.deepEqual(shellSegments('a&&b|c;d||e').map(s => [s.text, s.sep]),
    [['a', '&&'], ['b', '|'], ['c', ';'], ['d', '||'], ['e', '']]);
});

test('commandKey collapses whitespace, spaces separators canonically', () => {
  assert.equal(commandKey('a&&b|c;d||e'), 'a && b | c ; d || e');
  assert.equal(commandKey('pnpm   test \\\n  2>&1 |grep  -E x'), 'pnpm test N>&N | grep -E x');
  assert.equal(commandKey('for f in a b\ndo\n  wc -l $f\n\ndone\n'), 'for f in a b ; do ; wc -l $f ; done');
  assert.equal(commandKey('wc -l <<< abc\ngit status\nabc'), 'wc -l <<< abc ; git status ; abc',
    'here-string is not a heredoc');
  assert.equal(commandKey('cd /c/r\ngit status'), 'git status');
  assert.equal(commandKey('grep -n x "docs/plan.md"'), 'grep -n x <path>');
});

test('turn with 2 tool calls (git + Read) splits its cost 50/50', () => {
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': toolTurn('m1', [['Bash', { command: 'git status --short' }],
                                           ['Read', { file_path: 'C:/x/a.js' }]]),
  });
  const cats = byCat(audit(dir).detail.activity);
  assert.equal(cats.git.cost, 2);
  assert.equal(cats.read.cost, 2);
  assert.equal(cats.git.share, 0.5);
  assert.equal(cats.read.share, 0.5);
  // Text: fractional turns shown rounded, below one as `<1` (never 0 next to a cost); zero-turn categories: no row.
  const lines = auditText(dir).split('\n');
  const h = lines.findIndex(l => l.startsWith('COST BY ACTIVITY'));
  const rows = lines.slice(h + 2).filter(l => l.startsWith('  '));
  assert.equal(rows.length, 2, rows.join('\n'));
  assert.match(rows[0], /^\s+git\s+<1\s+0k\s+\$2\.00\s+50\.0%$/);
});

test('turn without tool_use -> other; text-only lines of a tool turn do not dilute its split', () => {
  const thinking = { type: 'assistant', timestamp: '2026-09-01T10:00:00.000Z', message: { id: 'm2',
    model: 'claude-opus-5-5', role: 'assistant', usage: USAGE, content: [{ type: 'thinking', thinking: '' }] } };
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': [
      ...turn({ id: 'm1', usage: USAGE }),
      thinking,
      ...toolTurn('m2', [['Edit', { file_path: 'a.js' }], ['Bash', { command: 'git diff' }]]),
      ...toolTurn('m2', [['Edit', { file_path: 'a.js' }]]), // same tool_use id seen again: counted once
    ],
  });
  const act = audit(dir).detail.activity;
  const cats = byCat(act);
  assert.deepEqual({ turns: cats.other.turns, cost: cats.other.cost }, { turns: 1, cost: 4 });
  assert.deepEqual({ turns: cats.edit.turns, cost: cats.edit.cost }, { turns: 0.5, cost: 2 });
  assert.deepEqual({ turns: cats.git.turns, cost: cats.git.cost }, { turns: 0.5, cost: 2 });
  assert.equal(act.reduce((a, c) => a + c.turns, 0), 2, 'turns sum to deduped turn count');
});

test('avg ctx of a category weights each turn by its share of the turn: Σ(w·ctx) / Σw', () => {
  const ctx = n => ({ input_tokens: 1e6, cache_read_input_tokens: n, output_tokens: 0 });
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': [
      ...toolTurn('m1', [['Bash', { command: 'git status' }], ['Read', { file_path: 'a' }]], { usage: ctx(100000) }),
      ...toolTurn('m2', [['Bash', { command: 'git diff' }]], { usage: ctx(10000) }),
    ],
  });
  const cats = byCat(audit(dir).detail.activity);
  // git: w 0.5 @ 100k + w 1 @ 10k -> 60k / 1.5 = 40k (not 110k / 1.5)
  assert.equal(cats.git.turns, 1.5);
  assert.equal(Math.round(cats.git.avgCtx), 40000);
  assert.equal(Math.round(cats.read.avgCtx), 100000);
});

test('activityCategory: one example per category, first matching rule wins', () => {
  const sh = command => ['Bash', { command }];
  const cases = [
    [sh('cd /c/r && git add -A && git commit -q -F - <<\'EOF\'\nfeat: x\nEOF'), 'git'],
    [['PowerShell', { command: 'git status --short' }], 'git'],
    [sh('cd /c/r && pnpm test 2>&1 | grep -E "Tests |FAIL"; git log --oneline -3'), 'test/lint/build'],
    [sh('npx prettier --check . 2>&1 | tail -1'), 'test/lint/build'],
    [sh('node --test tests/'), 'test/lint/build'],
    [sh('curl -s -H "Authorization: Bearer $T" https://api.github.com/repos/o/r/pulls'), 'github'],
    [sh('git push -u origin s11 && gh pr create --fill'), 'github'],
    [sh('curl -s https://api.github.com/repos/o/r/commits/abc1234/check-runs'), 'wait/poll'],
    [sh('for i in $(seq 1 40); do gh pr checks 12; sleep 30; done'), 'wait/poll'],
    [sh('for f in a b; do git add $f; done'), 'git'],
    [['Monitor', { command: 'x' }], 'wait/poll'],
    [['Read', { file_path: 'C:/x/src/a.ts' }], 'read'],
    [['Grep', { pattern: 'x' }], 'read'],
    [sh('sed -n 1,80p tokens.test.ts | grep -n PAR'), 'read'],
    [sh('cat -n src/a.ts'), 'read'],
    [['Edit', { file_path: 'a.ts' }], 'edit'],
    [['Write', { file_path: 'a.ts' }], 'edit'],
    [sh("sed -i 's/a/b/' a.ts"), 'edit'],
    [sh("cat > a.ts <<'EOF'\nx\nEOF"), 'edit'],
    [['Agent', { description: 'x', prompt: 'y' }], 'agent spawn'],
    [['SendMessage', { to: 'a', message: 'y' }], 'agent spawn'],
    [['Read', { file_path: 'C:/tmp/shot.PNG' }], 'screenshot/image'],
    [sh('for p in a b; do node scripts/screenshot.mjs "d/$p.html" "d/$p.png" --dpr 2; done'), 'screenshot/image'],
    [['mcp__playwright__browser_take_screenshot', {}], 'screenshot/image'],
    [sh('ls docs/screenshots/ && cat docs/screenshots/notes.md'), 'read'],
    [sh('git add docs/screenshots/a.png'), 'git'],
    [sh('grep -rn "git log" src/ | head'), 'read'],
    [sh('grep -n "pnpm test" package.json'), 'read'],
    [sh('test -f a.txt && echo yes'), 'other'],
    [['WebFetch', { url: 'https://x', prompt: 'y' }], 'web'],
    [['WebSearch', { query: 'y' }], 'web'],
    [sh('python - <<\'PY\'\nimport io\nPY'), 'other'],
    [['AskUserQuestion', {}], 'other'],
    // runners behind wrappers; the runner outranks trailing pipe helpers
    [sh('python -m pytest tests/ -q 2>&1 | tail -20'), 'test/lint/build'],
    [sh('timeout 600 python3 -m pytest -x'), 'test/lint/build'],
    [sh('uv run pytest -k foo | grep -E "passed|failed"'), 'test/lint/build'],
    // interpreter options before -m (real transcripts: python -X utf8 -m pytest … | tail)
    [sh('python -X utf8 -m pytest tests/ -q | tail'), 'test/lint/build'],
    [sh('python -u -m pytest -x'), 'test/lint/build'],
    [sh('py -3 -m pytest -x'), 'test/lint/build'],
    [sh('py -3.11 -m pytest -x'), 'test/lint/build'],
    [sh('pnpm --filter web test'), 'test/lint/build'],
    [sh('cargo test --all 2>&1 | head -50'), 'test/lint/build'],
    [sh('npx vitest run'), 'test/lint/build'],
    // separators inside quotes are not command starts
    [sh('grep -E "error|git" log'), 'read'],
    [sh('rg "foo;gh api" src'), 'read'],
    // screenshot = running a screenshot script, not touching the file
    [sh('cat scripts/screenshot.mjs'), 'read'],
    [sh('git log -- scripts/screenshot.mjs'), 'git'],
    [['Write', { file_path: 'scripts/screenshot.mjs' }], 'edit'],
    [sh('grep -n "page.screenshot(" src/a.ts'), 'read'],
    [sh('./scripts/screenshot.sh out.png'), 'screenshot/image'],
    [sh('timeout 60 node scripts/screenshot.mjs a.html'), 'screenshot/image'],
    [sh('curl -s https://api.github.com/repos/o/r/actions/runs/123/jobs'), 'wait/poll'],
    [['NewToolWeNeverSaw', {}], 'other'],
  ];
  const got = cases.map(([[tool, input]]) => activityCategory(tool, input));
  assert.deepEqual(got, cases.map(c => c[1]));
});

test('activityCategory: a long non-matching command after `node ` does not blow up (linear, not quadratic)', () => {
  const command = 'node ' + 'x'.repeat(200000);
  const t0 = Date.now();
  const cat = activityCategory('Bash', { command });
  assert.ok(Date.now() - t0 < 1000, 'should classify a 200k-char command in well under 1s');
  assert.equal(cat, 'other');
});

// Lines of the DETAIL block (from the DETAIL header to end of output).
const detailLines = out => {
  const lines = out.split('\n');
  const i = lines.indexOf('DETAIL');
  return i < 0 ? [] : lines.slice(i).filter(l => l.trim());
};

// 8 categories with distinct turn counts: web 8 turns ... git 1 turn, $4 each.
const EIGHT = [['WebFetch', { url: 'u' }], ['Agent', {}], ['Edit', { file_path: 'a' }], ['Read', { file_path: 'a' }],
  ['Monitor', {}], ['Bash', { command: 'gh pr view' }], ['Bash', { command: 'pnpm test' }],
  ['Bash', { command: 'git log' }]];
const eightCategoryDir = () => tmpClaudeDir({
  'projects/p/s1.jsonl': EIGHT.flatMap((call, c) =>
    Array.from({ length: 8 - c }, (_, i) => toolTurn(`c${c}-${i}`, [call], {
      usage: { input_tokens: 1e6, cache_read_input_tokens: 10000 * (c + 1), output_tokens: 0 } })).flat()),
});

test('DETAIL prints the top 6 categories by cost: category, turns, avg ctx, cost, share', () => {
  const detail = detailLines(auditText(eightCategoryDir()));
  const h = detail.findIndex(l => l.startsWith('COST BY ACTIVITY'));
  assert.ok(h > 0, `expected a COST BY ACTIVITY section, got:\n${detail.join('\n')}`);
  assert.match(detail[h + 1], /category\s+turns\s+avg ctx\s+cost\s+share/);
  const rows = detail.slice(h + 2, h + 8);
  assert.deepEqual(rows.map(l => l.trim().split(/\s{2,}/)[0]),
    ['web', 'agent spawn', 'edit', 'read', 'wait/poll', 'github']);
  assert.ok(!detail.slice(h + 8).some(l => /^\s+(test\/lint\/build|git)\s/.test(l)), 'only 6 rows');
  // web: 8 turns x $4.002 (1M input + 10k cache read on Opus 5.5) = $32.0; total $144.24
  assert.match(rows[0], /^\s+web\s+8\s+10k\s+\$32\.0\s+22\.2%$/, rows[0]);
  assert.match(rows[5], /^\s+github\s+3\s+60k\s+\$12\.0\s+8\.3%$/, rows[5]);
});

test('--json detail.activity: every category (zeros included), with turns / avgCtx / cost / share', () => {
  const act = audit(eightCategoryDir()).detail.activity;
  assert.deepEqual(act.map(a => a.category), ['web', 'agent spawn', 'edit', 'read', 'wait/poll', 'github',
    'test/lint/build', 'git', 'screenshot/image', 'other']);
  const git = byCat(act).git;
  assert.deepEqual({ ...git, cost: +git.cost.toFixed(4), share: +git.share.toFixed(4) },
    { category: 'git', turns: 1, avgCtx: 80000, cost: 4.016, share: +(4.016 / 144.24).toFixed(4) });
  assert.deepEqual(byCat(act).other, { category: 'other', turns: 0, cost: 0, avgCtx: 0, share: 0 });
});

test('no turns in the window -> one "none" line; --json lists every category at zero', () => {
  const dir = tmpClaudeDir({ 'projects/p/s1.jsonl': toolTurn('m1', [['Read', { file_path: 'a' }]]) });
  assert.ok(detailLines(auditText(dir, '--days', '1')).includes('COST BY ACTIVITY  none in this window'));
  const act = audit(dir, '--days', '1').detail.activity;
  assert.equal(act.length, 10);
  assert.ok(act.every(a => a.turns === 0 && a.cost === 0 && a.share === 0 && a.avgCtx === 0));
});
