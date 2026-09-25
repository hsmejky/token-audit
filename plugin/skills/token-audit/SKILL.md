---
name: token-audit
description: >
  Periodic checkup of Claude Code token spend and habits. Measures local
  transcripts (~/.claude/projects/**/*.jsonl) for cost, context-per-message,
  session concentration and week-over-week trend, inspects settings.json and
  installed plugins for config drift, flags transcript-retention risk
  separately as a confidentiality issue (not cost), and returns a ranked
  list of concrete habit fixes. Use when user says "token audit", "tokenomics", "check my
  claude usage", "how many tokens am I burning", "where do my tokens go",
  "am I wasting tokens", "cost report", "usage report", "weekly claude
  checkup", "why did I hit the limit", asks how to spend fewer tokens or
  make Claude Code cheaper, or invokes /token-audit.
---

# Token audit

Measure first, advise second. Every number comes from the script — never guess.

```
node <skill-dir>/scripts/token-audit.js --days 14
```
`<skill-dir>` = `${CLAUDE_PLUGIN_ROOT}/skills/token-audit` if plugin, else this
folder. `--top N` sessions (def 8) · `--json` · `--no-detail` (drop the DETAIL block below
the summary: top subagents by cost with their task text). ~30-60s. Read-only.

Scope defaults to the **current project** (cwd mapped to its `projects/` folder name).
`--project <path>` audits a different project; `--all` audits every project (habits differ
per project — don't mix them by default).

## Loop

```
 RUN ──▶ READ FLAGS ──▶ RANK BY $ ──▶ CHECK TREND ──▶ REPORT ──▶ PROPOSE
 script   REFERENCE.md   top 3 only    vs prev + wk    ≤24 lines  never apply
```

1. Run script, default window, full text output.
2. Each FLAGS id → playbook entry in [REFERENCE.md](REFERENCE.md). The summary shows the
   top 4 (ranked by extra cost, then fixed priority); the `… +N more: IDs` line names the rest,
   printed in full under `FLAGS (continued …)` in DETAIL / in `--json`'s `flags` — read those
   too.
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

Then trend — one sparkline, oldest→newest, ▁▂▃▄▅▆▇█ scaled to $/week:

```
TREND   ▇▆▅▃▃▂▁   6wk, $/msg   ↓ falling = good, say the direction in prose
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

## Hard rules

| rule | why |
|---|---|
| list-price ≠ bill | Pro/Max charges nothing per token; number = plan-limit proxy, say once |
| no flag → no advice | clean window → say so, stop. no generic tips |
| non-levers: file reads, greps, bash output, subagent count | measured, don't optimize |
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
