const test = require('node:test');
const assert = require('node:assert/strict');
const { audit, auditText, tmpClaudeDir, turn, turns } = require('./harness');

// design decision Q9 (an HITL decision): LONG_SESSION fires for a MAIN
// (non-subagent) session with >= LONG_SESSION_TURNS (200) turns; a long
// subagent is LONG_AGENT's job instead — the two flags used to double-count
// the same sessions when LONG_SESSION counted every session. SESSIONS' count/
// median/p90/"≥N msgs" line is likewise main-threads-only. See REFERENCE.md
// "LONG_SESSION".

test('LONG_SESSION: a main session at 200 turns fires', () => {
  const r = audit(tmpClaudeDir({ 'projects/p/main.jsonl': turns(200, 'm') }));
  assert.ok(r.flags.some(f => f.id === 'LONG_SESSION'), JSON.stringify(r.flags));
});

test('LONG_SESSION: a main session at 199 turns does not fire (>= boundary)', () => {
  const r = audit(tmpClaudeDir({ 'projects/p/main.jsonl': turns(199, 'm') }));
  assert.ok(!r.flags.some(f => f.id === 'LONG_SESSION'), JSON.stringify(r.flags));
});

test('LONG_SESSION: a subagent alone at 250 turns never fires it — that is LONG_AGENT\'s job', () => {
  const r = audit(tmpClaudeDir({
    'projects/p/main.jsonl': turn({ id: 'm-1' }),
    'projects/p/main/subagents/agent-a.jsonl': turns(250, 'a'),
  }));
  assert.ok(!r.flags.some(f => f.id === 'LONG_SESSION'),
    `a long subagent must not trip LONG_SESSION, got: ${JSON.stringify(r.flags)}`);
  assert.ok(r.flags.some(f => f.id === 'LONG_AGENT'), 'the same subagent must trip LONG_AGENT');
});

test('LONG_SESSION: count and share come from main sessions only, not mixed with subagents', () => {
  // Two qualifying main sessions (200 turns each) + one qualifying subagent (250 turns,
  // cheap, model sonnet) that must not be counted or costed into LONG_SESSION.
  const dir = tmpClaudeDir({
    'projects/p/m1.jsonl': turns(200, 'm1', { usage: { input_tokens: 1000, output_tokens: 0 } }),
    'projects/p/m2.jsonl': turns(200, 'm2', { usage: { input_tokens: 1000, output_tokens: 0 } }),
    'projects/p/m1/subagents/agent-a.jsonl':
      turns(250, 'a', { model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 0 } }),
  });
  const r = audit(dir);
  const f = r.flags.find(x => x.id === 'LONG_SESSION');
  assert.ok(f, JSON.stringify(r.flags));
  assert.match(f.text, /^2 session\(s\)/, `expected count 2 (main only), got: ${f.text}`);
});

test('SESSIONS line: count, median and p90 are main-threads-only', () => {
  const dir = tmpClaudeDir({
    'projects/p/m1.jsonl': turns(10, 'm1'),
    'projects/p/m2.jsonl': turns(20, 'm2'),
    'projects/p/m1/subagents/agent-a.jsonl': turns(400, 'a'), // would skew median/p90 if counted
  });
  const out = auditText(dir, '--no-detail');
  const line = out.split('\n').find(l => l.startsWith('SESSIONS'));
  // sorted main msgs [10, 20], n=2: quantile(q) = sorted[floor(q*n)] -> median = p90 = 20
  assert.match(line, /^SESSIONS\s+2\s+median 20 msgs\s+p90 20\s+≥200 msgs: 0$/, line);
});

test('--json cur.mainSessions is not exposed (internal only); cur.sessions still lists everything', () => {
  const dir = tmpClaudeDir({
    'projects/p/m1.jsonl': turn({ id: 'm-1' }),
    'projects/p/m1/subagents/agent-a.jsonl': turn({ id: 'a-1' }),
  });
  const r = audit(dir);
  assert.equal(r.cur.mainSessions, undefined);
  assert.equal(r.cur.sessions.length, 2);
});
