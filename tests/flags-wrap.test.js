const test = require('node:test');
const assert = require('node:assert/strict');
const { auditText, tmpClaudeDir, turn } = require('./harness');
const { printFlagLine } = require('../plugin/skills/token-audit/scripts/token-audit.js');

// Captures what printFlagLine() sends to console.log, one entry per call.
function captureLines(fn) {
  const out = [];
  const orig = console.log;
  console.log = (...args) => out.push(args.join(' '));
  try { fn(); } finally { console.log = orig; }
  return out;
}

// Slice 20 review: NO_RETENTION's advice text (112 chars) is longer than
// FLAG_TEXT_WIDTH (103), so it must wrap rather than overrun 120 chars — and
// the wrap must not drop "indefinitely" or misindent the continuation.
test('NO_RETENTION: cleanupPeriodDays unset wraps onto a 17-space-indented continuation line', () => {
  const dir = tmpClaudeDir({ 'projects/p/s1.jsonl': turn({ id: 'm1' }), 'settings.json': {} });

  const out = auditText(dir);
  const lines = out.split('\n');
  const idx = lines.findIndex(l => l.includes('NO_RETENTION'));
  assert.ok(idx !== -1, `expected a NO_RETENTION flag line, got:\n${out}`);
  assert.ok(lines[idx].startsWith('  NO_RETENTION'), `unexpected NO_RETENTION line: ${lines[idx]}`);

  const cont = lines[idx + 1];
  assert.ok(cont, 'expected NO_RETENTION text to wrap onto a continuation line');
  assert.ok(cont.startsWith(' '.repeat(17)) && cont[17] !== ' ',
    `expected continuation indented exactly 17 spaces, got: "${cont}"`);

  const joined = lines[idx] + ' ' + cont.trim();
  assert.ok(joined.includes('indefinitely'), `expected "indefinitely" preserved, got: ${joined}`);
  for (const line of [lines[idx], cont]) {
    assert.ok([...line].length <= 120, `line exceeds 120 chars (${[...line].length}): ${line}`);
  }
});

// Slice 20 review: POLLING/BOILERPLATE text is a literal shell command,
// already fit to width upstream (fitMiddle/fitPrefix) — printFlagLine must
// print it unchanged (no re-wrap, no space-collapsing), unlike a prose flag
// like NO_RETENTION which is expected to wrap and normalize whitespace.
test('printFlagLine: POLLING/BOILERPLATE text prints unchanged, even with internal double spaces', () => {
  const text = 'cmd  --flag   value here';
  for (const id of ['POLLING', 'BOILERPLATE']) {
    const printed = captureLines(() => printFlagLine({ id, text }));
    assert.deepEqual(printed, [`  ${id.padEnd(14)} ${text}`],
      `expected ${id} text printed byte-for-byte unchanged`);
  }
});

test('printFlagLine: a non-command flag still wraps and normalizes whitespace as before', () => {
  const printed = captureLines(() => printFlagLine({ id: 'NO_RETENTION', text: 'a  b '.repeat(30).trim() }));
  assert.ok(printed.length > 1, 'expected the long prose text to wrap onto more than one line');
  assert.ok(!printed[0].includes('  b'), 'expected internal whitespace runs collapsed for a prose flag');
});

// Slice 20 3rd review, finding 6: wrapWords() only broke between words, so a
// single "word" longer than the wrap width (e.g. an attacker-controlled plugin
// name with no separators, PLUGIN_BLOAT's "worst: ..." list) rode straight
// through unwrapped and overran 120 chars. It must now hard-break.
test('printFlagLine: a single word longer than the wrap width is hard-broken, not left overrunning', () => {
  const longWord = 'p'.repeat(250);
  const printed = captureLines(() => printFlagLine({ id: 'PLUGIN_BLOAT', text: `worst: ${longWord}` }));
  for (const line of printed) {
    assert.ok([...line].length <= 120, `line exceeds 120 chars (${[...line].length}): ${line}`);
  }
  // No characters of the long word may be dropped in the process.
  assert.equal(printed.join('').split('p').length - 1, 250);
});
