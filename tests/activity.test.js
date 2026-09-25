const test = require('node:test');
const assert = require('node:assert/strict');
const { audit, auditText, tmpClaudeDir, turn } = require('./harness');
const { commandKey, shellSegments, activityCategory } = require('../plugin/skills/token-audit/scripts/token-audit.js');

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
  // a quoted value containing a space is not treated as ending after its first word
  assert.equal(commandKey("MSG='a b'; echo hi"), "MSG='a b' ; echo hi");
  assert.equal(commandKey('MSG="a b" echo hi'), 'echo hi');
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
  assert.equal(commandKey('Set-Location -Path C:\\x; git status'), 'git status');
  assert.equal(commandKey('cd /c/my dir && git status'), 'git status');
  assert.equal(commandKey('(cd /tmp && ls)'), '(ls)');
  assert.equal(commandKey('git status && (cd /tmp && ls) || echo no'), 'git status && (ls) || echo no');
});

test('commandKey: a private-use char already in the input is left alone, not turned into "undefined"', () => {
  const key = commandKey('echo "\uE010"');
  assert.ok(!key.includes('undefined'), key);
});

test('commandKey: deep (…) nesting never throws (depth-capped, not recursive)', () => {
  const s = '('.repeat(5000) + 'ls' + ')'.repeat(5000);
  assert.doesNotThrow(() => commandKey(s));
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

test('shellScan: backtick-quoted text is not split by separators inside it', () => {
  assert.deepEqual(shellSegments('echo `a && b` && git status').map(s => s.text),
    ['echo `a && b`', 'git status']);
});

test('shellScan: a backslash outside quotes escapes the next char (does not open a quote)', () => {
  // Without the escape, the \" would open a quote and swallow the real `&&` below it,
  // leaving one unsplit segment instead of two.
  assert.deepEqual(shellSegments('echo a\\"b && c').map(s => s.text), ['echo a\\"b', 'c']);
});

test('shellSegments drops empty segments from consecutive separators, keeps a trailing empty one', () => {
  assert.deepEqual(shellSegments('a;;b').map(s => [s.text, s.sep]), [['a', ';'], ['b', '']]);
  assert.deepEqual(shellSegments('a &&').map(s => [s.text, s.sep]), [['a', '&&'], ['', '']]);
});

test('hashHeredocBodies: an unterminated heredoc is still hashed, no stray sentinel leaks into the key', () => {
  const key = commandKey('cat <<EOF\nfoo\nbar');
  assert.match(key, /^cat <<EOF \[heredoc [0-9a-f]{8}\]$/, key);
  assert.ok(!key.includes('\uFFFF'), key);
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

test('turn without tool_use -> reply (Slice 15); text-only lines of a tool turn do not dilute its split', () => {
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
  assert.deepEqual({ turns: cats.reply.turns, cost: cats.reply.cost }, { turns: 1, cost: 4 });
  assert.deepEqual({ turns: cats.other.turns, cost: cats.other.cost }, { turns: 0, cost: 0 });
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
    // Review finding (Slice 15): a compound of a real git command plus a Slice 15 busy-poll
    // addition (`Get-Process`/`tasklist`) used to fall to wait/poll (BUSY_POLLERS lived inside
    // the high-priority wait/poll rule, above git) — git is the real work here, not a wait.
    [sh('git status; Get-Process'), 'git'],
    [sh('git status && tasklist'), 'git'],
    // ...but standalone (no git alongside), the busy-poll still wins over test/lint/build etc.
    [sh('Get-Process'), 'wait/poll'],
    [sh('tasklist'), 'wait/poll'],
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
    [sh('python - <<\'PY\'\nimport io\nPY'), 'script run'],
    // Review finding (Slice 15): `script run` moved below edit/read in ACTIVITY_RULES.
    // A Bash call with a `python - <<EOF … EOF` segment PLUS a real edit/read segment
    // used to classify as `script run` (that rule ran first and `.find()` picks the
    // first rule with a match anywhere in the subject, not the first segment in the
    // command) — on real data this stole ~503 read + ~284 edit calls from their true
    // categories. Now edit/read are checked first, so these compounds classify as
    // they did before Slice 15 added the `script run` rule.
    [sh('python - <<\'EOF\'\nprint(1)\nEOF\nsed -i \'s/a/b/\' out.py'), 'edit'],
    [sh('python - <<\'EOF\'\nprint(1)\nEOF\ncat out.py'), 'read'],
    // …but a bare script run with no edit/read segment alongside still wins.
    [sh('python x.py'), 'script run'],
    [['AskUserQuestion', {}], 'harness'],
    // runners behind wrappers; the runner outranks trailing pipe helpers
    [sh('python -m pytest tests/ -q 2>&1 | tail -20'), 'test/lint/build'],
    [sh('timeout 600 python3 -m pytest -x'), 'test/lint/build'],
    [sh('uv run pytest -k foo | grep -E "passed|failed"'), 'test/lint/build'],
    // interpreter options before -m (real transcripts: python -X utf8 -m pytest … | tail)
    [sh('python -X utf8 -m pytest tests/ -q | tail'), 'test/lint/build'],
    [sh('python -u -m pytest -x'), 'test/lint/build'],
    [sh('python -x -m pytest'), 'test/lint/build'],
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
    // SHOT_EXEC must not cross a command boundary into the next command
    [sh('node build.js && git add scripts/screenshot.ts'), 'git'],
    [sh('curl -s https://api.github.com/repos/o/r/actions/runs/123/jobs'), 'wait/poll'],
    // quoted env value with a space must not corrupt the segment that follows it
    [sh("( TIMEFORMAT='%R sec'; time python -m pytest )"), 'test/lint/build'],
    [['NewToolWeNeverSaw', {}], 'other'],
    // Slice 15 HITL: `script run` — a bare interpreter/script-file run, below
    // test/lint/build, git and screenshot/image (all checked earlier and win)
    [sh('python scripts/report.py --days 7'), 'script run'],
    [sh('node scripts/build.mjs'), 'script run'],
    [sh('S=/tmp/x.mjs ; node $S'), 'script run'],
    [sh('./run.sh --flag'), 'script run'],
    [sh('python -m pytest tests/'), 'test/lint/build'], // runner wrapper still wins over script run
    // Slice 15 HITL: `harness` — CC's own tools, not agent spawn / real work
    [['Skill', { skill: 'commit' }], 'harness'],
    [['ToolSearch', { query: 'x' }], 'harness'],
    [['TodoWrite', { todos: [] }], 'harness'],
  ];
  const got = cases.map(([[tool, input]]) => activityCategory(tool, input));
  assert.deepEqual(got, cases.map(c => c[1]));
});

test('script source: no inline regex modifier groups (?i:…) / (?-i:…) / (?m:…), unsupported on Node 22', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'plugin/skills/token-audit/scripts/token-audit.js'), 'utf8');
  assert.doesNotMatch(src, /\(\?-?[a-z]+:/, 'inline modifier group found — throws SyntaxError on Node < 23');
});

test('activityCategory: a long non-matching command after `ruby ` does not blow up (linear, not quadratic)', () => {
  // `ruby` is not in any rule (SCRIPT_INTERP included) — stays a genuine non-match, unlike
  // `node`, which Slice 15's `script run` rule now catches on its own.
  const command = 'ruby ' + 'x'.repeat(200000);
  const t0 = Date.now();
  const cat = activityCategory('Bash', { command });
  assert.ok(Date.now() - t0 < 1000, 'should classify a 200k-char command in well under 1s');
  assert.equal(cat, 'other');
});

test('activityCategory: `node ` script run classifies a long trailing arg in well under 1s', () => {
  const command = 'node ' + 'x'.repeat(200000);
  const t0 = Date.now();
  const cat = activityCategory('Bash', { command });
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
  assert.equal(cat, 'script run');
});

// Review finding (Slice 15): SCRIPT_INTERP's `python\S*` alternative was unbounded — it
// could cross a CMD (‣) marker into the next command, so many adjacent `‣python` runs with
// no whitespace between them forced one giant \S* match that then backtracked one char at a
// time hunting for `(?: |$)`, O(n^2) (measured ~21s on 40k reps before the fix). Fixed to
// `python[^\s‣]*`, bounded at CMD same as SCRIPT_FILE. Tested against the `script run` rule's
// own regex (`SCRIPT_INTERP`, exported test-only) rather than through `activityCategory()`:
// the `screenshot/image` rule runs first and has its own separate, still-unbounded `python\S*`
// inside SHOT_EXEC (pre-Slice-15, explicitly out of scope for this fix) that would dominate
// the timing of any input shaped to stress this one instead.
test('SCRIPT_INTERP: `python[^\\s CMD]*` stays linear on many adjacent `‣python` runs (was O(n^2) unbounded)', () => {
  const { SCRIPT_INTERP } = require('../plugin/skills/token-audit/scripts/token-audit.js');
  const CMD = '‣'; // ‣ — see markCommands()/categorize() in the script
  const re = new RegExp(`${CMD}(?:${SCRIPT_INTERP})(?: |$)`, 'i');
  const s = (CMD + 'python').repeat(40000) + '\t'; // trailing tab: never a match, forces full backtrack per start
  const t0 = Date.now();
  re.test(s);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
});

test('activityCategory: many `-X` interpreter options before -m do not blow up (linear, not quadratic)', () => {
  const command = 'python ' + '-X '.repeat(40) + '-m pytest';
  const t0 = Date.now();
  const cat = activityCategory('Bash', { command });
  assert.ok(Date.now() - t0 < 1000, 'should classify 40 `-X` flags in well under 1s');
  assert.equal(cat, 'test/lint/build');
});

test('activityCategory: many `-X val` interpreter options before -m do not blow up (linear)', () => {
  const command = 'python ' + '-X val '.repeat(40) + '-m pytest';
  const t0 = Date.now();
  const cat = activityCategory('Bash', { command });
  assert.ok(Date.now() - t0 < 1000, 'should classify 40 `-X val` flags in well under 1s');
  assert.equal(cat, 'test/lint/build');
});

test('activityCategory: many `py -3` version flags do not blow up (linear, not quadratic)', () => {
  const command = 'py ' + '-3 '.repeat(40) + '-m pytest';
  const t0 = Date.now();
  const cat = activityCategory('Bash', { command });
  assert.ok(Date.now() - t0 < 1000, 'should classify 40 `-3` flags in well under 1s');
  assert.equal(cat, 'test/lint/build');
});

// Slice 30: known pathological inputs that used to blow up the RUNNERS regex / markCommands()
// (exponential or quadratic on the old code — see PY_OPT / RUNNERS / markCommands comments).
test('activityCategory: `pnpm` + `--a ` x40 with a non-matching tail classifies in < 1s (was exponential)', () => {
  const command = 'pnpm ' + '--a '.repeat(40) + 'run foo';
  const t0 = Date.now();
  const cat = activityCategory('Bash', { command });
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
  assert.equal(cat, 'other');
});

test('activityCategory: 50k nested `(…)` in a command key processes well under 1s (was ~10s, quadratic)', () => {
  const command = '('.repeat(50000) + 'echo hi' + ')'.repeat(50000);
  const t0 = Date.now();
  activityCategory('Bash', { command });
  // 3s, not the AC's literal 1s: generous headroom against GC/scheduling noise on a loaded
  // machine while still failing hard on the old ~10s quadratic code (new code: ~150ms typical).
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`);
});

test('activityCategory: `time ` x8000 (chained WRAPPED words) processes in < 100ms (was ~0.9s)', () => {
  const command = 'time '.repeat(8000) + 'echo hi';
  const t0 = Date.now();
  activityCategory('Bash', { command });
  assert.ok(Date.now() - t0 < 100, `took ${Date.now() - t0}ms`);
});

test('activityCategory: `python -m ` x10k processes in < 200ms (was exponential)', () => {
  // Repeating `-m` isn't real python usage (it's the "run module" flag; nothing after it is
  // itself a flag), so no classification is pinned here — only that the pathological repeat
  // no longer hangs. Real single-`-m` commands are covered by the existing `-X`/`-3` tests.
  const command = 'python ' + '-m '.repeat(10000) + 'pytest';
  const t0 = Date.now();
  activityCategory('Bash', { command });
  assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0}ms`);
});

test('activityCategory: `-X -m ` x10k processes in < 200ms (was exponential)', () => {
  const command = 'python ' + '-X -m '.repeat(10000) + 'pytest';
  const t0 = Date.now();
  activityCategory('Bash', { command });
  assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0}ms`);
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
  // Slice 15 HITL added harness / script run / reply; zero-cost categories keep
  // ACTIVITY_RULES table order (stable sort) after the nonzero ones.
  assert.deepEqual(act.map(a => a.category), ['web', 'agent spawn', 'edit', 'read', 'wait/poll', 'github',
    'test/lint/build', 'git', 'harness', 'screenshot/image', 'script run', 'other', 'reply']);
  const git = byCat(act).git;
  assert.deepEqual({ ...git, cost: +git.cost.toFixed(4), share: +git.share.toFixed(4) },
    { category: 'git', turns: 1, avgCtx: 80000, cost: 4.016, share: +(4.016 / 144.24).toFixed(4) });
  assert.deepEqual(byCat(act).other, { category: 'other', turns: 0, cost: 0, avgCtx: 0, share: 0 });
});

test('no turns in the window -> one "none" line; --json lists every category at zero', () => {
  const dir = tmpClaudeDir({ 'projects/p/s1.jsonl': toolTurn('m1', [['Read', { file_path: 'a' }]]) });
  assert.ok(detailLines(auditText(dir, '--days', '1')).includes('COST BY ACTIVITY  none in this window'));
  const act = audit(dir, '--days', '1').detail.activity;
  assert.equal(act.length, 13); // Slice 15 HITL: + harness, script run, reply
  assert.ok(act.every(a => a.turns === 0 && a.cost === 0 && a.share === 0 && a.avgCtx === 0));
});
