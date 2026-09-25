const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    JSON.parse(text);
    assertNoPersonalEmail(rel);
  });
}

for (const rel of TEXT_FILES) {
  test(`${rel}: no personal email (only GitHub noreply allowed)`, () => {
    assertNoPersonalEmail(rel);
  });
}
