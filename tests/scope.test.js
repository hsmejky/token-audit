const test = require('node:test');
const assert = require('node:assert/strict');
const { audit, auditCwd, auditRaw, tmpClaudeDir, tmpDir, turn } = require('./harness');
const { projectFolder } = require('../skills/token-audit/scripts/token-audit.js');

// Real on-disk convention (~/.claude/projects/<folder>/): the folder name is
// the absolute cwd Claude Code was launched from, with path separators (and
// the Windows drive colon) each turned into `-`.
test('projectFolder maps a Windows drive path', () => {
  assert.equal(projectFolder('C:\\Users\\jdoe\\demo-proj'), 'C--Users-jdoe-demo-proj');
});

test('projectFolder maps a POSIX path', () => {
  assert.equal(projectFolder('/Users/jdoe/demo-proj'), '-Users-jdoe-demo-proj');
});

test('projectFolder is idempotent on a bare name (no separators)', () => {
  assert.equal(projectFolder('proj-a'), 'proj-a');
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
    'projects/proj-a/sess1.jsonl': turn({ id: 'a1' }),
    'projects/proj-a/sess1/subagents/agent-x.jsonl': turn({ id: 'a1-sub' }),
    'projects/proj-b/sess2.jsonl': turn({ id: 'b1' }),
  });
  const r = audit(dir, '--project', 'proj-a');
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
