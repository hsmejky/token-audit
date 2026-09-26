const test = require('node:test');
const assert = require('node:assert/strict');
const { audit, auditText, tmpClaudeDir, perfLimit } = require('./harness');
const { redactPaths } = require('../plugin/skills/token-audit/scripts/token-audit.js');

// Secret layer of the shared printed-key redaction (redactPaths), which POLLING keys
// and BOILERPLATE prefixes both go through, plus BOILERPLATE's `NAME=<value>` rule
// for literal assignment values. See REFERENCE.md "POLLING" / "BOILERPLATE".
//
// Every fake secret carries the marker Zqxv and no digit, so commandKey()'s N / <id>
// rewrites leave it intact: output must never contain the marker, in any case.
const LEAK = /zqxv/i;
const tok = p => `${p}ZqxvAbcdEfghIjklMnopQrstUvwx`;
const JWT = 'eyJZqxvHeaderPart.eyJZqxvPayloadPart.ZqxvSignaturePart';
const NO_ID = {};

// [what, command fragment carrying a secret]
const SHAPES = [
  ['ghp_ token', `echo ${tok('ghp_')}`],
  ['gho_ token', `echo ${tok('gho_')}`],
  ['ghs_ token', `echo ${tok('ghs_')}`],
  ['github_pat_ token', `echo ${tok('github_pat_')}`],
  ['sk- key', `echo ${tok('sk-')}`],
  ['sk-ant- key', `echo ${tok('sk-ant-api-')}`],
  ['xoxb- token', `echo ${tok('xoxb-')}`],
  ['xoxp- token', `echo ${tok('xoxp-')}`],
  ['AKIA key id', 'aws configure set aws_access_key_id AKIAZQXVZQXVZQXVZQXV'],
  ['JWT', `echo ${JWT}`],
  ['Authorization: token header', 'curl -H "Authorization: token Zqxvopaque" https://x.test/a'],
  ['Authorization: Bearer header', "curl -H 'Authorization: Bearer Zqxvopaque' https://x.test/a"],
  ['Authorization: Basic header', 'curl -H "authorization: basic Zqxvopaque" https://x.test/a'],
  ['bare Bearer', 'http x.test/a "Bearer Zqxvopaque"'],
  ['X-Api-Key header', 'curl -H "X-Api-Key: Zqxvopaque" https://x.test/a'],
  ['-u user:pass', 'curl -u jdoe:Zqxvpass https://x.test/a'],
  ['--user=user:pass', 'curl --user="jdoe:Zqxvpass" https://x.test/a'],
  ['--password=', 'mysql --password=Zqxvpass -e "select N"'],
  ['--token value', 'deploy-tool --token Zqxvpass'],
  ['--api-key=', 'tool --api-key=Zqxvpass'],
  ['URL credentials', 'curl -s https://jdoe:Zqxvpass@api.test/a'],
  ['NAME=value, digit-free password', 'export DB_PASSWORD=Zqxvhunter'],
  ['quoted NAME=value', `GH_TOKEN="Zqxv opaque value"`],
  ['PowerShell $env:NAME=value', `$env:GH_TOKEN='Zqxvopaque'`],
  ['URL query token=', 'curl "https://x.test/a?access_token=Zqxvopaque&x=y"'],
  // marker is not the quoted value's first word, so a bug that redacts only the
  // first word (leaving the rest of the quote to print raw) is caught.
  ['--password= quoted value with spaces', `tool --password "pass Zqxv phrase"`],
  ['-u quoted user:pass with spaces', `curl -u 'jdoe:pass Zqxv word'`],
  ['--user= quoted user:pass with spaces', `curl --user "jdoe:pass Zqxv word"`],
  ['Cookie header, second pair', `curl -H "Cookie: session=a; other=${tok('Zqxv')}" https://x.test/a`],
  ['--oauth2-bearer', `curl --oauth2-bearer ${tok('Zqxv')} https://x.test/a`],
  ['JSON body password key', `curl -d '{"password":"${tok('Zqxv')}"}' https://x.test/a`],
  ['JSON body token key, spaced colon', `curl -d '{"token": "${tok('Zqxv')}"}' https://x.test/a`],
  ['mysql -pX', `mysql -p${tok('Zqxv')}`],
  ['sshpass -p X', `sshpass -p ${tok('Zqxv')} ssh host`],
  ['docker login -p X', `docker login -p ${tok('Zqxv')} registry.test`],
  ['mysql -u before -p', `mysql -u root -p${tok('Zqxv')} db`],
  ['mysql --user= before -p', `mysql --user=root -p${tok('Zqxv')}`],
  ['docker login -u before -p', `docker login -u me -p ${tok('Zqxv')} registry.test`],
  ['single-quoted --password $-literal', `tool --password '$${tok('Zqxv')}'`],
  ['single-quoted header $-literal',
    `curl -H 'Authorization: token $${tok('Zqxv')}' https://x.test/a`],
  ['gh secret set --body', `gh secret set MY_SECRET --body ${tok('Zqxv')}`],
  ['gh secret set -b (short form)', `gh secret set MY_SECRET -b ${tok('Zqxv')}`],
  ['npm :_authToken space form', `npm config set //registry.npmjs.org/:_authToken ${tok('Zqxv')}`],
  ['secret-named assignment via $(echo …)', `TOKEN=$(echo ${tok('Zqxv')}) && curl x`],
  ['single-quoted literal starting with $', `PASSWORD='$${tok('ecretZqxv')}'`],
];

for (const [what, cmd] of SHAPES) {
  test(`secret layer: ${what} → <secret>`, () => {
    const out = redactPaths(cmd, NO_ID);
    assert.ok(!LEAK.test(out), out);
    assert.match(out, /<secret>/, out);
  });
}

test('secret layer: normal keys stay readable (no over-redaction)', () => {
  for (const k of ['echo a=b', 'echo -o=json', 'echo key:value', 'export PYTHONIOENCODING=utf-N && python x.py',
    'curl -s -H "Authorization: token $TOKEN" https://api.github.com/user',
    String.raw`TOKEN=$(printf 'protocol=https\nhost=github.com\n' | git credential fill | sed -n 's/^password=//p')`,
    'git push -u origin main', 'sort --key=N f', 'gh auth login --with-token < <path>',
    'curl -u "$GH_USER:$GH_PASS" https://x.test', 'deploy --token "$TOKEN"', 'export GH_TOKEN=${GH_TOKEN}',
    'curl -s https://api.github.com/repos/o/r/actions/runs?per_page=N', 'npm run task-list-summary-for-ci',
    'mkdir -p a', 'ssh -p 22 host', 'mysql -p db', String.raw`TOKEN=$(printf 'protocol=https\nhost=github.com\n' | ` +
    `git credential fill | sed -n 's/^password=//p')`,
    'mysql -P 3306 -h h', 'mysql -P3306 db', 'mysql -h h -P N -p db', 'mysql -p$MYSQL_PWD db', 'mysql -p"$PW" db',
    'sshpass -f pwfile ssh -p N host', 'sshpass -p $PW ssh -p N host', 'sshpass -P assword ssh -p N h',
    'docker login -p $PW reg; ssh -p N h', 'docker run -p N:N img', 'mysql db; ssh -pN host',
    'docker login -u me reg && ssh -p N host', 'gh secret set N --repo o/web-build -b $B', 'gh secret set N -b"$B"']) {
    assert.equal(redactPaths(k, NO_ID), k);
  }
});

// `-p` password of mysql / sshpass / docker login: every password occurrence is
// redacted and every other token (flags, hosts, a later `ssh -p N`) kept exactly.
const S = tok('Zqxv');
const SHORT_P_EXACT = [
  [`mysql -p${S} -P N`, 'mysql -p<secret> -P N'],
  [`sshpass -p ${S} ssh -p $PORT host`, 'sshpass -p <secret> ssh -p $PORT host'],
  [`docker login -p ${S} reg; ssh -p $P h`, 'docker login -p <secret> reg; ssh -p $P h'],
  [`mysql -p${S} db < x; ssh -p N host`, 'mysql -p<secret> db < x; ssh -p N host'],
  [`mysql -p${S} -h h -p db`, 'mysql -p<secret> -h h -p db'],
  [`sshpass -p ${S} ssh -p N host`, 'sshpass -p <secret> ssh -p N host'],
  [`mysql -u root -p${S} db`, 'mysql -u root -p<secret> db'],
  [`docker login -u 'me' -p ${S}`, "docker login -u 'me' -p <secret>"],
  [`docker login -u "me" -p ${S} reg`, 'docker login -u "me" -p <secret> reg'],
  [`mysql -p"${S}"`, 'mysql -p"<secret>"'],
  [`mysql -p'${S}' db`, "mysql -p'<secret>' db"],
  [`sshpass -p '$${S}' ssh h`, "sshpass -p '<secret>' ssh h"],
  [`sshpass -p${S} ssh -p N h`, 'sshpass -p<secret> ssh -p N h'],
  [`sshpass -e -p "${S} two" ssh h`, 'sshpass -e -p "<secret>" ssh h'],
  [`mysql -h h -p${S} -e "select N" && mysql -p${S} db`,
    'mysql -h h -p<secret> -e "select N" && mysql -p<secret> db'],
  [`bash -c "mysql -u root -p${S} db"`, 'bash -c "mysql -u root -p<secret> db"'],
  [`X=$(docker login -u me -p ${S} reg)`, 'X=$(docker login -u me -p <secret> reg)'],
  [`sudo /usr/bin/mysql -p${S}\nssh -p N h`, 'sudo <path> -p<secret>\nssh -p N h'],
  [`gh secret set N -b${S}`, 'gh secret set N -b<secret>'],
  [`gh secret set N -b'${S}'`, "gh secret set N -b'<secret>'"],
  // a quoted part anywhere in a word, escaped nested quotes, deeper nesting, an
  // unterminated quote (runs to the end); quotes and redirects kept exactly as typed
  [`x --cmd="mysql -p${S} db"`, 'x --cmd="mysql -p<secret> db"'],
  [`bash -c "bash -c \\"mysql -p${S}\\""`, 'bash -c "bash -c \\"mysql -p<secret>\\""'],
  [`bash -c "sh -c 'bash -c \\"mysql -p${S}\\"'"`, `bash -c "sh -c 'bash -c \\"mysql -p<secret>\\"'"`],
  [`"mysql -p${S}`, '"mysql -p<secret>'],
  [`bash -c "mysql -p${S}`, 'bash -c "mysql -p<secret>'],
  [`mysql -p'${S}`, "mysql -p'<secret>"],
  [`mysql -p${S}>out.txt`, 'mysql -p<secret>>out.txt'],
  [`mysql -p"${S}"'${S}' db`, `mysql -p"<secret>"'<secret>' db`],
];
for (const [cmd, want] of SHORT_P_EXACT) {
  test(`secret layer: -p password redacted, rest kept — ${want}`, () => {
    assert.equal(redactPaths(cmd, NO_ID), want);
  });
}

test('secret layer: Cookie header redacts the whole value, not just the first pair', () => {
  const out = redactPaths(`curl -H "Cookie: session=abc; other=${tok('Zqxv')}" https://x.test/a`, NO_ID);
  assert.ok(!LEAK.test(out), out);
  assert.match(out, /Cookie: <secret>/, out);
});

test('secret layer is fast on 200k-char pathological inputs', () => {
  for (const s of ['eyJ' + 'a'.repeat(200000), '-u a:'.repeat(40000), 'Authorization:'.repeat(15000),
    'A_TOKEN="'.repeat(20000), '--token'.repeat(30000), '//a:'.repeat(50000), 'x-token-'.repeat(25000),
    'ghp_'.repeat(50000), 'sk-'.repeat(70000), 'Bearer '.repeat(30000), 'TOKEN'.repeat(40000) + '=x',
    '-' + 'a'.repeat(200000), 'X-' + 'a'.repeat(200000) + ':', '"token"'.repeat(20000),
    'A_TOKEN=$(echo '.repeat(15000), 'mysql -p'.repeat(20000), '--oauth2-bearer'.repeat(20000),
    'gh secret set '.repeat(10000) + '--body', ':_authToken '.repeat(20000), 'sshpass -p'.repeat(20000),
    'docker login -p '.repeat(12000), 'mysql -pX '.repeat(20000), 'bash -c "'.repeat(20000), '"'.repeat(200000),
    "'\\".repeat(100000), 'sshpass -f '.repeat(20000), 'gh secret set N -b'.repeat(10000), '\\'.repeat(200000),
    '\\"'.repeat(100000), 'bash -c "sh -c \''.repeat(15000), 'x="'.repeat(70000), '"\\"mysql -pX '.repeat(15000),
    'mysql ' + "-p'".repeat(60000), 'mysql -p' + '"a"'.repeat(60000), 'bash -c "' + '\\\\\\"'.repeat(50000),
    '"'.repeat(100000) + 'mysql -pX', "'\\\"".repeat(60000), 'bash -c "sh -c \'bash -c \\"'.repeat(8000)]) {
    const t0 = Date.now();
    redactPaths(s, NO_ID);
    assert.ok(Date.now() - t0 < perfLimit(1000), `${Date.now() - t0}ms for ${s.slice(0, 12)}…`);
  }
});

// ---- both flags, end to end (text and --json)
const USAGE = { input_tokens: 1e6, output_tokens: 0 };
const bashTurns = (n, id, cmd) => Array.from({ length: n }, (_, i) => ({
  type: 'assistant', timestamp: '2026-09-01T10:00:00.000Z',
  message: { id: `${id}-${i}`, model: 'claude-opus-5-5', role: 'assistant', usage: USAGE,
    content: [{ type: 'tool_use', id: `${id}-${i}-tu`, name: 'Bash', input: { command: cmd } }] },
}));
const flagOf = (r, id) => r.flags.find(f => f.id === id);

test('POLLING: no secret shape prints, in the text or --json', () => {
  const files = {};
  SHAPES.forEach(([, cmd], i) => {
    files[`projects/p/s${i}.jsonl`] = bashTurns(20, `s${i}`, `${cmd} && sleep 5`);
  });
  const dir = tmpClaudeDir(files);
  const f = flagOf(audit(dir), 'POLLING');
  assert.ok(f);
  assert.equal(f.groups.length, SHAPES.length, f.groups.map(g => g.key).join('\n'));
  for (const g of f.groups) assert.ok(!LEAK.test(g.key) && /<secret>/.test(g.key), g.key);
  const text = auditText(dir);
  assert.ok(!LEAK.test(text), text.split('\n').filter(l => LEAK.test(l)).join('\n'));
});

// [what, setup prefix, printed prefix or null (only checked for no leak)]
const BOILER_SHAPES = [
  ['export GH_TOKEN=ghp_…', `export GH_TOKEN=${tok('ghp_')}`, 'export GH_TOKEN=<value>'],
  ['export ANTHROPIC_API_KEY=sk-ant-…', `export ANTHROPIC_API_KEY=${tok('sk-ant-api-')}`,
    'export ANTHROPIC_API_KEY=<value>'],
  ['digit-free password', 'PGPASSWORD=Zqxvhunter', 'PGPASSWORD=<value>'],
  ['quoted literal', 'MODE="Zqxv literal"', 'MODE=<value>'],
  ['token header inside $(…)', `TOKEN=$(curl -s -H "Authorization: token ${tok('ghp_')}" https://x.test/t)`, null],
  ['-u inside $(…)', 'DATA=$(curl -s -u jdoe:Zqxvpass https://x.test/d)', null],
  ['--password= inside $(…)', 'OUT=$(tool --password=Zqxvpass)', null],
  ['JWT inside $(…)', `J=$(echo ${JWT})`, null],
];

test('BOILERPLATE: literal values print as NAME=<value>, secrets in $(…) as <secret>; text and --json', () => {
  const files = {};
  BOILER_SHAPES.forEach(([, prefix], i) => {
    for (let s = 0; s < 5; s++) {
      files[`projects/p/b${i}-s${s}.jsonl`] = bashTurns(1, `b${i}-${s}`, `${prefix} && python x.py`);
    }
  });
  const dir = tmpClaudeDir(files);
  const f = flagOf(audit(dir), 'BOILERPLATE');
  assert.ok(f);
  assert.equal(f.groups.length, BOILER_SHAPES.length, f.groups.map(g => g.prefix).join('\n'));
  const printed = new Set(f.groups.map(g => g.prefix));
  for (const [what, , want] of BOILER_SHAPES) if (want) assert.ok(printed.has(want), `${what}: ${[...printed]}`);
  for (const g of f.groups) assert.ok(!LEAK.test(g.prefix), g.prefix);
  const text = auditText(dir);
  assert.ok(!LEAK.test(text), text.split('\n').filter(l => LEAK.test(l)).join('\n'));
});

test('BOILERPLATE: grouping stays on the raw value — two different literal values are two groups', () => {
  const files = {};
  for (let s = 0; s < 6; s++) {
    const value = s < 3 ? 'Zqxva' : 'Zqxvb';
    files[`projects/p/s${s}.jsonl`] = bashTurns(1, `s${s}`, `export GH_TOKEN=${value} && gh pr list`);
  }
  assert.equal(flagOf(audit(tmpClaudeDir(files)), 'BOILERPLATE'), undefined);
});

// Shapes that leaked or got mangled in earlier redaction passes.
test('secret layer: quoted mysql path (PowerShell `& "…\mysql.exe"`) still redacts -pX', () => {
  for (const cmd of [String.raw`& "C:\Program Files\MySQL\bin\mysql.exe" -p${S} db`,
    String.raw`& 'C:\Program Files\MySQL\bin\mysql.exe' -p${S}`, `"/usr/bin/mysql" -p${S}`]) {
    const out = redactPaths(cmd, NO_ID);
    assert.ok(!LEAK.test(out) && /-p<secret>/.test(out), out);
  }
});

test('secret layer: escaped-quote references (\\"$PW\\") stay intact, not path-mangled', () => {
  for (const k of [String.raw`bash -c "mysql -p\"\$PW\""`, String.raw`bash -c "echo \"\$PW\""`,
    String.raw`echo \"\$PW\"`]) {
    assert.equal(redactPaths(k, NO_ID), k);
  }
});

test('secret layer: a literal part glued after a reference (-p$X\'lit\') still redacts', () => {
  assert.equal(redactPaths(`mysql -p$X'${S}' db`, NO_ID), "mysql -p$X'<secret>' db");
  assert.equal(redactPaths(`mysql -p"$X"${S} db`, NO_ID), 'mysql -p"$X"<secret> db');
});

test('secret + path layers stay linear on 200k-char escape / quoted-path runs', () => {
  for (const s of ['\\$'.repeat(100000), ' \\"'.repeat(66000), '"/a\\$'.repeat(40000),
    '& "C:\\x\\mysql.exe" -p'.repeat(9000), "mysql -p$X'a'".repeat(15000)]) {
    const t0 = Date.now();
    redactPaths(s, NO_ID);
    assert.ok(Date.now() - t0 < perfLimit(1000), `${Date.now() - t0}ms for ${s.slice(0, 12)}…`);
  }
});
