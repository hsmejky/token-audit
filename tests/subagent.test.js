const test = require('node:test');
const assert = require('node:assert/strict');
const { audit, auditText, tmpClaudeDir, turn } = require('./harness');

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
