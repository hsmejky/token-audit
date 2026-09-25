const test = require('node:test');
const assert = require('node:assert/strict');
const { audit, auditText, tmpClaudeDir, turn, turns } = require('./harness');

// Real on-disk layout (see ~/.claude/projects/<project>/):
//   <project>/<session-uuid>.jsonl                    — main session transcript
//   <project>/<session-uuid>/subagents/agent-*.jsonl  — its subagent transcripts
test('subagent project = real project, not the session uuid', () => {
  const dir = tmpClaudeDir({
    'projects/C--Users-zq-demo-proj/3ac91e04-uuid.jsonl': turn({ id: 'main-1' }),
    'projects/C--Users-zq-demo-proj/3ac91e04-uuid/subagents/agent-a1.jsonl': turn({ id: 'sub-1' }),
  });
  const r = audit(dir);
  const byId = Object.fromEntries(r.cur.sessions.map(s => [s.sid, s]));
  assert.equal(byId['3ac91e04-uuid'].project, 'C--Users-zq-demo-proj');
  assert.equal(byId['agent-a1'].project, 'C--Users-zq-demo-proj',
    'subagent project must be the real project, not the session-uuid folder');
});

test('each subagent session carries its parent session id; main sessions have none', () => {
  const dir = tmpClaudeDir({
    'projects/p/3ac91e04-uuid.jsonl': turn({ id: 'main-1' }),
    'projects/p/3ac91e04-uuid/subagents/agent-a1.jsonl': turn({ id: 'sub-1' }),
  });
  const r = audit(dir);
  const byId = Object.fromEntries(r.cur.sessions.map(s => [s.sid, s]));
  assert.equal(byId['agent-a1'].parent, '3ac91e04-uuid');
  assert.equal(byId['3ac91e04-uuid'].parent, null);
});

// Slice 15 HITL (re-review decision): ALL-TIME (--json `all`) mixes populations on
// purpose — `sessions`/`msgs` count main sessions only, same population as SESSIONS
// (all.mainSessions), but `cost` is all-time spend INCLUDING subagents, so the
// invariant SPEND (cur.cost, which also includes subagents) ≤ ALL-TIME cost holds.
test('--json `all` (ALL-TIME): sessions/msgs are main-only, cost includes subagents', () => {
  const dir = tmpClaudeDir({
    'projects/p/main-1.jsonl': turn({ id: 'm1' }),
    'projects/p/main-1/subagents/agent-a1.jsonl': turns(3, 'sub-a'),
  });
  const r = audit(dir);
  assert.equal(r.all.sessions, 1, 'only the main session counted');
  assert.equal(r.all.msgs, 1, 'subagent turns excluded from the message count');
  const mainCost = r.cur.sessions.find(s => s.sid === 'main-1').cost;
  const subCost = r.cur.sessions.filter(s => s.isSub).reduce((a, s) => a + s.cost, 0);
  assert.ok(subCost > 0, 'fixture must actually carry subagent cost for this test to mean anything');
  assert.equal(r.all.cost.toFixed(6), (mainCost + subCost).toFixed(6),
    'ALL-TIME cost must include subagent spend, so SPEND <= ALL-TIME always holds');
});

// re-review finding (Slice 15): the previous test above used the harness default
// --days 36500, so every fixture row landed in BOTH `cur` and `all` — it couldn't
// tell "all.cost happens to include subagents" apart from "all.cost is scoped to
// all-time history, wider than the --days window". This test uses a tight --days
// window with a session OUTSIDE it (own subagent too), so `cur` excludes that old
// session entirely while `all` still must include its cost — the actual scenario
// the SPEND <= ALL-TIME invariant exists to cover.
test('--json `all`: includes cost from sessions outside the --days window', () => {
  // Dates relative to Date.now() (the script's own "today"), not hardcoded, so this
  // test keeps meaning whenever it runs instead of going stale after a fixed date.
  const daysAgo = n => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  const dir = tmpClaudeDir({
    // Well outside a 7-day window as of "today": excluded from cur/prev, included
    // in all-time.
    'projects/p/old-main.jsonl': turn({ id: 'old-1', ts: daysAgo(24) }),
    'projects/p/old-main/subagents/agent-old.jsonl': turns(3, 'old-sub', { ts: daysAgo(24) }),
    // Inside the window: counted in both cur and all. Also carries its own subagent, so
    // "all.cost only sums main sessions" would fail this test too, not just "all.cost
    // ignores rows outside the window" (which the old session alone would already cover).
    'projects/p/new-main.jsonl': turn({ id: 'new-1', ts: daysAgo(1) }),
    'projects/p/new-main/subagents/agent-new.jsonl': turns(2, 'new-sub', { ts: daysAgo(1) }),
  });
  const r = audit(dir, '--days', '7');
  assert.equal(r.cur.sessions.some(s => s.sid === 'old-main' || s.sid === 'agent-old'), false,
    'old session and its subagent must be outside the cur window');
  assert.equal(r.all.sessions, 2, 'ALL-TIME sessions counts both main sessions, old and new');
  const newMainCost = r.cur.sessions.find(s => s.sid === 'new-main').cost;
  const newSubCost = r.cur.sessions.find(s => s.sid === 'agent-new').cost;
  assert.ok(newSubCost > 0, 'fixture must actually carry in-window subagent cost for this test to mean anything');
  assert.equal((newMainCost + newSubCost).toFixed(6), r.cur.cost.toFixed(6),
    'SPEND must include the in-window subagent cost');
  assert.ok(r.all.cost > r.cur.cost,
    `ALL-TIME cost (${r.all.cost}) must exceed the windowed SPEND (${r.cur.cost}) ` +
    'since it includes the old session + its subagent, which the window excludes');
  assert.ok(r.cur.cost <= r.all.cost, 'SPEND <= ALL-TIME must hold even with rows outside the window');
});

// re-review finding (Slice 15): pin the actual printed ALL-TIME line shape, not just
// the --json fields behind it — a formatting slip (wrong label, dropped "sessions"/
// "messages" word, money() not applied) would pass every --json-only test above.
test('ALL-TIME summary line: "ALL-TIME     $X.XX over N sessions, M messages"', () => {
  const dir = tmpClaudeDir({
    'projects/p/main-1.jsonl': turn({ id: 'm1' }),
    'projects/p/main-1/subagents/agent-a1.jsonl': turns(2, 'sub-a'),
  });
  const out = auditText(dir);
  const line = out.split('\n').find(l => l.startsWith('ALL-TIME'));
  assert.ok(line, `no ALL-TIME line found in:\n${out}`);
  // money() varies decimals by magnitude (n<1 -> 3dp, n<10 -> 2dp, ...) — match any.
  assert.match(line, /^ALL-TIME\s+\$\d+\.\d+ over \d+ sessions, \d+ messages$/, line);
  assert.match(line, / over 1 sessions, 1 messages$/, 'sessions/messages must be main-only');
});

// Real on-disk layout: a subagent id (e.g. from a `fork` agent whose name
// happens to collide across runs) can appear under two different parent
// session directories. Identity for a subagent session is (parent, sid) —
// two parents means two distinct sessions, each keeping its own parent and
// its own turns/cost. Grouping by `sid` alone (the pre-fix behaviour) merges
// them into one session and drops one parent.
test('same subagent id under two different parents stays two sessions, not merged', () => {
  const dir = tmpClaudeDir({
    'projects/p/parent-aaa/subagents/agent-shared.jsonl':
      turn({ id: 'a-1', usage: { input_tokens: 1000, output_tokens: 0 } }),
    'projects/p/parent-bbb/subagents/agent-shared.jsonl':
      turns(2, 'b', { usage: { input_tokens: 1000, output_tokens: 0 } }),
  });
  const r = audit(dir);
  const shared = r.cur.sessions.filter(s => s.sid === 'agent-shared');
  assert.equal(shared.length, 2, 'expected two distinct sessions for the shared subagent id');

  const byParent = Object.fromEntries(shared.map(s => [s.parent, s]));
  assert.ok(byParent['parent-aaa'], 'expected a session parented to parent-aaa');
  assert.ok(byParent['parent-bbb'], 'expected a session parented to parent-bbb');
  assert.equal(byParent['parent-aaa'].msgs, 1);
  assert.equal(byParent['parent-bbb'].msgs, 2);
  assert.ok(byParent['parent-bbb'].cost > byParent['parent-aaa'].cost,
    'each session must total only its own turns, not the merged pair');
});

// Slice 28 (design.md Q3, HITL decision): TOP SESSIONS was dropped from the
// summary (it overlapped DETAIL's WORK UNITS / TOP SUBAGENTS) — this project-
// name-not-uuid guarantee now lives in DETAIL's WORK UNITS project column
// instead (a subagent-only unit is keyed by its parent dir, sid = first 8
// chars of the parent; --json still carries the full project on every session
// regardless, see the audit()-based test above).
test('DETAIL WORK UNITS shows the project name for a subagent-only unit, not the session uuid', () => {
  const dir = tmpClaudeDir({
    'projects/C--Users-zq-demo-proj/3ac91e04-uuid/subagents/agent-a1.jsonl': turn({ id: 'sub-1' }),
  });
  const out = auditText(dir);
  const unitLine = out.split('\n').find(l => l.startsWith('  3ac91e04'));
  assert.ok(unitLine, `expected a WORK UNITS line for the orphan unit, got:\n${out}`);
  assert.ok(unitLine.includes('C--Users-zq-demo-proj'), `expected project name, got: ${unitLine}`);
  assert.ok(!unitLine.includes('3ac91e04-uuid'), `must not show the full session uuid as project: ${unitLine}`);
});
