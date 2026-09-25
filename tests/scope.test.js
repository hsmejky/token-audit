const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { audit, auditCwd, auditRaw, tmpClaudeDir, tmpDir, turn } = require('./harness');
const { projectFolder } = require('../skills/token-audit/scripts/token-audit.js');

// Real on-disk convention (~/.claude/projects/<folder>/): the folder name is
// the absolute, resolved path Claude Code was launched from, with every
// character that isn't a-z/A-Z/0-9 turned into `-` (Claude Code's own rule:
// `p.replace(/[^a-zA-Z0-9]/g, '-')`, applied to an already-resolved path).
// Names over 200 chars get truncated to 200 chars + `-<hash>` by Claude Code;
// this script doesn't reimplement the hash, it matches an existing folder
// that starts with the 200-char prefix (see below).
test('projectFolder maps a Windows drive path', () => {
  assert.equal(projectFolder('C:\\Users\\jdoe\\demo-proj'), 'C--Users-jdoe-demo-proj');
});

test('projectFolder resolves a POSIX-style path against the current OS, then maps separators', () => {
  const expected = path.resolve('/Users/jdoe/demo-proj').replace(/[^a-zA-Z0-9]/g, '-');
  assert.equal(projectFolder('/Users/jdoe/demo-proj'), expected);
});

test('projectFolder maps underscore, dot, and space to dash (not just \\ / :)', () => {
  const input = 'C:\\Users\\jdoe\\my_proj.v2 test';
  assert.equal(projectFolder(input), 'C--Users-jdoe-my-proj-v2-test');
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
  assert.equal(r.scope.project, folder);
  assert.equal(r.cur.sessions.length, 1);
  assert.equal(r.cur.sessions[0].sid, 's1');
  assert.equal(r.cur.sessions[0].project, folder);
});

test('--project <path> selects that project, mapping separators to `-`', () => {
  const dir = tmpClaudeDir({
    'projects/C--fake-proj-a/s1.jsonl': turn({ id: 'a1' }),
    'projects/C--fake-proj-b/s2.jsonl': turn({ id: 'b1' }),
  });
  const r = audit(dir, '--project', 'C:\\fake\\proj-a');
  assert.equal(r.scope.mode, 'project');
  assert.equal(r.scope.project, 'C--fake-proj-a');
  assert.equal(r.cur.sessions.length, 1);
  assert.equal(r.cur.sessions[0].project, 'C--fake-proj-a');
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
    'projects/C--fake-proj-a/sess1.jsonl': turn({ id: 'a1' }),
    'projects/C--fake-proj-a/sess1/subagents/agent-x.jsonl': turn({ id: 'a1-sub' }),
    'projects/C--fake-proj-b/sess2.jsonl': turn({ id: 'b1' }),
  });
  const r = audit(dir, '--project', 'C:\\fake\\proj-a');
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
  assert.equal(r.scope.project, folder);
  assert.equal(r.cur.sessions.length, 1);
});

// The exact bug called out in the plan: `--project --json` must not take
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
