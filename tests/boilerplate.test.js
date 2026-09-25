const test = require('node:test');
const assert = require('node:assert/strict');
const { audit, auditText, tmpClaudeDir } = require('./harness');
const { commandKey, setupPrefix } = require('../skills/token-audit/scripts/token-audit.js');

// plan.md Slice 13 / design.md Q9: BOILERPLATE = the same setup prefix of a
// command repeated across >= BOILER_MIN_SESSIONS (5, provisional)
// sessions. Prefix definition: see REFERENCE.md "BOILERPLATE".

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
const bashTurns = (n, prefix, cmd, usage) =>
  Array.from({ length: n }, (_, i) => bashTurn(`${prefix}-${i}`, [cmd(i)], usage)).flat();

const CRED = String.raw`TOKEN=$(printf 'protocol=https\nhost=github.com\n' | git credential fill | sed -n 's/^password=//p')`;
const credCurl = i => `cd /c/Users/me/proj && ${CRED} && curl -s -H "Authorization: token $TOKEN" ` +
  `https://api.github.com/repos/o/r/pulls/${100 + i} -d @body.json`;
// sessions × turnsPer turns, each session its own transcript file.
function sessions(n, cmd, turnsPer = 2) {
  const files = {};
  for (let s = 0; s < n; s++) files[`projects/p/s${s}.jsonl`] = bashTurns(turnsPer, `s${s}`, cmd);
  return files;
}
const boilerFlags = r => r.flags.filter(f => f.id === 'BOILERPLATE');

test('BOILERPLATE: git credential fill prefix in 6 sessions fires once; in 3 sessions does not', () => {
  const r = audit(tmpClaudeDir(sessions(6, credCurl)));
  const fl = boilerFlags(r);
  assert.equal(fl.length, 1, JSON.stringify(r.flags));
  assert.equal(fl[0].groups.length, 1);
  assert.equal(fl[0].groups[0].prefix, CRED);
  assert.equal(fl[0].groups[0].sessions, 6);
  assert.equal(boilerFlags(audit(tmpClaudeDir(sessions(3, credCurl)))).length, 0);
});

test('BOILERPLATE: exactly 5 sessions fire (>= boundary), 4 do not', () => {
  assert.equal(boilerFlags(audit(tmpClaudeDir(sessions(5, credCurl)))).length, 1, '5 sessions must fire');
  assert.equal(boilerFlags(audit(tmpClaudeDir(sessions(4, credCurl, 10)))).length, 0,
    '4 sessions must not fire, however many turns');
});

test('BOILERPLATE: flag text has prefix, #sessions, #turns, cost share; a multi-call turn gives 1/n', () => {
  // 5 sessions × 2 prefix turns ($4 each) = $40, + a 6th session with one turn
  // [prefix, prefix, ls, ls] ($4, half to the prefix) = $42 over 11 turns (12 calls —
  // #turns counts the turn once); + 10 `git status`
  // turns ($40). Window $84 → 50%.
  const files = sessions(5, credCurl);
  files['projects/p/s5.jsonl'] = bashTurn('mix', [credCurl(9), credCurl(10), 'ls', 'ls -la']);
  files['projects/p/s0.jsonl'].push(...bashTurns(10, 'g', () => 'git status'));
  const r = audit(tmpClaudeDir(files));
  const [f] = boilerFlags(r);
  assert.ok(f, JSON.stringify(r.flags));
  const g = f.groups[0];
  assert.deepEqual([g.sessions, g.turns, +g.cost.toFixed(6), +g.share.toFixed(6)], [6, 11, 42, 0.5]);
  assert.match(f.text, /^1 prefix\(es\) in ≥5 sessions = \$42\.0, 50% of spend; top 6 sess\/11 turns TOKEN=\$\(printf /);
  assert.ok(f.text.includes('…'), 'long prefix is cut in the middle: ' + f.text);
  assert.ok(f.text.endsWith("password=//p')"), f.text);
});

test('BOILERPLATE: one prefix before different commands (other endpoints, PR numbers) is one group', () => {
  const cmds = [credCurl, i => `${CRED} && curl -s https://api.github.com/repos/o/r/actions/runs/${i}`,
    () => `${CRED} && gh_like_script.sh`];
  const r = audit(tmpClaudeDir(sessions(6, i => cmds[i % 3](i))));
  const [f] = boilerFlags(r);
  assert.ok(f, JSON.stringify(r.flags));
  assert.equal(f.groups.length, 1);
  assert.equal(f.groups[0].sessions, 6);
});

test('BOILERPLATE: an `export NAME=value` setup prefix counts too (numbers normalized)', () => {
  const r = audit(tmpClaudeDir(sessions(5, i => `export PYTHONIOENCODING=utf-8 && python lib/x${i}.py`)));
  const [f] = boilerFlags(r);
  assert.ok(f, JSON.stringify(r.flags));
  assert.equal(f.groups[0].prefix, 'export PYTHONIOENCODING=<value>'); // literal value: may be a secret
});

test('BOILERPLATE: not a setup prefix — a plain command first, a lone assignment, a path-valued variable', () => {
  for (const cmd of [
    () => 'git status --short && git log --oneline -5',     // first segment is the work itself
    () => CRED,                                              // assignment with nothing after it
    () => 'S=/c/Users/jdoe/AppData/Local/Temp/scratch && ls $S', // scratchpad shorthand, unquoted
    () => String.raw`S="C:\Users\jdoe\scratch" && ls $S`,    // quoted path → <path>
    () => 'F="$HOME/notes/x.md" && wc -l "$F"',              // $VAR-rooted path
    () => 'F=docs/plan.md && wc -l $F',                      // relative path
  ]) {
    const r = audit(tmpClaudeDir(sessions(6, cmd)));
    assert.equal(boilerFlags(r).length, 0, `${cmd(0)} → ${JSON.stringify(r.flags)}`);
  }
});

test('BOILERPLATE: printed prefix is path-redacted; grouping uses the raw prefix', () => {
  const tok = user => () => `TOKEN=$(cat /home/${user}/.gh-token) && curl -s https://api.github.com/user`;
  // 3 + 3 sessions: the redacted prefixes would be equal, the raw ones are not → no hit.
  const files = sessions(3, tok('alice'));
  for (let s = 0; s < 3; s++) files[`projects/q/b${s}.jsonl`] = bashTurns(2, `b${s}`, tok('bob'));
  assert.equal(boilerFlags(audit(tmpClaudeDir(files))).length, 0);

  const dir = tmpClaudeDir(sessions(5, tok('alice')));
  const [f] = boilerFlags(audit(dir));
  assert.ok(f);
  assert.equal(f.groups[0].prefix, 'TOKEN=$(cat <path>)');
  assert.ok(!/alice/.test(f.text), f.text);
  const line = auditText(dir).split('\n').filter(l => l.startsWith('  BOILERPLATE '));
  assert.equal(line.length, 1);
  assert.ok(!/alice/.test(line[0]) && [...line[0]].length <= 120, line[0]);
});

test('BOILERPLATE: a long prefix keeps the flag line ≤ 120 chars', () => {
  const long = () => `TOKEN=$(printf '${'x'.repeat(300)}' | git credential fill) && curl -s https://example.com`;
  const line = auditText(tmpClaudeDir(sessions(5, long))).split('\n').filter(l => l.startsWith('  BOILERPLATE '));
  assert.equal(line.length, 1);
  assert.equal([...line[0]].length, 120, line[0]);
});

test('BOILERPLATE: setup-prefix detection is fast on 200k-char inputs', () => {
  for (const cmd of [
    `A=${'x'.repeat(200000)} && ls`,
    `A="${'/'.repeat(200000)} && ls`,
    `A='${"'".repeat(200000)} && ls`,
    `export ${'A'.repeat(200000)} && ls`,
    `A=$${'{'.repeat(200000)} && ls`,
  ]) {
    const t0 = Date.now();
    setupPrefix(commandKey(cmd));
    assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0}ms for ${cmd.slice(0, 12)}…`);
  }
});

test('BOILERPLATE: several prefixes → one flag, all groups, most expensive first (not most sessions)', () => {
  // export prefix: 7 sessions × 1 turn at $1 = $7; credential prefix: 5 sessions × 2 turns at $4 = $40.
  const files = sessions(5, credCurl);
  const cheap = { input_tokens: 250000, output_tokens: 0 };
  for (let s = 0; s < 7; s++)
    files[`projects/p/e${s}.jsonl`] = bashTurns(1, `e${s}`, () => 'export LANG=C && python x.py', cheap);
  const fl = boilerFlags(audit(tmpClaudeDir(files)));
  assert.equal(fl.length, 1);
  assert.deepEqual(fl[0].groups.map(g => [g.sessions, g.prefix.slice(0, 6)]), [[5, 'TOKEN='], [7, 'export']]);
  assert.match(fl[0].text, /^2 prefix\(es\) in ≥5 sessions = \$47\.0, 100% of spend; top 5 sess\/10 turns TOKEN=/);
});
