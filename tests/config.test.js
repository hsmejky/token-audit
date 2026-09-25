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
  assert.ok(out.includes('effortLevel:'), `expected a CONFIG effortLevel: line, got:\n${out}`);
  assert.ok(out.includes('claude-opus-5=high'), `expected opus-5 level, got:\n${out}`);
  assert.ok(out.includes('claude-opus-5-5=high'), `expected opus-5-5 level, got:\n${out}`);
  assert.ok(out.includes('claude-fable-5-1=medium'), `expected fable-5-1 level, got:\n${out}`);
  for (const line of out.split('\n')) {
    assert.ok([...line].length <= 120, `line exceeds 120 chars (${[...line].length}): ${line}`);
  }
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

// Mixed case: root effortLevel is a fallback default for any model without
// its own modelSettings entry, so it still applies and must not be hidden
// once modelSettings entries exist.
test('root effortLevel + modelSettings entries: CONFIG prints default= alongside per-model levels', () => {
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': turn({ id: 'm1' }),
    'settings.json': {
      effortLevel: 'low',
      modelSettings: {
        'claude-opus-5': { effortLevel: 'high' },
        'claude-opus-5-5': { effortLevel: 'high' },
        'claude-fable-5-1': { effortLevel: 'medium' },
      },
    },
  });

  const r = audit(dir);
  assert.equal(r.config.effortLevel, 'low');
  assert.deepEqual(r.config.modelEffort, [
    { model: 'claude-fable-5-1', effortLevel: 'medium' },
    { model: 'claude-opus-5', effortLevel: 'high' },
    { model: 'claude-opus-5-5', effortLevel: 'high' },
  ]);

  const out = auditText(dir);
  assert.ok(out.includes('default=low'), `expected default=low, got:\n${out}`);
  assert.ok(out.includes('claude-opus-5=high'), `expected opus-5 level, got:\n${out}`);
  assert.ok(out.includes('claude-opus-5-5=high'), `expected opus-5-5 level, got:\n${out}`);
  assert.ok(out.includes('claude-fable-5-1=medium'), `expected fable-5-1 level, got:\n${out}`);
  for (const line of out.split('\n')) {
    assert.ok([...line].length <= 120, `line exceeds 120 chars (${[...line].length}): ${line}`);
  }
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
