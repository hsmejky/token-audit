const test = require('node:test');
const assert = require('node:assert/strict');
const { audit, auditText, tmpClaudeDir, turn, turns } = require('./harness');

// Real subagent layout: next to each agent-*.jsonl, Claude Code writes an
// agent-*.meta.json whose `description` is the parent's Agent tool_use
// `description` (the short label the spawner gave the task).
const SUB = 'projects/p/3ac91e04-uuid/subagents/agent-a5f00ba7';
const userLine = content => ({ type: 'user', isSidechain: true, timestamp: '2026-09-01T09:59:00.000Z',
  message: { role: 'user', content } });

// Lines of the DETAIL block (from the DETAIL header to end of output).
const detailLines = out => {
  const lines = out.split('\n');
  const i = lines.indexOf('DETAIL');
  return i < 0 ? [] : lines.slice(i).filter(l => l.trim());
};

test('DETAIL top subagents row shows the task text, not the agent id', () => {
  const dir = tmpClaudeDir({
    'projects/p/3ac91e04-uuid.jsonl': turn({ id: 'main-1' }),
    [SUB + '.jsonl']: [userLine('Repo /x. Implement slice 14g.'), ...turns(3, 'sub')],
    [SUB + '.meta.json']: { agentType: 'general-purpose', description: 'Implement slice 14g' },
  });
  const detail = detailLines(auditText(dir));
  const row = detail.find(l => l.includes('Implement slice 14g'));
  assert.ok(row, `expected a DETAIL row with the task text, got:\n${detail.join('\n')}`);
  assert.ok(!row.includes('agent-a5'), `row must not show the agent id: ${row}`);
  assert.match(row, /\s3\s.*opus-5-5\s+3ac91e04\s+Implement/, `turns, short model, 8-char parent: ${row}`);
  assert.ok(!row.includes('3ac91e04-uuid'), `parent id cut to 8 chars: ${row}`);
});

test('no meta.json description -> task = first non-empty line of the first user prompt', () => {
  const dir = tmpClaudeDir({
    [SUB + '.jsonl']: [userLine('\n  Review slice 4 in repo token-audit.\nDetails follow...'), ...turns(2, 'sub')],
    [SUB + '.meta.json']: { agentType: 'general-purpose' },
  });
  const [top] = audit(dir).detail.topSubagents;
  assert.equal(top.task, 'Review slice 4 in repo token-audit.');
  assert.equal(top.sid, 'agent-a5f00ba7');
  assert.equal(top.parent, '3ac91e04-uuid');
  assert.equal(top.turns, 2);
});

test('no meta.json at all, attachment line first, array content -> task from the first user text part', () => {
  const dir = tmpClaudeDir({
    [SUB + '.jsonl']: [
      { type: 'attachment', isSidechain: true, attachment: { type: 'instructions' } },
      userLine([{ type: 'text', text: 'Audit sample-metrics progress' }]),
      ...turns(1, 'sub'),
    ],
  });
  assert.equal(audit(dir).detail.topSubagents[0].task, 'Audit sample-metrics progress');
});

test('DETAIL lines <= 120 chars; long task text cut at 70 chars with an ellipsis', () => {
  const long = 'Skřítek 4c truhly: hlídání zapomenutého sklepa plného spletitých run, ' +
    'a ještě mnohem delší popis pohádky, která se do políčka nevejde';
  const dir = tmpClaudeDir({
    [SUB + '.jsonl']: turns(3, 'sub', { model: 'claude-sonnet-4-6-extended-preview-20260101' }),
    [SUB + '.meta.json']: { description: long },
  });
  const detail = detailLines(auditText(dir));
  for (const l of detail) assert.ok([...l].length <= 120, `line too long (${[...l].length}): ${l}`);
  const row = detail.find(l => l.includes('Skřítek 4c'));
  assert.ok(row, `expected a row with the task, got:\n${detail.join('\n')}`);
  const task = row.slice(row.indexOf('Skřítek 4c'));
  assert.equal([...task].length, 70);
  assert.ok(task.endsWith('…'), `cut task must end with an ellipsis: ${task}`);
  assert.ok(long.startsWith(task.slice(0, -1)), 'cut text is a prefix of the original');
});

test('--no-detail prints the summary only: default output minus the DETAIL block', () => {
  const dir = tmpClaudeDir({
    'projects/p/3ac91e04-uuid.jsonl': turn({ id: 'main-1' }),
    [SUB + '.jsonl']: turns(2, 'sub'),
    [SUB + '.meta.json']: { description: 'Implement slice 14g' },
  });
  const full = auditText(dir);
  const compact = auditText(dir, '--no-detail');
  assert.ok(!compact.split('\n').includes('DETAIL'), 'no DETAIL header with --no-detail');
  assert.ok(!compact.includes('Implement slice 14g'));
  assert.equal(compact.trimEnd(), full.slice(0, full.indexOf('\nDETAIL\n')).trimEnd(),
    'summary part must be identical with and without DETAIL');
  assert.equal(audit(dir, '--no-detail').detail, undefined, '--json omits detail with --no-detail');
});

test('top subagents: at most 10, by cost desc, subagents only, with model / turns / peak ctx / cost', () => {
  const files = { 'projects/p/main-sess.jsonl': turns(50, 'main') };
  for (let i = 1; i <= 12; i++) {
    const base = `projects/p/main-sess/subagents/agent-${String(i).padStart(2, '0')}`;
    files[base + '.jsonl'] = turns(i, `s${i}`, { model: i % 2 ? 'claude-opus-5-5' : 'claude-sonnet-4-6',
      usage: { input_tokens: 0, cache_read_input_tokens: 1000 * i, output_tokens: 0 } });
    files[base + '.meta.json'] = { description: `task ${i}` };
  }
  const top = audit(tmpClaudeDir(files)).detail.topSubagents;
  assert.equal(top.length, 10);
  assert.ok(top.every(a => a.parent === 'main-sess'), 'main sessions are not listed');
  const costs = top.map(a => a.cost);
  assert.deepEqual(costs, [...costs].sort((a, b) => b - a), 'sorted by cost desc');
  const t12 = top.find(a => a.sid === 'agent-12');
  assert.deepEqual({ task: t12.task, model: t12.model, turns: t12.turns, peakCtx: t12.peakCtx },
    { task: 'task 12', model: 'claude-sonnet-4-6', turns: 12, peakCtx: 12000 });
});

test('same agent id under two parents keeps each own task text', () => {
  const dir = tmpClaudeDir({
    'projects/p/parent-aaa/subagents/agent-x.jsonl': turns(1, 'a'),
    'projects/p/parent-aaa/subagents/agent-x.meta.json': { description: 'first run' },
    'projects/p/parent-bbb/subagents/agent-x.jsonl': turns(2, 'b'),
    'projects/p/parent-bbb/subagents/agent-x.meta.json': { description: 'second run' },
  });
  const byParent = Object.fromEntries(audit(dir).detail.topSubagents.map(a => [a.parent, a.task]));
  assert.deepEqual(byParent, { 'parent-aaa': 'first run', 'parent-bbb': 'second run' });
});
