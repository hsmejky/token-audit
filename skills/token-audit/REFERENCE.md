# token-audit reference

## Cost model

```
cost ≈ Σ over turns ( context_size × per-token rate )
```

Context is re-sent on **every** turn, so spend grows with `context × turns` — roughly
quadratic in session length, and nearly independent of how many files were read.
This single fact drives every playbook entry below.

`$/MTok` used by the script. Source: https://claude.com/pricing (lookup 2026-09-25).
The page publishes input, output, cache read and 5-minute cache write directly; the
1-hour cache write column is not on the page itself — it is documented as a flat 2×
the input rate, applied uniformly across models (confirmed at
https://platform.claude.com/docs/en/build-with-claude/prompt-caching#1-hour-cache-duration,
lookup 2026-09-25) and matches every model's 5m/1h ratio below, so it is used as-is
rather than re-derived per model.

| model | input | cache write 5m | cache write 1h | cache read | output |
|---|---|---|---|---|---|
| Opus 5.5 | 4 | 5.00 | 8 | 0.20 | 20 |
| Opus 5 | 5 | 6.25 | 10 | 0.50 | 25 |
| Fable 5.1 | 10 | 12.50 | 20 | 0.25 | 50 |
| Fable 5 | 10 | 12.50 | 20 | 1.00 | 50 |
| Sonnet 5 | 2 | 2.50 | 4 | 0.20 | 10 |
| Sonnet 4.6 | 3 | 3.75 | 6 | 0.30 | 15 |
| Haiku 4.5 | 1 | 1.25 | 2 | 0.10 | 5 |

`opus-5-5` was checked against the `Opus` row per the implementation plan's open
question — it does **not** match: Opus 5.5 is the current/cheaper tier, Opus 5 is
legacy pricing on the same page. The script gives `opus-5-5` its own rate row
(`PRICES.opus55`) so its actual (cheaper) cost is used, but keeps it in the same
`Opus` family bucket in SPEND/`byFamily` — the plan only asked for Fable to show as
its own SPEND family, and splitting the SPEND bucket too would move `OPUS_HEAVY`'s
threshold behaviour out of scope for this slice.

Likewise `fable-5` (legacy) does **not** match `fable-5-1`/`fable-5.1` (current):
input, cache write and output are identical, but cache read is $1/MTok for Fable 5
vs $0.25/MTok for Fable 5.1 — a plain `includes('fable')` match silently priced
Fable 5 at the Fable 5.1 rate. The script matches `fable-5-1`/`fable-5.1` before the
looser `fable-5`, and both still roll into the same `Fable` family bucket in SPEND.

Read multiplier is **not** a flat 0.1× for every model — the source page gives it per
row (e.g. Opus 5.5 reads at 0.05× input, Fable 5.1 at 0.025×), so the table above is
taken verbatim rather than computed. 5m write is 1.25× and 1h write is 2× input,
uniformly, per the prompt-caching doc above. When a transcript entry has no 5m/1h
breakdown the script assumes 1h (the pessimistic case). There is **no long-context
premium tier** on current models — a 900k request bills at the same per-token rate as
a 9k one.

### Unknown models — `UNPRICED`

A model string `rateFor` doesn't recognize is **not** dropped: `collect()` counts its
rows and total tokens (input + cache write + cache read + output, summed per raw
JSONL line — not deduped by `message.id`, since these tokens are never priced and
exact turn accounting doesn't matter here) and reports them under `UNPRICED`, keyed
by the literal model string. Printed as its own line below `SPEND` in the text report
(only when non-empty) and always present as top-level `unpriced` in `--json`, so a
new/renamed model family shows up as a visible line item instead of silently
vanishing from the totals the way Fable did before this fix.

`UNPRICED` is windowed the same as `SPEND` — only rows with `ts >= curFrom` (the
`--days` window) are counted, not all-time. It used to ignore `--days` entirely and
count every unpriced row ever seen while printing under the windowed `SPEND` header,
which misrepresented an all-time total as this-window activity.

## Flag playbook

Each flag the script prints maps to exactly one entry. Quote the script's number.

### `MULTIDAY` — sessions spanning more than a day

Largest single lever. A session left open across days re-reads its whole history on
every turn; cost per message climbs the whole time.

**Do:** finish the session, write the artifact (design md / plan md / issue), `/clear`,
reopen against the artifact. Never resume yesterday's session "just to ask one thing".

### `LONG_SESSION` — sessions ≥ 250 messages

Same mechanism, measured by turns instead of days. The script prints what share of
window spend these sessions hold — usually a quarter to a half from a handful of them.

**Do:** one session = one workflow phase. `/grill-me` → save md → `/clear` →
`/to-issues` reads the md → save → `/clear` → `/tdd`. The artifacts already exist;
use them as the handoff instead of conversation history.

**Repeat review is the single worst habit here.** "One more review" inside an old
session costs ~400k of context; the same review in a fresh session with the md loaded
costs ~20k — 20× cheaper, and more objective, because it cannot see its own earlier
reasoning.

### `LONG_AGENT` — subagents over 150 turns or 300k peak context

A subagent is just another session — the same "context re-sent every turn" mechanism as
`MULTIDAY`/`LONG_SESSION` applies to it too, but a fat implementer subagent is easy to miss
because it lives inside a work unit, not at the top of TOP SESSIONS. The script prints how
many subagents cross either threshold and their combined share of window spend. Thresholds
(`LONG_AGENT_TURNS` = 150, `LONG_AGENT_CTX` = 300k, named constants in the script) are
provisional, to be re-tuned on real data.

**Do:**
- Give the agent a hard `maxTurns` in its `.claude/agents/*.md` frontmatter. A limit hit
  returns a partial result instead of silently running the context up forever.
- One sub-task per agent → commit → short report → stop. Hand off through git (commits +
  report), not through carried conversation context.
- Send review findings to a **fresh** fix agent, never `SendMessage` back into the fat
  implementer — a fresh agent re-reads the diff instead of re-walking its own history.
- After `maxTurns` is hit, start a **new** agent with the report plus `git log`, rather than
  resuming — resuming carries the full prior history straight back in.

**Judgment calls:** design.md Q5 says "over N turns or peak context > 300k" but leaves three
details unstated; decided at implementation time:

**Decided**: both comparisons are strict `>` (151 turns fires, 150 does not; 300 001 ctx fires,
300 000 does not) — design.md phrases the threshold as "over N turns" and "peak context > 300k,"
both explicitly strictly-greater language. `LONG_SESSION` instead uses `>=`, because its own
threshold ("250 messages") is stated as the boundary itself, not phrased as "over 250".

**Decided**: "share of spend" is the flagged subagents' combined cost as a fraction of the
**current window's total spend** (`cur.cost`, main + subagent), not just the subagent chain's
own total — same denominator `LONG_SESSION` uses for `longShare`, so the two flags read the
same way ("X% of everything spent this window").

**Decided**: `LONG_AGENT` is checked in `flags()` immediately after `LONG_SESSION`, and its
REFERENCE entry sits in the same position — both are "a session ran too long" flags, one for
main sessions, one for subagents, so they read together.

### `POLLING` — the same command ≥ 20× in one session

Cost = turns × context: every "is it done yet?" check is a full turn that re-sends the
whole context, so a wait that takes 25 checks costs 25 turns of a long session. The script
prints the number of polling runs (session × command key with ≥ `POLL_MIN_CALLS` = 20
calls, a named constant, provisional — Slice 15 re-tunes it), their combined cost and share
of window spend, and the most expensive run's count and command key. `--json`: the flag
carries `groups[]` = `{ sid, parent, key, count, cost, share }`, most expensive first.
`parent` is the parent sid for a subagent group, `null` for a main session — needed because
the same subagent id spawned under two different parents shares one `sid`; `parent` is what
tells those two groups apart.

**Do:** turn the wait into one waiting turn instead of dozens:
- `gh pr checks --watch` (or `gh run watch`) — blocks until CI finishes, one call, one turn.
  Replaces curl loops over `check-runs` / `actions/runs`.
- `Monitor` — let the harness watch the process/log and wake the agent when it changes.
- `run_in_background` — start the long command in the background and read its output
  once at the end, instead of `cat`/`tail`-ing the output file every few turns.

Also never burn turns on purpose to wait (`echo waiting-N`, `sleep 30` one call at a time):
one `sleep`/`until … done` loop inside a single call waits for free.

**Judgment calls** (plan.md says "same normalized command ≥ N times", not which commands):

- **Unit = one Bash/PowerShell call, grouped by `commandKey()` per session** (`sessionKey`:
  a subagent is its own session, also vs. a same-named agent under another parent). Other
  tools (`Read`, `TaskOutput`, …) don't count — POLLING is about a *command*.
- **Only categories where a repeat is a wait count**: `POLL_CATEGORIES` = wait/poll, github,
  read, other. test/lint/build, git, edit and screenshot are excluded — a repeated test run
  is a TDD loop, not polling. Why not just wait/poll + github: on real transcripts
  (2026-09-25, all history) the bulk of real polling was `cat`/`tail` of background-task
  `.output` files (read), `tasklist` and `echo waiting-N` (other); wait/poll alone caught
  1 of ~10. Same key ≥ 20 over all categories gave 14 hits, 2 of them pytest loops.
- **Real-data result with this rule**: 12 runs. ~9 look like real polling (task-output
  tails, a `sleep` loop, `tasklist`, `echo waiting-N`, a log `grep | tail`). 2 are the same
  kind of collapse spread across many different files, not a wait: `cat "<file>"` ×63 (44
  distinct raw commands) and `tail -N "<file>"` ×40 (35 distinct raw commands) — quoted
  paths to different result files all normalize to the same `commandKey()`. 1 is unclear:
  `wc -c CLAUDE.md` ×78, a single identical raw command every time (could be a real repeated
  check or noise). A "gap between repeats" rule was tried and dropped: it didn't remove the
  spread-out-file collapses and cut a real log-polling run. Tightening this (e.g. requiring
  a dominant raw command share, or time-clustering the repeats) belongs in `polling()` itself,
  not `commandKey()` — deferred to Slice 15.
- **Cost = 1/n of an n-call turn** (same split as COST BY ACTIVITY), share of window spend.
- **Printed key is path-redacted**: `commandKey()` leaves some paths in (`O=/c/Users/…`
  assignments, `{ cd …; }`, `(cd …) 2>&1`, `$(cd …)`, unquoted `C:\…` args), so `polling()`'s
  `redactPaths()` masks what's left, in the text and in `groups[].key`. An unquoted absolute
  path is redacted after any of: start of key, whitespace, `=`, `(`, a quote/backtick, `>`,
  `<`, `@`, or `:` not immediately followed by `//` (redirects, `@file` args, `NAME=$VAR:/…`,
  `scp host:/…`) — still needs two path separators after the trigger, so an http(s) URL
  (`//` with nothing between) stays readable. `~` / `~user` need only one separator. A
  `file://` URL is redacted despite the `//`, since it names a local file. A Users/home path
  is redacted whole even when the name contains a literal or backslash-escaped space, quoted
  or not, in every spelling: `C:\Users\<name>` with single or doubled (string-escaped)
  backslashes, `/c/Users/<name>` (git-bash), `C:/Users/<name>`, `/mnt/c/Users/<name>` (WSL),
  `/home/<name>`, `/Users/<name>` (macOS), after the same triggers as above (so
  `PATH=$PATH:/home/Petr\ Svarc/bin` and `scp host:/home/…` too). The drive letter and the
  `Users`/`home` root word match case-insensitively (`c:\users`, `C:\USERS`, `/HOME`). The
  name segment excludes shell metacharacters, so a following `| tee …` isn't swallowed. A
  bare email (`user@host.tld`) is redacted to `<email>`; the match is anchored to the start
  of a `[\w.+-]` run so a long unbroken run of such characters (no real email) redacts in
  linear time instead of quadratic.
- **Value layer — the current user's name is redacted to `<user>`** wherever it is left in
  the key, whatever the path shape (`C--Users-Petr-Svarc-proj` project-folder form, a path
  the patterns above miss) or plain text, any case. Terms: the login name
  (`os.userInfo()`), the last segment of `os.homedir()` and git `user.name`, each whole and
  split on whitespace/`.`/`_`/`-` (home `C:\Users\Petr Svarc` → `Petr`, `Svarc`). A term
  counts only if it is ≥ 3 chars and not a generic account name (`user`, `admin`, `root`,
  `runner`, …), and matches only as a whole word (`Petr` doesn't touch `January`), so short
  or common names don't over-redact. Pattern rules catch *any* user's path; the value
  layer catches *this* user's name in shapes no pattern foresaw. Both are best-effort, not
  a guarantee for every possible shell construct. Only the printed key is redacted —
  grouping uses the raw key. The key is cut in the middle (`head…tail`) so the line stays
  ≤ 120 chars and both the program and e.g. `…/check-runs` stay visible.
- **Heredoc bodies are hashed raw** (commandKey step 1): a poll script re-run verbatim
  groups; the same script with a different PR number inside the body is a different key.
  Accepted: within one wait the body is identical (same PR), which is what a run counts.
  No real-data hit was heredoc-driven.

### `BIG_CTX` — average context per message > 150k

Threshold, not a cliff: nothing bills extra, but it means most turns are dragging
history nobody is reading. Correlates with context rot — quality drops with it.

**Do:** `/clear` more aggressively. Measured effect of doing exactly that: average
context 185k → 112k, cost per message halved, 4.4× more messages handled per week at
2.5× the cost, with quality up rather than down.

### `CONCENTRATION` — top 5 sessions ≥ 50 % of spend

Confirms the distribution is the problem, not the volume. Fixing the handful of long
sessions moves the total; trimming everything else does not.

**Do:** look at what those sessions have in common — usually one project, one
long-running feature, one habit of not clearing.

### `REGRESSION` — cost per message up > 25 % vs previous window

Habit is sliding back. This is the flag worth acting on even when absolute numbers
look fine.

**Do:** name the regression explicitly and check the WEEKS table for when it started.

### `OPUS_HEAVY` — Opus > 90 % of spend

Means no model-per-phase split is in effect. Opus is right for judgment, wasteful for
mechanics.

**Do:**
- Opus: `/grill-me`, `/review`, `/review-design`, `/review-plan`, orchestrating `/tdd`.
- Sonnet: `/commit`, `/gitlab-issue`, changelogs, scaffolding, CI YAML fixes, mechanical
  TDD loops, anything with a known shape.

Switch per phase with `/model`, not globally in `settings.json`.

### `PLUGIN_BLOAT` — many agent/skill definitions in the prompt prefix

Every installed agent and skill puts its name and description into the system prompt of
every request, forever. The script estimates the total and lists the worst plugins.

It sits in the cached prefix, so the direct cost is modest — but it is pure loss, and a
crowded agent roster measurably degrades agent selection.

**Do:** `/plugin uninstall` the ones never used. Keep what actually fires.

### `CLEAN`

No threshold breached. Say so in one line and stop.

## Security playbook

Printed in its own `SECURITY` block, never inside `FLAGS` — this is a confidentiality
risk, not a spend signal, and must not compete with cost items for the top-3 `DO NEXT`
slots.

### `NO_RETENTION` — `cleanupPeriodDays` unset

`~/.claude/projects/**/*.jsonl` is written by default on every installation,
unencrypted, and contains customer code, diffs and CI logs. Unset means no
cleanup ever runs — transcripts accumulate indefinitely, not just 30 days.
A set value (e.g. 30) does not fire this flag; 30 days is an acceptable
retention window.

**Do:** set `cleanupPeriodDays` in `settings.json` to the retention the project's rules
allow. Propose the diff; do not write it. Always surface this flag when it fires,
regardless of measured cost impact.

## Measured non-levers

Do not recommend these — they were measured and are noise:

| candidate | actual share of spend |
|---|---|
| all tool output (file reads, greps, bash) over full history | **≈ 0.15 %** |
| subagents (mostly Sonnet) | ≈ 15–20 %, and they are the cheap part |
| output tokens | ≈ 12 % |
| `effortLevel` overrides | negligible — `high` is already the default |

Corollary: offloading "read these files and summarise" to a cheaper external model
targets 0.15 % of spend. It cannot pay for itself, and for customer code it collides
with the confidentiality rules anyway.

## Baseline (first full measurement, 2026-08-04 → 2026-09-15)

> **Predates the dedupe fix — not comparable with current output.** This baseline counted
> every transcript line as a message. One API response is written as several lines
> (thinking / text / tool_use) sharing one `message.id`, so spend and message counts
> below are inflated ≈ 1.8× (all-time on this machine: 118 574 lines → 63 083 turns,
> $24.1k → $12.9k). The script now counts each `message.id` once. Do not read a trend
> into old baseline vs. new numbers; a fresh baseline replaces this table.

Anchor for trend questions. 283 sessions, 63 910 transcript lines, 198 MB.

| | |
|---|---|
| total, 6 weeks | ≈ $2 950 list-price equivalent (~$490/week) |
| Opus share | 86.5 % |
| main thread vs subagents | 79.6 % / 20.4 % |
| cache read : write : output (Opus) | 2 358 M : 106 M : 12 M — **55 % of spend is re-reading context** |
| sessions ≥ 250 msgs (16 of 277) | 57.5 % of spend |
| top 7 sessions | 50 % of spend |
| worst single session (14 days open) | 26.4 % of spend |
| median session length | 61 messages (p90 182, max 1775) |

## DETAIL block

Printed by default **below** the summary (after SECURITY); `--no-detail` turns it off.
Same data under `detail` in `--json`. Fixed-width, every line ≤ 120 chars, no blank lines
between sections (the whole block has a line budget: ≤ 40 lines; 36 when every section is
full). Sections, in order:

- **TOP 10 WORK UNITS** (this window, parent + subagents): each main (non-subagent) session
  rolled up with the subagents it spawned (`sub.parent === main.sid`), sorted by unit cost desc.
  Columns: sid (main session id, 8 chars — or the parent id for an orphan unit, see below), cost
  (main + subs), sub % (`subCost / cost`), #ag (subagent count), turns (total msgs across every
  session in the unit — main + all its subagents), peak (largest single context hit by any
  session in the unit), span (full-history first-seen → last-seen across every session in the
  unit, not clipped to the window — same convention as the per-session span in TOP SESSIONS),
  project. A main session with no subagents still forms its own unit (sub 0%). A subagent whose
  parent main session has no priced turns in this window still rolls up under its parent id as
  an orphan unit (mainCost 0). `--json`: `detail.units[]` =
  `{ key, project, mainCost, subCost, agents, turns, peakCtx, span, cost, subShare }`.
- **TOP 10 SUBAGENTS** (this window, by cost): cost, turns (deduped), peak ctx, model (the
  model string that cost the session most, `claude-` and date suffix stripped), parent session
  id (8 chars), task (≤ 70 chars, whitespace collapsed, cut with `…`). `--json`:
  `detail.topSubagents[]` = `{ sid, parent, project, task, model, turns, peakCtx, cost }`.
  Main sessions are not listed here; `task` is `null` when no source had text (row shows the
  agent id instead).
- **SUBAGENT DISTRIBUTION** (this window): turns and peak ctx, each as median / p90 / max, over
  every subagent in the window scope (not just the TOP 10 SUBAGENTS list above — see "population"
  below). Header carries the subagent count; empty scope prints a single "none in this window"
  line instead of the two stat lines. `--json`: `detail.distribution` =
  `{ count, turns: { median, p90, max }, peakCtx: { median, p90, max } }`. Same
  `sorted[floor(q*n)]` quantile as the summary's SESSIONS median/p90, so both read the same way;
  `q=1` for max.
- **COST BY ACTIVITY** (this window, top 6 by cost): what the deduped turns were spent on
  (design.md Q9). Columns: category, turns, avg ctx, cost, share of window spend. Categories
  with no turns get no row; no turns at all prints one "none in this window" line. `--json`:
  `detail.activity[]` = `{ category, turns, cost, avgCtx, share }` for **every** category
  (zeros included, sorted by cost desc) — the full breakdown, not just the top 6. Rules below.

### Cost by activity — categories

**One table** in the script, `ACTIVITY_RULES` (regex → category), **first match wins**, so
table order is priority. Adding a category = one entry. Each regex runs over the call's
*subject*: `<tool name> <key>`, where key = the normalized command (below) for `Bash` /
`PowerShell`, and `input.file_path` for other tools. Shell words are matched only at a
*command start*, which `markCommands()` marks in the key: each top-level segment, each
`(…)` / `$(…)` body, and the command behind a wrapper — `do`, `then`, `else`, `{`, `!`,
`time`, `nice`, `env [X=y]`, `timeout [opts] N`, `xargs`, `python[N] -m`, `py -m`, `uv run`,
`poetry run`, `npx`, `bunx`, `pnpm/yarn dlx|exec`, `npm exec`. Never inside quotes or
backticks. So `cat foo.test.ts` is a read, `grep -E "error|git" log` is a read (not git),
and `timeout 600 python -m pytest | tail` is a test run. Priority order and what each catches:

| # | category | tool / command |
|---|---|---|
| 1 | agent spawn | `Agent`, `Task`, `SendMessage` |
| 2 | web | `WebFetch`, `WebSearch` |
| 3 | screenshot/image | `Read` of a .png/.jpg/.gif/.webp/.bmp; any tool named `*screenshot*` (MCP); a `screenshot*.mjs/js/ts/py/sh` script *run* (at a command start, directly or via `node`/`python`/`bun`/`deno`/`tsx`/`bash`/`sh`/`pwsh`); `.screenshot(` in such an interpreter's command |
| 4 | wait/poll | `Monitor`, `TaskOutput`, `BashOutput`; `sleep`, `Start-Sleep`, `gh pr checks`, `gh run watch/view`; any `check-runs` / `actions/runs` URL |
| 5 | github | `api.github.com`, `gh …` |
| 6 | test/lint/build | `pnpm/npm/yarn/bun [--opts] [run/exec] test/lint/build/typecheck/…` (e.g. `pnpm --filter x test`), `vitest`, `jest`, `pytest`, `unittest`, `ruff`, `mypy`, `eslint`, `prettier`, `tsc`, `playwright test`, `node --test`, `make`, `cargo test/build/check/clippy/nextest`, `go test/build/vet` |
| 7 | git | `git …` |
| 8 | edit | `Edit`, `Write`, `MultiEdit`, `NotebookEdit`; `sed -i`, `cat >`, `tee` |
| 9 | read | `Read`, `Grep`, `Glob`; `cat`, `sed -n`, `grep`, `rg`, `head`, `tail`, `ls`, `find`, `wc`, `awk`, `Get-Content` |
| – | other | no rule matched (python/node scripts, `ToolSearch`, `Skill`, `AskUserQuestion`, …) |

Decisions not fixed by design.md (judgment calls):

- **Status checks count as wait/poll, not GitHub.** design.md lists "repeated status checks"
  under wait/poll; a single call can't know it is repeated, so every `check-runs` /
  `actions/runs` / `gh pr checks` / `gh run watch|view` call is wait/poll. `POLLING` (Slice 12)
  is the repeat detector.
- **Compound commands take the highest-priority category**, not a split: `pnpm test && git
  commit` is one call → test/lint/build. Splitting is per *tool call*, not per shell segment.
  So a runner outranks the pipe helpers after it: `python -m pytest … | tail` is a test run.
- **Wrappers are looked through, a closed list.** Real transcripts had ≈ 4.5k pytest calls
  behind `python -m` / `timeout` / `uv run` or piped to `tail` that fell to read/other. A
  follow-up pass found ≈ 1.8k more behind `python -m` with interpreter options first
  (`python -X utf8 -m pytest`, `python -u -m pytest`, `py -3 -m pytest`) that the original
  `python -m` / `py -m` wrappers didn't allow for — `python`/`py` now accept zero or more
  `-X val` / `-W val` / single-letter / `py`-version-selector options before `-m`.
  `pnpm`/`npm`/`yarn` are *not* generic wrappers (`pnpm test` vs the shell's `test -f`);
  their options are skipped only in front of a known script name.
- **Screenshot = running a screenshot script**, not touching it: `cat` / `git log --` / `Write`
  of `scripts/screenshot.mjs` are read / git / edit.
- **Turn with no `tool_use` → `other`.** A text-only or thinking-only turn (final answer,
  plan, question to the user) has no tool to attribute it to. `other` keeps totals whole
  (turns and cost sum to the window's totals); a separate "text" category was not in the Q9
  list. On demo-proj (2026-09-25) ≈ 8 % of turns had no tool call.
- **Split = per call, evenly.** A turn with n tool calls gives 1/n of its cost, 1/n of a turn
  and 1/n of its context weight to each call's category (k calls in one category → k/n). So
  `turns` can be fractional in `--json` (shown rounded in text, `<1` below one), `avgCtx` is
  `Σ(w·ctx) / Σw`, and turns, cost and share each sum to the window totals.
- **Tool calls of a turn = union over its JSONL lines** (one line per content part, all
  sharing `message.id`); a `tool_use.id` seen twice counts once.

### Cost by activity — command key

`commandKey(command)` (exported) turns a `Bash` / `PowerShell` command into a key so the same
command against a different PR number, commit, path or cwd groups together. `POLLING`
counts identical keys per session (wait-type categories only — see its playbook entry);
`BOILERPLATE` (Slice 13) takes a prefix of it.
Steps, in order:

1. Heredoc bodies hashed: the line with `<<TAG` / `<<'TAG'` / `<<-TAG` stays; the body through
   the closing `TAG` line (surrounding whitespace ignored) becomes `[heredoc <8 hex of
   sha1(body)>]` right after the `<<TAG` (`<<<` here-strings are left alone). Line
   continuations (`\` + newline) become a space.
2. `sed -n` scripts kept verbatim: `sed -n '120,180p' f` keeps its numbers (steps 3–4 skip it).
3. Quoted paths → `<path>`: quoted text starting with `/`, `\`, `~`, `./`, `../` or a drive
   (`C:\`, `C:/`), or made only of path characters with at least one separator
   (`"docs/plan.md"`). Other quoted text (grep patterns, printf bodies, sed scripts) stays.
4. UUIDs and hex runs of ≥ 7 chars containing a digit (commit SHAs) → `<id>`; then every
   remaining digit run → `N`.
5. Split into top-level segments by `shellSegments()` (exported): `&&`, `||`, `|`, `;` and
   newline (= `;`) split only outside quotes, backticks and `(…)` / `$(…)`. Per segment:
   whitespace collapsed; leading `NAME=value` env prefixes removed (`CI=1 pnpm test` →
   `pnpm test`) — a value containing `$(` or `(` is not a prefix, and a bare assignment with
   no command after it stays (`TOKEN=$(… | git credential fill)` is the BOILERPLATE signal); a
   segment that is only `cd <anything>` / `Set-Location <anything>` — an unquoted multi-word
   path (`cd /c/my dir`), a `-Path`/`-LiteralPath` flag, or any other trailing text — is dropped
   wherever it appears, including recursively inside a `(…)` group that is a whole segment on
   its own (cwd is not the command, and would leak the project path); empty segments dropped.
6. Segments re-joined with canonical separators ` && `, ` || `, ` | `, ` ; `.

Judgment calls:

- **Heredoc body → hash, not dropped.** Dropping bodies collapsed every inline script
  (`python - <<'PY'`) and every `git commit -F - <<'EOF'` into one key; a simulated POLLING
  N=20 fired on those (≈ 1 of 30 hits was real polling). The body is hashed raw (no number
  rewriting): a poll script re-run verbatim still groups, two different scripts don't.
- **`sed -n` line ranges kept.** Reading a file in chunks (`sed -n '1,80p'`, `'81,160p'`) is
  not a repeated command; `head -N` / `tail -N` still collapse (tailing a log is polling).
- **Separators inside quotes / `$(…)` are text**, never split or respaced: `grep -E
  "error|git" log` stays one segment.
- **Env prefix is per segment, never across a newline**: a standalone `SCR="…"` line stays its
  own segment instead of swallowing the next line.

What Slices 12–13 can rely on: equal keys = same command modulo cwd, env prefixes, quoted
paths, ids and numbers (outside `sed -n` scripts and heredoc bodies). `shellSegments(key)`
round-trips a key into its top-level segments, so `shellSegments(key)[0].text` is the first
segment with any `$(…)` intact (the whole `TOKEN=$(printf … | git credential fill | …)`).

Example: `cd /c/r && curl -s https://api.github.com/repos/o/r/pulls/123/check-runs` and
`cd "C:\r2" && curl -s …/pulls/456/check-runs` → both
`curl -s https://api.github.com/repos/o/r/pulls/N/check-runs`.

### Subagent distribution — population

**Decided**: the distribution runs over **every subagent session in the current window scope**
(`cur.sessions` filtered to `isSub`), not just the TOP 10 SUBAGENTS-by-cost list printed just
above it.

**Reason**: design.md Q3 specifies the stat ("median, p90, max" for turns and peak ctx) but not
its population. The top-10 list is a leaderboard of the most expensive subagents; the
distribution's job is to say whether a leaderboard entry is typical or an outlier (design.md's own
example: "agent A ran 288 turns — is that normal?"), which only works if it is computed over the
full population, not the 10 rows the reader is already looking at (those would show a distribution
dominated by the leaderboard itself, converging to roughly the top-10's own median as list size
shrinks). This mirrors the summary's SESSIONS median/p90, which is likewise computed over all
sessions, not just TOP SESSIONS. Not yet reconciled against design.md's own text — see "Open
questions" in design.md.

### Subagent task text — source

**Decided**: `agent-*.meta.json` `description` first; fallback = first non-empty line of the
subagent's first `user` message (string content, or the first `text` part of an array);
last resort = agent id.

**Reason** (measured on 642 real subagent transcripts, 2026-09-25): Claude Code writes an
`agent-<id>.meta.json` next to every `agent-<id>.jsonl` (`{ agentType, description,
toolUseId, model, … }`). Its `description` is exactly the parent's `Agent` tool_use
`input.description` (verified via `toolUseId`), so it gives the parent's label without
scanning the parent transcript. It is short and author-chosen ("Re-review slice 4 fix"),
whereas the first prompt line is usually boilerplate ("Repo C:\Users\… Read-only task, do not
commit", "You are reviewer C for …"), which says where, not what. 640/642 metas had a
description; 11 transcripts start with an `attachment` line, not the prompt, hence "first
`user` message", not "first line".

## Config keys the script reads

| file | key | why |
|---|---|---|
| `~/.claude/settings.json` | `model` | global default; `OPUS_HEAVY` context |
| | `cleanupPeriodDays` | transcript retention — feeds `SECURITY`, not `FLAGS` |
| | `effortLevel` / `env.EFFORT_LEVEL` | root-level fallback, reported, low impact |
| | `modelSettings.<model>.effortLevel` | per-model override, reported per model when present (takes precedence over the root fallback in the printed line) |
| | `enabledPlugins` | filters which cache entries count — cache/ holds stale/uninstalled plugins too |
| `~/.claude/plugins/cache/**/.claude-plugin/plugin.json` | `agents`, `skills` | prefix weight, only for plugins enabled in `settings.json` |

Prefix weight is estimated from each definition's `name` + `description` frontmatter at
~4 chars per token. It is an estimate — present it as one. Only plugins with
`enabledPlugins["<plugin>@<marketplace>"] === true` are counted — `plugins/cache/` retains
entries for marketplaces/plugins that were browsed or previously installed but are not
active, and counting those inflates `PLUGIN_BLOAT`.

## Script flags

| flag | default | meaning |
|---|---|---|
| `--days N` | 14 | window; the previous N days form the comparison window |
| `--top N` | 8 | sessions listed |
| `--json` | off | full structured dump incl. per-week and per-plugin detail |
| `--claude-dir DIR` | `~/.claude` | read transcripts + settings from DIR instead (tests use fixture dirs) |
| `--project PATH` | cwd | scope to one project: PATH is resolved (`path.resolve`, so `.`, `..`, and relative paths work) then mapped to its `projects/` folder name the same way Claude Code names it — every character that isn't a-z/A-Z/0-9 becomes `-` (`C:\Users\jdoe\demo-proj` → `C--Users-jdoe-demo-proj`; `/Users/jdoe/demo-proj` → `-Users-jdoe-demo-proj`). Folder names over 200 chars are truncated by Claude Code to 200 chars + `-<hash>`; this script matches the 200-char prefix against an existing `projects/` folder instead of reimplementing the hash. An empty value (`--project ""`) errors the same as a missing value. |
| `--all` | off | scope to every project instead of just one (pre-Slice-6 behaviour) |
| `--no-detail` | off | drop the DETAIL block (text) and the `detail` key (`--json`): summary only |

**Default scope is the current working directory's project**, mapped the same way. `--project`
overrides it; `--all` scans every project under `<claude-dir>/projects`. Only one project's
directory is walked in project scope, which naturally includes that project's own subagent
transcripts (`projects/<project>/<session>/subagents/agent-*.jsonl` all live under the same
top-level project folder). The active scope is printed in the banner (`scope <folder>` or
`scope all projects`) and in `--json` as `scope: { mode, project }`.

Exit code 1 with a message when `<claude-dir>/projects` is missing or holds no priced
messages, when `--project` names a folder that doesn't exist under `<claude-dir>/projects`,
or when `--project` is passed with no value (guards against `--project --json` silently
taking `--json` as the path).

A "message" / "msg" is one API response (one turn), deduplicated by `message.id`: the
several transcript lines of one response count once, priced with the final (largest)
`output_tokens`, since earlier lines carry a partial streaming usage. Lines without a
`message.id` are counted one by one. An id that recurs in another file (resumed
subagent) stays with the session where it was first seen.

A subagent session's identity is `(parent, sid)`, not `sid` alone — the same subagent
id can recur under two different parent sessions, and those are two distinct sessions;
main sessions have no parent and keep keying by `sid` alone.
