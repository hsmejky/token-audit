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
const DOCS_DIR = path.join(ROOT, 'docs');

test('docs/ exists and holds the public design docs', () => {
  const names = fs.readdirSync(DOCS_DIR);
  for (const n of ['architecture.md', 'decisions.md', 'roadmap.md']) assert.ok(names.includes(n), n);
});

const DOC_FILES = fs.existsSync(DOCS_DIR)
  ? fs.readdirSync(DOCS_DIR).filter((n) => n.endsWith('.md')).map((n) => `docs/${n}`) : [];
for (const rel of [...DOC_FILES, 'README.md']) {
  test(`${rel}: no personal email or private word`, () => {
    assertNoPersonalEmail(rel);
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const word = findPrivateWord(text);
    assert.equal(word, null, `${rel} contains a forbidden private word`);
  });
}
