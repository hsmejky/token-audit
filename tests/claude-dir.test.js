const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpClaudeDir, tmpDir, turn, auditEnv } = require('./harness');

// Slice 23: --claude-dir gets a documented precedence — explicit flag wins,
// then CLAUDE_CONFIG_DIR, then ~/.claude as the default. Each test proves the
// script actually read transcripts from the winning directory (not just that
// it didn't crash) by giving each candidate directory a distinguishable
// project so a wrong pick shows up as 0 sessions / wrong total.

test('--claude-dir flag wins over CLAUDE_CONFIG_DIR and the default', () => {
  const flagDir = tmpClaudeDir({ 'projects/p/s1.jsonl': turn({ id: 'flag-1' }) });
  const envDir = tmpClaudeDir({ 'projects/p/s1.jsonl': turn({ id: 'env-1' }) });
  const home = tmpDir();
  fs.mkdirSync(path.join(home, '.claude', 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'projects', 'p', 's1.jsonl'),
    JSON.stringify(turn({ id: 'default-1' })[0]) + '\n');

  const out = auditEnv({ CLAUDE_CONFIG_DIR: envDir, HOME: home, USERPROFILE: home },
    ['--claude-dir', flagDir, '--all', '--days', '36500', '--json']);
  const r = JSON.parse(out);
  assert.equal(r.cur.msgs, 1, `expected only the flag dir's 1 turn, got: ${out}`);
});

test('no --claude-dir flag, CLAUDE_CONFIG_DIR set → env value used', () => {
  // Different turn counts in each candidate dir so picking the wrong one is
  // visible as the wrong number, not just "some number of turns".
  const envDir = tmpClaudeDir({
    'projects/p/s1.jsonl': [...turn({ id: 'env-1' }), ...turn({ id: 'env-2' })],
  });
  const home = tmpDir();
  fs.mkdirSync(path.join(home, '.claude', 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'projects', 'p', 's1.jsonl'),
    JSON.stringify(turn({ id: 'default-1' })[0]) + '\n');

  const out = auditEnv({ CLAUDE_CONFIG_DIR: envDir, HOME: home, USERPROFILE: home },
    ['--all', '--days', '36500', '--json']);
  const r = JSON.parse(out);
  assert.equal(r.cur.msgs, 2, `expected the env dir's 2 turns, got: ${out}`);
});

test('neither flag nor CLAUDE_CONFIG_DIR set → ~/.claude (HOME/.claude) used', () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, '.claude', 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'projects', 'p', 's1.jsonl'),
    [...turn({ id: 'default-1' }), ...turn({ id: 'default-2' }), ...turn({ id: 'default-3' })]
      .map(l => JSON.stringify(l)).join('\n') + '\n');

  const out = auditEnv({ HOME: home, USERPROFILE: home },
    ['--all', '--days', '36500', '--json']);
  const r = JSON.parse(out);
  assert.equal(r.cur.msgs, 3, `expected the default ~/.claude's 3 turns, got: ${out}`);
});

// Slice 14's mcpConfig() reads the user-scope MCP config from a file next to
// --claude-dir (`<claude-dir>.json`, mirroring the real `~/.claude` +
// `~/.claude.json` sibling layout). Real Claude Code moves that file INSIDE
// the dir when CLAUDE_CONFIG_DIR relocates it instead — so under
// CLAUDE_CONFIG_DIR, the sibling file must be ignored and the one inside the
// dir must be read.
test('CLAUDE_CONFIG_DIR set: MCP user-config is read from inside the dir, not beside it', () => {
  const envDir = tmpClaudeDir({ 'projects/p/s1.jsonl': turn({ id: 'env-1' }) });
  fs.writeFileSync(envDir + '.json', JSON.stringify({ mcpServers: { sibling: {} } }));
  fs.writeFileSync(path.join(envDir, '.claude.json'), JSON.stringify({ mcpServers: { inside: {} } }));

  try {
    const out = auditEnv({ CLAUDE_CONFIG_DIR: envDir },
      ['--all', '--days', '36500', '--json']);
    const r = JSON.parse(out);
    assert.deepEqual(r.config.mcpServers, [{ scope: 'user', name: 'inside' }],
      `expected only the inside-the-dir server, got: ${out}`);
  } finally {
    fs.rmSync(envDir + '.json');
  }
});

// --claude-dir is this script's own scoping override (not a real Claude Code
// flag), but real installs that relocate ~/.claude via CLAUDE_CONFIG_DIR keep
// .claude.json INSIDE that dir — so pointing --claude-dir at such a dir must
// also read the inside file, not assume the sibling convention its fixtures
// otherwise use (tests/harness.js tmpUserConfig).
test('--claude-dir flag: MCP user-config is read from inside the dir when present there', () => {
  const flagDir = tmpClaudeDir({ 'projects/p/s1.jsonl': turn({ id: 'flag-1' }) });
  fs.writeFileSync(flagDir + '.json', JSON.stringify({ mcpServers: { sibling: {} } }));
  fs.writeFileSync(path.join(flagDir, '.claude.json'), JSON.stringify({ mcpServers: { inside: {} } }));

  try {
    const out = auditEnv({}, ['--claude-dir', flagDir, '--all', '--days', '36500', '--json']);
    const r = JSON.parse(out);
    assert.deepEqual(r.config.mcpServers, [{ scope: 'user', name: 'inside' }],
      `expected only the inside-the-dir server, got: ${out}`);
  } finally {
    fs.rmSync(flagDir + '.json');
  }
});
