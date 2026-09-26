const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Repo is public: manifests (and, since Slice 27, README.md) must not carry
// a personal email. Any email present must be a GitHub noreply address.
const ROOT = path.join(__dirname, '..');
const JSON_MANIFESTS = ['plugin/.claude-plugin/plugin.json', '.claude-plugin/marketplace.json'];
const TEXT_FILES = ['README.md'];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function assertNoPersonalEmail(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const personal = (text.match(EMAIL) || []).filter((e) => !e.endsWith('@users.noreply.github.com'));
  assert.deepEqual(personal, []);
}

for (const rel of JSON_MANIFESTS) {
  test(`${rel}: no personal email (only GitHub noreply allowed)`, () => {
    JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    assertNoPersonalEmail(rel);
  });
}

for (const rel of TEXT_FILES) {
  test(`${rel}: no personal email (only GitHub noreply allowed)`, () => {
    assertNoPersonalEmail(rel);
  });
}

// Slice 32: public design docs (docs/*.md) were rewritten from private notes. Guard them
// (and README.md) against a personal email and two private terms: a local account name and
// the name of the author's other, unrelated project.
//
// The two private terms are matched by hashing whole words, not by a literal substring
// regex (Slice 32 fixup: the earlier version spelled the terms out in a regex and a comment,
// right here in the file meant to guard against exactly that). Text is lower-cased and split
// on runs of non-alphanumeric characters, so only a word that is *exactly* one of the private
// terms is flagged — a shared prefix (the public GitHub handle) hashes differently and passes.
// Whole-word comparison is a deliberate trade-off: it will not catch a private term glued to
// another word with no separator (e.g. run together with an adjacent word). Accepted for now.
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const FORBIDDEN_WORD_HASHES = new Set([
  '46bcb25fd6b1b61b8fcd513530081e6759f1f6574064a17f650785d0efd35d29',
  '3e6f3ef30c9311c7086582f5a7f015c3485ba4d2cbccbb059c19122e2c6ea359',
]);
function findPrivateWord(text) {
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w && FORBIDDEN_WORD_HASHES.has(sha256(w))) return w;
  }
  return null;
}
// Generic patterns, checked as regexes (not hashed: they describe a *shape*, not a fixed
// word). A literal Windows/POSIX user-profile path or a UUID-shaped id (a real session id) has
// no business in a published doc/plugin file/fixture at all, private-term or not.
// Matches single- or doubled-backslash (JSON-escaped, as a .jsonl fixture stores it) and
// forward-slash spellings of the drive form: `C:\Users\bob`, `C:\\Users\\bob`, `C:/Users/bob`.
const WIN_USER_PATH = /C:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\\/:*?"<>|\r\n]+/i;
// POSIX form: `/home/bob`, `/Users/bob` (macOS).
const POSIX_USER_PATH = /\/(?:home|Users)\/[^\\/:*?"<>|\r\n]+/i;
const SESSION_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

const DOCS_DIR = path.join(ROOT, 'docs');
const PLUGIN_DIR = path.join(ROOT, 'plugin');
const FIXTURES_DIR = path.join(ROOT, 'tests', 'fixtures');

test('docs/ exists and holds the public design docs', () => {
  const names = fs.readdirSync(DOCS_DIR);
  for (const n of ['architecture.md', 'decisions.md', 'roadmap.md']) assert.ok(names.includes(n), n);
});

function walk(dir) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walk(full));
    else out.push(full);
  }
  return out;
}
const toRel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

const DOC_FILES = fs.existsSync(DOCS_DIR)
  ? fs.readdirSync(DOCS_DIR).filter((n) => n.endsWith('.md')).map((n) => `docs/${n}`) : [];
// Slice 32 minor: the guard originally covered only docs/ and README.md. Extend it to the
// published plugin content (REFERENCE.md, SKILL.md, the manifest, the script) and the test
// fixtures, since any of those could just as easily carry a leaked private word or path.
const PLUGIN_FILES = fs.existsSync(PLUGIN_DIR)
  ? walk(PLUGIN_DIR).filter((f) => /\.(md|json|js)$/.test(f)).map(toRel) : [];
const FIXTURE_FILES = fs.existsSync(FIXTURES_DIR)
  ? walk(FIXTURES_DIR).filter((f) => f.endsWith('.jsonl')).map(toRel) : [];
// REFERENCE.md and the script carry synthetic `C:\Users\<name>` (and `/home/<name>`, …)
// examples throughout (worked documentation), so the generic user-path patterns would
// false-positive there. Only the path-shape check is skipped for them — neither file contains
// a UUID, so the UUID-shape check still runs, and the word-hash check above still applies too.
const NO_PATH_CHECK = new Set([
  'plugin/skills/token-audit/REFERENCE.md',
  'plugin/skills/token-audit/scripts/token-audit.js',
]);

for (const rel of [...DOC_FILES, 'README.md']) {
  test(`${rel}: no personal email or private word`, () => {
    assertNoPersonalEmail(rel);
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const word = findPrivateWord(text);
    assert.equal(word, null, `${rel} contains a forbidden private word`);
    assert.equal(WIN_USER_PATH.test(text), false, `${rel} contains a literal Windows user path`);
    assert.equal(POSIX_USER_PATH.test(text), false, `${rel} contains a literal POSIX user path`);
    assert.equal(SESSION_UUID.test(text), false, `${rel} contains a UUID-shaped id`);
  });
}

// PLUGIN_FILES: private-word and shape checks only — REFERENCE.md and the script use
// synthetic example addresses (`user@host.tld`) as worked documentation, so extending the
// personal-email regex to them would flag those examples, not a leak.
for (const rel of PLUGIN_FILES) {
  test(`${rel}: no private word`, () => {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const word = findPrivateWord(text);
    assert.equal(word, null, `${rel} contains a forbidden private word`);
    if (!NO_PATH_CHECK.has(rel)) {
      assert.equal(WIN_USER_PATH.test(text), false, `${rel} contains a literal Windows user path`);
      assert.equal(POSIX_USER_PATH.test(text), false, `${rel} contains a literal POSIX user path`);
    }
    assert.equal(SESSION_UUID.test(text), false, `${rel} contains a UUID-shaped id`);
  });
}

// Fixtures: hashed private words and a literal user path are always a leak. A UUID-shaped id
// is NOT checked here — real Claude Code transcripts use UUIDs for message and session ids,
// so a future fixture built from realistic-looking data would legitimately contain one; that
// would be a false positive, not a leak (today's two fixtures use plain `sess-000N`/`msg_A`
// ids and have none, but the exclusion is deliberate, not incidental).
for (const rel of FIXTURE_FILES) {
  test(`${rel}: no private word or literal user path`, () => {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const word = findPrivateWord(text);
    assert.equal(word, null, `${rel} contains a forbidden private word`);
    assert.equal(WIN_USER_PATH.test(text), false, `${rel} contains a literal Windows user path`);
    assert.equal(POSIX_USER_PATH.test(text), false, `${rel} contains a literal POSIX user path`);
  });
}
