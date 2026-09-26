const test = require('node:test');
const assert = require('node:assert/strict');
const { audit, auditText, tmpClaudeDir } = require('./harness');
const { commandKey, githubShapes, rankFlags, GH_POLL_MIN_CALLS } =
  require('../plugin/skills/token-audit/scripts/token-audit.js');

// Slice 31: GH_POLLING = GitHub API / `gh` calls (wait/poll + github categories) grouped by
// endpoint shape over every session and subagent in the window — catches polling spread as
// a few calls per session across many subagents, which POLLING (one key ≥ N× in ONE session)
// cannot see. Tests are written against GH_POLL_MIN_CALLS, not a literal threshold.
const N = GH_POLL_MIN_CALLS;

const USAGE = { input_tokens: 1e6, output_tokens: 0 }; // Opus 5.5: $4 per turn
function bashTurn(id, commands, usage = USAGE) {
  return commands.map((command, i) => ({
    type: 'assistant', timestamp: '2026-09-01T10:00:00.000Z',
    message: { id, model: 'claude-opus-5-5', role: 'assistant', usage,
      content: [{ type: 'tool_use', id: `${id}-tu${i}`, name: 'Bash', input: { command } }] },
  }));
}
// `total` calls spread over sessions of `perSession` calls; half of the sessions are
// subagents of s0. cmd(i) gets a global call index, so every call can carry its own id.
function spread(total, perSession, cmd) {
  const files = {};
  for (let i = 0, s = 0; i < total; s++) {
    const n = Math.min(perSession, total - i);
    const lines = Array.from({ length: n }, (_, k) => bashTurn(`s${s}-${k}`, [cmd(i + k)])).flat();
    const file = s % 2 ? `projects/demo-proj/s0/subagents/agent-a${s}.jsonl` : `projects/demo-proj/s${s}.jsonl`;
    files[file] = lines;
    i += n;
  }
  return files;
}
const CRED = String.raw`TOKEN=$(printf 'protocol=https\nhost=github.com\n' | git credential fill | ` +
  String.raw`sed -n 's/^password=//p')`;
const checkRuns = i => `${CRED} && for i in $(seq 1 6); do out=$(curl -s -H "Authorization: token $TOKEN" ` +
  `https://api.github.com/repos/jdoe/demo-proj/commits/${(0xabc0000 + i).toString(16)}/check-runs); ` +
  `echo "$out" | grep -q completed && break; sleep 20; done`;
const ghFlag = r => r.flags.find(f => f.id === 'GH_POLLING');
const shapes = cmd => githubShapes(commandKey(cmd));

test('githubShapes: REST path → endpoint shape, ids / owner / repo / branch never kept', () => {
  assert.deepEqual(shapes(checkRuns(1)), ['commits/*/check-runs']);
  assert.deepEqual(shapes('curl -s https://api.github.com/repos/jdoe/demo-proj/pulls/4242/merge -X PUT'),
    ['pulls/*/merge']);
  assert.deepEqual(shapes('curl "https://api.github.com/repos/jdoe/demo-proj/pulls?state=open&per_page=50"'),
    ['pulls']);
  assert.deepEqual(shapes('curl https://api.github.com/repos/jdoe/demo-proj/commits/feature-7-login/check-runs'),
    ['commits/*/check-runs']);
  assert.deepEqual(shapes('curl https://api.github.com/repos/jdoe/demo-proj/actions/runs/991/jobs'),
    ['actions/runs/*/jobs']);
  assert.deepEqual(shapes('curl https://api.github.com/repos/jdoe/demo-proj/commits/$SHA/check-runs'),
    ['commits/*/check-runs']);
  assert.deepEqual(shapes('curl -X PATCH https://api.github.com/repos/jdoe/demo-proj -d @s.json'), ['repos/*']);
  assert.deepEqual(shapes('curl https://api.github.com/user'), ['user']);
  assert.deepEqual(shapes('curl https://api.github.com/users/jdoe/repos'), ['users/*/repos']);
  const all = JSON.stringify(shapes('curl https://api.github.com/repos/jdoe/demo-proj/contents/src/app.js'));
  assert.equal(all, '["contents/*"]');
});

test('githubShapes: gh CLI → `gh <group> <verb>`, `gh api <path>` → path shape; non-GitHub → none', () => {
  assert.deepEqual(shapes('gh pr checks 4242 --watch'), ['gh pr checks']);
  assert.deepEqual(shapes('cd /c/x && gh run view 991 --log'), ['gh run view']);
  assert.deepEqual(shapes('gh api -X GET repos/jdoe/demo-proj/actions/runs?branch=x'), ['actions/runs']);
  assert.deepEqual(shapes('gh api user'), ['user']);
  assert.deepEqual(shapes('git push -u origin HEAD && gh pr create --fill'), ['gh pr create']);
  assert.deepEqual(shapes('curl -s https://api.github.com/repos/jdoe/demo-proj/pulls/7 && ' +
    'curl -s https://api.github.com/repos/jdoe/demo-proj/pulls/8'), ['pulls/*']);
  assert.deepEqual(shapes('sleep 30'), []);
  assert.deepEqual(shapes('git push origin main'), []);
  assert.deepEqual(shapes('echo "see github.com/jdoe/demo-proj"'), []);
});

test('githubShapes: linear on 200k-char inputs', () => {
  const inputs = ['api.github.com/'.repeat(14000), 'gh '.repeat(70000), 'curl https://api.github.com/' +
    'a/'.repeat(100000), 'x gh api '.repeat(25000), '/'.repeat(200000)];
  for (const s of inputs) {
    const t = process.hrtime.bigint();
    githubShapes(s);
    assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 500, `slow on ${s.slice(0, 20)}…`);
  }
});

test('GH_POLLING: N check-runs calls spread thin over many sessions/subagents fire; POLLING does not', () => {
  const r = audit(tmpClaudeDir(spread(N, 3, checkRuns)));
  const f = ghFlag(r);
  assert.ok(f, JSON.stringify(r.flags.map(x => x.id)));
  assert.equal(r.flags.filter(x => x.id === 'POLLING').length, 0);
  assert.equal(f.calls, N);
  assert.equal(f.sessions, Math.ceil(N / 3));
  assert.equal(f.subagents, Math.floor(Math.ceil(N / 3) / 2));
  assert.equal(f.groups.length, 1);
  const g = f.groups[0];
  assert.equal(g.shape, 'commits/*/check-runs');
  assert.deepEqual([g.calls, g.sessions, g.subagents], [f.calls, f.sessions, f.subagents]);
  assert.ok(Math.abs(g.cost - 4 * N) < 1e-9 && Math.abs(f.amount - 4 * N) < 1e-9);
  assert.ok(Math.abs(f.share - 1) < 1e-9 && Math.abs(g.share - 1) < 1e-9);
});

test('GH_POLLING: N−1 calls do not fire (>= boundary), however many sessions', () => {
  assert.equal(ghFlag(audit(tmpClaudeDir(spread(N - 1, 1, checkRuns)))), undefined);
});

test('GH_POLLING: counts only wait/poll + github calls — git push / plain sleep never count', () => {
  const files = spread(3 * N, 3, i => (i % 2 ? `git push origin feature-${i}` : `sleep ${i}`));
  assert.equal(ghFlag(audit(tmpClaudeDir(files))), undefined);
});

test('GH_POLLING: a call hitting two shapes counts once in the totals, in both groups', () => {
  const both = i => `curl https://api.github.com/repos/jdoe/demo-proj/pulls/${i} && ` +
    `curl https://api.github.com/repos/jdoe/demo-proj/commits/${i}/check-runs`;
  const f = ghFlag(audit(tmpClaudeDir(spread(N, 2, both))));
  assert.equal(f.calls, N);
  assert.deepEqual(f.groups.map(g => g.shape).sort(), ['commits/*/check-runs', 'pulls/*']);
  assert.ok(f.groups.every(g => g.calls === N));
  assert.ok(Math.abs(f.cost - 4 * N) < 1e-9, 'cost counted once, not per group');
});

test('GH_POLLING: text line ≤ 120 chars, names endpoint and spread; no owner/repo in text or --json', () => {
  const dir = tmpClaudeDir(spread(N, 2, checkRuns));
  const line = auditText(dir).split('\n').find(l => l.startsWith('  GH_POLLING '));
  assert.ok(line, 'flag line printed');
  assert.ok([...line].length <= 120, line);
  assert.match(line, new RegExp(`${N} calls in ${Math.ceil(N / 2)} sessions`));
  assert.match(line, /commits\/\*\/check-runs/);
  const json = JSON.stringify(ghFlag(audit(dir)));
  assert.doesNotMatch(json + line, /jdoe|demo-proj/);
});

test('GH_POLLING: ranks in tier 0 with POLLING/BOILERPLATE by its cost', () => {
  const r = audit(tmpClaudeDir(spread(N, 2, checkRuns)));
  const ids = rankFlags(r.flags).map(f => f.id);
  const boil = ids.indexOf('BOILERPLATE');
  assert.ok(boil >= 0, 'fixture also fires BOILERPLATE (same credential prefix)');
  assert.ok(ids.indexOf('GH_POLLING') < ids.indexOf('MULTIDAY') || !ids.includes('MULTIDAY'));
  assert.ok(Math.abs(ids.indexOf('GH_POLLING') - boil) === 1, ids.join(' '));
});
