const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { auditCwd, tmpClaudeDir, tmpUserConfig, tmpDir, turn } = require('./harness');
const { projectFolder } = require('../plugin/skills/token-audit/scripts/token-audit.js');

// Slice 14: CONFIG lists MCP servers from 3 sources — `.mcp.json` in the
// scoped project (design.md "project" / plan.md ".mcp.json"), the user-scope
// top-level `mcpServers` in the sibling `~/.claude.json`-equivalent file, and
// that same file's per-project `local`-scope `projects[<path>].mcpServers`.

function setupProject(extra = {}) {
  const cwd = tmpDir();
  const folder = projectFolder(cwd);
  const dir = tmpClaudeDir({
    [`projects/${folder}/s1.jsonl`]: turn({ id: 'a1' }),
    ...extra,
  });
  return { cwd, dir, folder };
}

test('fixture .mcp.json (2 servers) + 1 user-scope server → CONFIG lists all 3 with scope', () => {
  const { cwd, dir } = setupProject();
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({
    mcpServers: { playwright: { command: 'npx' }, aspire: { command: 'aspire' } },
  }));
  tmpUserConfig(dir, { mcpServers: { rider: { type: 'http', url: 'http://127.0.0.1:1/x' } } });

  const r = auditCwd(dir, cwd, '--json');
  assert.equal(r.config.mcpServers.length, 3);
  const byScope = Object.fromEntries(r.config.mcpServers.map(s => [s.name, s.scope]));
  assert.equal(byScope.playwright, 'mcp.json');
  assert.equal(byScope.aspire, 'mcp.json');
  assert.equal(byScope.rider, 'user');
  assert.equal(r.config.mcpPrefixTokens, 3 * 800);
});

test('text output: mcp servers line + one line per server with its scope', () => {
  const { cwd, dir } = setupProject();
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { foo: {} } }));

  const { execFileSync } = require('node:child_process');
  const script = path.join(__dirname, '..', 'plugin', 'skills', 'token-audit', 'scripts', 'token-audit.js');
  const out = execFileSync(process.execPath,
    [script, '--claude-dir', dir, '--days', '36500'], { encoding: 'utf8', cwd });
  const lines = out.split('\n');
  const header = lines.find(l => l.includes('mcp servers='));
  assert.ok(header, 'expected an "mcp servers=" line in CONFIG');
  assert.ok(header.includes('mcp servers=1'), header);
  const serverLine = lines.find(l => l.trim().startsWith('foo'));
  assert.ok(serverLine, 'expected a line naming the server');
  assert.ok(serverLine.includes('mcp.json'), serverLine);
});

test('project (local) scope: projects[<dir>].mcpServers in the user-config file is picked up', () => {
  const { cwd, dir } = setupProject();
  const key = cwd.replace(/\\/g, '/');
  tmpUserConfig(dir, { projects: { [key]: { mcpServers: { localdb: { command: 'x' } } } } });

  const r = auditCwd(dir, cwd, '--json');
  assert.deepEqual(r.config.mcpServers, [{ scope: 'project', name: 'localdb' }]);
});

test('no MCP config anywhere → no mcp servers line, summary stays short', () => {
  const { cwd, dir } = setupProject();

  const { execFileSync } = require('node:child_process');
  const script = path.join(__dirname, '..', 'plugin', 'skills', 'token-audit', 'scripts', 'token-audit.js');
  const out = execFileSync(process.execPath,
    [script, '--claude-dir', dir, '--days', '36500'], { encoding: 'utf8', cwd });
  assert.ok(!out.includes('mcp servers='), 'did not expect an mcp servers line');

  const r = auditCwd(dir, cwd, '--json');
  assert.deepEqual(r.config.mcpServers, []);
  assert.equal(r.config.mcpPrefixTokens, 0);
});

test('--all scope: only user-scope servers count, project/.mcp.json are skipped (no single project)', () => {
  const { cwd, dir } = setupProject();
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { foo: {} } }));
  tmpUserConfig(dir, { mcpServers: { bar: {} } });

  const { execFileSync } = require('node:child_process');
  const script = path.join(__dirname, '..', 'plugin', 'skills', 'token-audit', 'scripts', 'token-audit.js');
  const out = execFileSync(process.execPath,
    [script, '--claude-dir', dir, '--days', '36500', '--all', '--json'], { encoding: 'utf8', cwd });
  const r = JSON.parse(out);
  assert.deepEqual(r.config.mcpServers, [{ scope: 'user', name: 'bar' }]);
});
