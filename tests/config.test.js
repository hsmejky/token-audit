const test = require('node:test');
const assert = require('node:assert/strict');
const { audit, auditText, tmpClaudeDir, turn } = require('./harness');

// Real shape (~/.claude/settings.json): modelSettings.<model>.effortLevel, one
// entry per model. CONFIG must read these from --claude-dir, not root-only
// `effortLevel` / `env.EFFORT_LEVEL`.
test('modelSettings.<model>.effortLevel for 3 models: CONFIG prints each model\'s level', () => {
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': turn({ id: 'm1' }),
    'settings.json': {
      modelSettings: {
        'claude-opus-5': { effortLevel: 'high' },
        'claude-opus-5-5': { effortLevel: 'high' },
        'claude-fable-5-1': { effortLevel: 'medium' },
      },
    },
  });

  const r = audit(dir);
  assert.deepEqual(r.config.modelEffort, [
    { model: 'claude-fable-5-1', effortLevel: 'medium' },
    { model: 'claude-opus-5', effortLevel: 'high' },
    { model: 'claude-opus-5-5', effortLevel: 'high' },
  ]);

  const out = auditText(dir);
  const line = out.split('\n').find(l => l.includes('effortLevel='));
  assert.ok(line, 'expected a CONFIG line with effortLevel=');
  assert.ok(line.includes('claude-opus-5=high'), `expected opus-5 level, got: ${line}`);
  assert.ok(line.includes('claude-opus-5-5=high'), `expected opus-5-5 level, got: ${line}`);
  assert.ok(line.includes('claude-fable-5-1=medium'), `expected fable-5-1 level, got: ${line}`);
});

test('root-only effortLevel (no modelSettings) still reported as before', () => {
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': turn({ id: 'm1' }),
    'settings.json': { effortLevel: 'high' },
  });

  const r = audit(dir);
  assert.equal(r.config.effortLevel, 'high');
  assert.deepEqual(r.config.modelEffort, []);

  const out = auditText(dir);
  const line = out.split('\n').find(l => l.includes('effortLevel='));
  assert.ok(line.includes('effortLevel=high'), `expected root-level effortLevel, got: ${line}`);
});

test('neither root nor modelSettings effortLevel set → unset', () => {
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': turn({ id: 'm1' }),
    'settings.json': {},
  });

  const r = audit(dir);
  assert.equal(r.config.effortLevel, null);
  assert.deepEqual(r.config.modelEffort, []);

  const out = auditText(dir);
  const line = out.split('\n').find(l => l.includes('effortLevel='));
  assert.ok(line.includes('effortLevel=unset'), `expected unset, got: ${line}`);
});

// CONFIG must read settings.json from --claude-dir, never the real ~/.claude
// (the harness's tmpClaudeDir already proves this if it passes at all, since
// the fixture dir has no real ~/.claude modelSettings mixed in).
test('CONFIG reads settings from --claude-dir, not the real ~/.claude', () => {
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': turn({ id: 'm1' }),
    'settings.json': { modelSettings: { 'claude-sonnet-5': { effortLevel: 'low' } } },
  });
  const r = audit(dir);
  assert.deepEqual(r.config.modelEffort, [{ model: 'claude-sonnet-5', effortLevel: 'low' }]);
});
