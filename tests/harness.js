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
function audit(claudeDir, ...args) {
  const defaultDays = args.includes('--days') ? [] : ['--days', '36500'];
  const out = execFileSync(process.execPath,
    [SCRIPT, '--claude-dir', claudeDir, ...defaultDays, '--json', ...args],
    { encoding: 'utf8' });
  return JSON.parse(out);
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

module.exports = { audit, fixture, tmpClaudeDir, turn, turns };
