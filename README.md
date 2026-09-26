# Token Audit

```
┌────────────────────────────────────────────────────────────┐
│  TOKEN AUDIT              where do my tokens actually go?  │
│                                                            │
│  cost ▓▓▓▓▓▓░░░░   ctx/msg ▓▓▓░░░░░░░   habits ▓▓▓▓▓▓▓▓░░  │
└────────────────────────────────────────────────────────────┘
 RUN ──▶ MEASURE ──▶ FLAG ──▶ RANK BY $ ──▶ DO NEXT (top 3)
```

A checkup for your Claude Code habits. Type `/token-audit` and get a one-screen report: what you
spent, how fat each message's context is, which sessions ate the budget, whether this week beat
last week, what drifted in your config (model, effort, MCP servers, plugin count, transcript
retention), and a ranked list of the three fixes worth your time.

No vibes. Every number comes from a script that reads your transcripts; Claude only turns the
measured flags into advice, and says "all clear" when there's nothing to fix.

It reads your local transcripts under `~/.claude/projects` and your `settings.json`, and never
sends anything anywhere (see [Privacy](#privacy)).

## Install

Install it once, at **user scope**, and it works in every project:

```
/plugin marketplace add hsmejky/token-audit
/plugin install token-audit@token-audit
```

If the `/plugin` menu asks for a scope, pick **user**. From a terminal, the same thing is
`claude plugin install token-audit@token-audit --scope user` (user is the default there too).

Then, from a fresh session:

```
/token-audit
```

### Why user scope, and why it's free to keep around

```
 installed, not invoked    0 tokens      nothing in the prompt, not even a description
 /token-audit              1 run         script counts outside the context, Claude reads the report
```

The skill sets `disable-model-invocation: true`, so Claude never auto-loads it and its
description isn't in your context. It only wakes up when you type `/token-audit`. The plugin
ships no agents, hooks or MCP servers either. An uninvoked skill costs **zero tokens at rest**,
so there's nothing to gain by installing it per project, and a user-scope install lets you
audit any project (or all of them) from wherever you are.

## Sample report

This is what `/token-audit` actually puts on screen, not just the script's raw text: the
banner, the `SPEND`/`HABIT`/`CONFIG`/`SECURITY` rows and the `DO NEXT` fixes are Claude's own
rendering, drawn from the script's numbers per the skill's report template; the `TOKEN AUDIT`
header line, `TREND` line and everything from `DETAIL` down are the script's own output,
unedited. Generated from synthetic fixture data (`--all --days 7`), not a real project. Names,
sessions and paths below are made up for illustration:

```
┌──────────────────────┐
│  REGRESSION  ▓▓▓▓▓    │
└──────────────────────┘

TOKEN AUDIT   scope all projects   window 2026-09-16 → 2026-09-23 (7d)   list-price equivalent
TREND        ▃▁▃█ 2026-08-24 $0.012/msg → 2026-09-21 $0.022/msg +87%   span 5 wk (4 with data)   full table in --json

SPEND     $1.52 / 7d (+585%)         Opus 40% Sonnet 60%      main 100% sub 0%
HABIT     ctx/msg 68k (16k)          worst: sess-build $0.92, <1d span, 34 msgs
CONFIG    model=unset (harness default)  effort=unset  prefix≈0.0k tok/req
SECURITY  cleanupPeriodDays=30 — nothing flagged

DO NEXT   1 ▓▓▓▓▓░░░░░ 55%  cost/msg +122% vs last window ($0.84 extra) — check TREND, then sess-build
          2 ▓▓▓░░░░░░░ 30%  25x poll loop in sess-polling ($0.47) — swap for Monitor/run_in_background, one turn not 25

DETAIL
TOP 10 WORK UNITS (this window, parent + subagents; span = full history)
  sid          cost    sub%  #ag  turns   peak   span  project
  sess-bui   $0.921    0.0%    0     34   171k   0.0d  demo-webapp
  sess-pol   $0.465    0.0%    0     25    92k   0.0d  demo-webapp
  sess-qui   $0.139    0.0%    0      9    37k   0.0d  demo-webapp
TOP SUBAGENTS  none in this window
SUBAGENT DISTRIBUTION  none in this window
COST BY ACTIVITY (this window, top 6; a turn's cost split evenly over its tool calls)
  category           turns  avg ctx     cost   share
  reply                 43      74k    $1.06   69.5%
  wait/poll             25      56k   $0.465   30.5%
```

Costs are **list-price equivalents** (Claude API $/MTok): on Pro/Max nothing is billed per
token, so the number is a proxy for what eats the plan limit, not a bill.

## Pick your audit

Plain `/token-audit` is the weekly checkup. For anything else, add flags after the command
(`/token-audit --days 7 --no-detail`) and Claude passes them on to the script:

```
 you want...                        run
 ─────────────────────────────────  ──────────────────────────────────────────────
 the weekly checkup                 /token-audit
 a quick glance, summary only       /token-audit --days 7 --no-detail
 to see if a habit fix worked       /token-audit --days 3        (3 = days since the fix)
 a deep-dive into another project   /token-audit --project ../demo-webapp --days 30
 the whole machine at once          /token-audit --all --days 7
 the long view                      /token-audit --days 90
 numbers for a spreadsheet/script   node <skill-dir>/scripts/token-audit.js --json ...
```

**The weekly checkup** (`/token-audit`). This project, the last 14 days against the 14 before,
summary plus the DETAIL block (top work units, costliest subagents, cost by activity). Run it
from a fresh session: auditing from inside a long, fat-context session is exactly the habit it
is built to catch.

**A quick glance** (`--days 7 --no-detail`). This week against last week, summary only: the
banner, trend, flags and at most three next steps.

**Did the fix work?** (`--days N`). The window is always the last N days compared with the N
days before them. Set N to the number of days since you changed a habit and the report is a
clean before/after. Keep N at 3 or more; a day or two holds too few messages to say much.

**Another project** (`--project PATH`). Scope defaults to the project you're in. `--project`
points at a different one without leaving your session; relative paths like `../demo-webapp`
work. A longer window (`--days 30`) gives a quieter project enough data to flag anything.

**The whole machine** (`--all`). Every project in one report: the true total, and the one place
to see which project dominates (the `project` column in DETAIL). Habits differ per project, so
treat the flags as a pointer and follow up with `--project` on the project that stands out.

**The long view** (`--days 90`). `ALL-TIME` and `TREND` already cover your entire history
whatever window you pick; a wide `--days` makes SPEND, FLAGS and DETAIL cover a quarter too.
The full week-by-week table is `weeks` in `--json`.

**Machine-readable export** (`--json`). Run the script yourself instead of through the skill,
so a large JSON dump doesn't land in Claude's context. `<skill-dir>` is
`plugin/skills/token-audit` in a clone of this repo:

```
node <skill-dir>/scripts/token-audit.js --all --days 30 --json --top 25 > audit.json
```

`--top N` sets how many sessions `cur.sessions`/`prev.sessions` keep (default 8);
`--no-detail` drops the `detail` key for a smaller file. Run directly, the default scope is
your shell's current directory, so `cd` into the project first or pass `--project`/`--all`.

**A different Claude folder** (`--claude-dir DIR`). Audit a copied or relocated `.claude`
folder. If you set `CLAUDE_CONFIG_DIR`, the script already follows it without the flag.

## Requirements

Node.js **18 or newer**. Verified by running the full test suite (`node --test tests/*.test.js`)
on Node 18, 22 and 24 — all green (CI's matrix). No other dependencies; the script is plain Node
(`fs`, `path`, `readline`, `crypto`, `os`, `child_process`).

## Script flags

The script accepts these flags:

| flag | default | meaning |
|---|---|---|
| `--days N` | 14 | window; the previous N days form the comparison window |
| `--top N` | 8 | sessions kept in `--json` output |
| `--json` | off | full structured dump |
| `--claude-dir DIR` | `$CLAUDE_CONFIG_DIR` or `~/.claude` | read transcripts + settings from DIR instead |
| `--project PATH` | cwd | scope to one project |
| `--all` | off | scope to every project instead of just one |
| `--no-detail` | off | drop the DETAIL block: summary only |

`/token-audit` only forwards `--days`, `--project`, `--all`, `--no-detail` and `--claude-dir`,
and refuses `--json`; run the script directly for `--top` or `--json`.

Full detail on each flag, precedence rules, and the flag playbook (what each `FLAGS`/
`SECURITY` line means and how to act on it) live in
[`plugin/skills/token-audit/REFERENCE.md`](plugin/skills/token-audit/REFERENCE.md).

## Privacy

The script only reads local files: transcripts under `~/.claude/projects/**/*.jsonl` and
`settings.json`/MCP config. It never makes a network call and never writes or modifies
anything. All output stays on your machine — the skill only prints a report; sharing it
anywhere is your call, not the script's.

To redact your name from reports, it also runs `git config user.name` locally (a
subprocess call, not a network request) — see `token-audit.js`.

Path and name redaction (project folders, subagent task text, etc.) is **best-effort**, not
a guarantee. Review a report yourself before pasting it anywhere public.

## Documentation

- [REFERENCE.md](plugin/skills/token-audit/REFERENCE.md): user-facing reference — every flag
  and its playbook, output sections, `--json` fields, script flags.
- [docs/architecture.md](docs/architecture.md): how the script works — pipeline, main parts,
  flag ranking, line budgets, activity classification, redaction, packaging, tests.
- [docs/decisions.md](docs/decisions.md): design decisions and why they were made.
- [docs/roadmap.md](docs/roadmap.md): open work and known limitations.
- [docs/testing.md](docs/testing.md): how to run the test suite, fixtures, the privacy guard,
  performance tests and CI.

## License

MIT — see [LICENSE](LICENSE).
