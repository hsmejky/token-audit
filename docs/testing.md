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

One test file acts as a guard for the public repository: it scans the documentation and
manifests for anything that shouldn't be there — a real e-mail address, a personal name outside
the license and package manifests, a real filesystem path, an identifier that looks like it was
copied out of a live transcript rather than written by hand.

The guard checks candidate terms against a hashed list rather than a plaintext one, so the list
of things to avoid isn't itself a map of what to avoid. If you need to add a legitimate exception
(a synthetic name or path that happens to look real, or a new documentation file the guard should
also cover), extend the guard's allowlist and say why in the commit — don't loosen the check
itself without a reason recorded there.

## Performance tests

Some tests feed the script pathological input (very long commands, deeply nested shell
constructs, many repeated flags) and assert that parsing finishes within a time limit, to catch
accidental non-linear behaviour before it ships. These tests are never skipped.

Because a CI runner is slower and noisier than a developer's machine, every such assertion goes
through one shared helper that multiplies the limit when the `CI` environment variable is set,
instead of each test hard-coding its own allowance. If a performance test is flaky in CI, adjust
the shared helper or the specific limit — don't skip the test and don't duplicate the
CI-detection logic locally.

## CI

Continuous integration runs the full suite on every push and pull request, across a matrix of
supported Node versions and both a Linux and a Windows runner, with no dependency installation
step. A change that only passes on one platform or one Node version isn't done.
