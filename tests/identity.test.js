const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { auditEnv, tmpClaudeDir, tmpUserConfig, turn, perfLimit } = require('./harness');
const { projectFolder } = require('../plugin/skills/token-audit/scripts/token-audit.js');

// Slice 29: every printed field that can carry a path or the user's identity goes
// through redactPaths(). Identity is injected through the environment: home folder
// "Petr Svarc" (HOME/USERPROFILE), an empty git config (no user.name).
const NAME = /petr|svarc/i;
function petrHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-id29-'));
  const home = path.join(tmp, 'Petr Svarc');
  fs.mkdirSync(path.join(home, 'proj'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'gitconfig'), '');
  const env = { HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1' };
  return { home, env };
}
const leaked = out => (out.match(new RegExp(`.{0,40}(?:${NAME.source}).{0,40}`, 'gi')) || []).join('\n');

function petrClaudeDir(home) {
  const P = 'projects/C--Users-Petr-Svarc-proj';
  const SUB = `${P}/main-uuid/subagents/agent-a1`;
  const dir = tmpClaudeDir({
    [`${P}/main-uuid.jsonl`]: [...turn({ id: 'm-1' }), ...turn({ id: 'm-2', model: 'claude-svarc-9' })],
    [SUB + '.jsonl']: turn({ id: 's-1' }),
    [SUB + '.meta.json']: { description: String.raw`Fix C:\Users\Petr Svarc\proj for Petr` },
    [`projects/${projectFolder(path.join(home, 'proj'))}/s2.jsonl`]: turn({ id: 'p-1' }),
    'settings.json': { model: 'svarc-model', enabledPlugins: { 'svarc-tools@petr-market': true } },
    'plugins/cache/petr-market/svarc-tools/.claude-plugin/plugin.json': {},
  });
  tmpUserConfig(dir, { mcpServers: { 'svarc-db': {} } });
  return dir;
}

test('identity: home "Petr Svarc" + project C--Users-Petr-Svarc-proj → no name in text or --json', () => {
  const { home, env } = petrHome();
  const dir = petrClaudeDir(home);
  const base = ['--claude-dir', dir, '--days', '36500'];
  for (const args of [['--all'], ['--all', '--json'], ['--project', path.join(home, 'proj')],
    ['--project', path.join(home, 'proj'), '--json']]) {
    const out = auditEnv(env, [...base, ...args]);
    assert.ok(!NAME.test(out), `${args.join(' ')}:\n${leaked(out)}`);
  }
  const j = JSON.parse(auditEnv(env, [...base, '--all', '--json']));
  const projects = j.cur.sessions.map(s => s.project);
  assert.ok(projects.some(p => /<user>-proj$/.test(p)), projects.join(', '));
  assert.equal(j.config.mcpServers[0].name, '<user>-db');
});

test('identity: stderr errors (no transcripts / no project) carry no name', () => {
  const { home, env } = petrHome();
  const run = (e, args) => {
    try { auditEnv(e, args); } catch (err) { return String(err.stderr); }
    assert.fail('expected a non-zero exit');
  };
  const missing = run({ ...env, CLAUDE_CONFIG_DIR: path.join(home, '.claude') }, ['--all']);
  assert.match(missing, /no transcripts at/);
  assert.ok(!NAME.test(missing), missing);
  const dir = petrClaudeDir(home);
  const noProj = run(env, ['--claude-dir', dir, '--project', path.join(home, 'nope')]);
  assert.match(noProj, /no project/);
  assert.ok(!NAME.test(noProj), noProj);
});

const { redactPaths } = require('../plugin/skills/token-audit/scripts/token-audit.js');
const PETR = { username: 'psvarc', home: String.raw`C:\Users\Petr Svarc`, name: 'Petr Svarc' };
const SVARC_NFC = '\u0160varc'; // Š as one code point
const SVARC_NFD = 'S\u030Cvarc'; // S + combining caron

test('identity: name "Svarc" also redacts "Švarc" (NFC and NFD input), not inside a longer word', () => {
  for (const v of [SVARC_NFC, SVARC_NFD, SVARC_NFC.toUpperCase()]) {
    assert.equal(redactPaths(`echo ${v} done`, PETR), 'echo <user> done', JSON.stringify(v));
  }
  assert.equal(redactPaths(`C--Users-Petr-${SVARC_NFD}-proj`, PETR), 'C--Users-<user>-<user>-proj');
  assert.equal(redactPaths(`x${SVARC_NFC}y`, PETR), `x${SVARC_NFC}y`);
});

test('identity: accented identity (git name "Petr Švarc", NFD) redacts the plain "Svarc"', () => {
  const id = { username: '', home: '', name: `Petr ${SVARC_NFD}` };
  assert.equal(redactPaths('echo Svarc', id), 'echo <user>');
  assert.equal(redactPaths(`echo ${SVARC_NFC}`, id), 'echo <user>');
});

test('identity: accent folding stays linear on a 200k-char accented input', () => {
  const input = ('\u00e9a ' + 'S\u030C').repeat(40000);
  const t0 = Date.now();
  redactPaths(input, PETR);
  assert.ok(Date.now() - t0 < perfLimit(1000), `${Date.now() - t0} ms`);
});

test('security: git config read for identity is pinned to a safe cwd (home dir)', () => {
  // A cloned/malicious repo could plant its own `git`/`git.exe` in its working tree;
  // on Windows, an unpinned cwd lets that shadow the real git for execFileSync.
  // currentIdentity() must fix `cwd` to the home dir (not inherit the caller's), which
  // also cuts off any repo-local config that cwd would otherwise layer in.
  const scriptPath = require.resolve('../plugin/skills/token-audit/scripts/token-audit.js');
  const cp = require('child_process');
  const realExecFileSync = cp.execFileSync;
  let call = null;
  cp.execFileSync = (...args) => { call = args; return ''; };
  delete require.cache[scriptPath];
  try {
    const mod = require(scriptPath);
    mod.redactPaths('nothing to redact here');
    assert.ok(call, 'expected currentIdentity() to call execFileSync');
    const [cmd, cmdArgs, opts] = call;
    assert.equal(cmd, 'git');
    assert.deepEqual(cmdArgs, ['config', 'user.name']);
    assert.equal(opts.cwd, os.homedir());
  } finally {
    cp.execFileSync = realExecFileSync;
    delete require.cache[scriptPath];
  }
});

test('source: every line of the script and the tests is ≤ 120 chars', () => {
  const files = [require.resolve('../plugin/skills/token-audit/scripts/token-audit.js'),
    ...fs.readdirSync(__dirname).filter(f => f.endsWith('.js')).map(f => path.join(__dirname, f))];
  const long = files.flatMap(f => fs.readFileSync(f, 'utf8').split(/\r?\n/)
    .map((l, i) => [`${path.basename(f)}:${i + 1}`, l.length]).filter(([, n]) => n > 120));
  assert.deepEqual(long, []);
});
