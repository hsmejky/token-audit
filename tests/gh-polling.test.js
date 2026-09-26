const test = require('node:test');
const assert = require('node:assert/strict');
const { audit, auditText, tmpClaudeDir, perfLimit } = require('./harness');
const { commandKey, activityCategory, githubShapes, githubReadShapes, isGhWrite, rankFlags, GH_POLL_MIN_CALLS } =
  require('../plugin/skills/token-audit/scripts/token-audit.js');

// GH_POLLING = GitHub read (state-query) calls (wait/poll + github categories,
// write calls excluded — HITL decision) grouped by endpoint shape over every session and
// subagent in the window — catches polling spread as a few calls per session across many
// subagents, which POLLING (one key ≥ N× in ONE session) cannot see. Tests are written
// against GH_POLL_MIN_CALLS, not a literal threshold.
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
const readShapes = cmd => githubReadShapes(commandKey(cmd));

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
    assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < perfLimit(500), `slow on ${s.slice(0, 20)}…`);
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

// Fix: earlier tests only ran isGhWrite() on a raw command string (curl/gh
// resolved by basename there already). This drives the SAME unquoted absolute path through
// commandKey() -> activityCategory() (the `${ANY_CMD}gh `/`api.github.com` category rule)
// and then the full audit pipeline, to confirm a path-invoked curl is still classified
// `github` (not `other`, which GH_POLL_CATEGORIES would silently drop — see roadmap.md) and
// still trips GH_POLLING end to end.
test('GH_POLLING: curl invoked by an unquoted absolute path still categorizes as `github` ' +
  'and fires the flag', () => {
  const cmd = i => String.raw`C:\tools\curl.exe -s https://api.github.com/repos/jdoe/demo-proj/` +
    `pulls/${4000 + i}`;
  assert.equal(activityCategory('Bash', { command: cmd(1) }), 'github');
  const r = audit(tmpClaudeDir(spread(N, 3, cmd)));
  const f = ghFlag(r);
  assert.ok(f, JSON.stringify(r.flags.map(x => x.id)));
  assert.equal(f.calls, N);
  assert.equal(f.groups.length, 1);
  assert.equal(f.groups[0].shape, 'pulls/*');
});

// HITL decision: GH_POLLING counts state queries (reads) only, not writes.
test('isGhWrite: explicit write HTTP method or a writing gh verb is a write; view/checks/watch/GET read', () => {
  assert.equal(isGhWrite('curl -X POST https://api.github.com/repos/jdoe/demo-proj/pulls -d @b.json'), true);
  assert.equal(isGhWrite('curl -s -X PUT https://api.github.com/repos/jdoe/demo-proj/pulls/4242/merge'), true);
  assert.equal(isGhWrite('gh api --method DELETE repos/jdoe/demo-proj/issues/comments/1'), true);
  assert.equal(isGhWrite('gh pr merge 4242 --squash'), true);
  assert.equal(isGhWrite('gh issue create --title x --body y'), true);
  assert.equal(isGhWrite('gh pr checks 4242 --watch'), false);
  assert.equal(isGhWrite('gh pr view 4242'), false);
  assert.equal(isGhWrite('gh run view 991 --log'), false);
  assert.equal(isGhWrite('gh run watch 991'), false);
  assert.equal(isGhWrite('curl -s https://api.github.com/repos/jdoe/demo-proj/pulls/4242'), false);
  assert.equal(isGhWrite('gh api repos/jdoe/demo-proj/pulls/4242'), false);
});

test('GH_POLLING: N write calls (create/merge/-X POST), spread thin, never fire the flag', () => {
  const writeCmds = [
    i => `gh pr merge ${4000 + i} --squash`,
    i => `gh issue create --title issue-${i} --body x`,
    i => `curl -s -X POST https://api.github.com/repos/jdoe/demo-proj/pulls -d @b${i}.json`,
  ];
  for (const cmd of writeCmds) {
    assert.equal(ghFlag(audit(tmpClaudeDir(spread(N, 3, cmd)))), undefined, String(cmd));
  }
});

test('GH_POLLING: N read calls (checks/view/watch/GET), spread thin, fire the flag', () => {
  const readCmds = [
    i => `gh pr checks ${4000 + i} --watch`,
    i => `gh pr view ${4000 + i}`,
    i => `gh run view ${900 + i} --log`,
    i => `gh run watch ${900 + i}`,
  ];
  for (const cmd of readCmds) {
    const f = ghFlag(audit(tmpClaudeDir(spread(N, 3, cmd))));
    assert.ok(f, String(cmd));
    assert.equal(f.calls, N);
  }
});

test('GH_POLLING: mixed reads and writes — only the read shape is counted, writes excluded', () => {
  const total = 2 * N;
  const files = spread(total, 2, i => (i % 2
    ? `gh pr checks ${4000 + i} --watch`    // read
    : `gh pr merge ${4000 + i} --squash`)); // write
  const f = ghFlag(audit(tmpClaudeDir(files)));
  assert.ok(f);
  assert.equal(f.calls, N);
  assert.deepEqual(f.groups.map(g => g.shape), ['gh pr checks']);
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

// A call is excluded PER OCCURRENCE/shape, not whole — a read and a write
// gh/curl invocation in the same Bash call must keep the read shape and drop only the write.
test('githubReadShapes: one call with a read gh loop AND a write gh call keeps only the read ' +
  'shape', () => {
  const cmd = 'until gh pr checks 4242; do sleep 30; done && gh pr merge 4242';
  assert.deepEqual(readShapes(cmd), ['gh pr checks']);
  assert.deepEqual(shapes(cmd).sort(), ['gh pr checks', 'gh pr merge']);
  assert.equal(isGhWrite(commandKey(cmd)), true); // the key still HAS a write occurrence
});

test('githubReadShapes: one call with a read curl loop AND a write curl (-X PUT …/merge) ' +
  'keeps only the read shape', () => {
  const cmd = 'for i in $(seq 1 3); do curl -s https://api.github.com/repos/jdoe/demo-proj/' +
    'commits/$i/check-runs; sleep 5; done && curl -s -X PUT https://api.github.com/repos/' +
    'jdoe/demo-proj/pulls/4242/merge';
  assert.deepEqual(readShapes(cmd), ['commits/*/check-runs']);
});

test('GH_POLLING: a call with a read AND a write occurrence counts once, only under the ' +
  'read shape', () => {
  const cmd = i => `until gh pr checks ${4000 + i}; do sleep 5; done && gh pr merge ${4000 + i}`;
  const f = ghFlag(audit(tmpClaudeDir(spread(N, 2, cmd))));
  assert.ok(f);
  assert.equal(f.calls, N);
  assert.deepEqual(f.groups.map(g => g.shape), ['gh pr checks']);
});

// Privacy: the word after `gh <group>` is free text unless it is on that
// group's read-verb whitelist — anything else (a branch/repo name) must never be printed.
test('githubReadShapes: unknown word after `gh <group>` never printed, becomes `*`', () => {
  assert.deepEqual(readShapes('gh browse fix-login-bug'), ['gh browse *']);
  assert.deepEqual(readShapes('gh repo acme-secret'), ['gh repo *']);
  const dump = JSON.stringify(readShapes('gh browse fix-login-bug')) +
    JSON.stringify(readShapes('gh repo acme-secret'));
  assert.doesNotMatch(dump, /fix-login-bug|acme-secret/);
});

test('GH_POLLING --json groups[]: unknown gh word never appears', () => {
  const cmd = i => `gh browse fix-login-bug-${i}`;
  const f = ghFlag(audit(tmpClaudeDir(spread(N, 2, cmd))));
  assert.ok(f);
  assert.deepEqual(f.groups.map(g => g.shape), ['gh browse *']);
  assert.doesNotMatch(JSON.stringify(f), /fix-login-bug/);
});

// Global/local gh flags before the group/verb, and write-method regex
// scoped to its own command (not the whole compound key).
test('isGhWrite/githubReadShapes: --repo/-R before or after the group', () => {
  assert.equal(isGhWrite(commandKey('gh pr --repo jdoe/demo-proj merge 4242')), true);
  assert.equal(isGhWrite(commandKey('gh -R jdoe/demo-proj pr merge 4242')), true);
  assert.deepEqual(readShapes('gh -R jdoe/demo-proj pr view 4242'), ['gh pr view']);
  assert.deepEqual(readShapes('gh pr --repo jdoe/demo-proj view 4242'), ['gh pr view']);
});

test('isGhWrite: write-method regex scoped to its own command — an unrelated `-x post` in a ' +
  'different command must not false-positive', () => {
  assert.equal(isGhWrite(commandKey('grep -x post f && gh pr view 4242')), false);
});

// Extended write detection.
test('isGhWrite: curl --request/-XPOST/--data*/--method=POST, gh api field flags (graphql ' +
  'exception), gh workflow run / secret|variable set / repo fork', () => {
  assert.equal(isGhWrite('curl --request POST https://api.github.com/repos/jdoe/demo-proj/issues'), true);
  assert.equal(isGhWrite('curl -d @b.json https://api.github.com/repos/jdoe/demo-proj/issues'), true);
  assert.equal(isGhWrite('curl -G -d "state=open" https://api.github.com/repos/jdoe/demo-proj/pulls'), false);
  assert.equal(isGhWrite('curl -XPOST https://api.github.com/repos/jdoe/demo-proj/issues'), true);
  assert.equal(isGhWrite('gh api --method=POST repos/jdoe/demo-proj/issues'), true);
  assert.equal(isGhWrite('gh api -f title=x repos/jdoe/demo-proj/issues'), true);
  assert.equal(isGhWrite("gh api graphql -f query='{ viewer { login } }'"), false);
  assert.equal(isGhWrite("gh api graphql -f query='mutation { addComment(x:1) }'"), true);
  assert.equal(isGhWrite('gh workflow run ci.yml'), true);
  assert.equal(isGhWrite('gh secret set FOO --body x'), true);
  assert.equal(isGhWrite('gh variable set FOO --body x'), true);
  assert.equal(isGhWrite('gh repo fork'), true);
});

// `-f`/`-F` implicit POST must still read on an explicit GET spelled
// as `-X GET`/`-XGET`/`--method GET`/`--method=GET`, case-insensitive.
test('isGhWrite: `gh api` field flags read when the method is explicitly GET, any spelling', () => {
  assert.equal(isGhWrite('gh api -X GET search/issues -f q=is:open'), false);
  assert.equal(isGhWrite('gh api -XGET search/issues -f q=is:open'), false);
  assert.equal(isGhWrite('gh api --method GET search/issues -f q=is:open'), false);
  assert.equal(isGhWrite('gh api --method=get search/issues -f q=is:open'), false);
  assert.equal(isGhWrite('gh api -f title=x repos/jdoe/demo-proj/issues'), true); // no GET: still writes
});

// -G must be case-sensitive (curl's lowercase -g is --globoff, an
// unrelated flag) and must be recognized fused into a combined short-flag cluster.
test('isGhWrite: curl -G is case-sensitive and matches inside a combined short-flag cluster', () => {
  assert.equal(isGhWrite('curl -g -d "q=x" https://api.github.com/repos/jdoe/demo-proj/pulls'), true);
  assert.equal(isGhWrite('curl -sG -d "q=x" https://api.github.com/repos/jdoe/demo-proj/pulls'), false);
  assert.equal(isGhWrite('curl -Gs -d "q=x" https://api.github.com/repos/jdoe/demo-proj/pulls'), false);
  assert.equal(isGhWrite('curl --get -d "q=x" https://api.github.com/repos/jdoe/demo-proj/pulls'), false);
});

// curl --json / -F / --form are implicit-POST body flags (unless -G);
// gh api --input is always a write; a graphql `-F query=@file` is a file read, not a write
// just because the filename says "mutation".
test('isGhWrite: curl --json/-F/--form, gh api --input, graphql query=@file is a read', () => {
  assert.equal(isGhWrite('curl --json \'{"title":"x"}\' https://api.github.com/repos/jdoe/demo-proj/issues'),
    true);
  assert.equal(isGhWrite('curl -F file=@a.txt https://api.github.com/repos/jdoe/demo-proj/releases'), true);
  assert.equal(isGhWrite('curl -G -F file=@a.txt https://api.github.com/repos/jdoe/demo-proj/releases'), false);
  assert.equal(isGhWrite('gh api --input body.json repos/jdoe/demo-proj/issues'), true);
  assert.equal(isGhWrite('gh api --method GET --input body.json repos/jdoe/demo-proj/issues'), false);
  assert.equal(isGhWrite('gh api graphql -F query=@mutation.graphql'), false);
  assert.equal(isGhWrite("gh api graphql -f query='mutation { addComment(x:1) }'"), true);
  assert.equal(isGhWrite("gh api graphql -f query='query { viewer { login } }'"), false);
});

// Write detection tokenizes each occurrence: a flag-shaped string inside another option's
// quoted value is that option's value, never a flag of its own.
test('isGhWrite: a flag-shaped substring inside a header value is not a flag', () => {
  assert.equal(isGhWrite("curl -H 'X-Debug: -d' https://api.github.com/repos/jdoe/demo-proj/pulls"), false);
  assert.equal(isGhWrite('curl -H "X-Debug: -X POST" https://api.github.com/repos/jdoe/demo-proj/pulls'), false);
  assert.equal(isGhWrite("gh api -H 'X-Debug: -f a=b' repos/jdoe/demo-proj/pulls"), false);
});

// `gh search`: read-verb whitelist gains `commits` (issues/prs/repos/code were already present).
test('githubReadShapes: `gh search commits` is a known, printed verb', () => {
  assert.deepEqual(readShapes('gh search commits fix --repo jdoe/demo-proj'), ['gh search commits']);
  assert.deepEqual(readShapes('gh search issues fix --repo jdoe/demo-proj'), ['gh search issues']);
});

const PULLS = 'https://api.github.com/repos/jdoe/demo-proj/pulls';

// An explicit method always wins, for curl and gh api alike: GET (any spelling) reads even
// with a body/field flag, POST/PUT/PATCH/DELETE writes; a body flag implies a write only
// when no method is given.
test('isGhWrite: explicit method wins for curl and gh api — GET reads with a body, a write ' +
  'method writes without one', () => {
  assert.equal(isGhWrite(`curl -X GET -d q=x ${PULLS}`), false);
  assert.equal(isGhWrite(`curl -XGET --json '{}' ${PULLS}`), false);
  assert.equal(isGhWrite(`curl --request=get -F a=b ${PULLS}`), false);
  assert.equal(isGhWrite(`curl --request DELETE ${PULLS}/1`), true);
  assert.equal(isGhWrite('gh api --method=GET --input body.json repos/jdoe/demo-proj/issues'), false);
  assert.equal(isGhWrite('gh api -X PATCH repos/jdoe/demo-proj/pulls/1'), true);
  assert.equal(isGhWrite("gh api graphql -X GET -f query='mutation { x }'"), false);
});

// curl rules run only on a curl occurrence, gh api rules only on gh api: `-F`/`-d` on `gh api`
// is a field flag (overridden by an explicit GET), never a curl body flag; a full
// `https://api.github.com/…` URL given to gh api yields exactly one path shape.
test('isGhWrite/githubReadShapes: gh api with a full URL and -F under an explicit GET reads, ' +
  'one shape only', () => {
  assert.equal(isGhWrite(`gh api -X GET -F per_page=100 ${PULLS}`), false);
  assert.equal(isGhWrite(`gh api -F per_page=100 --method GET ${PULLS}`), false);
  assert.deepEqual(readShapes(`gh api -X GET -F per_page=100 ${PULLS}`), ['pulls']);
  assert.deepEqual(shapes(`gh api ${PULLS}/7`), ['pulls/*']);
  assert.equal(isGhWrite(`gh api -F title=x ${PULLS}`), true); // no method: field flag writes
  assert.equal(isGhWrite(`wget -d ${PULLS}`), false); // `-d` is only a body flag for curl
});

// graphql: an inline `query=` value containing the word `mutation` writes wherever the word
// sits (leading space, newline, double quotes); a `$(…)`/`@file` value's text isn't visible,
// so it reads; the field name must be exactly `query` (not `searchquery`).
test('isGhWrite: graphql inline mutation anywhere in the query value writes; $(…)/@file read; ' +
  '`query=` is a whole field name', () => {
  assert.equal(isGhWrite("gh api graphql -f query='\n  mutation { addComment(x:1) { id } }'"), true);
  assert.equal(isGhWrite("gh api graphql -f query=' mutation { addComment(x:1) { id } }'"), true);
  assert.equal(isGhWrite('gh api graphql -f query="mutation { addComment(x:1) { id } }"'), true);
  assert.equal(isGhWrite('gh api graphql -f query="$(cat m.graphql)"'), false);
  assert.equal(isGhWrite('gh api graphql -F query=@mutation.graphql'), false);
  assert.equal(isGhWrite("gh api graphql -f searchquery='mutation' -f query='{ viewer { login } }'"),
    false);
});

// curl combined short-flag clusters split the way curl does (the first value-taking letter
// ends the cluster); curl's options are case-sensitive: `-D` is `--dump-header`, `-x` `--proxy`.
test('isGhWrite: curl -sd/-sXPOST/-sF clusters write, -sSfG reads; -D and -x are not -d/-X', () => {
  assert.equal(isGhWrite(`curl -sd q=x ${PULLS}`), true);
  assert.equal(isGhWrite(`curl -sXPOST ${PULLS}`), true);
  assert.equal(isGhWrite(`curl -sF a=b ${PULLS}`), true);
  assert.equal(isGhWrite(`curl -sSfG -d q=x ${PULLS}`), false);
  assert.equal(isGhWrite(`curl -D - ${PULLS}`), false);
  assert.equal(isGhWrite(`curl -sD h.txt ${PULLS}`), false);
  assert.equal(isGhWrite(`curl -x post:8080 ${PULLS}`), false);
});

test('isGhWrite: `gh pr view --json` stays a read', () => {
  assert.equal(isGhWrite('gh pr view 12 --json statusCheckRollup'), false);
  assert.deepEqual(readShapes('gh pr view 12 --json statusCheckRollup'), ['gh pr view']);
});

test('isGhWrite/githubReadShapes: linear on 200k-char inputs — many/unclosed quotes, clusters', () => {
  const inputs = ['gh api graphql -f query=' + '"'.repeat(200000), `curl ${PULLS} '` + 'x'.repeat(200000),
    `curl ${PULLS}` + ' -sss'.repeat(40000), 'gh api' + ' -x'.repeat(66000), 'curl -' + 'a'.repeat(200000),
    'curl ' + "'a' ".repeat(50000) + PULLS, 'gh api ' + '--method '.repeat(22000), '\\'.repeat(200000),
    'gh api graphql -f query=' + ' mutation'.repeat(22000)];
  for (const s of inputs) {
    const t = process.hrtime.bigint();
    isGhWrite(s);
    githubReadShapes(s);
    assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < perfLimit(250), `slow on ${s.slice(0, 20)}…`);
  }
});

// Inside "…" a backslash escapes `"` (bash), so `\"` never closes the quote; inside '…' it is
// literal. An escaped quote must not shift the rest of the argv (the method after it).
test('isGhWrite: \\" inside double quotes stays in the word; the flags after it still parse', () => {
  assert.equal(isGhWrite(`curl -H "X: \\"a\\"" -X PATCH ${PULLS}/1`), true);
  assert.equal(isGhWrite('gh api -H "X: \\"a\\"" repos/o/r/pulls/1 -X POST'), true);
  assert.deepEqual(githubShapes('gh api -H "X: \\"a\\"" repos/o/r/pulls/1 -X POST'), ['pulls/*']);
  assert.equal(isGhWrite('gh api repos/o/r/pulls/1 -f body="a \\"b\\" c" -X GET'), false);
  assert.equal(isGhWrite(`curl -H 'X: \' -X PATCH ${PULLS}/1`), true); // '…' ends at the next '
  const t = process.hrtime.bigint();
  isGhWrite(`curl -H "${'\\"'.repeat(100000)}" -X GET ${PULLS}`);
  githubReadShapes(`gh api -f body="${'\\"'.repeat(100000)}" repos/o/r/pulls`);
  assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < perfLimit(250), 'slow on many \\"');
});

test('isGhWrite: curl/gh named by a path or with .exe is still curl/gh', () => {
  assert.equal(isGhWrite(`/usr/bin/curl -d x ${PULLS}`), true);
  assert.equal(isGhWrite(`C:\\tools\\curl.exe -d x ${PULLS}`), true);
  assert.equal(isGhWrite(`"C:\\Program Files\\curl\\curl.exe" -sd x ${PULLS}`), true);
  assert.equal(isGhWrite(`curl.exe -d x ${PULLS}`), true);
  assert.equal(isGhWrite(`/usr/bin/curl -G -d x ${PULLS}`), false);
  assert.equal(isGhWrite('gh.exe pr merge 1'), true);
  assert.equal(isGhWrite('C:\\bin\\gh.exe api -f a=b repos/o/r/issues'), true);
  assert.deepEqual(githubShapes('/usr/local/bin/gh pr checks 1'), ['gh pr checks']);
  assert.deepEqual(githubShapes('git clone https://github.com/cli/gh'), []);
});

test('isGhWrite: gh api -X=POST (pflag shorthand `=`) is the method POST', () => {
  assert.equal(isGhWrite('gh api -X=POST repos/o/r/issues'), true);
  assert.equal(isGhWrite('gh api -X=GET repos/o/r/issues -f a=b'), false);
  assert.equal(isGhWrite("gh api graphql -f=query='mutation { x }'"), true);
});

test('isGhWrite: curl -T/--upload-file is an implicit PUT; an explicit method still wins', () => {
  assert.equal(isGhWrite(`curl -T f.txt ${PULLS}`), true);
  assert.equal(isGhWrite(`curl -sT f.txt ${PULLS}`), true);
  assert.equal(isGhWrite(`curl --upload-file f.txt ${PULLS}`), true);
  assert.equal(isGhWrite(`curl -X GET -T f.txt ${PULLS}`), false);
  assert.equal(isGhWrite(`curl -G -T f.txt ${PULLS}`), true);
});

test('isGhWrite: graphql `mutation` is case-sensitive — `__type(name: "Mutation")` reads', () => {
  assert.equal(isGhWrite(`gh api graphql -f query='{ __type(name: "Mutation") { name } }'`), false);
  assert.equal(isGhWrite("gh api graphql -f query='MUTATION { x }'"), false);
  assert.equal(isGhWrite("gh api graphql -f query='mutation { x }'"), true);
});

test('isGhWrite: a curl long option value starting with `-` is never read as a flag', () => {
  assert.equal(isGhWrite(`curl --proxy-header -d ${PULLS}`), false);
  assert.equal(isGhWrite(`curl --user-agent -X POST ${PULLS}`), false);
  assert.equal(isGhWrite(`curl --aws-sigv4 -d ${PULLS}`), false);
});
