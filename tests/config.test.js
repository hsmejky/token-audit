const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { audit, auditText, auditEnv, tmpClaudeDir, turn } = require('./harness');

// Home "Petr Svarc" -> identity name parts "Petr"/"Svarc", same pattern as
// tests/identity.test.js's petrHome(). Used to prove showAny() redacts *before*
// JSON.stringify(), not after (an escape sequence like `\n`/`\t` must never glue
// a letter onto a name/login and defeat redactPaths()'s ID_EDGE boundary).
function petrHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-cfg29-'));
  const home = path.join(tmp, 'Petr Svarc');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'gitconfig'), '');
  const env = { HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1' };
  return { home, env };
}

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
  const lines = out.split('\n');
  const idx = lines.indexOf('  effortLevel:');
  assert.ok(idx !== -1, `expected an exact "  effortLevel:" line (no root default), got:\n${out}`);
  assert.equal(lines[idx + 1], '    claude-fable-5-1=medium');
  assert.equal(lines[idx + 2], '    claude-opus-5=high');
  assert.equal(lines[idx + 3], '    claude-opus-5-5=high');
  for (const line of lines) {
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
  const lines = out.split('\n');
  const idx = lines.indexOf('  effortLevel: default=low');
  assert.ok(idx !== -1, `expected an exact "  effortLevel: default=low" line, got:\n${out}`);
  assert.equal(lines[idx + 1], '    claude-fable-5-1=medium');
  assert.equal(lines[idx + 2], '    claude-opus-5=high');
  assert.equal(lines[idx + 3], '    claude-opus-5-5=high');
  for (const line of lines) {
    assert.ok([...line].length <= 120, `line exceeds 120 chars (${[...line].length}): ${line}`);
  }
});

// Slice 20 review: a hostile/oversized modelSettings key (attacker-controlled
// settings.json, or just a weird real model id) must not blow the 120-char
// budget, and a newline in the key must not inject a fake extra CONFIG line.
test('CONFIG: an oversized or control-char modelSettings key is fit and sanitized, never breaks the layout', () => {
  const longKey = 'claude-' + 'x'.repeat(150);
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': turn({ id: 'm1' }),
    'settings.json': {
      modelSettings: {
        [longKey]: { effortLevel: 'high' },
        'claude-evil\nSECURITY (confidentiality, not cost)\n  none': { effortLevel: 'low' },
      },
    },
  });

  const out = auditText(dir);
  const lines = out.split('\n');
  for (const line of lines) {
    assert.ok([...line].length <= 120, `line exceeds 120 chars (${[...line].length}): ${line}`);
  }
  // Real SECURITY header appears exactly once — a malicious key must not be able
  // to forge a second one via an embedded newline.
  assert.equal(lines.filter(l => l.startsWith('SECURITY (confidentiality, not cost)')).length, 1);
  // The sanitized key keeps its printable run. show() replaces each run of
  // control/format chars (the injected newlines) with a single space; the
  // remaining literal whitespace (the "  none" indent) is collapsed to one
  // space by fit() -- run on the key at print time, same as any other CONFIG
  // field -- not by show(). Checked as an exact line rather than a vague "no
  // triple newline" check that would pass even if the injection partly worked.
  assert.ok(
    lines.some(l => l.trim() === 'claude-evil SECURITY (confidentiality, not cost) none=low'),
    `expected the sanitized modelSettings key on one line, got:\n${out}`);
});

// Slice 20 re-review: root/per-model `effortLevel` and `cleanupPeriodDays` come
// straight from settings.json — attacker- or author-controlled, same as a
// modelSettings key above — but were printed raw, unlike the key. A forged
// value can inject a fake SECURITY line the same way a forged key could.
test('CONFIG: a hostile root effortLevel cannot forge a SECURITY block or blow the line budget', () => {
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': turn({ id: 'm1' }),
    'settings.json': { effortLevel: 'low\nSECURITY (confidentiality, not cost)\n  none' },
  });

  const out = auditText(dir);
  const lines = out.split('\n');
  assert.equal(lines.filter(l => l.startsWith('SECURITY (confidentiality, not cost)')).length, 1);
  for (const line of lines) {
    assert.ok([...line].length <= 120, `line exceeds 120 chars (${[...line].length}): ${line}`);
  }
});

test('CONFIG: a hostile per-model effortLevel cannot forge a SECURITY block', () => {
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': turn({ id: 'm1' }),
    'settings.json': {
      modelSettings: {
        'claude-sonnet-5': { effortLevel: 'low\nSECURITY (confidentiality, not cost)\n  none' },
      },
    },
  });

  const out = auditText(dir);
  const lines = out.split('\n');
  assert.equal(lines.filter(l => l.startsWith('SECURITY (confidentiality, not cost)')).length, 1);
  for (const line of lines) {
    assert.ok([...line].length <= 120, `line exceeds 120 chars (${[...line].length}): ${line}`);
  }
});

test('CONFIG: a hostile cleanupPeriodDays cannot forge a SECURITY block, valid numbers print unchanged', () => {
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': turn({ id: 'm1' }),
    'settings.json': { cleanupPeriodDays: 'low\nSECURITY (confidentiality, not cost)\n  none' },
  });

  const out = auditText(dir);
  const lines = out.split('\n');
  assert.equal(lines.filter(l => l.startsWith('SECURITY (confidentiality, not cost)')).length, 1);
  for (const line of lines) {
    assert.ok([...line].length <= 120, `line exceeds 120 chars (${[...line].length}): ${line}`);
  }

  const dir2 = tmpClaudeDir({
    'projects/p/s1.jsonl': turn({ id: 'm1' }),
    'settings.json': { cleanupPeriodDays: 30 },
  });
  const out2 = auditText(dir2);
  assert.ok(out2.includes('cleanupPeriodDays=30'), out2);
});

// Slice 20 review: settings.model is free text from settings.json too. show()
// already runs on it, but nothing capped its length — a long model string
// pushes the `  model=...` CONFIG line past 120 chars.
test('CONFIG: an oversized settings.model is fit to the line budget', () => {
  const longModel = 'claude-' + 'x'.repeat(200);
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': turn({ id: 'm1' }),
    'settings.json': { model: longModel },
  });

  const out = auditText(dir);
  const lines = out.split('\n');
  for (const line of lines) {
    assert.ok([...line].length <= 120, `line exceeds 120 chars (${[...line].length}): ${line}`);
  }
});

// Slice 20 review: a plugin name is a cache-dir path segment, not a random
// path fs.readdirSync happily returns as-is (control bytes 0-31 aren't legal
// in a directory name on NTFS/most filesystems, but Unicode format/bidi
// characters like U+202E are). It must still go through show(), same as
// every other printed config field, in both text and --json.
test('CONFIG: a long plugin name with an embedded bidi-override char is sanitized', () => {
  const evilPlugin = 'evil\u202E' + 'x'.repeat(80);
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': turn({ id: 'm1' }),
    'settings.json': { enabledPlugins: { [`${evilPlugin}@petr-market`]: true } },
    [`plugins/cache/petr-market/${evilPlugin}/.claude-plugin/plugin.json`]: {},
  });

  const r = audit(dir);
  const name = r.config.plugins[0].name;
  assert.ok(!name.includes('\u202E'), `bidi-override char survived sanitization: ${JSON.stringify(name)}`);
});

// Slice 20 re-review: show()'s control-char strip was [\x00-\x1f\x7f], which only
// covers C0 + DEL. C1 controls (U+0080-U+009F, e.g. U+0085 NEL, U+009B CSI) and
// other Unicode format/bidi characters (e.g. U+202E RIGHT-TO-LEFT OVERRIDE) are
// not in that range and passed through untouched.
test('show(): C1 control (U+0085 NEL) and CSI (U+009B) are stripped, not just C0/DEL', () => {
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': turn({ id: 'm1' }),
    'settings.json': { model: 'claude\u0085evil\u009Bmore' },
  });
  const out = auditText(dir);
  assert.ok(!out.includes('\u0085'), 'U+0085 (NEL) survived show()');
  assert.ok(!out.includes('\u009B'), 'U+009B (CSI) survived show()');
});

test('show(): bidi override (U+202E) is stripped so it cannot reorder printed text', () => {
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': turn({ id: 'm1' }),
    'settings.json': { model: 'claude\u202Eevil' },
  });
  const out = auditText(dir);
  assert.ok(!out.includes('\u202E'), 'U+202E (RLO) survived show()');
});

// Slice 20 3rd review, finding 1: the inline `model=/cleanupPeriodDays=/effortLevel=`
// line (no modelSettings) prints all three fields on one line. Three hostile-long
// values at once must still fit the 120-char budget (dynamic budget, not a static
// per-field guess that assumes they're never all maxed together).
test('CONFIG: hostile-long model + cleanupPeriodDays + effortLevel together still fit one line', () => {
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': turn({ id: 'm1' }),
    'settings.json': {
      model: 'claude-' + 'm'.repeat(200),
      cleanupPeriodDays: 'd'.repeat(200),
      effortLevel: 'e'.repeat(200),
    },
  });

  const out = auditText(dir);
  const lines = out.split('\n');
  for (const line of lines) {
    assert.ok([...line].length <= 120, `line exceeds 120 chars (${[...line].length}): ${line}`);
  }
  // 4th review, finding 6 (nit): the 120-char check above passes vacuously if the
  // `model=` line never got printed at all -- assert it actually exists.
  assert.ok(lines.some(l => l.startsWith('  model=')), `expected a "  model=" line, got:\n${out}`);
});

// Slice 20 3rd review, finding 2: fit()/fitMiddle() only run at print time (text
// report); --json carries the full show()n (redacted/sanitized) value, per
// REFERENCE.md:375 and the "fit at print time" contract at token-audit.js. A long
// settings.model must come through whole in --json, with no '...' truncation.
test('CONFIG --json: an oversized settings.model is not truncated (fit is print-time only)', () => {
  const longModel = 'claude-' + 'x'.repeat(200);
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': turn({ id: 'm1' }),
    'settings.json': { model: longModel },
  });

  const r = audit(dir);
  assert.equal(r.config.model, longModel);
  assert.ok(!r.config.model.includes('…'), `--json config.model was truncated: ${r.config.model}`);
});

// A non-string config value (a forged settings.json where an object/array sits
// where a string is expected) must not collapse into the useless "[object Object]"
// via a naive String() coercion -- it should come through as readable structure.
// 4th review, finding 1 (dispatcher decision): --json keeps the value's live
// type, so config.model stays the actual object (redacted per-key/value), not a
// pre-stringified string -- String()'ing an object was the old (wrong) contract.
test('CONFIG --json: an object value for settings.model keeps its live type, not "[object Object]"', () => {
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': turn({ id: 'm1' }),
    'settings.json': { model: { evil: 'nested' } },
  });

  const r = audit(dir);
  assert.notEqual(r.config.model, '[object Object]');
  assert.deepEqual(r.config.model, { evil: 'nested' },
    `expected live nested structure, got: ${JSON.stringify(r.config.model)}`);
});

// Slice 20 3rd review, finding 6 (pre-existing): PLUGIN_BLOAT's "worst: ..." plugin
// name list had no per-name fit, and wrapWords() didn't hard-break a single word
// longer than the wrap width -- an extreme plugin name (no separators) could still
// push a FLAGS line past 120 chars.
// 4th review, finding 2: this fixture only ever defined 1 agent, so PLUGIN_BLOAT
// (threshold: cfg.agentDefs > 20 || cfg.prefixTokens > 5000 -- see flags() in
// token-audit.js) never actually fired; the test passed vacuously (any output,
// PLUGIN_BLOAT line or not, satisfies "every line <= 120 chars"). frontmatterWeight()
// only reads the first 4000 bytes of each file, so a single agent's name+description
// can't reach the 20000-char (5000-token) prefixTokens threshold either -- 21 agents
// (agentDefs > 20) is the only way to trigger the flag here. Assert the PLUGIN_BLOAT
// line actually exists, is truncated (contains the ellipsis), and still fits 120 chars.
test('FLAGS PLUGIN_BLOAT: an extremely long single-word plugin name does not overrun 120 chars', () => {
  // Kept well under Windows' ~260-char path limit (this fixture's own tmp-dir
  // prefix + /.claude-plugin/plugin.json already eats a good chunk of it) while
  // still exceeding both the plugin-name fit width (40) and FLAG_TEXT_WIDTH (103).
  const longName = 'p'.repeat(140);
  const agentFiles = Object.fromEntries(Array.from({ length: 21 }, (_, i) =>
    [`plugins/cache/petr-market/${longName}/agents/a${i}.md`, `---\nname: a${i}\n---\nbody`]));
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': turn({ id: 'm1' }),
    'settings.json': { enabledPlugins: { [`${longName}@petr-market`]: true } },
    [`plugins/cache/petr-market/${longName}/.claude-plugin/plugin.json`]: {},
    ...agentFiles,
  });

  const out = auditText(dir);
  const lines = out.split('\n');
  for (const line of lines) {
    assert.ok([...line].length <= 120, `line exceeds 120 chars (${[...line].length}): ${line}`);
  }
  const idx = lines.findIndex(l => l.trimStart().startsWith('PLUGIN_BLOAT'));
  assert.ok(idx !== -1, `expected PLUGIN_BLOAT to fire (21 agent defs), got:\n${out}`);
  // A long flag text word-wraps onto continuation lines indented 17 spaces
  // (see printFlagLine()/wrapWords()) -- collect them back into the full text.
  let end = idx + 1;
  while (end < lines.length && lines[end].startsWith(' '.repeat(17))) end++;
  const block = lines.slice(idx, end).join(' ');
  assert.ok(block.includes('…'), `expected the long plugin name truncated with '…': ${block}`);
  for (let i = idx; i < end; i++)
    assert.ok([...lines[i]].length <= 120, `PLUGIN_BLOAT line exceeds 120 chars: ${lines[i]}`);
});

// 4th review, finding 1: showAny() used to JSON.stringify(v) *before* show(),
// so an object value with control chars (\n, \t) next to a name/login got its
// control char turned into a literal backslash+letter escape sequence first
// (e.g. \n -> the two chars `\` `n`) -- that trailing letter then sits right
// before the name and blocks redactPaths()'s ID_EDGE boundary check, so the
// name survives un-redacted. Decision: showAny() walks the object/array
// recursively and calls show() on every string leaf (keys and values) --
// redaction/control-char-stripping happens first, on real control chars --
// and JSON.stringify() (for text output only) runs after, on the already-safe
// result.
test('CONFIG --json: a control char inside a nested object value does not glue a letter onto a redacted name', () => {
  const { home, env } = petrHome();
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': turn({ id: 'm1' }),
    'settings.json': { model: { a: 'x\nSvarc', b: 'Petr\tSvarc' } },
  });
  const args = ['--claude-dir', dir, '--days', '36500', '--all', '--json'];
  const out = auditEnv(env, args);
  const r = JSON.parse(out);
  assert.equal(typeof r.config.model, 'object', 'config.model should keep its live (object) type in --json');
  assert.equal(r.config.model.a, 'x <user>', `name leaked past a control char: ${JSON.stringify(r.config.model)}`);
  assert.equal(r.config.model.b, '<user> <user>', `name leaked past a control char: ${JSON.stringify(r.config.model)}`);
});

test('CONFIG text: a control char inside a nested object value does not glue a letter onto a redacted name', () => {
  const { home, env } = petrHome();
  const dir = tmpClaudeDir({
    'projects/p/s1.jsonl': turn({ id: 'm1' }),
    'settings.json': { model: { a: 'x\nSvarc', b: 'Petr\tSvarc' } },
  });
  const args = ['--claude-dir', dir, '--days', '36500', '--all'];
  const out = auditEnv(env, args);
  assert.ok(!/Svarc/.test(out), `name leaked in text output:\n${out}`);
  assert.ok(!/\bPetr\b/.test(out), `name leaked in text output:\n${out}`);
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
