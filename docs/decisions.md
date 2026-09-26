# Design decisions

Architecture decision records for `token-audit`. Each entry gives the context, the decision,
the alternatives that were rejected, and the consequences. Q1–Q10 come from the original design
review; the later entries record decisions made during implementation (the threshold re-tune,
the publication-and-privacy work, the summary line-budget rework and the GH_POLLING work) plus
a few smaller ones. REFERENCE.md cites these as "design decision Q<n>".

Decisions and reasons only. Threshold values are named where the code uses them; measurements
behind them are not reproduced here.

See also: [architecture.md](architecture.md), [roadmap.md](roadmap.md),
[REFERENCE.md](../plugin/skills/token-audit/REFERENCE.md).

## Contents

- [Q1 Fix and extend token-audit, no new tool](#q1-fix-and-extend-token-audit-no-new-tool)
- [Q2 No third-party tool](#q2-no-third-party-tool)
- [Q3 DETAIL block by default](#q3-detail-block-by-default)
- [Q4 Project scope by default](#q4-project-scope-by-default)
- [Q5 LONG_AGENT flag and playbook](#q5-long_agent-flag-and-playbook)
- [Q6 Measured non-levers are reported, not asserted](#q6-measured-non-levers-are-reported-not-asserted)
- [Q7 Plugin and marketplace packaging](#q7-plugin-and-marketplace-packaging)
- [Q8 Fixture tests with node:test](#q8-fixture-tests-with-nodetest)
- [Q9 Cost by activity, POLLING, BOILERPLATE, MCP config](#q9-cost-by-activity-polling-boilerplate-mcp-config)
- [Q10 Cross-session GitHub polling](#q10-cross-session-github-polling)
- [Thresholds re-tuned on deduped history](#thresholds-re-tuned-on-deduped-history)
- [Publication and privacy](#publication-and-privacy)
- [Summary back to 24 lines](#summary-back-to-24-lines)
- [GH_POLLING details](#gh_polling-details)
- [Smaller decisions](#smaller-decisions)

## Background: what this rewrite fixed

The original script was checked against hand-written analysis of a real, subagent-heavy project
and four transcript-shape bugs turned up:

1. **No dedupe by `message.id`.** One API response is written as several JSONL lines sharing one
   `usage`; every line was priced, so cost and message counts were inflated, and every
   message-count threshold with them.
2. **Unknown models dropped.** A model missing from the price table returned no rate and its rows
   silently vanished.
3. **Subagent project = session id.** The subagent layout
   `projects/<project>/<session>/subagents/agent-*.jsonl` puts the project two levels up; the
   original script took one level, which broke per-project filtering and the
   session-to-subagent link.
4. **`effortLevel` read only at the settings root**, missing per-model
   `modelSettings.<model>.effortLevel`.

The same check showed the main cost lever there was long-running subagents, which the original
playbook called a non-lever, and that the top-sessions list gave no hint of what a subagent was
doing. The decisions below come from that review.

## Q1 Fix and extend token-audit, no new tool

- **Context.** Ad-hoc scripts had detail the original script lacked, but no verdict, trend or
  cost.
- **Decision.** Fix and extend `token-audit`; no new script or skill.
- **Rejected.** A separate analysis tool next to it.
- **Consequences.** Keeps what already worked: one script run, a short fixed-size verdict,
  trend from transcripts, flag → playbook → at most 3 actions, config and security checks, zero
  dependencies. New features must fit that shape (line budgets, one flag per finding).

## Q2 No third-party tool

- **Context.** Several usage analyzers exist (ccusage, token-scope, claude-token-analyzer,
  claude-token-report, analyze-claude-tokens, contextscope, a session-audit skill).
- **Decision.** Keep the own zero-dependency script.
- **Rejected.** Adopting one of those. They mostly measure; `token-audit` also advises against a
  specific workflow (analyze → plan → implement with TDD → review).
- **Consequences.** Maintenance stays in-house. Revisit only if a tool offers the subagent
  drill-down of Q3 for free. The comparison was not verified hands-on.

## Q3 DETAIL block by default

- **Context.** "Subagent `agent-a5` plus a UUID" is not actionable; the insight needs the
  subagent's task and the parent/subagent rollup.
- **Decision.** A DETAIL block prints **by default, below** the summary; `--no-detail` gives the
  compact report. The summary stays ≤ 24 lines; DETAIL ≤ 40 lines, enforced by a hard guard
  (`DETAIL_MAX_LINES` in `renderDetail()`), not by small top-N constants alone. Sections:
  - **work units**, top 10: a parent session rolled up with its subagents (cost, subagent share,
    agent count, turns, peak context, span);
  - **top 10 subagents**: task text, model, turns, peak context, cost, parent id. Task text comes
    from `agent-<id>.meta.json` `description`, else the first line of the first user prompt,
    else the agent id;
  - **subagent distribution**: median, p90, max of turns and of peak context, over **every
    subagent in the window**, not just the top 10 (the top 10 is a leaderboard; the distribution
    is the population it came from).
- **Rejected.** DETAIL behind an opt-in flag (the useful part would rarely be seen); task text
  from scanning the parent's `Agent` call (the meta file already holds the same label).
- **Consequences.** Every section needs a line budget and ≤ 120-character rows. The population
  choice is marked for confirmation in the final review ([roadmap](roadmap.md)).

## Q4 Project scope by default

- **Context.** Habits differ per project (one subagent-heavy, another main-thread-heavy); mixing
  all projects hides that.
- **Decision.** Default scope = the current working directory, mapped to its `projects/` folder
  name. `--project <path>` picks another project; `--all` scans everything (the original default
  behaviour). The banner states the scope. An unknown project is an error.
- **Rejected.** All projects by default.
- **Consequences.** Needs the exact Claude Code folder-name mapping, including long-name
  truncation; subagents must resolve to their real project (bug 3).

## Q5 LONG_AGENT flag and playbook

- **Context.** Cost is turns × context. Long subagent runs (many turns at large context) were the
  main lever and the playbook had no entry for them.
- **Decision.** `LONG_AGENT` fires for subagents over `LONG_AGENT_TURNS` turns or over
  `LONG_AGENT_CTX` peak context and prints their share of spend. `LONG_AGENT_CTX` was originally
  300k at design time; [the threshold re-tune](#thresholds-re-tuned-on-deduped-history) raised it
  to 400k (`LONG_AGENT_CTX = 400e3`) after the lower value flagged ordinary agents that had simply
  read a lot. Playbook:
  - a hard `maxTurns` in agent frontmatter (a limit hit returns a partial result);
  - one sub-task per agent → commit → short report → stop; hand off through git and the report,
    not through context;
  - review findings go to a **fresh** fix agent, not back into the large implementer;
  - after `maxTurns`, start a new agent with the report and `git log` instead of resuming.
- **Rejected.** Counting only main-thread length.
- **Consequences.** Values were provisional until
  [the threshold re-tune](#thresholds-re-tuned-on-deduped-history). Flag ranking is recorded
  under [the summary rework](#summary-back-to-24-lines).

## Q6 Measured non-levers are reported, not asserted

- **Context.** The original REFERENCE listed subagents as a measured non-lever. That held for one
  project and was false for another.
- **Decision.** Subagents are a non-lever only when their measured share is small and they run on
  a cheaper model; otherwise report the measured share and model mix. File reads, tool output and
  screenshots stay non-levers (re-confirmed). The old baseline is replaced by one computed after
  the dedupe fix.
- **Rejected.** Keeping blanket non-lever claims.
- **Consequences.** REFERENCE says the number instead of asserting a rule. Tool *output* stays
  noise, but tool-*driven turns* (polling, boilerplate) are a lever (Q9).

## Q7 Plugin and marketplace packaging

- **Context.** The script started as a loose skill in one user's skills folder.
- **Decision.** Plugin plus marketplace in one GitHub repository; nothing installed by hand.
  Install is `/plugin marketplace add <owner>/token-audit` then `/plugin install`. `SKILL.md`
  resolves its folder from `${CLAUDE_PLUGIN_ROOT}`. Plugin content lives under `plugin/` and the
  marketplace entry's `source` is `./plugin`.
- **Rejected.** `source: "./"` (repo root): `claude plugin install` copies the whole source
  directory, so tests and private notes were copied into every install, and there is no ignore
  file or allowlist for it.
- **Consequences.** One versioned install across projects and machines. `tests/` and `docs/` are
  outside the source and never installed. `marketplace.json` stays at the repo root (read by
  `marketplace add`, not copied by `install`).

## Q8 Fixture tests with node:test

- **Context.** All four bugs are transcript-shape bugs.
- **Decision.** Test-driven, with small JSONL fixtures: a multi-line message sharing one
  `message.id`, an unknown-model row, the subagent folder layout, a `modelSettings` settings file.
  The script and tests stay dependency-free (`node:test`), and tests never read the real
  `~/.claude` (`--claude-dir`).
- **Rejected.** A test framework dependency; tests against live data.
- **Consequences.** Fixtures pin each shape; later features add their own fixtures and
  generated transcripts.

## Q9 Cost by activity, POLLING, BOILERPLATE, MCP config

- **Context.** Because cost is turns × context, what matters is how many turns went to polling or
  repeated setup, not how large a tool's output was. The original script had no view of
  tool-driven turns.
- **Decision.**
  - **Cost by activity.** Each deduped turn's cost goes to the category of its tool calls, split
    evenly when a turn makes several. Categories come from one ordered regex table in the
    script (tool name plus normalized shell command), so a category is one line. DETAIL shows
    the top 6: category, turns, average context, cost, share.
  - **Command normalization.** Strip `cd … &&`, env prefixes, quoted paths, numbers and ids, so
    polling different PR numbers groups as one command.
  - **Read refinement.** Pipe filters (`tail`, `head`, `grep`, …) after a `|` are not reads of
    their own; a piped script run is a script run; an unpaired read (`ls; python x.py`) stays a
    read.
  - **`POLLING`**: the same normalized command ≥ N times in one session. Playbook: one waiting
    turn (`gh pr checks --watch`, `Monitor`, background run) instead of dozens.
  - **`BOILERPLATE`**: the same setup prefix across ≥ N sessions (for example a credential fetch
    before every API call). Playbook: a missing tool or script.
  - **CONFIG lists MCP servers** from the user config (`mcpServers` and
    `projects[<dir>].mcpServers`) and `<project>/.mcp.json`, with a flat per-server estimate of
    their prompt-prefix weight, like `PLUGIN_BLOAT`.
  - **ALL-TIME accounting**: cost includes subagents, so SPEND ≤ ALL-TIME always; session and
    message counts and median/p90 are over main sessions only.
- **Rejected.** Pricing tool output size (measured as noise, Q6); counting MCP tools from
  transcripts (undercounts, reads zero for a configured but unused server).
- **Consequences.** Classification order matters and is tested. Thresholds were provisional until
  [the threshold re-tune](#thresholds-re-tuned-on-deduped-history).

## Q10 Cross-session GitHub polling

- **Context.** Real GitHub status polling was spread thinly across many sessions and subagents,
  each loop with a different PR or commit id inline, so no single command repeated enough in one
  session to trip `POLLING` at any threshold. `BOILERPLATE` saw the credential prefix, not the
  polling volume.
- **Decision.** `GH_POLLING` aggregates `wait/poll` and `github` read-only calls across every
  session and subagent in the window, grouped by **endpoint shape** (not full command key),
  independent of per-session counts. Threshold `GH_POLL_MIN_CALLS = 20`. Read-only means: curl
  with `-G` or without a body/upload option; `gh api` without field or input options; no GraphQL
  `mutation`. Shapes keep only REST path words and known `gh` verbs; ids, owners, repos and SHAs
  become `*`. Tier 0, ranked by cost. Playbook: install `gh` (or a wrapper script) and wait once.
- **Rejected.** A per-session any-key count (still misses thinly spread polling); grouping by full
  command key (the inline ids keep calls apart).
- **Consequences.** `POLLING` and `GH_POLLING` count independently; a session can appear in both.
  Details in [the GH_POLLING work](#gh_polling-details).

## Thresholds re-tuned on deduped history

- **Context.** Every threshold had been set on inflated (pre-dedupe) counts.
- **Decision.** Re-measure on the author's whole local history plus per-project cuts, reusing the
  script's own exported classifiers so categories match exactly, and set:
  - `LONG_AGENT_TURNS = 150`, `LONG_AGENT_CTX = 400e3`. The turn limit matches the `maxTurns`
    advice and sits before the distribution thins out; the context arm was raised because the
    lower value flagged ordinary agents that had simply read a lot;
  - `LONG_SESSION` counts **main threads only**, `LONG_SESSION_TURNS = 200`. Long subagents are
    `LONG_AGENT`'s job; mixing them double-counted. The old limit no longer fired on main
    threads after dedupe. The SESSIONS line median/p90 is main-only too;
  - `POLL_MIN_CALLS = 10`, together with a new `script run` category that is left out of
    `POLL_CATEGORIES` (re-running a script while iterating is work, not waiting);
  - `BOILER_MIN_SESSIONS = 5` kept; the false positives it admits are cheap and rank low;
  - new activity categories so `other` means "unclassified": `reply` (no tool call),
    `script run`, `harness` (skills, tool search, task and plan tools), plus busy-wait patterns
    (`echo waiting…`, `tasklist`, `Get-Process`) as wait/poll, below git in priority.
- **Rejected.** Tuning on only two projects; keeping the looser context arm; keeping
  `LONG_SESSION` over main and subagents.
- **Consequences.** REFERENCE documents a reason per threshold. The check also found the
  thinly spread GitHub polling case that led to Q10, and the MCP and model-id gaps listed in the
  [roadmap](roadmap.md). Model ids in unknown formats (Bedrock, Vertex) land in `UNPRICED`, which
  is the safe default.

## Publication and privacy

- **Context.** The repository was about to become public, but its history carried personal data.
- **Decision.** Before the first push:
  - rewrite history so commit identities use a GitHub noreply address and manifests carry no
    personal e-mail;
  - replace real user names, project names and session ids in fixtures and docs with synthetic
    ones;
  - keep private design notes out of git, with no references to them from published files;
  - MIT license; README with install, requirements, flags and a privacy note (read-only, local,
    redaction is best effort);
  - a test that fails if a manifest or README carries a personal e-mail. (Extended later,
    alongside publishing `docs/`, to also cover the `docs/` pages and known private names.)
- **Rejected.** Publishing with the history as it was; keeping private notes in the repository.
- **Consequences.** REFERENCE keeps its anonymized example numbers (a separate decision: they are
  examples, not leakage). Design notes are published only as these `docs/` pages, rewritten
  without evidence.

## Summary back to 24 lines

- **Context.** Features added over earlier work pushed the summary far past its 24-line budget
  on real data.
- **Decision.**
  - **B.** TOP SESSIONS leaves the summary (DETAIL's work units and top subagents cover it;
    `--json` keeps it). The per-week table becomes one `TREND` line (first week vs last week
    cost per message, change, span); `--json` keeps the table.
  - **Flags fit a hard guard.** Flags are ranked and fill the lines left after every fixed line,
    including the whole SECURITY block (`fitFlags()`). The rest move to DETAIL under their own
    cap, or to `--json` with `--no-detail`. SECURITY is never displaced.
  - **D.** CONFIG, UNPRICED and the SPEND family split print one line each, ending in a
    `+N more` marker when a list does not fit; `retention=` is left out while unset (SECURITY
    says so); full lists only in `--json`.
  - **Q-B ranking.** Tier 0 = flags with a defined extra cost, by that cost: `REGRESSION` (cost
    above what the previous cost per message would give), `POLLING`, `GH_POLLING`,
    `BOILERPLATE` (cost of those turns, an upper bound on the saving). Then fixed tiers, ranked in
    this order, flagged spend as tie-break inside a tier, id as the final tie-break for a stable
    order: `LONG_AGENT` above (`LONG_SESSION`, `MULTIDAY` — tied) above (`OPUS_HEAVY`,
    `CONCENTRATION` — tied) above (`BIG_CTX`, `PLUGIN_BLOAT` — tied) above `CLEAN`.
  - **Q-C.** The overflow line names the moved flag ids (`… +3 more: A, B, C (DETAIL / --json)`),
    cut to fit 120 characters; DETAIL's continued block counts against DETAIL's 40 lines.
- **Rejected.** A fixed "top N flags" count (breaks when a flag wraps or SECURITY grows);
  moving CONFIG detail to DETAIL (no room left there).
- **Consequences.** A worst-case fixture that fires every section at once asserts ≤ 24 lines.
  `--json` `flags` stays unranked and complete, each entry with `amount`. Open: a saveable part
  for `OPUS_HEAVY` or `CONCENTRATION` would move them into tier 0 ([roadmap](roadmap.md)).

## GH_POLLING details

- **Context.** Implementing Q10 raised four questions: aggregation unit, threshold, whether
  writes count, and overlap with other tier-0 flags.
- **Decision.**
  - **Window-wide aggregation** per endpoint shape (summed across projects under `--all`, since
    the fix is per machine), not per session.
  - **`GH_POLL_MIN_CALLS = 20`**, final. Chosen from the distribution of calls per shape in the
    author's history, which had an empty band between ordinary use and the polling case; 20
    leaves headroom for heavier normal `gh` use than the author's.
  - **Reads only.** A call that changes state (explicit write method, implicit POST from a body
    or field option, upload, GraphQL mutation, or a `gh` write verb such as `create` or `merge`)
    is excluded, so frequent PR creation never trips a polling flag.
  - **Per command occurrence, on tokenized argv.** Write detection runs on one command's own
    argv, parsed the way curl and gh parse options, so a flag-like string inside another
    option's value or in a different command of the same compound call is never misread. A read
    loop next to an unrelated write keeps its read shape.
  - **Global `gh` flags** (`-R`, `--repo`, `--hostname`) are skipped when finding the group and
    verb.
  - **Verb whitelist per group** for privacy: the word after `gh <group>` is printed only if it
    is a known verb; free text such as a branch name becomes `*`.
  - **No cross-flag dedupe.** `POLLING`, `BOILERPLATE` and `GH_POLLING` are independent,
    non-additive views, as documented in REFERENCE.
- **Rejected.** Counting writes too (made the flag about general API traffic rather than
  polling); whole-call exclusion (one write dropped every read in the same call); regex matching
  on raw text (false positives across commands).
- **Consequences.** A small number of tokenizer edge cases remain ([roadmap](roadmap.md)).

## Smaller decisions

- **Shared `message.id` across files**: credited to the occurrence with the earliest
  timestamp, not the first file in path order. Totals are unchanged; attribution is right.
- **Claude dir precedence**: `--claude-dir`, then `CLAUDE_CONFIG_DIR`, then
  `~/.claude`. With `CLAUDE_CONFIG_DIR` the user config file lives inside that dir, as in Claude
  Code.
- **Exact model matching**: known ids only, after stripping `claude-`, a date suffix
  and dots. An unlisted version goes to `UNPRICED` with a warning instead of borrowing a
  neighbour's price; `<synthetic>` zero-usage rows are ignored.
- **Redaction everywhere**: every printed field that can carry a path or identity
  goes through the same redaction, in text and `--json`; grouping stays on raw values. The
  identity layer matches name parts as whole words, accent-insensitive.
- **Linear-time parsing**: command-key and classification code must stay linear on
  pathological input; each known blow-up has a timing test.
- **Output width**: every text line ≤ 120 characters; advice text wraps instead of
  being cut; untrusted names are sanitized so they cannot forge report lines.
- **TREND sparkline is inline, full-range, and text-only**: printed in the `TREND` line itself
  rather than as its own row, so a glance at cost/message also shows its shape (e.g. a steady
  climb versus a spike that has since settled reads differently even at the same first→last
  number). Scaled against the low/high of the whole trend, not just the trailing weeks shown —
  a trailing flat run must still read as low against a wider history, not as a false "no
  change" flat bar. No `--json` field for it: `weeks` already gives every point, so the bars
  would be a redundant re-encoding of data already there.
