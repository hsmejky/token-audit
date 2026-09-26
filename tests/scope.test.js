const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { audit, auditText, auditCwd, auditRaw, tmpClaudeDir, tmpDir, turn } = require('./harness');
// Printed project names are identity-redacted: a tmp cwd under the real home
// shows as its redactPaths() form, so compare against that.
const { projectFolder, redactPaths } = require('../plugin/skills/token-audit/scripts/token-audit.js');

// Real on-disk convention (~/.claude/projects/<folder>/): the folder name is
// the absolute, resolved path Claude Code was launched from, with every
// character that isn't a-z/A-Z/0-9 turned into `-` (Claude Code's own rule:
// `p.replace(/[^a-zA-Z0-9]/g, '-')`, applied to an already-resolved path).
// Names over 200 chars get truncated to 200 chars + `-<hash>` by Claude Code;
// this script doesn't reimplement the hash, it matches an existing folder
// that starts with the 200-char prefix (see below).
// path.resolve() resolves a bare drive path like 'C:\...' differently per OS: on
// Windows it's already absolute (no-op); on POSIX it isn't absolute, so it gets
// joined onto cwd, which is not a fixed value across machines/CI. To test the
// dash-mapping behavior deterministically on any OS, pick an input this OS's own
// path.resolve() already treats as absolute (so resolve is a no-op, no cwd
// dependency), and hand-compute (not path.resolve()-derive) the expected value
// for each platform, so a regex/mapping regression is still caught either way.
const WIN = process.platform === 'win32';

test('projectFolder maps a Windows drive path', () => {
  const input = WIN ? 'C:\\Users\\jdoe\\demo-proj' : '/Users/jdoe/demo-proj';
  const expected = WIN ? 'C--Users-jdoe-demo-proj' : '-Users-jdoe-demo-proj';
  assert.equal(projectFolder(input), expected);
});

test('projectFolder resolves a POSIX-style path against the current OS, then maps separators', () => {
  const expected = path.resolve('/Users/jdoe/demo-proj').replace(/[^a-zA-Z0-9]/g, '-');
  assert.equal(projectFolder('/Users/jdoe/demo-proj'), expected);
});

test('projectFolder maps underscore, dot, and space to dash (not just \\ / :)', () => {
  const input = WIN ? 'C:\\Users\\jdoe\\my_proj.v2 test' : '/Users/jdoe/my_proj.v2 test';
  const expected = WIN ? 'C--Users-jdoe-my-proj-v2-test' : '-Users-jdoe-my-proj-v2-test';
  assert.equal(projectFolder(input), expected);
});

// Review finding: real project folder names can run well past the header's
// own budget (~38 chars) before hitting the 120-char line cap — the header must
// fitMiddle() the project name rather than overrun it. (TOP SESSIONS,
// the other line this test used to check, was dropped from the summary —
// design decision Q3; DETAIL's WORK UNITS project column replaces it, but that one
// uses a fixed 40-char fit() cap, not a dynamic budget, so it can't overrun
// regardless of project-name length — nothing left there to regression-test.)
test('CONFIG-adjacent header stays <=120 chars for a long project path', () => {
  const longPath = WIN ? 'C:\\Users\\jdoe\\' + 'p'.repeat(160) : '/Users/jdoe/' + 'p'.repeat(160);
  const mapped = path.resolve(longPath).replace(/[^a-zA-Z0-9]/g, '-');
  const dir = tmpClaudeDir({ [`projects/${mapped}/s1.jsonl`]: turn({ id: 'a1' }) });

  const out = auditText(dir, '--project', longPath, '--days', '36500');
  const lines = out.split('\n');
  const header = lines.find(l => l.startsWith('TOKEN AUDIT'));
  assert.ok(header, `expected a TOKEN AUDIT header line, got:\n${out}`);
  assert.ok([...header].length <= 120, `header exceeds 120 chars (${[...header].length}): ${header}`);

  for (const l of lines) assert.ok([...l].length <= 120, `line exceeds 120 chars (${[...l].length}): ${l}`);
});

test('projectFolder resolves "." the same as an explicit absolute cwd path', () => {
  assert.equal(projectFolder('.'), projectFolder(process.cwd()));
});

test('projectFolder resolves a relative path against cwd before mapping', () => {
  assert.equal(projectFolder('sub/dir'), projectFolder(path.resolve('sub/dir')));
});

test('projectFolder matches a truncated+hashed folder for names over 200 chars', () => {
  const longPath = 'C:\\Users\\jdoe\\' + 'x'.repeat(250);
  const mapped = path.resolve(longPath).replace(/[^a-zA-Z0-9]/g, '-');
  const prefix = mapped.slice(0, 200);
  const hashedFolder = prefix + '-abc123';
  const dir = tmpClaudeDir({ [`projects/${hashedFolder}/s1.jsonl`]: turn({ id: 'a1' }) });
  assert.equal(projectFolder(longPath, path.join(dir, 'projects')), hashedFolder);
});

test('projectFolder falls back to the bare 200-char prefix when no hashed folder matches', () => {
  const longPath = 'C:\\Users\\jdoe\\' + 'y'.repeat(250);
  const mapped = path.resolve(longPath).replace(/[^a-zA-Z0-9]/g, '-');
  const prefix = mapped.slice(0, 200);
  const dir = tmpClaudeDir({ 'projects/proj-a/s1.jsonl': turn({ id: 'a1' }) });
  assert.equal(projectFolder(longPath, path.join(dir, 'projects')), prefix);
});

test('projectFolder falls back to the bare 200-char prefix when two folders match the prefix ambiguously', () => {
  const longPath = 'C:\\Users\\jdoe\\' + 'z'.repeat(250);
  const mapped = path.resolve(longPath).replace(/[^a-zA-Z0-9]/g, '-');
  const prefix = mapped.slice(0, 200);
  const dir = tmpClaudeDir({
    [`projects/${prefix}-aaa/s1.jsonl`]: turn({ id: 'a1' }),
    [`projects/${prefix}-bbb/s2.jsonl`]: turn({ id: 'b1' }),
  });
  assert.equal(projectFolder(longPath, path.join(dir, 'projects')), prefix);
});

test('default scope (no --project/--all) is the cwd\'s project only', () => {
  const cwd = tmpDir();
  const folder = projectFolder(cwd);
  const dir = tmpClaudeDir({
    [`projects/${folder}/s1.jsonl`]: turn({ id: 'a1' }),
    'projects/other-project/s2.jsonl': turn({ id: 'b1' }),
  });
  const r = auditCwd(dir, cwd);
  assert.equal(r.scope.mode, 'project');
  assert.equal(r.scope.project, redactPaths(folder));
  assert.equal(r.cur.sessions.length, 1);
  assert.equal(r.cur.sessions[0].sid, 's1');
  assert.equal(r.cur.sessions[0].project, redactPaths(folder));
});

// Same cross-platform-fixed-point trick as above: pick an already-native-absolute
// --project value per OS, and hand-compute (not path.resolve()-derive) the
// mapped folder name it must select.
const [PROJECT_ARG, FOLDER_A, FOLDER_B] = WIN
  ? ['C:\\fake\\proj-a', 'C--fake-proj-a', 'C--fake-proj-b']
  : ['/fake/proj-a', '-fake-proj-a', '-fake-proj-b'];

test('--project <path> selects that project, mapping separators to `-`', () => {
  const dir = tmpClaudeDir({
    [`projects/${FOLDER_A}/s1.jsonl`]: turn({ id: 'a1' }),
    [`projects/${FOLDER_B}/s2.jsonl`]: turn({ id: 'b1' }),
  });
  const r = audit(dir, '--project', PROJECT_ARG);
  assert.equal(r.scope.mode, 'project');
  assert.equal(r.scope.project, FOLDER_A);
  assert.equal(r.cur.sessions.length, 1);
  assert.equal(r.cur.sessions[0].project, FOLDER_A);
});

test('--all includes every project', () => {
  const dir = tmpClaudeDir({
    'projects/proj-a/s1.jsonl': turn({ id: 'a1' }),
    'projects/proj-b/s2.jsonl': turn({ id: 'b1' }),
  });
  const r = audit(dir, '--all');
  assert.equal(r.scope.mode, 'all');
  assert.equal(r.scope.project, null);
  assert.equal(r.cur.sessions.length, 2);
});

test('project scope includes that project\'s subagents', () => {
  const dir = tmpClaudeDir({
    [`projects/${FOLDER_A}/sess1.jsonl`]: turn({ id: 'a1' }),
    [`projects/${FOLDER_A}/sess1/subagents/agent-x.jsonl`]: turn({ id: 'a1-sub' }),
    [`projects/${FOLDER_B}/sess2.jsonl`]: turn({ id: 'b1' }),
  });
  const r = audit(dir, '--project', PROJECT_ARG);
  const sids = r.cur.sessions.map(s => s.sid).sort();
  assert.deepEqual(sids, ['agent-x', 'sess1']);
});

test('unknown --project errors clearly and exits 1', () => {
  const dir = tmpClaudeDir({ 'projects/proj-a/s1.jsonl': turn({ id: 'a1' }) });
  assert.throws(() => audit(dir, '--project', 'does-not-exist'), err => {
    assert.equal(err.status, 1);
    assert.match(err.stderr.toString(), /does-not-exist/);
    return true;
  });
});

test('--project with no value at all errors instead of scanning cwd', () => {
  const dir = tmpClaudeDir({ 'projects/proj-a/s1.jsonl': turn({ id: 'a1' }) });
  assert.throws(() => audit(dir, '--project'), err => {
    assert.equal(err.status, 1);
    assert.match(err.stderr.toString(), /--project/);
    return true;
  });
});

test('--project "" errors the same as --project with no value, instead of silently falling back to all', () => {
  const dir = tmpClaudeDir({ 'projects/proj-a/s1.jsonl': turn({ id: 'a1' }) });
  assert.throws(() => audit(dir, '--project', ''), err => {
    assert.equal(err.status, 1);
    assert.match(err.stderr.toString(), /--project/);
    return true;
  });
});

test('--project "." scopes to the cwd project, not every project', () => {
  const cwd = tmpDir();
  const folder = projectFolder(cwd);
  const dir = tmpClaudeDir({
    [`projects/${folder}/s1.jsonl`]: turn({ id: 'a1' }),
    'projects/other-project/s2.jsonl': turn({ id: 'b1' }),
  });
  const r = auditCwd(dir, cwd, '--project', '.');
  assert.equal(r.scope.mode, 'project');
  assert.equal(r.scope.project, redactPaths(folder));
  assert.equal(r.cur.sessions.length, 1);
});

// The exact bug this guards against: `--project --json` must not take
// `--json` as the project path.
test('--project immediately followed by --json does not swallow --json as the value', () => {
  const dir = tmpClaudeDir({
    'projects/proj-a/s1.jsonl': turn({ id: 'a1' }),
    'projects/proj-b/s2.jsonl': turn({ id: 'b1' }),
  });
  assert.throws(() => auditRaw(dir, ['--days', '36500', '--project', '--json']), err => {
    assert.equal(err.status, 1);
    assert.match(err.stderr.toString(), /--project/);
    return true;
  });
});
