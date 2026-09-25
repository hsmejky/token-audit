const test = require('node:test');
const assert = require('node:assert/strict');
const { audit, auditText, tmpClaudeDir } = require('./harness');
const { commandKey, setupPrefixes } = require('../plugin/skills/token-audit/scripts/token-audit.js');

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

const CRED = String.raw`TOKEN=$(printf 'protocol=https\nhost=github.com\n' | git credential fill |` +
  String.raw`sed -n 's/^password=//p')`;
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
  assert.match(f.text, /^1 prefix\(es\) = \$42\.0, 50% of spend; top 6 sess\/11 turns TOKEN=\$\(printf /);
  // too long for the line: quoted values, then non-command words go first — command words stay
  assert.ok(f.text.endsWith('TOKEN=$(printf … | git credential fill | sed …)'), f.text);
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
    () => String.raw`S="$HOME\x" && ls`,                     // $VAR-rooted path, backslash separator
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
  assert.ok([...line[0]].length <= 120 && line[0].endsWith("TOKEN=$(printf '…' | git credential fill)"), line[0]);
  const bare = () => `TOKEN=$(${'x'.repeat(300)}) && ls`; // nothing to drop: cut in the middle
  const cut = auditText(tmpClaudeDir(sessions(5, bare))).split('\n').find(l => l.startsWith('  BOILERPLATE '));
  assert.ok([...cut].length === 120 && cut.includes('…'), cut);
});

test('BOILERPLATE: setup-prefix detection is fast on 200k-char inputs', () => {
  for (const cmd of [
    `A=${'x'.repeat(200000)} && ls`,
    `A="${'/'.repeat(200000)} && ls`,
    `A='${"'".repeat(200000)} && ls`,
    `export ${'A'.repeat(200000)} && ls`,
    `A=${'{'.repeat(200000)} && ls`,
    `$env:${'A'.repeat(200000)} && ls`,
    `${'A=b && '.repeat(25000)}ls`,
  ]) {
    const t0 = Date.now();
    setupPrefixes(commandKey(cmd));
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
  assert.match(fl[0].text, /^2 prefix\(es\) = \$47\.0, 100% of spend; top 5 sess\/10 turns TOKEN=/);
  assert.ok(fl[0].text.endsWith('TOKEN=$(… | git credential fill | …)'), fl[0].text);
});

// Every assignment in the leading run is its own prefix, so the credential
// fetch groups the same whether or not an env export / scratch path comes before it.
test('BOILERPLATE: each assignment of the leading run counts — a fetch after an export or a path var groups', () => {
  const files = {};
  for (let s = 0; s < 3; s++) {
    files[`projects/p/e${s}.jsonl`] = bashTurns(1, `e${s}`, i => `export PYTHONIOENCODING=utf-8 && ${credCurl(i)}`);
    files[`projects/p/c${s}.jsonl`] = bashTurns(1, `c${s}`, credCurl);
  }
  for (let s = 0; s < 2; s++) {
    files[`projects/p/p${s}.jsonl`] = bashTurns(1, `p${s}`, i => `SCRATCH=/c/Users/jdoe/tmp && ${credCurl(i)}`);
  }
  const [f] = boilerFlags(audit(tmpClaudeDir(files)));
  assert.ok(f);
  assert.deepEqual(f.groups.map(g => [g.prefix, g.sessions]), [[CRED, 8]]);
});

test('BOILERPLATE: a call with two setup prefixes counts once in the flag total', () => {
  // 5 sessions × 1 turn ($4) = $20; both prefixes are hits, each $20 — the flag says $20.
  const [f] = boilerFlags(audit(tmpClaudeDir(sessions(5, i => `export LANG=C && ${credCurl(i)}`, 1))));
  assert.ok(f);
  assert.deepEqual(f.groups.map(g => [g.prefix, +g.cost.toFixed(6)]), [[CRED, 20], ['export LANG=<value>', 20]]);
  assert.match(f.text, /^2 prefix\(es\) .*= \$20\.0, 100% of spend;/);
});

test('BOILERPLATE: only assignments with a command after the run are prefixes', () => {
  assert.deepEqual(setupPrefixes('A=x && B=y'), []);
  assert.deepEqual(setupPrefixes('A=x && B=y && ls'), ['A=x', 'B=y']);
  assert.deepEqual(setupPrefixes('ls && A=x && ls'), []);
});

// PowerShell's `$env:NAME=…` is an assignment too.
test('BOILERPLATE: PowerShell $env:NAME=value prefix is recognised', () => {
  const files = {};
  for (let s = 0; s < 5; s++) {
    files[`projects/p/s${s}.jsonl`] = [{
      type: 'assistant', timestamp: '2026-09-01T10:00:00.000Z',
      message: { id: `m${s}`, model: 'claude-opus-5-5', role: 'assistant', usage: USAGE,
        content: [{ type: 'tool_use', id: `t${s}`, name: 'PowerShell',
          input: { command: `$env:PYTHONIOENCODING='utf-8'; python lib/x${s}.py` } }] },
    }];
  }
  const [f] = boilerFlags(audit(tmpClaudeDir(files)));
  assert.ok(f);
  assert.equal(f.groups[0].prefix, '$env:PYTHONIOENCODING=<value>');
  assert.deepEqual(setupPrefixes(`$env:X = 'v'; python x.py`), [`$env:X = 'v'`]);
});

test('BOILERPLATE / POLLING: a non-zero share under 1% prints <1%, not 0%', () => {
  const tiny = { input_tokens: 1000, output_tokens: 0 }; // $0.004 a turn
  const files = {};
  for (let s = 0; s < 5; s++) files[`projects/p/s${s}.jsonl`] = bashTurns(1, `s${s}`, credCurl, tiny);
  files['projects/p/w.jsonl'] = [...bashTurns(20, 'w', () => 'echo waiting', tiny),
    ...bashTurns(1, 'big', () => 'git status', { input_tokens: 1e7, output_tokens: 0 })];
  const r = audit(tmpClaudeDir(files));
  for (const id of ['BOILERPLATE', 'POLLING']) {
    const f = r.flags.find(x => x.id === id);
    assert.ok(f, id);
    assert.match(f.text, /, <1% of spend;/, f.text);
  }
});

test('BOILERPLATE: printed prefix drops the user\'s own name (value layer), text and --json', () => {
  // Identity is injected through the environment: home folder "Zelda Quux", no git user.name.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-id-'));
  const home = path.join(tmp, 'Zelda Quux');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(tmp, 'gitconfig'), '');
  const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1' };
  const dir = tmpClaudeDir(sessions(5, () => 'NOTE=$(grep -c Quux notes.txt) && echo done'));
  const run = (...a) => execFileSync(process.execPath, [require.resolve('../plugin/skills/token-audit/scripts/token-audit.js'),
    '--claude-dir', dir, '--all', '--days', '36500', ...a], { encoding: 'utf8', env, cwd: tmp });
  const [f] = boilerFlags(JSON.parse(run('--json')));
  assert.ok(f);
  assert.equal(f.groups[0].prefix, 'NOTE=$(grep -c <user> notes.txt)');
  const line = run().split('\n').find(l => l.startsWith('  BOILERPLATE '));
  assert.ok(line && !/quux|zelda/i.test(line), line);
});
