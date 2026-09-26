# Architecture

How `token-audit` is built: one dependency-free Node script, wrapped by a Claude Code skill and
shipped as a plugin. This document is for contributors. What the report means, every flag's
playbook and the `--json` fields are in the user-facing
[REFERENCE.md](../plugin/skills/token-audit/REFERENCE.md); the reasons behind the design are in
[decisions.md](decisions.md); open work is in [roadmap.md](roadmap.md).

All names in `code` below are functions or constants in
`plugin/skills/token-audit/scripts/token-audit.js` unless another file is named.

## Contents

- [Overview](#overview)
- [Pipeline and data flow](#pipeline-and-data-flow)
- [Main parts of token-audit.js](#main-parts-of-token-auditjs)
- [Transcripts, dedupe and pricing](#transcripts-dedupe-and-pricing)
- [Flags, tiers and ranking](#flags-tiers-and-ranking)
- [Summary and DETAIL layout budget](#summary-and-detail-layout-budget)
- [Activity classification and command tokenizing](#activity-classification-and-command-tokenizing)
- [Privacy and redaction model](#privacy-and-redaction-model)
- [Packaging](#packaging)
- [Test layout](#test-layout)

## Overview

```
SKILL.md ──runs──▶ token-audit.js ──reads──▶ ~/.claude/projects/**/*.jsonl   (transcripts)
   │                    │                     ~/.claude/settings.json, plugin cache
   │                    │                     ~/.claude.json, <project>/.mcp.json (MCP)
   │                    ▼
   │              text report (summary ≤ 24 lines + DETAIL ≤ 40 lines)  or  --json
   ▼
REFERENCE.md  (flag → playbook; the skill turns flags into at most 3 proposed actions)
```

- **Read-only and offline.** The script reads local files only, never writes, never opens a
  network connection. The one subprocess is a local `git config user.name`, used to redact the
  user's own name (see [privacy](#privacy-and-redaction-model)).
- **Zero dependencies.** Plain Node (`fs`, `path`, `readline`, `crypto`, `os`,
  `child_process`), Node 18 or newer. Tests use `node:test`.
- **Measure, then advise.** The script prints numbers and flags. The skill (`SKILL.md`) maps each
  flag to its REFERENCE.md playbook entry, ranks by measured impact, and proposes fixes. It never
  applies them.

## Pipeline and data flow

`main()` runs these stages in order:

1. **Arguments and paths.** Top-level constants parse `argv`: `DAYS` (`--days`, default 14),
   `TOP` (`--top`, default 8), `JSON_OUT`, `ALL`, `DETAIL` (off with `--no-detail`) and
   `projectArg()` for `--project`. The Claude dir is `--claude-dir`, else `CLAUDE_CONFIG_DIR`,
   else `~/.claude` (`CLAUDE`, `ROOT` = its `projects/` folder).
2. **Scope.** `projectFolder()` maps a project path to its transcript folder name the same way
   Claude Code does (every non-alphanumeric character becomes `-`; names over 200 characters are
   matched by prefix). `SCOPE_DIR` / `SCOPE_PROJECT` / `SCOPE_ROOT` hold the result. Default scope
   is the current working directory; `--all` scans every project.
3. **Collect.** `collect()` walks `SCOPE_ROOT` (`walk()`, sorted for determinism), parses every
   JSONL line, prices it, dedupes by `message.id`, and records tool calls per turn. It returns
   `rows` (priced turns), raw `unpriced` rows, and `tasks` (subagent task text). See
   [Transcripts, dedupe and pricing](#transcripts-dedupe-and-pricing).
4. **Windows.** Rows are split by timestamp into `cur` (last `DAYS` days), `prev` (the `DAYS`
   before that) and `all` (full history), each run through `summarize()` (cost, family and
   main/subagent split, per-session stats, median/p90, shares). `weeks()` buckets rows by
   ISO week for the trend. `aggregateUnpriced()` windows unknown-model rows like SPEND.
5. **Config.** `config()` reads `settings.json` (model, `effortLevel`, per-model
   `modelSettings.<model>.effortLevel`, `cleanupPeriodDays`), enabled plugins from the plugin
   cache (`eachPluginDir()`, `frontmatterWeight()` to estimate the prompt-prefix weight of their
   agent and skill definitions) and MCP servers (`mcpConfig()`).
6. **Detectors.** Over `cur` rows: `polling()`, `boilerplate()` and `ghPolling()`. Then
   `flags()` builds the cost/habit flags and `securityFlags()` the confidentiality flags.
7. **Detail.** `detail()` builds top subagents, work units (`workUnits()`), the subagent
   distribution (`subagentDistribution()`) and cost by activity (`activity()`).
8. **Redacted view.** Every printable field is copied through `show()` / `showAny()`
   (`showSessions()`, `showConfig()`, `showDetail()`). Grouping ran on raw values before this.
9. **Render.** `--json` prints the whole structure. Otherwise the text report is assembled under
   hard line budgets (see [layout budget](#summary-and-detail-layout-budget)) and printed.

## Main parts of token-audit.js

The file is split into sections by comment banners. In file order:

| section | key names | role |
|---|---|---|
| scope | `projectFolder()`, `SCOPE_*` | cwd / `--project` / `--all` to a `projects/` folder |
| pricing | `PRICES`, `KNOWN_MODELS`, `rateFor()` | $/MTok per model, exact-id matching |
| activity | `commandKey()`, `shellSegments()`, `markCommands()`, `ACTIVITY_RULES`, `categorize()`, `activity()` | normalize shell commands, classify tool calls |
| collect | `walk()`, `collect()`, `subagentMetaTask()`, `promptText()`, `sessionKey` | read transcripts into deduped, priced turns |
| summarize | `summarize()`, `weeks()` | per-window and per-session aggregates |
| config | `config()`, `mcpConfig()`, `eachPluginDir()`, `MCP_SERVER_TOKENS` | settings, plugins, MCP servers |
| flags | `LONG_AGENT_TURNS`, `LONG_SESSION_TURNS`, `POLL_MIN_CALLS`, `POLL_CATEGORIES` | thresholds |
| redaction | `redactPaths()`, `redactSecrets()`, `identityPattern()`, `currentIdentity()` | secrets, paths, e-mails, the user's name |
| polling / boilerplate | `polling()`, `setupPrefixes()`, `showPrefix()`, `boilerplate()`, `BOILER_MIN_SESSIONS` | repeated-command detectors |
| GitHub polling | `ghPolling()`, `githubReadShapes()`, `occurrenceGithub()`, `GH_POLL_MIN_CALLS` | cross-session GitHub read polling |
| flag assembly | `flags()`, `securityFlags()` | flag entries with `id`, `text`, `amount` |
| report | `fit()`, `fitMiddle()`, `fitPrefix()`, `wrapWords()`, `flagLines()`, `rankFlags()`, `fitFlags()`, `configLine()`, `trendLine()` | text formatting under the 120-char and line budgets |
| detail | `workUnits()`, `quantile()`, `subagentDistribution()`, `detail()`, `DETAIL_SECTIONS`, `renderDetail()` | the DETAIL block |
| redacted view | `show()`, `showAny()`, `textOf()`, `CONTROL_CHARS` | printable copies of untrusted values |
| main | `main()` | orchestration and printing |

`module.exports` exposes the pure helpers the unit tests call directly (`commandKey`,
`activityCategory`, `redactPaths`, `setupPrefixes`, `githubShapes`, `githubReadShapes`,
`isGhWrite`, `rankFlags`, `fitFlags`, `renderDetail`, the line-budget constants and a few
more). The script only runs `main()` when executed directly.

## Transcripts, dedupe and pricing

**Layout.** Main sessions are `projects/<project>/<session>.jsonl`. Subagents are
`projects/<project>/<session>/subagents/agent-<id>.jsonl`, so a subagent's project is two levels
above `subagents/` and the folder in between is its parent session id. A subagent's identity is
`(parent, sid)` (`sessionKey`), because one agent id can recur under two parents.

**Turns.** Claude Code writes one API response as several JSONL lines (thinking, text, tool use)
that share one `message.id` and each carry a `usage` block. `collect()` keeps one row per id:

- the line with the largest `output_tokens` wins (earlier lines carry partial usage);
- a turn is credited to the occurrence with the earliest timestamp, so an id repeated in another
  file lands on the session that produced it first, not on whichever file sorts first;
- tool calls are the union over the turn's lines (a repeated tool-use id counts once);
- a line with no `message.id` cannot be deduped and is counted as is.

**Cost.** `usage` is priced with five rates per model (input, 5-minute cache write, 1-hour cache
write, cache read, output). When a row has no cache-write breakdown, the write is priced as
1-hour. `ctx` of a turn = cache read + cache write tokens. Costs are list-price equivalents, a
proxy for plan usage rather than a bill.

**Models.** `rateFor()` normalizes the model id (drops `claude-`, a trailing 8-digit date, folds
dots to hyphens) and looks it up exactly in `KNOWN_MODELS`. Each entry names a SPEND family
(Opus, Sonnet, Haiku, Fable) and a `PRICES` row. Anything not listed is not guessed: its rows go
to `UNPRICED` (model, rows, tokens) and the text report prints a warning to add the price.
Claude Code's zero-usage `<synthetic>` rows are skipped.

**Subagent task text.** `agent-<id>.meta.json` `description` (the spawner's label), else the
first non-empty line of the subagent's first user prompt, else the agent id.

## Flags, tiers and ranking

`flags()` returns entries `{ id, text, amount }` (some carry extra `--json` fields such as
`groups`). `amount` is the dollar figure used for ranking and is never printed in text.

| flag | fires when | constant | amount | tier |
|---|---|---|---|---|
| `REGRESSION` | cost per message > 1.25 × previous window | inline | extra cost vs previous cost/message | 0 |
| `POLLING` | same command key ≥ N calls in one session, in `POLL_CATEGORIES` | `POLL_MIN_CALLS = 10` | cost of those calls | 0 |
| `BOILERPLATE` | same setup prefix in ≥ N sessions | `BOILER_MIN_SESSIONS = 5` | cost of those calls | 0 |
| `GH_POLLING` | one GitHub read endpoint shape ≥ N calls across all sessions | `GH_POLL_MIN_CALLS = 20` | cost of those calls | 0 |
| `LONG_AGENT` | subagent over N turns or peak context over X | `LONG_AGENT_TURNS = 150`, `LONG_AGENT_CTX = 400e3` | their spend | 1 |
| `LONG_SESSION` | main session ≥ N turns | `LONG_SESSION_TURNS = 200` | their spend | 2 |
| `MULTIDAY` | a session spans more than one day | `DAY` | their spend | 2 |
| `OPUS_HEAVY` | Opus > 90 % of spend | inline | Opus spend | 3 |
| `CONCENTRATION` | top 5 sessions > 50 % of spend | inline | top-5 spend | 3 |
| `BIG_CTX` | average context per message > 150k | inline | none | 4 |
| `PLUGIN_BLOAT` | > 20 agent definitions or > 5000 prefix tokens | inline | none | 4 |
| `CLEAN` | nothing else fired | | none | 5 |

`securityFlags()` is kept separate on purpose: `NO_RETENTION` (`cleanupPeriodDays` unset) is a
confidentiality risk, never ranked against cost flags, and always printed in its own SECURITY
block.

**Ranking.** `rankFlags()` sorts by `FLAG_TIER`, then `amount` descending, then id. Tier 0 holds
the flags whose `amount` is a real saving estimate (extra cost, or cost of the flagged turns);
the other tiers are a fixed priority where `amount` is only the flagged spend and breaks ties.
The `--json` `flags` array is unranked and always complete.

The tier-0 detectors are independent views: one turn can count in `POLLING`, `BOILERPLATE` and
`GH_POLLING` at once, so their amounts are not additive.

## Summary and DETAIL layout budget

Every text line is ≤ 120 characters. The summary (everything above DETAIL, including the blank
line before it) is ≤ `SUMMARY_MAX_LINES` (24); DETAIL is ≤ `DETAIL_MAX_LINES` (40). Both are hard
guards enforced by construction, not by hoping fixed counts add up.

**Summary.** `main()` first builds `pre` (banner, SPEND with one family line from
`familyLine()`, main/subagent split, optional `unpricedLine()`, PER MESSAGE, SESSIONS, ALL-TIME,
`trendLine()`, `configLine()`, the FLAGS header) and `post` (blank line plus the whole SECURITY
block). The room left for flags is `SUMMARY_MAX_LINES` minus both, minus the DETAIL separator.
`fitFlags()` fills that room in rank order, counting wrapped lines, and reserves one line for the
`… +N more: IDs (DETAIL / --json)` marker (`moreIdsLine()`, `flagsMoreLine()`,
`appendFlagsMore()`). SECURITY is never displaced; flags shrink first.

**One-line sections.** CONFIG, UNPRICED and the SPEND family split print one line each.
`joinFit()` packs as many list items as fit and ends with a `+N more` marker; `--json` keeps the
full lists.

**DETAIL.** `DETAIL_SECTIONS` renders, in order: top work units (`TOP_UNITS`), top subagents
(`TOP_SUBAGENTS`, task text cut to `TASK_WIDTH`), the subagent distribution, and cost by activity
(`TOP_ACTIVITIES`). `renderDetail()` truncates at `DETAIL_MAX_LINES`. Flags that did not fit the
summary continue under `FLAGS (continued …)` via `continuedFlagLines()`, in whatever DETAIL budget
is left; the rest are named for `--json`.

**Width helpers.** `fit()` cuts the end, `fitMiddle()` cuts the middle (keeps a command's program
and endpoint), `fitPrefix()` shortens a BOILERPLATE prefix by values first, then stages.
`wrapWords()` wraps advice text onto continuation lines instead of truncating it, hard-breaking a
single overlong word. `flagLines()` renders one flag with `FLAG_TEXT_WIDTH`.

## Activity classification and command tokenizing

**Command key.** `commandKey()` turns a Bash/PowerShell command into a normalized key so the same
command against a different PR, commit, path or cwd groups together:

1. heredoc bodies become `[heredoc <hash>]` (`hashHeredocBodies()`), `sed -n` scripts are kept;
2. quoted paths become `<path>`; UUIDs and hex ids with digits become `<id>`; digits become `N`;
3. `stripCdAndEnv()` drops `cd` / `Set-Location` segments and `NAME=value` env prefixes, also
   inside `(…)` groups (recursion capped by `STRIP_DEPTH_MAX`).

`shellSegments()` / `shellScan()` split at top-level `&&`, `||`, `|`, `;` and newlines, ignoring
separators inside quotes, backticks and `(…)`.

**Command starts.** `markCommands()` inserts a marker before every command start: `CMD` after
`;`, `&&`, `||`, newline or `(`, and `CMD_PIPE` after a bare `|`. It also swallows wrapper words
(`WRAPPERS`: `do`, `time`, `timeout N`, `xargs`, `python -m`, `uv run`, `npx`, …) so the wrapped
command gets the marker. The two markers let the read rule ignore pipe filters (`… | tail`) while
every other rule treats both alike.

**Categories.** `ACTIVITY_RULES` is one ordered table of regex → category; first match wins, and
adding a category is one line. Each rule runs over `<Tool> <key>` (the key is the command key for
shell tools, the file path otherwise). Order: agent spawn, harness (`HARNESS_TOOLS`), web,
screenshot/image, wait/poll (`POLLERS`, check-runs, actions/runs), github, test/lint/build
(`RUNNERS`, `CHECKERS`), git, busy-wait polls (`BUSY_POLLERS`), edit, read (`READERS`, only after
`CMD`), script run (`SCRIPT_INTERP`, `SCRIPT_FILE`). No match is `ACTIVITY_OTHER`; a turn with no
tool call at all is `ACTIVITY_REPLY`. `activity()` splits a turn's cost, turns and context evenly
over its tool calls, so shares sum to 100 %.

**Setup prefixes.** `setupPrefixes()` returns each leading `NAME=…` / `export NAME=…` /
`$env:NAME=…` segment of a key when a real command follows; path-only values are skipped.
`boilerplate()` groups calls by these raw prefixes across sessions; `showPrefix()` prints a
literal value as `<value>`.

**GitHub endpoint shapes.** `ghPolling()` takes shell calls in `GH_POLL_CATEGORIES` and groups
them by `githubReadShapes()` over every session and subagent in the window:

- `commandOccurrences()` splits a key into single command occurrences (via `markCommands()`);
- `occurrenceGithub()` finds the occurrence's `gh` or `curl` word (by basename, `.exe` dropped)
  and tokenizes its argv with `argWords()` (shell quoting rules, one pass);
- `walkArgs()` walks that argv the way curl and gh parse it (short clusters, value-taking options
  from `CURL_SHORT_VAL` / `CURL_LONG_VAL` / `GH_API_SHORT_VAL` / `GH_API_LONG_VAL`);
- write detection per occurrence: `isCurlWrite()` (explicit method, upload, or body without
  `-G`), `ghApiCall()` (explicit method, field flags, GraphQL `mutation`), `GH_WRITE_VERBS` for
  `gh <group> <verb>` (`ghGroupVerb()`), `explicitWriteMethod()` for any other client;
- shapes: `githubPathShape()` keeps only `GH_PATH_WORDS` and collapses everything else (owner,
  repo, ids, SHAs, branches) to `*`; `ghGroupShape()` prints a verb only if `GH_GROUP_VERBS` or
  `GH_WRITE_VERBS` knows it, for a group in `GH_GROUPS`.

Write occurrences contribute no shape, so a compound call that polls and then merges still counts
its read. `isGhWrite()` and `githubShapes()` are exported for tests.

**Linear time.** Keys come from arbitrary transcripts, so every regex and scanner here is written
to stay linear on pathological input: character classes are bounded at the command markers
(`NOT_CMD`), alternations are kept disjoint (`PY_OPT`, `RUNNERS`), the wrapper chain is consumed
by a sticky regex (`WRAP_RE`) in one pass, and recursion is depth-capped. Timing tests pin this.

## Privacy and redaction model

- **Inputs are local, output is local.** No network, no writes. The report is printed; sharing it
  is the user's call.
- **Group raw, print redacted.** Keys, grouping and counting use raw values. Only the copies that
  get printed, in text and `--json` alike, pass through `show()` / `showAny()`.
- **`redactPaths()` layers, in order:**
  1. secrets (`redactSecrets()`): token shapes (`SECRET_SHAPE`), auth headers, bearer tokens,
     `-u user:pass`, credential-named flags, assignments and JSON keys, URL credentials,
     `gh secret set --body`, npm auth tokens, and `-p` passwords for mysql / sshpass / docker
     login (`redactShortP()`, a token scan per command segment). A value that is a reference
     (`$VAR`, `$(…)`) stays;
  2. e-mails (`EMAIL`), `file://` URLs, user home paths in Windows and POSIX spellings
     (`WIN_USERS_PATH`, `FWD_USERS_PATH`, `TILDE_PATH`) and other absolute paths (`ABS_PATH`)
     become `<email>` / `<path>`;
  3. the identity layer: the login name, the home folder name and `git config user.name`, whole
     and split into parts, become `<user>` wherever they appear as a whole word, with accents
     folded on both sides (`identityPattern()`, `currentIdentity()`, `redactIdentity()`). Terms
     shorter than `ID_MIN_LEN` and generic names (`ID_GENERIC`) are skipped.
- **Untrusted text.** Plugin, MCP server and settings values can be author- or attacker-controlled.
  `show()` collapses control, format and line-separator characters (`CONTROL_CHARS`) so a value
  cannot inject a fake report line. `showAny()` walks objects and arrays so `--json` keeps real
  types; `textOf()` serializes them only for text output.
- **Privacy by construction for GitHub shapes.** Only whitelisted words (`GH_PATH_WORDS`,
  `GH_GROUPS`, `GH_GROUP_VERBS`) are ever printed in a `GH_POLLING` shape.
- **Best effort.** Redaction is pattern-based. README tells users to review a report before
  sharing it.

## Packaging

```
.claude-plugin/marketplace.json      marketplace; its plugin entry has source "./plugin"
plugin/.claude-plugin/plugin.json    plugin manifest
plugin/skills/token-audit/SKILL.md   the skill (loop, report shape, rules)
plugin/skills/token-audit/REFERENCE.md   flag playbook, output reference
plugin/skills/token-audit/scripts/token-audit.js
tests/                               node:test suite (not installed)
docs/                                this documentation (not installed)
```

`claude plugin install` copies the marketplace entry's whole `source` directory into the plugin
cache, so only `plugin/` is installed; `tests/` and `docs/` stay in the repository. `SKILL.md`
runs the script from `${CLAUDE_PLUGIN_ROOT}/skills/token-audit`. Install instructions are in the
[README](../README.md#install).

## Test layout

- **Runner.** `node --test tests/*.test.js`, no dependencies. The suite is kept green on Node 18
  and current LTS releases.
- **Harness.** `tests/harness.js` runs the real script as a CLI against a fixture Claude dir
  (never the real `~/.claude`) through `--claude-dir` and returns `--json` or text:
  `audit()`, `auditText()`, `auditCwd()`, `auditRaw()`, `auditEnv()`. Fixture dirs come from
  `tests/fixtures/<name>/` (small, hand-readable) or `tmpClaudeDir()` with `turn()` rows (bulk
  shapes); `tmpUserConfig()` writes an MCP user config. Harness calls default to `--all` unless a
  test sets scope itself.
- **Unit tests** call exported helpers directly (`commandKey`, `activityCategory`,
  `redactPaths`, `githubReadShapes`, `rankFlags`, `fitFlags`, `renderDetail`, …).
- **Files by area:** `dedupe`, `pricing`, `subagent`, `scope`, `claude-dir`, `config`, `mcp`
  (collect, pricing, scope, config); `detail`, `long-agent`, `long-session`, `activity`,
  `polling`, `boilerplate`, `gh-polling` (detectors and DETAIL); `flags-rank`, `flags-wrap`,
  `summary-budget` (ranking and line budgets); `identity`, `secrets` (redaction); `manifest`
  (public-repo guard: no personal e-mail in manifests, README and `docs/`).
- **Timing tests** feed pathological inputs (deep nesting, long repeated flags) and assert an
  upper bound, to keep the parsers linear.
- **Fixtures use synthetic names only** (`demo-proj`, `Petr Svarc`, `sess-0001`), never real
  projects or people.
