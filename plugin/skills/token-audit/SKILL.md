---
name: token-audit
description: >
  Periodic checkup of Claude Code token spend and habits. Measures local
  transcripts (~/.claude/projects/**/*.jsonl) for cost, context-per-message,
  session concentration and week-over-week trend, inspects settings.json and
  installed plugins for config drift, flags transcript-retention risk
  separately as a confidentiality issue (not cost), and returns a ranked
  list of concrete habit fixes.
argument-hint: "[--days N] [--project <path>] [--all] [--no-detail] [--claude-dir <path>]"
disable-model-invocation: true
---

# Token audit

Measure first, advise second. Every number comes from the script — never guess.

Requires Node.js 18 or newer.

```
node <skill-dir>/scripts/token-audit.js --days 14
```
`<skill-dir>` = `${CLAUDE_PLUGIN_ROOT}/skills/token-audit` if plugin, else this
folder. `--top N` sessions (def 8, `--json` only) · `--json` · `--no-detail` (drop the DETAIL block below
the summary: top work units, top subagents by cost with task text, subagent turn/peak-ctx
distribution, and a cost-by-activity table — see "Report shape" below). ~30-60s. Read-only.

Scope defaults to the **current project** (cwd mapped to its `projects/` folder name).
`--project <path>` audits a different project; `--all` audits every project (habits differ
per project — don't mix them by default).

## Loop

```
 RUN ──▶ READ FLAGS ──▶ RANK BY $ ──▶ CHECK TREND ──▶ REPORT ──▶ PROPOSE
 script   REFERENCE.md   top 3 only    vs prev + wk    ≤24 lines  never apply
```

1. Run the script. `$ARGUMENTS` is whatever the user typed after `/token-audit`, and it lands
   in a shell command — never forward it verbatim. Only the flags below pass through, and only
   with a valid value; drop everything else in `$ARGUMENTS` — a flag not on this list, or a
   listed flag with an invalid value — silently for junk, with a one-line note to the user for a
   listed flag that got dropped:
   - `--days N` — N must match `^\d+$`, else drop the flag.
   - `--project <path>` / `--claude-dir <path>` — always wrap the value in single quotes in the
     command, so it's passed as one argument even with spaces; if it contains a `'` or a
     newline, or is empty or starts with `-`, drop the flag instead of wrapping it.
   - `--all`, `--no-detail` — no value, pass through as-is.
   `--top N` is not on this list: it only reshapes `--json`'s session list, and this skill never
   emits `--json`, so it has nothing to affect here. Refuse `--json` itself: it doesn't fit the
   summary's line budget here — tell the user to run the script directly instead (see the
   README's "Machine-readable export"). With no recognized flags in `$ARGUMENTS`, fall back to
   the default window, full text output.
2. Each FLAGS id → playbook entry in [REFERENCE.md](REFERENCE.md). The summary shows as many as
   fit (ranked by extra cost, then fixed priority; typically 4-5, see REFERENCE.md "Summary cap
   and ranking"); the `… +N more: IDs` line names the rest, printed in full under
   `FLAGS (continued …)` in DETAIL / in `--json`'s `flags` — read those too.
3. Rank by **measured** impact. Max 3 actions. State the % each targets.
4. Compare `PER MESSAGE` vs prev window + the `TREND` line (per-week table: `--json` `weeks`)
   — trend > level.
5. `NO_RETENTION` never competes for DO NEXT slots — always its own line,
   always reported, confidentiality not cost. Tag rest CONFIG (one-time) vs
   HABIT (recurring).
6. Propose fixes only — exact diff / `/plugin` command. Never edit settings,
   disable plugins, or delete transcripts.

## Report shape

Banner first — verdict felt before a number is read. Box chars only, no emoji:

```
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│  ALL CLEAR   ▓░░░░    │  │  IMPROVING   ▓▓▓░░    │  │  REGRESSION  ▓▓▓▓▓    │
└──────────────────────┘  └──────────────────────┘  └──────────────────────┘
  no flag fired             beat prev window          cost/msg up >25%
```

Then trend — one line: a sparkline over the weeks with data, first week vs last week cost/msg,
the % change and the span:

```
TREND        ▅█▆▂▁ 2026-05-04 $0.120/msg → 2026-06-15 $0.090/msg -25%   span 7 wk (5 with data)   full table in --json
```

Then data, fixed-width labels so it scans as a table:

```
SPEND     $X / Nd (±%)        Opus X% Sonnet Y%      main X% sub Y%
HABIT     ctx/msg Xk (Yk)     worst: <sid> $X, Nd span, N msgs
CONFIG    model=… prefix≈Xk tok/req              [one-time fix]
SECURITY  cleanupPeriodDays=… → plaintext transcripts   [confidentiality]

DO NEXT   1 ▓▓▓▓▓▓▓▓░░ 40%  …
          2 ▓▓▓░░░░░░░ 15%  …
          3 ▓▓░░░░░░░░ 8%   …
```
DO NEXT bars are relative-impact gauges, 10 chars, filled ∝ % of spend targeted
— largest lever visually first, no exceptions.

If this window beat the last one, one line before DO NEXT, own row:
```
BEAT LAST WEEK  ctx/msg -24%  $/msg -18%  → keep doing whatever changed
```
Skip it if nothing beat last window. Never invent a win.

**Budget: ≤24 lines** (banner + trend ≈3 of them). Raw script output only if asked.

Below the summary, DETAIL runs by default (`--no-detail` drops it): top 10 work units
(parent session + its subagents rolled up), top 10 subagents by cost with task text,
subagent turn/peak-ctx distribution, and a cost-by-activity table (top 6 categories —
git, test/lint/build, GitHub, read, edit, script run, wait/poll, agent spawn, web,
screenshot, harness, reply, other). Read it before ranking DO NEXT — it's where the
subagent/activity evidence for that ranking lives.

## Hard rules

| rule | why |
|---|---|
| list-price ≠ bill | Pro/Max charges nothing per token; number = plan-limit proxy, say once |
| no flag → no advice | clean window → say so, stop. no generic tips |
| non-levers: file reads, greps, bash output | measured, don't optimize |
| subagent count/duration: lever only if measured share is large or Opus-heavy | REFERENCE.md "Measured non-levers" / `LONG_AGENT` |
| audit itself: 1 script run, 1 reply | no subagents, no manual transcript reads/greps |

## Cadence

Weekly — habits move on a week scale.

```
manual    /token-audit            start of week
loop      /loop 6h /token-audit   watching an active regression
scheduled /schedule                unattended
```

Run from a **fresh session** — auditing inside a fat-context session is the
exact habit this audit exists to catch.

## Reference

[REFERENCE.md](REFERENCE.md) — flag playbook, baselines, pricing, cost model, config keys.
