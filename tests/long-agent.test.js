const test = require('node:test');
const assert = require('node:assert/strict');
const { audit, tmpClaudeDir, turn, turns } = require('./harness');

// design.md Q5 / plan.md Slice 10: LONG_AGENT fires for a subagent over 150
// turns OR with peak context > 300k. Thresholds are named constants in the
// script (LONG_AGENT_TURNS, LONG_AGENT_CTX) — see REFERENCE.md "LONG_AGENT".

function withSubagent(n) {
  return tmpClaudeDir({
    'projects/p/main.jsonl': turn({ id: 'm-1' }),
    [`projects/p/main/subagents/agent-a.jsonl`]: turns(n, 'a'),
  });
}

test('LONG_AGENT: subagent at 151 turns fires', () => {
  const r = audit(withSubagent(151));
  assert.ok(r.flags.some(f => f.id === 'LONG_AGENT'), `expected LONG_AGENT, got: ${JSON.stringify(r.flags)}`);
});

test('LONG_AGENT: subagent at 149 turns / 200k peak ctx does not fire', () => {
  const dir = tmpClaudeDir({
    'projects/p/main.jsonl': turn({ id: 'm-1' }),
    'projects/p/main/subagents/agent-a.jsonl':
      turns(149, 'a', { usage: { input_tokens: 0, cache_read_input_tokens: 200000, output_tokens: 0 } }),
  });
  const r = audit(dir);
  assert.ok(!r.flags.some(f => f.id === 'LONG_AGENT'),
    `LONG_AGENT must not fire under both thresholds, got: ${JSON.stringify(r.flags)}`);
});

test('LONG_AGENT: subagent at 40 turns but 350k peak ctx fires', () => {
  const dir = tmpClaudeDir({
    'projects/p/main.jsonl': turn({ id: 'm-1' }),
    'projects/p/main/subagents/agent-a.jsonl':
      turns(40, 'a', { usage: { input_tokens: 0, cache_read_input_tokens: 350000, output_tokens: 0 } }),
  });
  const r = audit(dir);
  assert.ok(r.flags.some(f => f.id === 'LONG_AGENT'),
    `expected LONG_AGENT from peak ctx alone, got: ${JSON.stringify(r.flags)}`);
});

test('LONG_AGENT: a main session alone (not a subagent) never fires it, however long', () => {
  const dir = tmpClaudeDir({ 'projects/p/main.jsonl': turns(300, 'm') });
  const r = audit(dir);
  assert.ok(!r.flags.some(f => f.id === 'LONG_AGENT'), 'main sessions must not trip a subagent flag');
});

test('LONG_AGENT: flag text includes the count and the share of spend', () => {
  // One long subagent (151 turns) plus a cheap main session, so the long
  // subagent's share of spend is exact and checkable.
  const dir = tmpClaudeDir({
    'projects/p/main.jsonl': turn({ id: 'm-1', usage: { input_tokens: 1000, output_tokens: 0 } }),
    'projects/p/main/subagents/agent-a.jsonl':
      turns(151, 'a', { model: 'claude-sonnet-4-5', usage: { input_tokens: 1000, output_tokens: 0 } }),
  });
  const r = audit(dir);
  const f = r.flags.find(x => x.id === 'LONG_AGENT');
  assert.ok(f, 'expected a LONG_AGENT flag');
  assert.match(f.text, /^1 subagent\(s\)/, `expected count 1, got: ${f.text}`);
  // main: 1000 * 2 / 1e6 = 0.002; subagent: 151 * 1000 * 2 / 1e6 = 0.302
  // share = 0.302 / (0.302 + 0.002) = 0.99341... -> rounds to 99%
  assert.match(f.text, /= 99% of spend$/, `expected 99% share, got: ${f.text}`);
});
