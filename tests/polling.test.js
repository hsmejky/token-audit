const test = require('node:test');
const assert = require('node:assert/strict');
const { audit, auditText, tmpClaudeDir } = require('./harness');
const { redactPaths } = require('../plugin/skills/token-audit/scripts/token-audit.js');

// plan.md Slice 12 / design.md Q9: POLLING = the same normalized command
// (commandKey) >= POLL_MIN_CALLS (10, Slice 15 HITL decision) times in one session.
// Only commands whose repeat is a wait count (not test/lint/build, git, edit):
// see REFERENCE.md "POLLING".

// One assistant turn with Bash calls, one JSONL line per tool_use, shared message.id.
// input_tokens 1M on Opus 5.5 = $4 per turn.
const USAGE = { input_tokens: 1e6, output_tokens: 0 };
function bashTurn(id, commands, usage = USAGE) {
  return commands.map((command, i) => ({
    type: 'assistant', timestamp: '2026-09-01T10:00:00.000Z',
    message: { id, model: 'claude-opus-5-5', role: 'assistant', usage,
      content: [{ type: 'tool_use', id: `${id}-tu${i}`, name: 'Bash', input: { command } }] },
  }));
}
// n one-call turns; cmd(i) gives the i-th command.
const bashTurns = (n, prefix, cmd, usage) =>
  Array.from({ length: n }, (_, i) => bashTurn(`${prefix}-${i}`, [cmd(i)], usage)).flat();
const checkRuns = i => `cd /c/Users/me/proj && curl -s https://api.github.com/repos/o/r/pulls/${100 + i}/check-runs`;
const CHECK_KEY = 'curl -s https://api.github.com/repos/o/r/pulls/N/check-runs';
const pollingFlags = r => r.flags.filter(f => f.id === 'POLLING');

test('POLLING: 25 check-runs calls on different PR numbers in one session fire once, count 25', () => {
  const r = audit(tmpClaudeDir({ 'projects/p/s1.jsonl': bashTurns(25, 't', checkRuns) }));
  const fl = pollingFlags(r);
  assert.equal(fl.length, 1, JSON.stringify(r.flags));
  assert.equal(fl[0].groups.length, 1);
  assert.equal(fl[0].groups[0].count, 25);
  assert.equal(fl[0].groups[0].key, CHECK_KEY);
});

test('POLLING: exactly 10 calls in one session fire (>= boundary), 9 do not', () => {
  const at = n => pollingFlags(audit(tmpClaudeDir({ 'projects/p/s1.jsonl': bashTurns(n, 't', checkRuns) })));
  assert.equal(at(10).length, 1, '10 calls must fire');
  assert.equal(at(9).length, 0, '9 calls must not fire');
});

test('POLLING: 25 calls spread over 5 sessions (5 each) do not fire — the count is per session', () => {
  const files = {};
  for (let s = 0; s < 5; s++) files[`projects/p/s${s}.jsonl`] = bashTurns(5, `s${s}`, checkRuns);
  assert.equal(pollingFlags(audit(tmpClaudeDir(files))).length, 0);
});

test('POLLING: a subagent session counts on its own, not merged with its parent', () => {
  // 5 + 5 = 10 would fire if wrongly merged (>= POLL_MIN_CALLS); kept separate, neither
  // session alone reaches 10.
  const r = audit(tmpClaudeDir({
    'projects/p/main.jsonl': bashTurns(5, 'm', checkRuns),
    'projects/p/main/subagents/agent-a.jsonl': bashTurns(5, 'a', checkRuns),
  }));
  assert.equal(pollingFlags(r).length, 0);
});

test('POLLING: two polled commands in one session → one flag, both groups, worst first', () => {
  const actions = i => `curl -s https://api.github.com/repos/o/r/actions/runs/${900 + i}`;
  const r = audit(tmpClaudeDir({
    'projects/p/s1.jsonl': [...bashTurns(21, 'a', actions), ...bashTurns(25, 'c', checkRuns)],
  }));
  const fl = pollingFlags(r);
  assert.equal(fl.length, 1);
  assert.deepEqual(fl[0].groups.map(g => g.count), [25, 21]);
});

test('POLLING: flag text has command key, count and cost share; a multi-call turn gives 1/n of its cost', () => {
  // 24 one-call turns ($4 each) + 1 turn with the poll and one `ls` ($4, half to the poll)
  // = 25 calls, $98 polling; plus 10 `git status` turns ($40). Window $140 → 70%.
  const r = audit(tmpClaudeDir({
    'projects/p/s1.jsonl': [
      ...bashTurns(24, 't', checkRuns),
      ...bashTurn('mix', [checkRuns(99), 'ls']),
      ...bashTurns(10, 'g', () => 'git status'),
    ],
  }));
  const [f] = pollingFlags(r);
  assert.ok(f, JSON.stringify(r.flags));
  assert.equal(f.groups[0].count, 25);
  assert.equal(+f.groups[0].cost.toFixed(6), 98);
  assert.equal(+f.groups[0].share.toFixed(6), 0.7);
  assert.match(f.text, /^1 run\(s\) ≥10×\/session = \$98\.0, 70% of spend; top 25× /);
  assert.ok(f.text.endsWith('check-runs'), f.text);
  assert.ok(f.text.includes('curl -s https://api.git'), f.text);
});

test('POLLING: shares add up over several runs; worst = most expensive run', () => {
  // run A: 30 calls at $1 (250k input) = $30; run B: 20 calls at $4 = $80 → B is worst by
  // cost though A has more calls. Plus 10 `git status` turns ($40). Window $150:
  // runs $110 = 73% (B alone would be 53%).
  const r = audit(tmpClaudeDir({
    'projects/p/a.jsonl': bashTurns(30, 'a', checkRuns, { input_tokens: 250000, output_tokens: 0 }),
    'projects/p/b.jsonl': [
      ...bashTurns(20, 'b', () => 'tail -5 /tmp/x.log'),
      ...bashTurns(10, 'g', () => 'git status'),
    ],
  }));
  const [f] = pollingFlags(r);
  assert.deepEqual(f.groups.map(g => g.count), [20, 30]);
  assert.match(f.text, /^2 run\(s\) ≥10×\/session = \$110, 73% of spend; top 20× tail -N /);
});

test('POLLING: repeats whose category is the work itself (test/lint/build, git, edit) do not fire', () => {
  for (const cmd of [
    i => `cd /c/r && python -m pytest tests/ -q 2>&1 | tail -${i % 9 + 1}`, // TDD loop
    () => 'git status',
    i => `sed -i 's/a/b${i}/' src/x.ts`,
  ]) {
    const r = audit(tmpClaudeDir({ 'projects/p/s1.jsonl': bashTurns(25, 't', cmd) }));
    assert.equal(pollingFlags(r).length, 0, `${cmd(1)} → ${JSON.stringify(r.flags)}`);
  }
});

test('POLLING: waits, status checks, log tails and other repeated commands do fire', () => {
  for (const cmd of [
    () => 'sleep 30',                                    // wait/poll
    i => `gh pr view ${i} --json state`,                 // github
    () => String.raw`tail -5 "C:\tmp\tasks\b5nj.output"`, // read: tailing a background task
    i => `echo waiting-${i}`,                            // other
  ]) {
    const r = audit(tmpClaudeDir({ 'projects/p/s1.jsonl': bashTurns(25, 't', cmd) }));
    assert.equal(pollingFlags(r).length, 1, `${cmd(1)} → ${JSON.stringify(r.flags)}`);
  }
});

// Slice 15 HITL busy-polls, real data: `echo waiting-N`/`echo idle-check-N`, `tasklist`,
// `Get-Process` — added to BUSY_POLLERS so a repeated busy-poll counts as wait/poll instead
// of falling to `other`/`read`. Kept in their own lower-priority rule (below git) — see
// "POLLING: git wins over a bare busy-poll" below for why.
test('POLLING: new Slice 15 busy-poll commands (echo waiting/idle, tasklist, Get-Process) fire on their own', () => {
  for (const cmd of [
    i => `echo waiting-${i}`,
    i => `echo idle-check-${i}`,
    () => String.raw`tasklist //FI "IMAGENAME eq python.exe"`,
    () => 'Get-Process python -ErrorAction SilentlyContinue',
  ]) {
    const r = audit(tmpClaudeDir({ 'projects/p/s1.jsonl': bashTurns(25, 't', cmd) }));
    assert.equal(pollingFlags(r).length, 1, `${cmd(1)} → ${JSON.stringify(r.flags)}`);
  }
});

// Review finding (Slice 15): `script run` (a bare `python foo.py` re-run while iterating) is
// deliberately excluded from POLL_CATEGORIES (§4 slice15-proposal.md) — it is work, not a
// wait. 10 is POLL_MIN_CALLS itself (the boundary), so this also confirms the category
// exclusion, not just the threshold, is what keeps it from firing.
test('POLLING: `python x.py` repeated 10x (script run) does not fire — script run is not a poll category', () => {
  const r = audit(tmpClaudeDir({ 'projects/p/s1.jsonl': bashTurns(10, 't', () => 'python x.py') }));
  assert.equal(pollingFlags(r).length, 0, JSON.stringify(r.flags));
});

// Slice 15 fix (re-review, BLOCKER): before the CMD_PIPE fix, `python x.py 2>&1 | tail -20`
// classified as `read` (the read rule's READERS alt matched the piped-in `tail`, and read is
// checked before script run) — `read` IS a POLL_CATEGORIES member, so 10 piped re-runs of the
// same script while iterating used to fire POLLING as a false positive. Now the whole compound
// is `script run` (READERS only matches a `|`-free command start), which is excluded from
// POLL_CATEGORIES, same as the bare `python x.py` case above.
test('POLLING: piped script re-run (`python x.py 2>&1 | tail -N`) x10 does not fire', () => {
  const r = audit(tmpClaudeDir({
    'projects/p/s1.jsonl': bashTurns(10, 't', i => `python x.py 2>&1 | tail -${i % 9 + 1}`),
  }));
  assert.equal(pollingFlags(r).length, 0, JSON.stringify(r.flags));
});

// Slice 15 fix (re-review): a compound of real work (`git status`) plus a Slice 15 busy-poll
// addition (`Get-Process`) must not fire POLLING — `git status; Get-Process` classifies as
// `git` (real work wins, see activity.test.js), and `git` is not a POLL_CATEGORIES member.
test('POLLING: `git status; Get-Process` repeated Nx does not fire', () => {
  const r = audit(tmpClaudeDir({
    'projects/p/s1.jsonl': bashTurns(12, 't', () => 'git status; Get-Process'),
  }));
  assert.equal(pollingFlags(r).length, 0, JSON.stringify(r.flags));
});

test('POLLING: only shell commands count — 25 Read calls of one file do not fire', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    type: 'assistant', timestamp: '2026-09-01T10:00:00.000Z',
    message: { id: `r-${i}`, model: 'claude-opus-5-5', role: 'assistant', usage: USAGE,
      content: [{ type: 'tool_use', id: `r-${i}-tu`, name: 'Read', input: { file_path: '/tmp/x.log' } }] },
  }));
  assert.equal(pollingFlags(audit(tmpClaudeDir({ 'projects/p/s1.jsonl': rows }))).length, 0);
});

test('POLLING: no path (user name) is printed — unquoted paths in the key become <path>; line ≤ 120', () => {
  const cmds = [
    i => `O=/c/Users/jdoe/AppData/Local/Temp/x/scratchpad; for i in $(seq 1 ${i}); do sleep 30; done`,
    () => '{ cd /home/jdoe/proj; tail -5 build.log; }',      // cd kept by commandKey inside { }
    () => '(cd /home/jdoe/proj && tail -5 x.log) 2>&1',   // …and in a group with a redirect
    () => String.raw`type C:\Users\jdoe\proj\out.log`,
    () => 'tail -f ~/proj-jdoe/x.log',
  ];
  for (const cmd of cmds) {
    const dir = tmpClaudeDir({ 'projects/p/s1.jsonl': bashTurns(25, 't', cmd) });
    const [f] = pollingFlags(audit(dir));
    assert.ok(f, cmd(1));
    assert.ok(!/jdoe/.test(f.text) && !/jdoe/.test(f.groups[0].key), `${cmd(1)} → ${f.text}`);
    assert.match(f.text, /<path>/, f.text);
    const line = auditText(dir, '--no-detail').split('\n').find(l => l.startsWith('  POLLING'));
    assert.ok(line && [...line].length <= 120, `${[...(line || '')].length}: ${line}`);
  }
});

test('POLLING: a long key is cut in the middle — program and endpoint both stay visible', () => {
  const cmd = i => `curl -s -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" ` +
    `https://api.github.com/repos/some-org/some-long-repository-name/commits/${i}abc/check-runs`;
  const dir = tmpClaudeDir({ 'projects/p/s1.jsonl': bashTurns(25, 't', cmd) });
  const line = auditText(dir, '--no-detail').split('\n').find(l => l.startsWith('  POLLING'));
  assert.equal([...line].length, 120, line);
  assert.match(line, /top 25× curl -s -H .*….*\/check-runs$/, line);
});

test('POLLING: one subagent id under two parents is two sessions (5 + 5 calls do not fire)', () => {
  const r = audit(tmpClaudeDir({
    'projects/p/m1/subagents/agent-a.jsonl': bashTurns(5, 'x', checkRuns),
    'projects/p/m2/subagents/agent-a.jsonl': bashTurns(5, 'y', checkRuns),
  }));
  assert.equal(pollingFlags(r).length, 0, JSON.stringify(r.flags));
});

test('POLLING: same subagent id under two parents, both ≥10× — groups[].parent tells them apart', () => {
  const r = audit(tmpClaudeDir({
    'projects/p/m1/subagents/agent-a.jsonl': bashTurns(20, 'x', checkRuns),
    'projects/p/m2/subagents/agent-a.jsonl': bashTurns(20, 'y', checkRuns),
  }));
  const [f] = pollingFlags(r);
  assert.ok(f, JSON.stringify(r.flags));
  assert.equal(f.groups.length, 2);
  assert.equal(f.groups[0].sid, f.groups[1].sid, 'same subagent id in both groups');
  assert.notEqual(f.groups[0].parent, f.groups[1].parent, 'different parent must distinguish the groups');
  assert.deepEqual(new Set(f.groups.map(g => g.parent)), new Set(['m1', 'm2']));
});

// Review finding 1: redactPaths() missed several places a path can start, and
// let an email through untouched. One test per case.
test('POLLING: redirect target (>) does not leak a user name', () => {
  const [f] = pollingFlags(audit(tmpClaudeDir({
    'projects/p/s1.jsonl': bashTurns(25, 't', i => `echo x${i} >/c/Users/jdoe/out.log`),
  })));
  assert.ok(f);
  assert.ok(!/jdoe/.test(f.groups[0].key), f.groups[0].key);
  assert.match(f.groups[0].key, /<path>/);
});

test('POLLING: stderr redirect (2>) does not leak a user name', () => {
  const [f] = pollingFlags(audit(tmpClaudeDir({
    'projects/p/s1.jsonl': bashTurns(25, 't', i => `echo x${i} 2>/home/jdoe/err.log`),
  })));
  assert.ok(f);
  assert.ok(!/jdoe/.test(f.groups[0].key), f.groups[0].key);
  assert.match(f.groups[0].key, /<path>/);
});

test('POLLING: @-file argument (curl -d @path) does not leak a user name', () => {
  const [f] = pollingFlags(audit(tmpClaudeDir({
    'projects/p/s1.jsonl': bashTurns(25, 't', i => `curl -d @/c/Users/jdoe/body${i}.json https://api.example.com/x`),
  })));
  assert.ok(f);
  assert.ok(!/jdoe/.test(f.groups[0].key), f.groups[0].key);
  assert.match(f.groups[0].key, /<path>/);
});

test('POLLING: env-var-prefixed PATH assignment (NAME=$VAR:/path) does not leak a user name', () => {
  const [f] = pollingFlags(audit(tmpClaudeDir({
    'projects/p/s1.jsonl': bashTurns(25, 't', () => 'PATH=$PATH:/home/jdoe/bin'),
  })));
  assert.ok(f);
  assert.ok(!/jdoe/.test(f.groups[0].key), f.groups[0].key);
  assert.match(f.groups[0].key, /<path>/);
});

test('POLLING: scp-style host:/path target does not leak a user name', () => {
  const [f] = pollingFlags(audit(tmpClaudeDir({
    'projects/p/s1.jsonl': bashTurns(25, 't', i => `scp host:/home/jdoe/x${i}`),
  })));
  assert.ok(f);
  assert.ok(!/jdoe/.test(f.groups[0].key), f.groups[0].key);
  assert.match(f.groups[0].key, /<path>/);
});

test('POLLING: file:// URL does not leak a user name (unlike http(s), which stays readable)', () => {
  const [f] = pollingFlags(audit(tmpClaudeDir({
    'projects/p/s1.jsonl': bashTurns(25, 't', i => `curl file:///home/jdoe/x${i}`),
  })));
  assert.ok(f);
  assert.ok(!/jdoe/.test(f.groups[0].key), f.groups[0].key);
  assert.match(f.groups[0].key, /<path>/);
});

test('POLLING: http(s) URL stays readable (not redacted)', () => {
  const [f] = pollingFlags(audit(tmpClaudeDir({
    'projects/p/s1.jsonl': bashTurns(25, 't', checkRuns),
  })));
  assert.ok(f);
  assert.match(f.groups[0].key, /^curl -s https:\/\/api\.github\.com\//);
});

test('POLLING: ~/file shorthand (one separator) does not leak a user name', () => {
  const [f] = pollingFlags(audit(tmpClaudeDir({
    'projects/p/s1.jsonl': bashTurns(25, 't', () => 'cat ~/jdoe.log'),
  })));
  assert.ok(f);
  assert.ok(!/jdoe/.test(f.groups[0].key), f.groups[0].key);
  assert.match(f.groups[0].key, /<path>/);
});

test('POLLING: ~user shorthand does not leak a user name', () => {
  const [f] = pollingFlags(audit(tmpClaudeDir({
    'projects/p/s1.jsonl': bashTurns(25, 't', () => 'ls ~jdoe/x/y'),
  })));
  assert.ok(f);
  assert.ok(!/jdoe/.test(f.groups[0].key), f.groups[0].key);
  assert.match(f.groups[0].key, /<path>/);
});

test('POLLING: quoted Windows path with a space in the user name does not leak the surname', () => {
  const [f] = pollingFlags(audit(tmpClaudeDir({
    'projects/p/s1.jsonl': bashTurns(25, 't', i => `echo "see C:\\Users\\Petr Svarc\\x${i}"`),
  })));
  assert.ok(f);
  assert.ok(!/Svarc/.test(f.groups[0].key), f.groups[0].key);
  assert.match(f.groups[0].key, /<path>/);
});

test('POLLING: an email address is redacted to <email>', () => {
  const [f] = pollingFlags(audit(tmpClaudeDir({
    'projects/p/s1.jsonl': bashTurns(25, 't', () => 'curl -u jdoe@gmail.com:$T https://api.example.com/x'),
  })));
  assert.ok(f);
  assert.ok(!/jdoe@gmail\.com/.test(f.groups[0].key), f.groups[0].key);
  assert.match(f.groups[0].key, /<email>/);
});

// Re-review finding 1: EMAIL was O(n^2) on a long unbroken [\w.+-] run (no '@' or a
// pathological one) — `\b` let the alternation restart at every non-word char inside
// the run. The (?<![\w.+-]) lookbehind anchors matching to run starts, making it O(n).
test('POLLING: redactPaths is fast on a 200k-char run of "." (no email)', () => {
  const s = 'a.'.repeat(100000);
  const t0 = Date.now();
  redactPaths(s);
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0}ms`);
});

test('POLLING: redactPaths is fast on a 200k-char run of "-" (no email)', () => {
  const s = 'a-'.repeat(100000);
  const t0 = Date.now();
  redactPaths(s);
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0}ms`);
});

test('POLLING: redactPaths is fast on a 200k-char dotted run ending in "@" (email-shaped)', () => {
  const s = 'x.'.repeat(99999) + 'x@';
  const t0 = Date.now();
  redactPaths(s);
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0}ms`);
});

// Re-review finding 2: a path whose name segment has a space, in several shapes.
test('POLLING: escaped-space forward-slash Users path does not leak the surname', () => {
  const [f] = pollingFlags(audit(tmpClaudeDir({
    'projects/p/s1.jsonl': bashTurns(25, 't', () => String.raw`cat /c/Users/Petr\ Svarc/x`),
  })));
  assert.ok(f);
  assert.ok(!/Svarc/.test(f.groups[0].key), f.groups[0].key);
  assert.match(f.groups[0].key, /<path>/);
});

test('POLLING: escaped-space Windows-backslash Users path does not leak the surname', () => {
  const [f] = pollingFlags(audit(tmpClaudeDir({
    'projects/p/s1.jsonl': bashTurns(25, 't', () => String.raw`type C:\Users\Petr\ Svarc\x`),
  })));
  assert.ok(f);
  assert.ok(!/Svarc/.test(f.groups[0].key), f.groups[0].key);
  assert.match(f.groups[0].key, /<path>/);
});

test('POLLING: quoted forward-slash Users path with a literal space does not leak the surname', () => {
  const [f] = pollingFlags(audit(tmpClaudeDir({
    'projects/p/s1.jsonl': bashTurns(25, 't', () => 'echo "see /c/Users/Petr Svarc/x"'),
  })));
  assert.ok(f);
  assert.ok(!/Svarc/.test(f.groups[0].key), f.groups[0].key);
  assert.match(f.groups[0].key, /<path>/);
});

test('POLLING: lowercase drive/users root is redacted case-insensitively', () => {
  const [f] = pollingFlags(audit(tmpClaudeDir({
    'projects/p/s1.jsonl': bashTurns(25, 't', () => String.raw`type c:\users\Petr Svarc\x`),
  })));
  assert.ok(f);
  assert.ok(!/Svarc/.test(f.groups[0].key), f.groups[0].key);
  assert.match(f.groups[0].key, /<path>/);
});

test('POLLING: unquoted Windows path with a space in the user name does not leak the surname', () => {
  const [f] = pollingFlags(audit(tmpClaudeDir({
    'projects/p/s1.jsonl': bashTurns(25, 't', () => String.raw`echo C:\Users\Petr Svarc\x`),
  })));
  assert.ok(f);
  assert.ok(!/Svarc/.test(f.groups[0].key), f.groups[0].key);
  assert.match(f.groups[0].key, /<path>/);
});

test('POLLING: redactPaths does not swallow a trailing pipe after a Windows-users path', () => {
  const out = redactPaths(String.raw`echo C:\Users\jdoe | tee out.log`);
  assert.ok(!/jdoe/.test(out), out);
  assert.match(out, /\| tee out\.log$/, out);
});

test('POLLING: assignment, key:value and flag=value pairs are not over-redacted', () => {
  for (const cmd of ['echo a=b', 'echo key:value', 'echo -o=json']) {
    const [f] = pollingFlags(audit(tmpClaudeDir({ 'projects/p/s1.jsonl': bashTurns(25, 't', () => cmd) })));
    assert.ok(f, cmd);
    assert.ok(!/<path>|<email>/.test(f.groups[0].key), `${cmd} -> ${f.groups[0].key}`);
  }
});

// Re-review round 3. Generic (pattern) layer — tested with an empty identity so the
// value layer below can't mask a pattern gap, whoever runs the tests.
const NO_ID = {};
const genericLeaks = [
  ['forward-slash drive path with escaped space', String.raw`node C:/Users/Petr\ Svarc/x.js`, /Svarc/],
  ['WSL /mnt/c path with escaped space', String.raw`ls /mnt/c/Users/Petr\ Svarc/x`, /Svarc/],
  ['PATH=$PATH:/home/... with escaped space', String.raw`PATH=$PATH:/home/Petr\ Svarc/bin`, /Svarc/],
  ['scp host:/home/... with escaped space', String.raw`scp host:/home/Petr\ Svarc/x`, /Svarc/],
  ['doubled-backslash Windows path', 'cat C:\\\\Users\\\\jdoe\\\\x', /jdoe/],
  ['upper-case Windows root', String.raw`type C:\USERS\Petr Svarc\x`, /Svarc/],
  ['upper-case git-bash root', 'cat /C/USERS/Petr Svarc/x', /Svarc/],
  ['upper-case /HOME root', 'cat /HOME/jdoe/x', /jdoe/],
];
for (const [what, cmd, leak] of genericLeaks) {
  test(`POLLING: redactPaths generic layer — ${what} does not leak the name`, () => {
    const out = redactPaths(cmd, NO_ID);
    assert.ok(!leak.test(out), out);
    assert.match(out, /<path>/, out);
  });
}

test('POLLING: redactPaths generic layer keeps http(s) URLs, a=b, key:value, -o=json', () => {
  const cmds = ['curl -s https://api.github.com/repos/o/r/pulls/1', 'echo a=b', 'echo key:value', 'echo -o=json'];
  for (const cmd of cmds) {
    assert.equal(redactPaths(cmd, NO_ID), cmd);
  }
});

// Value layer: the current user's own name parts are redacted to <user> wherever
// they appear, in any spelling or case. Identity is injected here.
const PETR = { username: 'psvarc', home: String.raw`C:\Users\Petr Svarc`, name: 'Petr Svarc' };
test('POLLING: value layer — Claude project folder form (C--Users-Petr-Svarc-…) loses both name parts', () => {
  const out = redactPaths('ls C--Users-Petr-Svarc-token-audit', PETR);
  assert.ok(!/Petr|Svarc/.test(out), out);
  assert.match(out, /<user>/);
});

test('POLLING: value layer — a name part outside any path shape, any case, is redacted', () => {
  const out = redactPaths('grep -i SVARC notes.txt', PETR);
  assert.ok(!/svarc/i.test(out), out);
  assert.equal(out, 'grep -i <user> notes.txt');
});

test('POLLING: value layer — the login name is redacted', () => {
  const out = redactPaths('echo psvarc-notes', PETR);
  assert.ok(!/psvarc/.test(out), out);
  // a dotted login name is split into parts too
  assert.equal(redactPaths('echo svarc', { username: 'petr.svarc' }), 'echo <user>');
});

test('POLLING: value layer — home-folder name comes from the home path (no username/name given)', () => {
  const out = redactPaths('echo Svarc', { home: '/home/Petr Svarc' });
  assert.equal(out, 'echo <user>');
});

test('POLLING: value layer — a name part inside a longer word is left alone (January)', () => {
  assert.equal(redactPaths('echo January', PETR), 'echo January');
});

test('POLLING: value layer — parts shorter than 3 chars and generic account names are not redacted', () => {
  // each part alone stays; the whole name "al bo" (5 chars) is a term of its own
  assert.equal(redactPaths('echo al alpha bo', { username: 'al', home: '/home/Al Bo', name: 'Al Bo' }),
    'echo al alpha bo');
  assert.equal(redactPaths('echo user admin', { username: 'user', home: '/home/admin' }), 'echo user admin');
});

test('POLLING: value layer is fast on a 200k-char run of a name-part prefix', () => {
  const id = { username: 'aaa' };
  for (const s of ['a'.repeat(200000), 'aab'.repeat(70000)]) {
    const t0 = Date.now();
    redactPaths(s, id);
    assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0}ms`);
  }
});

test('POLLING: generic layer is fast on 200k-char runs of Users-path prefixes', () => {
  for (const s of [':/home/\\ '.repeat(25000), 'C:\\\\Users\\\\'.repeat(20000),
    ' C:/Users/'.repeat(20000), ':'.repeat(200000), ' /mnt/c/'.repeat(25000)]) {
    const t0 = Date.now();
    redactPaths(s, NO_ID);
    assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0}ms`);
  }
});
