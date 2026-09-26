# Working on token-audit

## Project

A Claude Code plugin: one dependency-free Node script plus a skill. See
[docs/architecture.md](../docs/architecture.md) for the pipeline, file layout and test
layout — don't duplicate it here. Design reasoning is in
[docs/decisions.md](../docs/decisions.md); open work is in
[docs/roadmap.md](../docs/roadmap.md).

## Constraints

- Zero dependencies, plain Node (`fs`, `path`, `readline`, `crypto`, `os`,
  `child_process`). No `package.json`.
- Node 18 or newer. Keep the suite green on Node 18 and current LTS releases.
- Every regex or scanner over transcript-derived text must stay linear on
  pathological input (tested up to ~200k characters) — no unbounded
  backtracking, no accidental quadratic scans.

## Tests

- Run: `node --test tests/*.test.js`.
- Details on structure, fixtures, the privacy guard and perf-test CI scaling:
  [docs/testing.md](../docs/testing.md).
- Run the full suite green before every commit.

## Privacy (this is a public repo)

- No Windows usernames, no real project names, no session IDs, no local
  filesystem paths, no text pasted from real transcripts, and no real numbers
  in `docs/` — fixtures and docs use synthetic data only.
- The author's name appears only in `LICENSE` and package/plugin manifests.
- `tests/manifest.test.js` is the automated privacy guard; it must keep
  passing.

## Commits

- Conventional Commits, imperative subject, no scope, no suffix like
  `(Slice N)`.
- No `Claude-Session:` trailer.

## Editing text

- No bulk find/replace across prose (docs, comments, user-facing strings).
  Edit each occurrence deliberately so meaning isn't lost.

## Tracking work

- Open work and its acceptance criteria live in
  [docs/roadmap.md](../docs/roadmap.md), not in ad hoc TODOs.

## Codebase lookups

Codebase lookups that produce more than a few lines of output go to the Explore agent with model haiku, not inline reads.
