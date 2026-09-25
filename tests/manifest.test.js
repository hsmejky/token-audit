const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Repo is public: manifests must not carry a personal email. Any email
// present must be a GitHub noreply address.
const ROOT = path.join(__dirname, '..');
const MANIFESTS = ['plugin/.claude-plugin/plugin.json', '.claude-plugin/marketplace.json'];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

for (const rel of MANIFESTS) {
  test(`${rel}: no personal email (only GitHub noreply allowed)`, () => {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    JSON.parse(text);
    const personal = (text.match(EMAIL) || []).filter((e) => !e.endsWith('@users.noreply.github.com'));
    assert.deepEqual(personal, []);
  });
}
