# Token Audit

A Claude Code plugin that runs a periodic checkup of your token spend and habits: cost,
context-per-message, session concentration, week-over-week trend, config drift (model,
effort, MCP servers, plugin count, transcript retention), and a ranked list of concrete
habit fixes. For anyone running Claude Code regularly who wants a measured answer to "where
do my tokens go" instead of a guess — everything printed comes from the script, nothing is
inferred.

It reads your local transcripts under `~/.claude/projects` and your `settings.json`; it
never sends anything anywhere (see [Privacy](#privacy) below).

## Sample report

Generated from synthetic fixture data (`--all --days 7`), not a real project — names,
sessions and paths below are made up for illustration:

```
TOKEN AUDIT   scope all projects   window 2026-09-18 → 2026-09-25 (7d)   list-price equivalent

SPEND        $3.86   prev window $0.288  +1242%
  Opus $3.12 80.7%   Sonnet $0.744 19.3%
  main $3.86 (100.0%)   subagents $0.000 (0.0%)

PER MESSAGE  ctx 108k avg   cost $0.034   prev 8k / $0.010
SESSIONS     3   median 40 msgs   p90 60   ≥200 msgs: 0
ALL-TIME     $4.15 over 4 sessions, 144 messages
TREND        2026-09-14 $0.010/msg → 2026-09-21 $0.034/msg +253%   span 2 wk (2 with data)   full table in --json
CONFIG       model=(unset — harness default) effort=unset plugins=0 prefix≈0.0k retention=30

FLAGS
  REGRESSION     cost/message +253% vs previous window
  POLLING        1 run(s) ≥10×/session = $0.224, 6% of spend; top 14× gh pr checks N
  CONCENTRATION  top 5 sessions = 100% of spend

SECURITY (confidentiality, not cost)
  none

DETAIL
TOP 10 WORK UNITS (this window, parent + subagents; span = full history)
  sid          cost    sub%  #ag  turns   peak   span  project
  sess-02     $3.12    0.0%    0     60   180k    <1d  demo-webapp
  sess-01    $0.520    0.0%    0     40    25k    <1d  demo-webapp
  sess-03    $0.224    0.0%    0     14    40k    <1d  demo-webapp
TOP SUBAGENTS  none in this window
SUBAGENT DISTRIBUTION  none in this window
COST BY ACTIVITY (this window, top 6; a turn's cost split evenly over its tool calls)
  category           turns  avg ctx     cost   share
  reply                100     118k    $3.64   94.2%
  wait/poll             14      40k   $0.224    5.8%
```

Costs are **list-price equivalents** (Claude API $/MTok): on Pro/Max nothing is billed per
token, so the number is a proxy for what eats the plan limit, not a bill.

## Install

```
/plugin marketplace add hsmejky/token-audit
/plugin install token-audit@token-audit
```

Then run:

```
/token-audit
```

## Requirements

Node.js **18 or newer**. Verified by running the full test suite (`node --test tests/*.test.js`)
on Node 18, 20, 22 and 24 — all green. No other dependencies; the script is plain Node
(`fs`, `path`, `readline`, `crypto`, `os`, `child_process`).

## Script flags

The skill runs `node <skill-dir>/scripts/token-audit.js` with these flags:

| flag | default | meaning |
|---|---|---|
| `--days N` | 14 | window; the previous N days form the comparison window |
| `--top N` | 8 | sessions kept in `--json` output |
| `--json` | off | full structured dump |
| `--claude-dir DIR` | `$CLAUDE_CONFIG_DIR` or `~/.claude` | read transcripts + settings from DIR instead |
| `--project PATH` | cwd | scope to one project |
| `--all` | off | scope to every project instead of just one |
| `--no-detail` | off | drop the DETAIL block: summary only |

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

## License

MIT — see [LICENSE](LICENSE).
