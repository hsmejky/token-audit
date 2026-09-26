# Testing

How to run and extend the test suite. The pipeline and file layout the tests exercise are in
[architecture.md](architecture.md#test-layout); this document is about the tests themselves.

## Running

```
node --test tests/*.test.js
```

No dependencies to install, no build step. The suite is kept green on Node 18 and current LTS
releases; CI runs it on a small matrix of supported Node versions across Linux and Windows.

## Structure

- `tests/*.test.js` — one file per area of the script (collection and pricing, scope, config,
  each detector, flag ranking, layout budgets, redaction, the privacy guard).
- `tests/harness.js` — spawns the real script as a CLI against a fixture Claude directory
  (never the real user config directory) and returns either its `--json` output or the plain
  text report, plus helpers for building fixture data on the fly.
- `tests/fixtures/` — small, hand-readable fixture directories that stand in for a real
  Claude config directory. All names inside them are synthetic: made-up project names, made-up
  people, made-up session identifiers. Nothing here is drawn from a real transcript.

## Privacy guard

One test file (`tests/manifest.test.js`) acts as a guard for the public repository. It scans
docs, the plugin manifest and script, fixtures, `.claude/CLAUDE.md` and `.github/` for four kinds
of leak: a personal e-mail address (only a GitHub noreply address is allowed), a hashed private
word (a local account name or the author's other, unrelated project), a literal Windows/POSIX
user-profile path, and a UUID-shaped id (a real session id).

Private words are checked against a hashed list rather than a plaintext one, so the list of
things to avoid isn't itself a map of what to avoid. There's no general allowlist: the guard has
two narrow, named exceptions instead — `NO_PATH_CHECK` skips the path-shape check for the handful
of files (REFERENCE.md, the script) that use synthetic `C:\Users\<name>`-style examples as worked
documentation, and the e-mail check exempts `@users.noreply.github.com` addresses. If you need a
new exception, extend one of those two mechanisms and say why in the commit — don't loosen the
check itself without a reason recorded there.

## Performance tests

Some tests feed the script pathological input (very long commands, deeply nested shell
constructs, many repeated flags) and assert that parsing finishes within a time limit, to catch
accidental non-linear behaviour before it ships. These tests are never skipped.

Because a CI runner is slower and noisier than a developer's machine, every such assertion goes
through one shared helper that multiplies the limit, instead of each test hard-coding its own
allowance. The multiplier applies only when the `CI` environment variable is exactly `true` or
`1` (strict equality, not truthiness — a local `CI=false node --test ...` run must not get the
multiplier). If a performance test is flaky in CI, adjust the shared helper or the specific
limit — don't skip the test and don't duplicate the CI-detection logic locally.

## CI

Continuous integration runs the full suite across a matrix of supported Node versions and both
a Linux and a Windows runner, with no dependency installation step. It runs on every pull
request (any branch), and on every push to `main` only — not on push to other branches. A
change that only passes on one platform or one Node version isn't done.
