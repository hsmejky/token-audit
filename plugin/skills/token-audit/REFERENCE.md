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
`Opus` family bucket in SPEND/`byFamily` — only Fable was meant to show as
its own SPEND family, and splitting the SPEND bucket too would move `OPUS_HEAVY`'s
threshold behaviour out of scope for this slice.

Likewise `fable-5` (legacy) does **not** match `fable-5-1`/`fable-5.1` (current):
input, cache write and output are identical, but cache read is $1/MTok for Fable 5
vs $0.25/MTok for Fable 5.1 — a plain `includes('fable')` match used to silently price
Fable 5 at the Fable 5.1 rate. Both still roll into the same `Fable` family bucket in SPEND.

### Exact matching, not prefix/`includes()` (Slice 25)

`rateFor` matches the normalized model string (`claude-` prefix stripped, a trailing
8-digit date suffix stripped, dots folded to hyphens) against an exact list of known
versions (`KNOWN_MODELS`). It used to match loosely (`includes('opus')`, `includes
('fable-5')`, `includes('sonnet')`), which let any unlisted version silently fall
through to the wrong row — e.g. `sonnet-4-5` (a real, older model, not in the pricing
table) used to match the `includes('sonnet')` fallback and get priced at the Sonnet 5
rate. Under exact matching, `sonnet-4-5` is `UNPRICED` like any other unlisted version
instead of being guessed at. A date-suffixed id of a known model (`claude-opus-5-
20251001`) still matches, since the date suffix is stripped before the lookup.

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

`<synthetic>` rows are excluded before this check, not counted as UNPRICED: Claude Code
writes a `<synthetic>`-model, all-zero-usage row for locally generated placeholder/error
messages (not a real API call). Without this exclusion `UNPRICED` fired on essentially
every run just from these, drowning out a real new-model warning. A `<synthetic>` row
with non-zero usage (unexpected, but not ruled out) is not excluded — it still goes
through the normal UNPRICED + warning path below.

The text report prints `UNPRICED` as **one line** (Slice 28, HITL decision D):
`UNPRICED     <n> model(s) <tokens>M tok: <model>, <model>, +N more (--json) -- add prices to
PRICES + REFERENCE.md`. It names as many models as fit the 120-char line (each fit to 40
chars) and ends the list in one `+N more (--json)` marker when they don't all fit; `--json`
lists every model and doesn't need a separate field — the model already being listed under
`unpriced` is the signal. By construction every `UNPRICED` entry is a model `rateFor` doesn't
have an exact row for, so the line covers exactly the set the AC asked for: "every model present
in real data either matches an exact known row or shows up in the UNPRICED list (text: what
fits one line, --json: all)" holds automatically, not by separate bookkeeping.

`UNPRICED` is windowed the same as `SPEND` — only rows with `ts >= curFrom` (the
`--days` window) are counted, not all-time. It used to ignore `--days` entirely and
count every unpriced row ever seen while printing under the windowed `SPEND` header,
which misrepresented an all-time total as this-window activity.

## Flag playbook

Each flag the script prints maps to exactly one entry. Quote the script's number.

**Summary cap and ranking (Slice 28, HITL Q-B/Q-C)**: the summary's `FLAGS` block shows as many
flags, in this order (`rankFlags()`), as fit the lines left after every other fixed summary line
and the *whole* `SECURITY` block, computed first so `SECURITY` is never displaced (`fitFlags()`;
typically 4-5 flags on real data, fewer if `SECURITY` needs more room, more if it doesn't) — plus
one `… +N more: IDs` line for the rest:

| tier | flags | sorted by |
|---|---|---|
| 0 — extra cost defined | `REGRESSION`, `POLLING`, `BOILERPLATE`, `GH_POLLING` | `amount` desc |
| 1 — design decision Q5's main lever | `LONG_AGENT` | — |
| 2 — session habits | `LONG_SESSION`, `MULTIDAY` | `amount` desc (tie-break) |
| 3 — spend mix | `OPUS_HEAVY`, `CONCENTRATION` | `amount` desc (tie-break) |
| 4 — no dollar figure | `BIG_CTX`, `PLUGIN_BLOAT` | id |
| 5 | `CLEAN` | — |

Tier 0 holds the flags whose saving design decision Q5 defines: `REGRESSION`'s `amount` is the extra
cost vs the previous window's cost/message, `cur.cost − prev.costPerMsg × cur.msgs` (clamped
≥ 0); `POLLING`/`BOILERPLATE`/`GH_POLLING`'s is the cost of those turns (the saving's upper bound, see
below). Design decision Q5 defines no saveable part for `OPUS_HEAVY` (its `amount` is all Opus spend)
or `CONCENTRATION` (top-5 session spend), nor for `LONG_AGENT`/`LONG_SESSION`/`MULTIDAY`
(their flagged spend), so those rank by the fixed tier and use `amount` only as a tie-break
inside a tier — a large Opus bill never outranks a smaller extra-cost flag. Ties fall back to
the id.

The rest are named on one line, `  … +3 more: PLUGIN_BLOAT, BIG_CTX, MULTIDAY (DETAIL / --json)`
(`(--json)` under `--no-detail`, or when DETAIL has no room left; the id list ends in `, …` if
it would pass 120 chars), and print in full under `FLAGS (continued, ranked, N total)` at the
end of DETAIL. That block counts against DETAIL's 40-line budget: it shows the flags that fit
(a wrapped flag counts all its lines) and names the rest on a `… +N more: IDs (--json)` line;
with no room for even one flag it is left out. `--json`'s `flags` array is unranked and always
has every flag; since Slice 28 each entry also carries `amount` (the dollar figure above, 0 for
`BIG_CTX`/`PLUGIN_BLOAT`/`CLEAN`) next to `id`/`text`.

### `MULTIDAY` — sessions spanning more than a day

Largest single lever. A session left open across days re-reads its whole history on
every turn; cost per message climbs the whole time.

**Do:** finish the session, write the artifact (design md / plan md / issue), `/clear`,
reopen against the artifact. Never resume yesterday's session "just to ask one thing".

### `LONG_SESSION` — main sessions ≥ 200 messages

Same mechanism, measured by turns instead of days. The script prints what share of
window spend these sessions hold — usually a quarter to a half from a handful of them.

**Slice 15 HITL re-tune (real, deduped, all-history data, `token-audit.js --all --days
3650` and per-project cuts; full table measured during development):**
main-thread turn distribution (subagents excluded) was p50 35, p75 64, p90 121, p95 185,
p99 4784 (main history: 195 sessions; the p99 jump is the two multi-day monster sessions,
already caught by `MULTIDAY`). Two changes from the original design:

- **Main threads only.** The original flag counted every session, including subagents —
  double-counting the same sessions `LONG_AGENT` already flags (all-history: 13 sessions
  `≥250`, of which 9 were subagents). `LONG_SESSION` now filters to `!isSub`
  (`cur.mainSessions`, also what the summary's `SESSIONS` line reports); a long subagent
  is `LONG_AGENT`'s job.
- **`LONG_SESSION_TURNS` = 200** (was 250, and implicitly counted the wrong population).
  200 sits at the histogram's gap between the ordinary cluster (up to ~215) and the true
  multi-day monsters, ≈ p95 of main threads overall and ≈ p99 of the last-14-days window.
  250 would fire on zero main-thread sessions in the last 14 days and zero in the second project —
  effectively dead; 150 (~p90) still catches some ordinary long interactive sessions, not
  just orchestrators. Real-data check on this rule: all-history 6 sessions = 54% of spend;
  the second project 1 session (its worst orchestrator, 215 turns) = 5% of spend; token-audit 0
  (its one-slice-per-agent discipline never reaches 200 on a main thread).

**Do:** one session = one workflow phase. `/grill-me` → save md → `/clear` →
`/to-issues` reads the md → save → `/clear` → `/tdd`. The artifacts already exist;
use them as the handoff instead of conversation history.

**Repeat review is the single worst habit here.** "One more review" inside an old
session costs ~400k of context; the same review in a fresh session with the md loaded
costs ~20k — 20× cheaper, and more objective, because it cannot see its own earlier
reasoning.

### `LONG_AGENT` — subagents over 150 turns or 400k peak context

A subagent is just another session — the same "context re-sent every turn" mechanism as
`MULTIDAY`/`LONG_SESSION` applies to it too, but a fat implementer subagent is easy to miss
because it lives inside a work unit, not among the top main sessions. The script prints how
many subagents cross either threshold and their combined share of window spend.

**Slice 15 HITL re-tune** (`LONG_AGENT_TURNS` = 150 unchanged, `LONG_AGENT_CTX` raised
300k → 400k; real, deduped, all-history data — full table measured during development):
subagent turn distribution (761 subagents, all history) p50 34, p75 73, p90 134,
p95 174, p99 287, max 456; peak-ctx distribution p50 146k, p75 239k, p90 352k, p95 440k,
p99 572k, max 830k. 150 turns sits at p90–p92 (the second project alone: p85), right before the
turn histogram's count halves at 175 (25-turn buckets from 25–175 each carry about the
same total $, so the lever is real all the way up — 150 is a tuning choice, not a "nothing
past here" cliff), and matches the `maxTurns` playbook advice below, so the flag and the
playbook agree on one number. 300k (the original design-phase guess) is only ≈ p85 of peak
ctx and added 65 subagents that stay under 150 turns — "normal Opus agent that read a
lot", not a long run; on the second project it fired on 1 in 4 subagents, which felt noisy in
practice. 400k ≈ p93 overall (between the second project's own p90 352k and p95 495k), so the ctx
arm now catches outliers instead of the upper quarter. Real-data check: all-history 83
subagents = 17% of spend; the second project 17 subagents = 34% of spend (its worst offenders: a
287-turn/638k agent, a 226-turn/538k agent, a 189-turn/558k agent); token-audit 0 — its
disciplined one-slice-per-agent runs (max 95 turns / 182k peak) never fire, so the flag
stays clean on the project that already follows the playbook below.

**Do:**
- Give the agent a hard `maxTurns` in its `.claude/agents/*.md` frontmatter. A limit hit
  returns a partial result instead of silently running the context up forever.
- One sub-task per agent → commit → short report → stop. Hand off through git (commits +
  report), not through carried conversation context.
- Send review findings to a **fresh** fix agent, never `SendMessage` back into the fat
  implementer — a fresh agent re-reads the diff instead of re-walking its own history.
- After `maxTurns` is hit, start a **new** agent with the report plus `git log`, rather than
  resuming — resuming carries the full prior history straight back in.

**Judgment calls:** design decision Q5 says "over N turns or peak context > 300k" but leaves three
details unstated; decided at implementation time:

**Decided**: both comparisons are strict `>` (151 turns fires, 150 does not; 400 001 ctx fires,
400 000 does not — the boundary moved with the Slice 15 re-tune, the comparison direction did
not) — design decision Q5 phrases the threshold as "over N turns" and "peak context > 300k," both
explicitly strictly-greater language. `LONG_SESSION` instead uses `>=`, because its own
threshold ("200 messages") is stated as the boundary itself, not phrased as "over 200".

**Decided**: "share of spend" is the flagged subagents' combined cost as a fraction of the
**current window's total spend** (`cur.cost`, main + subagent), not just the subagent chain's
own total — same denominator `LONG_SESSION` uses for `longShare`, so the two flags read the
same way ("X% of everything spent this window").

**Decided**: `LONG_AGENT` is checked in `flags()` immediately after `LONG_SESSION`, and its
REFERENCE entry sits in the same position — both are "a session ran too long" flags, one for
main sessions, one for subagents, so they read together.

### `POLLING` — the same command ≥ 10× in one session

Cost = turns × context: every "is it done yet?" check is a full turn that re-sends the
whole context, so a wait that takes 25 checks costs 25 turns of a long session. The script
prints the number of polling runs (session × command key with ≥ `POLL_MIN_CALLS` = 10
calls, a named constant), their combined cost and share
of window spend, and the most expensive run's count and command key. `--json`: the flag
carries `groups[]` = `{ sid, parent, key, count, cost, share }`, most expensive first.
`parent` is the parent sid for a subagent group, `null` for a main session — needed because
the same subagent id spawned under two different parents shares one `sid`; `parent` is what
tells those two groups apart.

**Slice 15 HITL re-tune** (`POLL_MIN_CALLS` 20 → 10; real, deduped, all-history data, sessions
with any poll-category shell call, n = 819 — full table measured during development):
per-session max repeat of one key was p50 1, p75 2, p90 3, p95 6, p99 20, max 104 — almost
every session repeats nothing, the tail is thin. 20 (the original guess) sat at exactly p99,
catching only near-certain waits (12 runs all-history, 0.8% of spend) and never fired on
the second project at all, so its own known GitHub-polling case stayed invisible to the flag. 10 ≈ p97:
40 runs all-history = $207 = 1.5% of spend, 6 runs in the last 14 days, 1 in the second project. The
10–19 band is mostly genuine waits (`until grep -q "passed|failed" … ; sleep N ; done` loops,
log tails, progress `grep -c`); the main false-positive risk at that band was re-running the
same script while iterating (`python <path>` × 10–17), fixed by moving script runs to their
own `script run` activity category (below) and leaving it out of `POLL_CATEGORIES` — a
`python foo.py` re-run is work, not a wait. Note: the second project GitHub-polling case (89
`check-runs` + 23 `actions/runs` + 107 `pulls` calls, ~$33 = 2.5% of the second project's spend) still
does not trip `POLLING` even at N = 10 — it is spread over 33 sessions (max 8 calls/session)
behind ~87 distinct per-call keys (a fresh PR/commit id each time), so no single key repeats
enough in one session. `GH_POLLING` (Slice 31) is that cross-session detector — flagging the
same polling shape spread across many sessions instead of repeated within one; see its own
section below.

**Do:** turn the wait into one waiting turn instead of dozens:
- `gh pr checks --watch` (or `gh run watch`) — blocks until CI finishes, one call, one turn.
  Replaces curl loops over `check-runs` / `actions/runs`.
- `Monitor` — let the harness watch the process/log and wake the agent when it changes.
- `run_in_background` — start the long command in the background and read its output
  once at the end, instead of `cat`/`tail`-ing the output file every few turns.

Also never burn turns on purpose to wait (`echo waiting-N`, `sleep 30` one call at a time):
one `sleep`/`until … done` loop inside a single call waits for free.

**Judgment calls** (fixed during design as "same normalized command ≥ N times", not which commands):

- **Unit = one Bash/PowerShell call, grouped by `commandKey()` per session** (`sessionKey`:
  a subagent is its own session, also vs. a same-named agent under another parent). Other
  tools (`Read`, `TaskOutput`, …) don't count — POLLING is about a *command*.
- **Only categories where a repeat is a wait count**: `POLL_CATEGORIES` = wait/poll, github,
  read, other. test/lint/build, git, edit, screenshot and (Slice 15) `script run` are
  excluded — a repeated test run is a TDD loop, a repeated script run is iterating on it,
  not polling. Why not just wait/poll + github: on real transcripts (2026-09-25, all
  history) the bulk of real polling was `cat`/`tail` of background-task `.output` files
  (read), `tasklist` and `echo waiting-N` (other, at the time); wait/poll alone caught 1 of
  ~10. Same key ≥ 20 over all categories gave 14 hits, 2 of them pytest loops. Slice 15
  additionally moved `tasklist`/`Get-Process` and `echo waiting-*`/`echo idle-*` from
  `other` into `wait/poll` itself (they are "burn a turn on purpose to wait" patterns, not
  uncategorized noise), so this bullet's `other` catch is narrower now than the 2026-09-25
  measurement above describes.
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
- **Secret layer — credentials are redacted to `<secret>`** before the path and name layers
  (`redactPaths()` → `redactSecrets()`), so a token pasted into a command that repeats ≥ 10×
  (Slice 15: was ≥ 20×) never prints. Shapes: known token prefixes (`ghp_`/`gho_`/`ghs_`/`ghu_`, `github_pat_`,
  `sk-`/`sk-ant-`, `xoxb-`/`xoxp-`/`xoxa-`/`xoxs-`, `AKIA…`, a JWT `eyJ….….…`); the value of an
  `Authorization:` / `Cookie:` / `*-Token:` / `*-Api-Key:` / `*Secret:` header (a `Bearer` /
  `Basic` / `token` scheme word stays); the header value runs to the next quote/backtick/
  newline, not just whitespace, so `Cookie: a=1; b=Zqxv` redacts the whole header, not just
  its first `;`-pair; the value of a bare `Bearer x`; the password of `-u` / `--user
  user:pass` and of URL credentials (`https://user:pass@host`); the value of a flag whose
  name contains password/passwd/passphrase/pwd/token/secret/api-key/access-key/private-key/
  cred/bearer (`--password=x`, `--token x`, `--oauth2-bearer x`); and `NAME=value` (also
  `export`, `$env:`, `?access_token=`) where NAME matches
  `/TOKEN|KEY|SECRET|PASS|PWD|AUTH|CRED/i`. A `-u`/flag/JSON value may be `"…"` / `'…'` with
  spaces and is redacted whole, not just its first word (`--password "a pass phrase"`,
  `-u 'jdoe:a pass word'`). Also covered: a secret-named JSON key (`{"password":"x"}`,
  `{"token": "x"}`); the `-p` password of `mysql` / `mysqldump` / `mysqladmin` / `mariadb`
  (`-pX`, `-p"X"`, `-p'X'`), `sshpass` (`-p X` / `-pX`) and `docker login` (`-p X` / `-pX`).
  `-p` is found by a small token scan per command segment (split at `;` `&` `|` `(` `)`
  backtick newline; a quoted `bash -c "mysql -pX"` is scanned inside), not one regex: other
  flags and args may sit before `-p` (`mysql -u root -pX db`, `docker login -u 'me' -p X`),
  every password in the segment redacts (`mysql -pX … && mysql -pY`), and every other token
  is kept exactly (`mysql -u root -p<secret> db`). `-p` is case-sensitive (`mysql -P 3306` is
  the port); mysql's password is attached only, so `mysql -p db` (space) is the prompt form,
  not a secret, and stays; sshpass's own options end at the command it wraps, so in
  `sshpass -p X ssh -p N host` only `X` redacts; a later segment (`…; ssh -p N h`),
  `mkdir -p a`, `ssh -p 22 host` and `docker run -p N:N` stay readable. Quoted parts are
  re-scanned as shell text up to 4 levels deep (`bash -c "…"`, `sh -c '…'`, `--cmd="mysql -pX"`,
  `\"`-escaped inner quotes), and the command may be a quoted path
  (`& "C:\Program Files\MySQL\bin\mysql.exe" -pX`). A value made of several parts redacts each
  literal part and keeps each reference part (`-p$X'lit'` → `-p$X'<secret>'`). A `\` before
  `$`, `"` or a backtick is a shell escape, not a path separator, so `bash -c "mysql -p\"\$PW\""`
  stays intact. Known limits, left as typed: a 5th or deeper quoting level; a password glued
  across a quote boundary inside a nested command (`sh -c 'mysql -p'X' db'`); a literal glued
  onto a reference in the same bare part (`-p${X}lit`). Also
  `gh secret set NAME --body x` / `-b x` / attached `-bx` / `-b'x'`; npm's `:_authToken x`
  (space form; the `=` form was already covered). A value that is a reference — `$VAR`, `${VAR}`,
  `$(…)`, unquoted or double-quoted — is not a secret and stays (`-H "Authorization: token
  $TOKEN"`, `TOKEN=$(… git credential fill …)`, `mysql -p"$PW"` stay readable); a
  **single-quoted** value (`PASSWORD='$ecret'`, `-H 'Authorization: token $x'`,
  `--password '$x'`, `sshpass -p '$x'`) is a shell literal, not a reference — shell never
  expands `$` inside `'…'` — so it is redacted like any other literal. A secret-named assignment whose value is
  a literal `$(echo x)` / `$(printf x)` (no `|`, so it can't be piping through a real lookup)
  redacts `x` too (`TOKEN=$(echo a-pasted-secret)`); a piped form like `$(printf … | git
  credential fill)` is a real fetch and stays untouched. An assignment matches only after
  start/whitespace/separator/quote/`?`/`:`, so a sed script's `s/^password=//p` stays. Every
  pattern is anchored to the start of a run and bounds its name part, so it stays linear on
  200k-char inputs. Normal keys are untouched (`a=b`, `-o=json`, `PYTHONIOENCODING=utf-N`,
  `sort --key=N`, `git push -u origin main`, `ssh -p 22 host`, `mkdir -p a`). Accepted
  over-redaction: an odd NAME containing a keyword (`MONKEY=x`, `GIT_ASKPASS=x`) and a boolean
  flag named like a secret flag followed by a plain word (`--no-token foo`).
- **Value layer — the current user's name is redacted to `<user>`** wherever it is left in
  the key, whatever the path shape (`C--Users-Petr-Svarc-proj` project-folder form, a path
  the patterns above miss) or plain text, any case. Terms: the login name
  (`os.userInfo()`), the last segment of `os.homedir()` and git `user.name`, each whole and
  split on whitespace/`.`/`_`/`-` (home `C:\Users\Petr Svarc` → `Petr`, `Svarc`). A term
  counts only if it is ≥ 3 chars and not a generic account name (`user`, `admin`, `root`,
  `runner`, …), and matches only as a whole word (`Petr` doesn't touch `Petrol`), so short
  or common names don't over-redact. Accents are folded on both sides (NFD, combining marks
  dropped), so `Svarc` also redacts `Švarc` in NFC or NFD form and an accented git name
  redacts its plain spelling; letters without a decomposition (`ł`, `ø`) are not folded.
  Pattern rules catch *any* user's path; the value
  layer catches *this* user's name in shapes no pattern foresaw. Both are best-effort, not
  a guarantee for every possible shell construct. Only the printed key is redacted —
  grouping uses the raw key. The key is cut in the middle (`head…tail`) so the line stays
  ≤ 120 chars and both the program and e.g. `…/check-runs` stay visible.
- **Same redaction on every printed field** (all three layers): the scope and session
  (`--json` `cur.sessions`) / work-unit / subagent project folders (`C--Users-<user>-<user>-proj`
  — still tells projects apart), subagent task text, model names (UNPRICED line, CONFIG `model=`
  and `effort=` per-model entries), plugin and MCP server names, and the stderr errors
  (`no transcripts at …`, `no project …`), in the text report and `--json` alike. Grouping,
  session keys and JSON property names stay raw; only the printed copies change.
- **Heredoc bodies are hashed raw** (commandKey step 1): a poll script re-run verbatim
  groups; the same script with a different PR number inside the body is a different key.
  Accepted: within one wait the body is identical (same PR), which is what a run counts.
  No real-data hit was heredoc-driven.

### `BOILERPLATE` — the same setup prefix in ≥ 5 sessions

The same setup typed again in session after session is a tool or setting that is missing:
every session re-derives it (and re-spends turns getting it right). The script prints the
number of boilerplate prefixes (a setup prefix seen in ≥ `BOILER_MIN_SESSIONS` = 5 distinct
sessions, a named constant), the combined cost and share
of window spend of the turns carrying them, and the most expensive prefix with its #sessions
and #turns. `--json`: the flag carries `groups[]` = `{ prefix, sessions, turns, cost, share }`,
most expensive first.

**Slice 15 HITL re-tune: kept N = 5** (real, deduped, all-history data; distribution of
sessions-per-prefix over 206 prefixes: p50 1, p90 2, p95 3, p99 8, max 71 — full table
measured during development). 5 sits between p95 (3) and p99 (8): loosening to 3 (~p95)
lets in more idioms (`T=$(mktemp -d)`, loop counters) without finding more real boilerplate;
tightening to 8 (~p99) drops nothing but the two biggest hits. The false positives N = 5 lets
through (`SHA=$(git rev-parse HEAD)`, `n=<value>` loop counters, `start=$(date +%s)` timing)
are cheap and rank low in the flag's own $-sorted output, so they cost nothing in practice.
Real-data check: all-history 7 prefixes = $188 = 1% of spend; the second project 4 prefixes = $9.38 =
1% of spend; token-audit 0.

**Do:** replace the setup with the tool or setting it stands in for:
- `TOKEN=$(printf 'protocol=https\nhost=github.com\n' | git credential fill | …)` + `curl
  api.github.com` + a JSON body file → install and authenticate `gh` (`gh auth login`), then
  `gh pr view` / `gh pr checks` / `gh api`. Second project case: this is what the fix was.
- An env var exported before every command (`export PYTHONIOENCODING=utf-8 && python …`) →
  set it once in `settings.json` `env` (or `PYTHONUTF8=1` system-wide).
- Any other multi-step setup → a script in the repo (`scripts/…`) the agent calls by name,
  and a line in CLAUDE.md saying it exists.

**Prefix definition** (left open during design): the **setup prefixes** of a command key
(`commandKey()`) are the segments of its leading run of variable assignments
(`shellSegments(key)`, `$(…)` intact) — `NAME=…`, `export NAME=…` or PowerShell
`$env:NAME=…` (spaces around `=` allowed; an assignment with a command after it in the
same segment was already stripped as an env prefix) — when (a) a non-assignment segment
follows the run (a prefix *of* something), and (b) the value is not just a path — `<path>`,
an absolute/relative path, or a `$VAR`-rooted one (`"$HOME/x"`), quotes stripped; a path
assignment is skipped but the run goes on past it. **Each assignment of the run is its own
prefix** (not the run as one): `export PYTHONIOENCODING=… && TOKEN=$(… git credential fill
…) && curl` and `SCRATCH=<path> && TOKEN=$(…) && curl` then group their credential fetch
with the bare `TOKEN=$(…) && curl`; as one run-prefix they would be three groups, each
below N. Grouped over all sessions (`sessionKey`, so a subagent is its own session) by the
exact raw prefix; Bash/PowerShell calls only, all activity categories. A call carrying two
hit prefixes counts in both groups, but once in the flag's total cost/share.

**Real-data validation** (2026-09-25, `--all --days 3650`, 895 transcripts), hits at N = 5:
- first segment of every key: 324 prefixes — nearly all noise (`git status --short` 287
  sessions, `git log --oneline -N`, `python -m pytest …`, `cat <path>`, `ls -la`). Rejected.
- first segment of a key with ≥ 2 segments: 238 — same noise. Rejected.
- assignment-first (a + b, no path rule): 17 — 3 real (below) + 10 scratchpad-variable
  shorthands (`S=<path>`, `SP=<path>`, `SCRATCH=<path>`, unquoted `S=/c/Users/…/scratchpad`
  per project) + 4 file shorthands (`F=<path>`, `T=<path>`, `D=<path>`, `W=<path>` — many
  different files collapsed to `<path>`). A path shorthand only names a location; no missing
  tool behind it, so rule (c) drops them.
- **chosen rule (a + b + c): 3 hits, all real boilerplate**, 1 % of spend ($138 of $13.5k):
  `export PYTHONIOENCODING=utf-N` (68 sessions, 1171 turns, $134) and two spellings of the
  `git credential fill` token fetch (8 sessions / 38 turns and 6 / 15; a third spelling with
  `grep "^password="` is in 3 sessions). Hand-count check: design decision Q9 estimated ~110 `pulls`
  calls with a fresh credential fill in the second project; 53 turns carry the two spellings here.

**Leading-run + `$env:` rule** (2026-09-25, same data, vs. first-segment-only above):
7 hits (was 3), $188 = 1 % of spend (was $138). `export PYTHONIOENCODING=<value>` 71
sessions / 1210 turns (was 68 / 1171); the credential fetch 8 / 39 and 7 / 18 (was 8 / 38
and 6 / 15); new: `$env:PYTHONIOENCODING=<value>` (6 / 23, real), `SHA=$(git rev-parse
HEAD)` (13 / 22), `start=$(date +%s)` (5 / 14) and `n=<value>` (5 / 114, a loop counter —
noise; Slice 15). The credential fetch is in 54 sessions / 232 calls overall, but in ~15
spellings (quotes, `\n\n`, `2>/dev/null`, `sed` vs `grep | cut`, `TOKEN` vs `T`), most
in 2–4 sessions each, plus some fetches after a non-assignment segment (`S=<path> && cat …
&& TOKEN=$(…)`); the leading run fixes only the few behind an export / path variable. So the
design's ~110 is right for the fetch overall; the flag reports the two spellings that cross
N (57 turns). Merging spellings is the "no fuzzing" call below — Slice 15.

**Judgment calls:**
- **Exact prefix, no fuzzing**: the credential fetch in three spellings is three groups (quote
  style, `\n\n`, `sed` vs `grep`). Merging them would need a looser key; not needed — the two
  main spellings each cross N on their own. Revisit in Slice 15 if a real case splits below N.
- **Cost = the turns carrying the prefix**, 1/n of an n-call turn (as in COST BY ACTIVITY), not
  the prefix's own tokens: cost = turns × context, and those turns are what a `gh` call or a
  setting would have made shorter or fewer. It over-states the saving (the turn also did real
  work), so read the share as "spend on turns that needed this setup". #turns counts a turn
  once even if several of its calls carry the prefix.
- **A literal value prints as `NAME=<value>`** (text and `groups[].prefix`): a value that is
  not `$(…)` / `$VAR` / `${VAR}` may be a pasted secret (`export GH_TOKEN=ghp_…`, a digit-free
  password), and the value is what makes it boilerplate only through its name
  (`export PYTHONIOENCODING=<value>`). Any other prefix is redacted with `redactPaths()`
  (secret layer — see POLLING — then paths, then the user's name), so a token inside `$(…)`
  prints as `<secret>`. Grouping uses the raw prefix — two users' `$(cat /home/<name>/.token)`
  are two groups, and two different literal values of one NAME are two groups. A prefix too
  long for its flag line (≤ 120 chars) loses values before command words: quoted strings
  become `'…'`, then each stage of a `NAME=$(…)` keeps only its leading command words
  (`TOKEN=$(printf … | git credential fill | sed …)`), then a one-word stage becomes `…`,
  and only then is it cut in the middle; the full prefix is in `--json`. The flag line
  leaves out the ≥ 5 threshold to make room. A share under 0.5 % prints `<1%` (also
  POLLING), not `0%`.

### `GH_POLLING` — one GitHub endpoint ≥ 20 calls across sessions (Slice 31)

`POLLING` only sees one command key repeated in *one* session. GitHub polling done by many
subagents — each checks CI a few times with its own inline `curl …/commits/<sha>/check-runs`
loop, a different PR number or SHA in every call — never repeats one key often enough in any
single session, yet adds up to hundreds of full-context turns in the window. `GH_POLLING`
sums those calls over **every session and subagent in the window**, grouped by endpoint shape
instead of command key. The script prints the calls, sessions (main + subagent) and subagents
behind the hit shapes, their combined cost and share of window spend, and the most expensive
shape with its call count, e.g. `121 calls in 37 sessions (13 subagents) = $13.7, 1% of
spend; top 76× commits/*/check-runs +2 more`. `--json`: the flag carries `calls`, `sessions`,
`subagents`, `cost`, `share` and `groups[]` = `{ shape, calls, sessions, subagents, cost,
share }`, most expensive first. Tier 0 like `POLLING`, `amount` = the cost of those
calls' turns.

- **Counted calls**: Bash/PowerShell calls in the `wait/poll` or `github` activity category
  that name a GitHub endpoint *and query state rather than change it* (HITL decision),
  decided **per command occurrence, not per whole Bash call** — a
  compound call mixing a read and a write (`until gh pr checks 12; do sleep 30; done && gh
  pr merge 12`, a `check-runs` curl loop next to a `curl -X PUT …/merge`) keeps the read
  occurrence's shape and drops only the write one; a flag in one occurrence (e.g. an
  unrelated `grep -x post f`) never taints another occurrence in the same call. Each
  occurrence is split into shell words (quotes removed, `\"` inside `"…"` escaped as in bash, one
  linear pass; `curl`/`gh` recognized by basename too — `/usr/bin/curl`, `curl.exe`, `gh.exe`) and its options are
  read the way the command itself parses them: a combined short-flag cluster splits at its
  first value-taking letter (curl `-sXPOST` = `-s -X POST`, `-sd q` = `-s -d q`, `-sSfG` =
  `-s -S -f -G`), and an option's value is never read as a flag (`-H 'X-Debug: -d'` is a
  header, not a body). curl rules apply only to a `curl` occurrence, `gh api` rules only to
  `gh api`. A write is:
  - **explicit method first**, for curl and `gh api` alike: `-X`/`--request` (curl),
    `-X`/`--method` (`gh api`), fused, spaced or `=`, value case-insensitive —
    `POST`/`PUT`/`PATCH`/`DELETE` write, `GET` (or any other method) reads even alongside a
    body/field/`--input` flag. Any other command naming an `api.github.com` URL writes only
    on such an explicit write method (`-Method` included).
  - **curl, no method**: a `-d`/`--data`/`--data-raw`/`--data-binary`/`--data-ascii`/
    `--data-urlencode`/`--json`/`-F`/`--form`/`--form-string` body with no `-G`/`--get`
    turning it into a query string, or a `-T`/`--upload-file` upload (implicit PUT, `-G`
    or not). curl options are case-sensitive: `-g` is `--globoff`,
    `-D` `--dump-header`, `-x` `--proxy` — none of them is `-G`/`-d`/`-X`.
  - **`gh api`, no method**: `--input FILE` or `-f`/`-F`/`--field`/`--raw-field` (implicit
    POST) — **except** `gh api graphql`, itself a query endpoint: a write only when an inline
    `query=` field value contains the word `mutation` — lowercase, the GraphQL keyword, so
    `__type(name: "Mutation")` reads — anywhere (leading spaces or newlines
    included); a `query=@file.graphql` or `query="$(cat file)"` value's text is not visible
    in the command, so it reads (even when the filename says "mutation"), as does `--input`.
    The field name must be exactly `query` (`searchquery=…` is not it).
  - **`gh <group> <verb>`** whose verb writes (`create`, `merge`, `close`, `edit`,
    `comment`, `reopen`, `rerun`, `run` — only for `gh workflow run` — `set` — `gh
    secret|variable set` — `fork` — `gh repo fork` — …).

  No method/body/`--input` flag and no matching verb/field defaults to a read. So `gh pr
  checks`/`view` (`--json` included), `gh run view`/`watch`, a bare `gh api repos/…/pulls/1`,
  a **GET** on `pulls/N/merge` (checking mergeability) and any other GET curl count; `gh pr
  create`, `gh pr merge`, `gh issue create`, a **write** (`PUT`) to `pulls/*/merge` and any
  other explicit write method never do, however many times they run. `git push`, a plain
  `sleep`, `Monitor` never count either.
- **Endpoint shape** (`githubShapes()`/`githubReadShapes()`): an `api.github.com/<path>` URL
  loses `repos/<owner>/<repo>/` and its query; every other segment that is not a known REST
  word (`pulls`, `commits`, `check-runs`, `actions`, `runs`, `jobs`, `merge`, `branches`, …)
  becomes `*`, consecutive `*` collapse — `…/commits/<sha|branch|$SHA>/check-runs` →
  `commits/*/check-runs`, `…/pulls/4242/merge` → `pulls/*/merge`, the repository itself →
  `repos/*`. `gh api <path>` gets the same path shape (a full `https://api.github.com/…` URL
  is reduced to its path first — one shape); any other `gh` call is `gh <group>
  <verb>` (`gh pr checks`, `gh run view`), the group and verb read past any flag that comes
  before them (`gh -R o/r pr merge`, `gh pr --repo o/r merge`). The verb
  is only printed when it is on that group's own read-verb whitelist or a known write verb
  (`gh pr create`); any other word — a branch name (`gh browse <branch>`), a mistyped repo
  name (`gh repo <name>`), an issue title, … — becomes `*` instead (privacy:
  `gh browse fix-login-bug` → `gh browse *`, never the branch name, in text or
  `--json groups[]`). Only whitelisted words are ever printed, so a shape never carries an
  owner, repo, branch, file path or id. The URL scan is one literal anchor plus one negated
  character class, the word split one pass per occurrence — linear on 200k-char input, however
  many (or unclosed) quotes.
- **Hit**: a shape with ≥ `GH_POLL_MIN_CALLS` calls in the window (a named constant; a count
  per window, so `--days 30` sees roughly twice the calls of the default 14 days). A call that
  hits two shapes counts in both groups and once in the flag totals. In `--all` scope a shape
  sums across projects (the fix is per machine).
- **Overlap**: `GH_POLLING`, `POLLING` and `BOILERPLATE` are independent views over the same
  turns (by endpoint shape, by repeated command key, by credential-prefix), not a partition —
  a turn can count in more than one. Their `amount`s are never deduplicated against each
  other and must not be added together as "total saveable spend"; each is its own upper
  bound, read on its own.

**Threshold — final: `GH_POLL_MIN_CALLS = 20`.** Chosen from real, deduped, all-history data
(calls per project × shape, n = 50, writes and reads together, before the read-only scope
below was decided): p50 1, p75 3, p90 25, p95 31, max 76. Ordinary GitHub use stayed at ≤ 8
calls per shape; the one known spread-out polling case ran 25–76 per shape (218 calls over
54 sessions, 26 of them subagents, median 3 calls per session — invisible to `POLLING` at
any N), and nothing fell in between — the data can't distinguish 10 from 25. Any value from
9 to 25 fires on exactly the same shapes for that case (0 hits elsewhere); 20 sits closer to
p90 and leaves headroom for heavier normal use (e.g. a PR created and merged every day of a
14-day window) that the measured data doesn't show. 40 would keep only the pure `check-runs`
poll; ≤ 5 starts flagging auth checks (`gh auth status`, `user`) — false positives, not
polling, so 20 is comfortably clear of that floor too.

**Scope — reads only (HITL decision).** Write calls (`gh pr create`/`merge`, `gh issue
create`, any explicit write method or body, per the extended "Counted calls" rule above) are
excluded from `GH_POLLING` regardless of category, decided per occurrence, not per whole
call. Re-measured on the same all-history data with writes excluded (`--all --days 3650`):
3 shapes clear `T = 20` — `commits/*/
check-runs` (76 calls), `repos/*` (28 GET calls) and `pulls/*` (23 GET calls) — 121 calls, 37
sessions (13 subagents), $13.67 = 1.03 % of the second project's spend (all of it; 0 hits in
any other project). That is higher than this same reads-only measurement before the review
fixes (2 shapes, 87 calls, 33 sessions, $8.56 = 0.65 %) — the per-call exclusion had been
dropping whole compound calls (a read loop next to an unrelated write, or a write-verb regex
tripped by an unrelated flag elsewhere in the same call) that the per-occurrence fix now
correctly keeps the read part of. Against the writes-included figure from before the reads-
only scope decision (5 shapes, 183 calls, 46 sessions, $25.8 = 1.96 %) it is a bit over half —
the flag still measures spread-out CI/status polling specifically, not general `gh`/API
traffic. At lower T the same reads-only, review-fixed data gives: `T=5` 5 shapes, 132 calls,
$14.78 (1.12 %); `T=10` 3 shapes, 121 calls, $13.67 (1.03 %, same as `T=20`); `T=30`/`T=40` 1
shape (the 76 `check-runs`), $7.55 (0.57 %). `T=20` still lands in the same empty band
between the largest ordinary shape and the case shapes as before, so the finalized value is
unchanged by either the scope decision or the review fixes — only the flag's reported impact
changed.

**Playbook**: install and authenticate `gh` (removes the per-call `git credential fill` +
`curl` + JSON-body boilerplate) and wait with one call — `gh pr checks --watch`,
`gh run watch`, or a `run_in_background` / `Monitor` wait — instead of each subagent polling
CI in its own loop. Put the wait in the orchestrating session or a script, not in every
subagent's prompt.

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

**Do:** name the regression explicitly and check the `TREND` line (full per-week table:
`--json`'s `weeks`) for when it started.

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

Do not recommend these — they were measured and are noise. Tool output and screenshots
were re-confirmed on the second project; output tokens (≈ 12 %) and `effortLevel`
were only measured on the first project this script checked:

| candidate | actual share of spend |
|---|---|
| all tool output (file reads, greps, bash) over full history | **≈ 0.15 %** |
| screenshots carried in context | ≈ 1.4 % (2.6 % pre-dedupe hand estimate; see "Activity table vs Q9 hand estimates" below) |
| output tokens | ≈ 12 % |
| `effortLevel` overrides | negligible — `high` is already the default |

Corollary: offloading "read these files and summarise" to a cheaper external model
targets 0.15 % of spend. It cannot pay for itself, and for customer code it collides
with the confidentiality rules anyway.

**Subagents are a non-lever only when their measured share is small and they run on
Sonnet — report the number, never assert it (design decision Q6).** The claim held for the
first project this script measured (below: 20.4 % of spend, pre-dedupe) but not for the
second project that motivated this rewrite (85 % of spend, mostly Opus — 82 % is
that project's share of *input tokens*, not spend) or
for this machine's own all-history data today (below:
35.1 % of spend, 82.7 % of that on Opus). When the measured share is large and/or Opus-
heavy, subagent count/duration *is* the lever — that's `LONG_AGENT`'s job (subagents
over 150 turns or 400k peak context; see its playbook above), not this section's.
Tool-driven turns inside subagents or main sessions (the same command run over and over)
are also a lever, not noise — `POLLING` and `BOILERPLATE` catch those; only the tool
*output* (bytes read/produced) measures as noise, not the turns spent producing it.

## Baseline

Anchor for trend questions, computed with the deduped (post-Slice-2) script,
`--all --days 3650`, all local history through 2026-09-25. 972 sessions total: 196
main + 776 subagents, spanning 9 weeks with data (2026-07-27 → 2026-09-25).

| | |
|---|---|
| total, all-time | $13 546 list-price equivalent, 9 wk with data |
| Opus / Fable / Sonnet / Haiku share | 87.5 % / 6.6 % / 5.8 % / 0.0 % |
| main thread vs subagents | 64.9 % / 35.1 % |
| subagent model mix (of subagent-only spend) | Opus 82.7 %, Sonnet 16.6 %, Fable 0.7 % |
| `LONG_SESSION` (≥200 msgs, main only) | 6 of 196 sessions = 54 % of spend |
| `LONG_AGENT` (>150 turns or >400k peak, subagents) | 83 of 776 = 17 % of spend |
| `POLLING` (≥10× same command/session) | 34 runs = $193, 1 % of spend |
| `BOILERPLATE` (≥5 sessions same setup prefix) | 7 prefixes = $188, 1 % of spend |
| main-thread turn distribution | median 35, p90 121 |

Subagent turn/peak-ctx percentiles (measured the same way, slightly different subagent
count on a later run since history keeps growing) live in the `LONG_AGENT` section above,
not duplicated here.

> **Supersedes the pre-Slice-2 baseline.** The first full measurement (2026-08-04 →
> 2026-09-15, 283 sessions, 63 910 transcript lines) counted every transcript line as a
> message; one API response is written as several lines (thinking / text / tool_use)
> sharing one `message.id`, so its spend and message counts were inflated ≈ 1.9×.
> All-time recount on this machine when the dedupe fix landed, Slice 2, 2026-09-25:
> 118 574 lines → 63 083 turns, $24.1k → $12.9k deduped; the rise to $13 546 above is
> newer history, not a method change.
> The old baseline reported 86.5 % Opus share,
> 79.6 % / 20.4 % main/subagent split, sessions ≥ 250 msgs at 57.5 % of spend — do not
> read a trend into old-baseline vs. this table; the dedupe fix and threshold re-tune
> (Slices 2 and 15) both moved the numbers.

## Summary layout (Slice 28)

The summary (everything above DETAIL, incl. the blank line before it) stays ≤ 24 lines on
real data and on the fixture that fires every section at once (`tests/summary-budget.test.js`):

- **SPEND** — the total, then the model families on **one** line (`Opus $… x%   Fable $… y%`,
  largest first, `+N more (--json)` if they don't fit), then main vs subagents.
- **UNPRICED** — one line (see "Unknown models" above).
- **PER MESSAGE / SESSIONS / ALL-TIME / TREND / CONFIG** — one line each. `TREND` spans the
  whole history: first week → last week cost/message, the % change (`n/a` when the first week
  cost nothing), and `span N wk (M with data)` — N = calendar weeks from the first to the last
  week with data, M = weeks that had any rows. With one week of data it prints `week of <date>
  only` and no change. The full per-week table is `--json`'s `weeks`. CONFIG: see "CONFIG — one
  line" below. **ALL-TIME mixes two populations on purpose (Slice 15 HITL, re-review
  decision):** `sessions`/`msgs` are main sessions only — same population as `SESSIONS`
  above it (`mainSessions`, `!isSub`) — but `cost` is all-time spend **including
  subagents** (`all.cost`, every row ever seen). Deliberate: `SPEND` (the window total,
  which already includes subagent cost) must never exceed `ALL-TIME`, and all-time
  history is always a superset of the window, so `ALL-TIME`’s cost has to cover the
  same subagent spend `SPEND` does — main-only cost would let a window with heavy
  subagent spend show `SPEND` > `ALL-TIME`. Keeping `sessions`/`msgs` main-only means
  "N sessions" next to `ALL-TIME` still means N *main* sessions, matching `SESSIONS`’
  count/median/p90 — a subagent never counts as one of the sessions the figure is
  "over". `--json`’s `all: { cost, msgs, sessions }` follows the same split (cost
  all-inclusive, msgs/sessions main-only); of the raw `summarize()` fields (not this
  trimmed `all` json object), `all.cost` and `all.sessions` still use every session
  including subagents internally (`workUnits()`, `LONG_AGENT` spans) — `all.msgs` isn’t
  used internally at all. Only the exposed ALL-TIME figure is this deliberate mix.
- **FLAGS** — as many as fit (`fitFlags()`; typically 4-5) + one `… +N more: IDs` line for the
  rest (see "Summary cap and ranking"); **SECURITY** in full.

TOP SESSIONS is no longer printed (DETAIL's WORK UNITS / TOP SUBAGENTS cover it; `--json`
keeps `cur.sessions`/`prev.sessions`).

## DETAIL block

Printed by default **below** the summary (after SECURITY); `--no-detail` turns it off.
Same data under `detail` in `--json`. Fixed-width, every line ≤ 120 chars, no blank lines
between sections (the whole block has a hard line-budget guard: ≤ 40 lines, `DETAIL_MAX_LINES`;
if a section's own rendering would still overrun it, `renderDetail()` cuts it down to
`DETAIL_MAX_LINES - 1` lines and appends a `… DETAIL truncated, full data in --json` marker
line). Sections, in order, plus one optional trailing `FLAGS (continued, …)` block (Slice 28)
when the summary's `fitFlags()` guard moved any flags here — it gets only the lines left of the
40 (`DETAIL_MAX_LINES`), see "Summary cap and ranking" above:

- **TOP 10 WORK UNITS** (this window, parent + subagents): each main (non-subagent) session
  rolled up with the subagents it spawned (`sub.parent === main.sid`), sorted by unit cost desc.
  Columns: sid (main session id, 8 chars — or the parent id for an orphan unit, see below), cost
  (main + subs), sub % (`subCost / cost`), #ag (subagent count), turns (total msgs across every
  session in the unit — main + all its subagents), peak (largest single context hit by any
  session in the unit), span (full-history first-seen → last-seen across every session in the
  unit, not clipped to the window — same convention as the `MULTIDAY` flag's span),
  project. A main session with no subagents still forms its own unit (sub 0%). A subagent whose
  parent main session has no priced turns in this window still rolls up under its parent id as
  an orphan unit (mainCost 0). Its subagents still get the normal "reach back past the window"
  full-history span, same as any other unit — `workUnits()` looks up each session's real
  first/last by id regardless of which unit it rolls into. Only the absent main session's own
  full history is left out of the span, because a main session with zero rows in this window
  is never visited by the loop that builds `first`/`last` in the first place (it isn't one of
  `cur.sessions`), not because subagent history is clipped.
  `--json`: `detail.units[]` =
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
  (design decision Q9). Columns: category, turns, avg ctx, cost, share of window spend. Categories
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
| 2 | harness (Slice 15) | `Skill`, `ToolSearch`, `AskUserQuestion`, `TaskStop`, `TaskCreate`, `TaskUpdate`, `TaskList`, `TodoWrite`, `ListAgents`, `EnterPlanMode`, `ExitPlanMode`, `EnterWorktree`, `ExitWorktree`, `CronCreate`, `CronDelete`, `ScheduleWakeup` |
| 3 | web | `WebFetch`, `WebSearch` |
| 4 | screenshot/image | `Read` of a .png/.jpg/.gif/.webp/.bmp; any tool named `*screenshot*` (MCP); a `screenshot*.mjs/js/ts/py/sh` script *run* (at a command start, directly or via `node`/`python`/`bun`/`deno`/`tsx`/`bash`/`sh`/`pwsh`); `.screenshot(` in such an interpreter's command |
| 5 | wait/poll | `Monitor`, `TaskOutput`, `BashOutput`; `sleep`, `Start-Sleep`, `gh pr checks`, `gh run watch/view`; any `check-runs` / `actions/runs` URL |
| 6 | github | `api.github.com`, `gh …` |
| 7 | test/lint/build | `pnpm/npm/yarn/bun [--opts] [run/exec] test/lint/build/typecheck/…` (e.g. `pnpm --filter x test`), `vitest`, `jest`, `pytest`, `unittest`, `ruff`, `mypy`, `eslint`, `prettier`, `tsc`, `playwright test`, `node --test`, `make`, `cargo test/build/check/clippy/nextest`, `go test/build/vet` |
| 8 | git | `git …` |
| 9 | wait/poll — busy-poll (Slice 15) | `echo waiting-*`/`echo idle-*`, `tasklist`, `Get-Process`, checked below git and test/lint/build — real work wins a compound like `git status; Get-Process` (review finding: these used to live in row 5's high-priority rule, so that compound fell to wait/poll instead of git) |
| 10 | edit | `Edit`, `Write`, `MultiEdit`, `NotebookEdit`; `sed -i`, `cat >`, `tee` |
| 11 | read | `Read`, `Grep`, `Glob`; `cat`, `sed -n`, `grep`, `rg`, `head`, `tail`, `ls`, `find`, `wc`, `awk`, `Get-Content` — **only when reached directly** (a new top-level command: start of string, or after `;`/`&&`/`\|\|`/newline/`(`). A reader reached only by piping another command's output into it (`python x.py 2>&1 \| tail -20`) does NOT count as read (BLOCKER fix, re-review finding): `markCommands()` marks a `\|`-opened boundary with a distinct marker (`CMD_PIPE`, vs. plain `CMD` for every other boundary) and this rule's `READERS` alternative matches only the plain marker, so `\| tail`/`\| head`/`\| grep`/`\| sort`/`\| wc`/`\| less` filters fall through to whatever rule the piped-FROM command matches (usually `script run`, below). Every other rule still matches through either marker (`ANY_CMD`), so e.g. `cat file \| git apply` is still `git` — only `read`'s READERS branch is narrowed. `ls; python x.py` (semicolon, not pipe) is unaffected and still reads as `read`. |
| 12 | script run (Slice 15) | a bare interpreter run (`python[^\s‣‥]*`, `py`, `node`, `deno`, `bun`, `tsx`, `ts-node`, `sh`, `bash`, `pwsh`, `powershell`) or a direct `*.mjs/js/py/sh/ps1` file run, at a command start (`CMD` or `CMD_PIPE`) — below test/lint/build, git, screenshot/image, edit **and read** (all of which win first: `python -m pytest` is still a test run, `node scripts/screenshot.mjs` is still a screenshot). Moved below edit/read after a review finding (real data): a compound Bash call mixing a `python - <<EOF … EOF` heredoc segment with a real edit/read segment (e.g. a `cat`/`sed -i` elsewhere in the same call) used to classify as `script run` — `.find()` over `ACTIVITY_RULES` picks the first *rule* with a match anywhere in the subject, not the first *segment* in the command, and `script run` ran before edit/read. With `script run` last, it only ever claims turns edit/read didn't already recognize — i.e. it takes share from `other`, plus (after the `CMD_PIPE` fix above) the false `read` share that piped script re-runs (`python x.py \| tail`) used to get. **Measured** (`--all --days 3650`, real local history, after both fixes): read 29.3%, script run 16.0%, edit 15.2%, test/lint/build 13.6%, git 10.5%, reply 7.0%, wait/poll 2.3%, other 0.5% — `other` stays a small residual, as designed. |
| – | other | no rule matched at all |
| – | reply (Slice 15) | the turn made no tool call (final answer, plan, question to the user) |

Decisions not fixed by design decision Q9 (judgment calls):

- **Status checks count as wait/poll, not GitHub.** Design decision Q9 lists "repeated status checks"
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
- **Turn with no `tool_use` → `reply` (Slice 15; `other` before it).** A text-only or
  thinking-only turn (final answer, plan, question to the user) has no tool to attribute it
  to. Originally folded into `other`, which kept totals whole (turns and cost still sum to
  the window's totals with `reply`) but hid `other`'s real composition — measured on
  2026-09-25, all-history real data, reply-type turns were ≈ 7% of total spend on their
  own (9.6% on the second project, 9.7% on token-audit), by far the largest single piece of what
  `other` used to mean. Split into its own category so `other` reports only genuinely
  uncategorized tool calls.
- **Split = per call, evenly.** A turn with n tool calls gives 1/n of its cost, 1/n of a turn
  and 1/n of its context weight to each call's category (k calls in one category → k/n). So
  `turns` can be fractional in `--json` (shown rounded in text, `<1` below one), `avgCtx` is
  `Σ(w·ctx) / Σw`, and turns, cost and share each sum to the window totals.
- **Tool calls of a turn = union over its JSONL lines** (one line per content part, all
  sharing `message.id`); a `tool_use.id` seen twice counts once.
- **`harness` and `script run` (Slice 15) pulled out of `other`.** Measured on 2026-09-25,
  all-history real data, `other`'s composition (share of total spend) was: reply-shaped
  turns ≈ 7% (now `reply`, above), shell runs of a script (`python …`, `node …`,
  `S=<path> ; python -c …`, `sh x.sh`) ≈ 11.3% all / 6.4% second project / 2.4% token-audit (now
  `script run`), harness tools (`Skill`, `ToolSearch`, `AskUserQuestion`, `TaskStop`, …)
  ≈ 1.6% all / 1.4% second project / 5.4% token-audit (now `harness`), wait-shaped commands
  (`echo waiting-*`, `tasklist`, `true`) ≈ 0.2% (folded into `wait/poll`'s busy-poll row,
  table row 9 above), misc shell (`mkdir`, `cp`, `rm`, `for`, `export …`) ≈ 0.2–0.6%,
  genuinely unmatched ≈ 0.1%. So `other` was never one thing — it was mostly replies, script
  re-runs and harness bookkeeping wearing a single "uncategorized" label. `script run` sits
  below test/lint/build, git, screenshot/image, edit and read in `ACTIVITY_RULES` (checked
  above it, they win — see table row 12 above for the edit/read review finding); its
  file-extension alternative is written `[^\s${CMD}${CMD_PIPE}]*\.(?:m?js|py|sh|ps1)\b`,
  not `\S+\.(?:m?js|py|sh|ps1)\b` — the latter, anchored at every `CMD` boundary (e.g. every
  `(` of 50k nested parens, none of them whitespace), backtracks per anchor across the rest
  of the string, O(n²) or worse (Slice 30's exact bug class); excluding `CMD` from the
  class too stops each attempt at the very next command boundary, same fix as `SHOT_TARGET`
  above. Its bare-interpreter alternative had the same flaw for `python`: `python\S*` is
  unbounded, so many adjacent `‣python` command starts with no whitespace between them (e.g.
  40k reps) forced one giant greedy match that then backtracked a char at a time hunting for
  the trailing `(?: |$)` — O(n²), ≈21s measured. Fixed to `python[^\s${CMD}${CMD_PIPE}]*`, same bound as
  the file-extension alternative above (review finding, re-tune pass). A sibling, still-open
  instance of the identical flaw lives in `SHOT_EXEC` (the `screenshot/image` row above,
  which is checked *before* `script run` and so masks this one on the same adversarial
  input) — pre-existing (before Slice 15), out of scope for this fix.

### Activity table vs Q9 hand estimates (Slice 15)

Design decision Q9 gave two hand estimates to verify once this feature existed: polling ≈ 1–2%
of the second project's spend, screenshots ≈ 2.6%. Measured with the finished script (the second project,
`--all --days 3650`, real data):

- **Polling: `wait/poll` 1.35% + `github` 1.49% = 2.84%.** The hand estimate holds
  (1.3–2%) if "polling" means only the actual wait endpoints (`check-runs` / `actions/runs`
  / `sleep` loops, i.e. the `wait/poll` category alone); it reads 2.8% if every GitHub API
  call counts, including `pulls` fetches and the `git credential fill` setup that isn't
  itself a wait. No bug — a definition gap, not a measurement gap. This case (89 `check-runs`
  + 23 `actions/runs` + 107 `pulls`, ~$33 = 2.5% of the second project's spend, spread across 33
  sessions with ≤ 8 calls/session and ~87 distinct keys) is also why `POLLING` itself never
  fires on it — `GH_POLLING` (Slice 31) is the cross-session detector that catches it.
- **Screenshots: `screenshot/image` table row = 4.89% of the second project's spend.** Higher than the
  2.6% hand estimate because the table charges the *whole turn* (full context) to the
  category, not just the image's own tokens. A second, narrower measure — the tokens a
  screenshot actually carries forward in context (image tokens × remaining turns in that
  session, at the session's cache-read price) — comes to ≈ 1.4% (the original hand estimate,
  2.6%, was computed on non-deduped turns; 2.6 / 1.9, the dedupe factor, ≈ 1.4%, i.e. the
  gap there was the pre-Slice-2 dedupe bug, not a real difference). The conclusion from
  design decision Q6 stands either way: screenshots are a non-lever (≈ 1.4% actually carried in
  context); the table's 4.9% is turn cost that the verification step would spend regardless
  of whether it looked at a screenshot.
- **`other` (now `other` + `reply` + `script run` + `harness` together, so they can be
  compared to the old single-bucket `other`): before Slice 15, all-history 20.4%, the second project
  18.1%, token-audit 17.9%, last-14-days 16.7%. After Slice 15 (same real data, `other`
  alone): all-history 0.28%, the second project 0.76%, token-audit 0.66% — comfortably under the
  "~1%" target on every cut, on the second project and on this repo's own history. The rest of the old `other` moved to
  `reply` (≈7–10%), `script run` (≈2–14% depending on project), `harness` (≈1–5%) and a
  small amount into `wait/poll`'s two new `BUSY_POLLERS` patterns. Re-measured after the
  `CMD_PIPE` read/script-run fix above (`--all --days 3650`, all-history real data, whole
  local history, no `--project` filter): `other` 0.48%, `read` 29.3%, `script run` 16.0%,
  `edit` 15.2% — `other` stays comfortably under 1%; the pipe fix moved a further slice
  of turns from `read` into `script run` (piped script re-runs), on top of the `other` →
  `script run`/`reply`/`harness` split above.
  **Before/after on the exact same population** (re-review finding: the numbers above came
  from two different points in time, not a controlled comparison). Ran the pre-`CMD_PIPE`-fix
  script (commit `5561717`, immediately before the `CMD_PIPE` fix) against the *same*
  `--all --days 3650` local history, seconds apart from the post-fix run: `other` 0.28% →
  0.48%, `read` 34.2% → 29.3%, `script run` 11.3% → 16.0% (all other categories within a
  few cents — `git` $1417.86 → $1417.88, `screenshot/image` $64.65 both). So the `other`
  0.28% → 0.48% move is **not** data growth (same live history, measured moments apart) —
  it's 258 tool calls (commit `8328f46`, ~230 more turns) where an unrecognized command is
  piped into a read-style filter (`curl | grep`, `cut -f | grep`, `pnpm ingest | tail`,
  `npm view | tail`, `unzip -l | head`): under the "a filter after `|` is not `read`"
  decision, `READERS` no longer credits these once they correctly carry `CMD_PIPE`, so
  they fall to `other` instead — `other`'s post-fix total is $65.56, of which these 258
  calls added +$27.8 over the pre-fix run. The wrapper-after-pipe
  fix in `b30c5e3` moved 0 calls on this population — the whole increase is this
  filter-after-pipe decision; still comfortably under the ~1% target. `script run`'s 16.0%
  above the ~11.3% hand-estimate target measured during development for "all" the same way:
  that estimate was computed before the `CMD_PIPE` fix existed (11.3% is what this same
  before-fix run reproduces almost exactly), on the assumption that a piped-into-filter
  script run (`python x.py | tail`) still counted as `read`. Post-fix it correctly counts as
  `script run` — the user decision behind the `CMD_PIPE` fix itself — so 16.0% is expected,
  not a regression.

### Cost by activity — command key

`commandKey(command)` (exported) turns a `Bash` / `PowerShell` command into a key so the same
command against a different PR number, commit, path or cwd groups together. `POLLING`
counts identical keys per session (wait-type categories only — see its playbook entry);
`BOILERPLATE` groups its setup prefix across sessions (see its playbook entry).
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

**Reason**: design decision Q3 specifies the stat ("median, p90, max" for turns and peak ctx) but not
its population. The top-10 list is a leaderboard of the most expensive subagents; the
distribution's job is to say whether a leaderboard entry is typical or an outlier (an example
considered during design: "agent A ran 288 turns — is that normal?"), which only works if it is computed over the
full population, not the 10 rows the reader is already looking at (those would show a distribution
dominated by the leaderboard itself, converging to roughly the top-10's own median as list size
shrinks). This mirrors the summary's SESSIONS median/p90 (Slice 15: main sessions only,
`cur.mainSessions`, see `LONG_SESSION` above), which is likewise computed over its full
population — main sessions, not subagents — rather than just the top ones.

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
| | `modelSettings.<model>.effortLevel` | per-model override, reported per model when present (root fallback still shown as `default=`) |
| | `enabledPlugins` | filters which cache entries count — cache/ holds stale/uninstalled plugins too |
| `~/.claude/plugins/cache/**/.claude-plugin/plugin.json` | `agents`, `skills` | prefix weight, only for plugins enabled in `settings.json` |
| `~/.claude.json` (sibling of `~/.claude/`, **not** inside it) | `mcpServers` | user-scope MCP servers, available in every project |
| | `projects[<absProjectDir>].mcpServers` | project-local MCP servers (private to this user+project, e.g. `claude mcp add` without `--scope project`) |
| `<project>/.mcp.json` | `mcpServers` | project (repo-shared) MCP servers, checked into source control |

Prefix weight is estimated from each definition's `name` + `description` frontmatter at
~4 chars per token. It is an estimate — present it as one. Only plugins with
`enabledPlugins["<plugin>@<marketplace>"] === true` are counted — `plugins/cache/` retains
entries for marketplaces/plugins that were browsed or previously installed but are not
active, and counting those inflates `PLUGIN_BLOAT`.

### CONFIG value types in `--json` (Slice 20, 4th review)

`config.model`, `config.cleanupPeriodDays`, `config.effortLevel` and each
`config.modelEffort[].effortLevel` keep their **live JSON type** in `--json` — a
string stays a string, a number stays a number, and a forged non-string value
(an object/array where `settings.json` was expected to hold a string) comes
through as that same object/array, not a stringified placeholder. Every string
anywhere in that structure (both keys and values, recursively) is redacted
(`redactPaths()`) and control-char-stripped (`show()`'s `CONTROL_CHARS`) before
it is ever serialized — never after — so an escape sequence produced by
serializing first (e.g. `\n` becoming the two literal characters `\` and `n`)
can't glue a letter onto a name/login and defeat `redactPaths()`'s identity
boundary check. Values are never truncated in `--json`: `fit()`/`fitMiddle()`
run only when building the text report, on a `JSON.stringify()` of the
already-redacted structure at that point — see `showAny()`/`textOf()` in
token-audit.js.

### CONFIG — one line (Slice 28, HITL decision D)

CONFIG prints one ≤ 120-char line, right under `TREND`:
`CONFIG       model=<model> effort=<root>,<model>:<level>,… plugins=N mcp=N prefix≈N.Nk
retention=N`.

- `effort=` lists the root `effortLevel` (the default for models without their own entry)
  first, then each `modelSettings.<model>.effortLevel` as `<model>:<level>` with the `claude-`
  prefix dropped, comma-separated; `unset` when neither is set. `effort=` is fit first; entries
  that don't fit end in one `+N` marker. `model=` gets what's left (12–30 chars).
- `mcp=` (MCP server count) is left out when no server is configured; `prefix≈` is the fixed
  tokens/request that plugin agent/skill definitions plus MCP tool definitions add.
- `retention=` (`cleanupPeriodDays`) is left out while unset — SECURITY's `NO_RETENTION`
  already says so.
- Per-plugin rows, MCP server names/scopes, agent/skill counts and the separate token
  estimates are no longer printed (DETAIL has no room left): `--json`'s `config` has all of
  them. Every value is `show()`n (redacted/sanitized) before and `fit()` at print time
  (Slice 20/29), so a hostile value can't add a line or pass 120 chars.

Replaces the Slice 20 layout (own `effortLevel:` line plus one `    <model>=<level>` line per
model, and one row per heavy plugin / MCP server).

### FLAGS/SECURITY text — wraps instead of truncating (Slice 20)

A flag's `text` can be a fixed advisory message (e.g. `NO_RETENTION`'s "transcripts …
sit in plaintext indefinitely", 109 chars) that alone exceeds `FLAG_TEXT_WIDTH` (103 —
`120` minus the 17-char `  <id padded to 14> ` gutter). Unlike task text,
this is advice, not a label, so it is never cut with `…`; instead it word-wraps onto
continuation lines indented 17 spaces to align under the first line's text. POLLING and
BOILERPLATE lines are unaffected — their variable part is already bounded to
`FLAG_TEXT_WIDTH` by `fitMiddle`/`fitPrefix` before printing.

### MCP servers — CONFIG's `mcp=` field

Slice 14. `--json`'s `config.mcpServers` lists the MCP servers configured for the scoped
project, tagged `user` / `project` / `mcp.json` for which of the 3 sources above declared it.
`config.mcpPrefixTokens` is the estimated tool-definition weight those servers add to the
prompt prefix (`mcpServers.length * MCP_SERVER_TOKENS`, see "Weight estimate" below) — the
same number folded into the text report's `prefix≈` figure, exposed on its own for callers
that want the MCP-only portion split out from plugin agent/skill weight.
Since Slice 28 (HITL decision D) the text report only counts them (`mcp=N` on the one CONFIG
line, their estimated tool-definition tokens folded into `prefix≈`); no `mcp=` at all when
nothing is configured.
Under `--all` (no single scoped project), only `user`-scope servers are listed —
`project` and `mcp.json` need one project directory to check.

**Location decided at implementation time**: checked a real `~/.claude.json` —
`mcpServers` lives there, at the top level and per-project, never in `settings.json`.
Where the script reads that file from tracks how the Claude dir itself was resolved
(Slice 23): under the default (`~/.claude`), it reads the sibling `<claude-dir>.json`
(`DIR.json`, matching real Claude Code's default `~/.claude` + `~/.claude.json` layout,
and the convention fixtures already use — tests fixture `DIR.json` the same way they
already fixture `settings.json` inside `DIR`). Under `CLAUDE_CONFIG_DIR`, it reads
`<claude-dir>/.claude.json` (inside the dir) instead — that matches real Claude Code,
which moves `.claude.json` inside the relocated dir rather than leaving it beside it.
Under an explicit `--claude-dir DIR`, it prefers `DIR/.claude.json` when that file
exists (DIR may itself be a dir set up via `CLAUDE_CONFIG_DIR`, `.claude.json` living
inside it) and only falls back to the sibling `DIR.json` when it doesn't.

**Weight estimate**: MCP tool *definitions* (name, JSON-schema, description per tool)
are fetched live over the MCP protocol when a session connects — they are not in any
local config file or transcript, so unlike `PLUGIN_BLOAT` (measured from real
frontmatter files) this can't be measured, only estimated. The alternative
considered — counting distinct `mcp__<server>__*` tool names seen in transcripts —
undercounts (a server usually exposes more tools than were ever called) and reads
zero for a configured-but-unused server, which is precisely the "you're paying the
prefix cost but not using it" case this line exists to catch. So: a flat
`MCP_SERVER_TOKENS = 800` per server (~6-10 tools/server, ~100-150 tok each is a
typical MCP tool schema), clearly presented as an estimate, not a measurement.

## Script flags

| flag | default | meaning |
|---|---|---|
| `--days N` | 14 | window; the previous N days form the comparison window |
| `--top N` | 8 | sessions kept in `--json`'s `cur.sessions`/`prev.sessions`; TOP SESSIONS is no longer printed in the text summary (Slice 28) |
| `--json` | off | full structured dump incl. per-week and per-plugin detail |
| `--claude-dir DIR` | `$CLAUDE_CONFIG_DIR` or `~/.claude` | read transcripts + settings from DIR instead (tests use fixture dirs) |
| `--project PATH` | cwd | scope to one project: PATH is resolved (`path.resolve`, so `.`, `..`, and relative paths work) then mapped to its `projects/` folder name the same way Claude Code names it — every character that isn't a-z/A-Z/0-9 becomes `-` (`C:\Users\user\project` → `C--Users-user-project`; `/Users/user/project` → `-Users-user-project`). Folder names over 200 chars are truncated by Claude Code to 200 chars + `-<hash>`; this script matches the 200-char prefix against an existing `projects/` folder instead of reimplementing the hash. An empty value (`--project ""`) errors the same as a missing value. |
| `--all` | off | scope to every project instead of just one (pre-Slice-6 behaviour) |
| `--no-detail` | off | drop the DETAIL block (text) and the `detail` key (`--json`): summary only |

**`--json`'s `cur.medianMsgs`/`cur.p90Msgs`** (and the same fields on `prev`) are computed over
**main sessions only** (`cur.mainSessions`, `!isSub`) — the same population the text summary's
`SESSIONS` line reports (Slice 15; see `LONG_SESSION` above). `cur.sessions`/`prev.sessions`
still list every session, main and subagent alike; only the median/p90 stat excludes subagents.

**`--claude-dir` precedence (Slice 23)**: an explicit `--claude-dir DIR` flag wins if given;
else the `CLAUDE_CONFIG_DIR` env var if set (real Claude Code's own relocation variable);
else `~/.claude` (the default). This also decides where the MCP user-config file is read
from — see "MCP servers" above.

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
subagent) is credited to whichever occurrence has the earliest timestamp for that id,
not whichever file the scan reaches first — files are walked in path-sorted order, and
a later-sorted file can hold the earlier real occurrence. A missing/unparsed timestamp
never outranks a real one, and an exact tie keeps whichever occurrence was seen first.

A subagent session's identity is `(parent, sid)`, not `sid` alone — the same subagent
id can recur under two different parent sessions, and those are two distinct sessions;
main sessions have no parent and keep keying by `sid` alone.
