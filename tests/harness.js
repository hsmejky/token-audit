// Test harness: runs the real script as a CLI against a fixture Claude dir
// (never the real ~/.claude) and returns its --json output.
//
// A fixture Claude dir stands in for ~/.claude: transcripts under
// projects/<project>/..., settings.json etc. at its root. Two sources:
//   fixture(name)        static, hand-readable: tests/fixtures/<name>/
//   tmpClaudeDir(files)  generated, for bulk shapes (hundreds of turns)
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'skills', 'token-audit', 'scripts', 'token-audit.js');

const fixture = name => path.join(__dirname, 'fixtures', name);

// Window wide enough that every fixture row lands in `cur`, unless the
// caller passes its own --days (e.g. to test window filtering).
//
// Scope: since Slice 6, default scope (no --project/--all) is the *current
// working directory's* project — but these fixtures live under arbitrary
// project folder names ("p", "C--proj-a", ...) that have nothing to do with
// the test process's real cwd. Callers here almost never care about scoping,
// so audit()/auditText() default to `--all` (the old, unscoped behaviour)
// unless the caller explicitly passes --project or --all itself. Tests that
// exercise scoping directly pass their own --project/--all, or use
// auditCwd()/auditRaw() below for cases that need exact control.
function defaultScope(args) {
  return (args.includes('--project') || args.includes('--all')) ? [] : ['--all'];
}

function audit(claudeDir, ...args) {
  const defaultDays = args.includes('--days') ? [] : ['--days', '36500'];
  const out = execFileSync(process.execPath,
    [SCRIPT, '--claude-dir', claudeDir, ...defaultDays, ...defaultScope(args), '--json', ...args],
    { encoding: 'utf8' });
  return JSON.parse(out);
}

// Same as audit(), but returns the plain-text report (no --json) — for
// assertions about the printed layout itself (line content, formatting).
function auditText(claudeDir, ...args) {
  const defaultDays = args.includes('--days') ? [] : ['--days', '36500'];
  return execFileSync(process.execPath,
    [SCRIPT, '--claude-dir', claudeDir, ...defaultDays, ...defaultScope(args), ...args],
    { encoding: 'utf8' });
}

// Like audit(), but spawns the script with a chosen process cwd and adds no
// implicit scope flags — for testing the true default (no --project/--all)
// scope, which maps process.cwd() to a project folder.
function auditCwd(claudeDir, cwd, ...args) {
  const defaultDays = args.includes('--days') ? [] : ['--days', '36500'];
  const out = execFileSync(process.execPath,
    [SCRIPT, '--claude-dir', claudeDir, ...defaultDays, '--json', ...args],
    { encoding: 'utf8', cwd });
  return JSON.parse(out);
}

// Full control over argv order (no --claude-dir even), for edge cases like
// flag-parsing bugs where argument position matters. Returns stdout on
// success; throws (with .status/.stderr) on a non-zero exit.
function auditRaw(claudeDir, args) {
  return execFileSync(process.execPath,
    [SCRIPT, '--claude-dir', claudeDir, ...args],
    { encoding: 'utf8' });
}

// Full control over both argv and env, for Slice 23's --claude-dir /
// CLAUDE_CONFIG_DIR precedence tests. Starts from a copy of the real
// process.env with CLAUDE_CONFIG_DIR, HOME and USERPROFILE all deleted first
// (so neither the dev machine's real CLAUDE_CONFIG_DIR nor its real home
// directory can leak into a test), then applies `env` on top — so a test
// controls exactly what the script sees regardless of host OS. Returns
// stdout; throws (with .status/.stderr) on a non-zero exit.
function auditEnv(env, args) {
  const childEnv = { ...process.env };
  delete childEnv.CLAUDE_CONFIG_DIR;
  delete childEnv.HOME;
  delete childEnv.USERPROFILE;
  Object.assign(childEnv, env);
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: childEnv });
}

// Creates a real, empty directory for tests that need an actual filesystem
// path to spawn the script with as cwd (see auditCwd). Auto-cleaned on exit,
// same as tmpClaudeDir.
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-audit-cwd-'));
  tmpDirs.push(dir);
  return dir;
}

// files: { 'projects/p/s.jsonl': [lineObj, ...], 'settings.json': obj }
// Arrays become JSONL, anything else JSON. Removed when the process exits.
const tmpDirs = [];
process.on('exit', () => tmpDirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));
function tmpClaudeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-audit-'));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Array.isArray(content)
      ? content.map(l => JSON.stringify(l)).join('\n') + '\n'
      : JSON.stringify(content));
  }
  return dir;
}

// One API response as it lands in a transcript: `lines` JSONL lines
// (thinking / text / tool_use) sharing one message.id and usage.
function turn({ id, model = 'claude-opus-5-5', ts = '2026-09-01T10:00:00.000Z',
                usage = { input_tokens: 1000, output_tokens: 0 }, lines = 1 }) {
  return Array.from({ length: lines }, () => ({
    type: 'assistant', timestamp: ts,
    message: { id, model, role: 'assistant', content: [], usage },
  }));
}

// n turns with ids `${prefix}-0..n-1`, each written as `lines` lines.
const turns = (n, prefix, opts = {}) =>
  Array.from({ length: n }, (_, i) => turn({ ...opts, id: `${prefix}-${i}` })).flat();

// Writes the sibling `<claudeDir>.json` file that stands in for the real
// `~/.claude.json` (user-scope + per-project `local`-scope mcpServers live
// there, never in settings.json — see token-audit.js `mcpConfig()`). Cleaned
// up on exit alongside the fixture dir it sits next to.
function tmpUserConfig(claudeDir, obj) {
  const p = claudeDir + '.json';
  fs.writeFileSync(p, JSON.stringify(obj));
  tmpDirs.push(p);
  return p;
}

module.exports = {
  audit, auditText, auditCwd, auditRaw, auditEnv, fixture, tmpClaudeDir, tmpDir, tmpUserConfig, turn, turns,
};
