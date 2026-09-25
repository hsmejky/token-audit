const test = require('node:test');
const assert = require('node:assert/strict');
const { audit, auditText, tmpClaudeDir, turn, turns } = require('./harness');

// Real on-disk layout (see ~/.claude/projects/<project>/):
//   <project>/<session-uuid>.jsonl                    — main session transcript
//   <project>/<session-uuid>/subagents/agent-*.jsonl  — its subagent transcripts
test('subagent project = real project, not the session uuid', () => {
  const dir = tmpClaudeDir({
    'projects/C--Users-jdoe-demo-proj/3ac91e04-uuid.jsonl': turn({ id: 'main-1' }),
    'projects/C--Users-jdoe-demo-proj/3ac91e04-uuid/subagents/agent-a1.jsonl': turn({ id: 'sub-1' }),
  });
  const r = audit(dir);
  const byId = Object.fromEntries(r.cur.sessions.map(s => [s.sid, s]));
  assert.equal(byId['3ac91e04-uuid'].project, 'C--Users-jdoe-demo-proj');
  assert.equal(byId['agent-a1'].project, 'C--Users-jdoe-demo-proj',
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

test('TOP SESSIONS text report shows the project name for a subagent, not the session uuid', () => {
  const dir = tmpClaudeDir({
    'projects/C--Users-jdoe-demo-proj/3ac91e04-uuid/subagents/agent-a1.jsonl': turn({ id: 'sub-1' }),
  });
  const out = auditText(dir);
  const topLine = out.split('\n').find(l => l.includes('agent-a1'));
  assert.ok(topLine, 'expected a TOP SESSIONS line for the subagent');
  assert.ok(topLine.includes('C--Users-jdoe-demo-proj'), `expected project name, got: ${topLine}`);
  assert.ok(!topLine.includes('3ac91e04-uuid'), `must not show the session uuid as project: ${topLine}`);
});
