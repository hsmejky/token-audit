# token-audit reference

## Cost model

```
cost ≈ Σ over turns ( context_size × per-token rate )
```

Context is re-sent on **every** turn, so spend grows with `context × turns` — roughly
quadratic in session length, and nearly independent of how many files were read.
This single fact drives every playbook entry below.

`$/MTok` used by the script:

| model | input | cache write 5m | cache write 1h | cache read | output |
|---|---|---|---|---|---|
| Opus 5 | 5 | 6.25 | 10 | 0.50 | 25 |
| Sonnet 5 | 2 | 2.50 | 4 | 0.20 | 10 |
| Sonnet 4.6 | 3 | 3.75 | 6 | 0.30 | 15 |
| Haiku 4.5 | 1 | 1.25 | 2 | 0.10 | 5 |

Multipliers: cache read 0.1×, 5m write 1.25×, 1h write 2× the input rate. When a
transcript entry has no 5m/1h breakdown the script assumes 1h (the pessimistic case).
There is **no long-context premium tier** on current models — a 900k request bills at
the same per-token rate as a 9k one.

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

## Config keys the script reads

| file | key | why |
|---|---|---|
| `~/.claude/settings.json` | `model` | global default; `OPUS_HEAVY` context |
| | `cleanupPeriodDays` | transcript retention — feeds `SECURITY`, not `FLAGS` |
| | `effortLevel` / `env.EFFORT_LEVEL` | reported, low impact |
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

Exit code 1 with a message when `~/.claude/projects` is missing or holds no priced
messages.
