# Roadmap

Open work and known limitations of `token-audit` v2. Finished work is in `git log`; the reasons
behind the design are in [decisions.md](decisions.md), the code map in
[architecture.md](architecture.md).

## Next

### Final review

`/review` of the whole v2 against [architecture.md](architecture.md) and
[decisions.md](decisions.md), plus a hands-on run on real data.

- [ ] The four v1 transcript bugs (dedupe, unknown models, subagent project, per-model effort)
      are fixed and pinned by fixtures.
- [ ] Q1–Q10 and the later decisions are implemented as recorded.
- [ ] Confirm the subagent-distribution population (every subagent in the window, not only the
      top 10; Q3).
- [ ] Summary ≤ 24 lines, DETAIL ≤ 40 lines, every line ≤ 120 characters, on fixtures and on
      real data.
- [ ] Numbers on real data are plausible and consistent with the dedupe factor documented in
      REFERENCE.md.
- [ ] Review findings fixed or moved to the list below.

### Publish and install check

- [ ] Repository pushed; `/plugin marketplace add hsmejky/token-audit` then
      `/plugin install token-audit@token-audit` works.
- [ ] `/token-audit` runs from a fresh session in another project.
- [ ] No stale standalone copy of the skill left in `~/.claude/skills`.
- [ ] Record a baseline on a second project, then re-measure it after a few slices of work there
      to see whether the `LONG_AGENT` playbook moved the numbers.

## Known limitations and deferred items

### Pricing and models

- **Older and cloud-provider model ids are untested.** The author's history contains only a
  handful of current model ids. Pricing for older families is unverified, and Bedrock
  (`anthropic.claude-…`, `us.anthropic.…`) or Vertex (`claude-…@date`) ids are not normalized:
  they land in `UNPRICED`. That is safe, but a normalizer rule may be wanted.

### MCP servers in CONFIG

- **Connector and plugin-provided MCP servers are invisible.** CONFIG reads only the user config
  and `.mcp.json`; servers that come from claude.ai connectors or from plugins (for example
  context7) are not counted, so `mcp=` can read zero while MCP tool definitions are in the
  prompt prefix.
- **`.mcp.json` approvals are ignored.** `mcpConfig()` lists every server in `.mcp.json`
  regardless of `enabledMcpjsonServers`, `disabledMcpjsonServers` or
  `enableAllProjectMcpServers`, so an unapproved server is counted as configured.

### Redaction

- **GitHub login in API URLs.** The identity layer matches name terms as whole words, so a GitHub
  login that is the local user name plus a suffix survives in an `api.github.com/repos/<owner>/…`
  key. It only prints if such a key becomes a top `POLLING`/`BOILERPLATE` entry.
- **`showAny()` key collisions.** A settings key named `__proto__` is dropped, and two keys that
  redact to the same text overwrite each other in `--json`.
- **Deep nesting.** A `settings.json` value nested more than about 5000 levels throws a
  `RangeError` in the recursive walk.

### Activity classification

- **Quadratic screenshot rule.** `SHOT_EXEC` still contains an unbounded `python\S*`; an
  adversarial input of repeated `(python` takes tens of seconds. Pre-existing, not seen in real
  data. Bound it like `SCRIPT_INTERP`.
- **`xargs` and `cut` pipelines.** `echo x | xargs grep foo` and `cut … | grep` classify as
  `other`: `cut` is missing from `READERS`, and `xargs` turns stdin into arguments. Small
  impact.
- **BOILERPLATE variants.** Textual variants of the same setup (different quoting or a different
  filter after `git credential fill`) count as separate prefixes. Possible enhancement: group a
  `NAME=$(…)` prefix by the command words inside `$(…)`.

### GH_POLLING tokenizer edge cases

- A backslash before a non-space character outside quotes is kept (to preserve Windows paths),
  so `curl -X \POST` and `curl --\data` read as reads. Document in REFERENCE or handle in the
  tokenizer.
- `CURL_LONG_VAL` lacks some value-taking curl options (`--tls13-ciphers`, `--curves`,
  `--proxy-cert-type`, `--dns-interface`, `--knownhosts`, `--ip-tos`, …), so the word after them
  can be misread as an option.
- `node ./tools/gh pr merge` is treated as a `gh` write (the command word is matched by basename);
  `gh api -X =POST` is treated as POST.
- `gh` invoked by a path or as `gh.exe` (`C:\tools\gh.exe`, `/usr/local/bin/gh`) falls into the
  `other` activity category, not `github`: the category rule matches the literal word `gh `,
  while `githubReadShapes()`/`isGhWrite()` already resolve `gh` by basename. `GH_POLL_CATEGORIES`
  only counts `wait/poll` and `github`, so those calls are silently excluded from `GH_POLLING`
  even though a shape is available for them.

### Flags and layout

- **Saveable part for `OPUS_HEAVY` / `CONCENTRATION`.** Neither has a defined extra cost (for
  example Opus spend × (1 − cheaper/Opus price ratio)), so both rank in a fixed tier. Defining one
  would move them into tier 0.
- **`appendFlagsMore()` with no room.** When `flagRoom` is 0 the marker line still prints, giving
  25 summary lines. Not reachable with today's fixed sections; document it or assert against it.

### Tests

- Run the suite on Node 18, 22 and 24 as a routine check (ideally in CI).
- The timing test for 50k nested parentheses is flaky on Node 18 under full-suite load (fixed
  1500 ms limit); raise the limit or measure relative to a baseline.
- `tests/subagent.test.js`: the exact-sum check covers `cur.cost` but not `all.cost` across all
  sessions.
- A retention test checks `>=` where it should check `>`.
- The home-directory helpers (`petrHome()`) in `tests/config.test.js` and
  `tests/identity.test.js` leave an unused variable and do not clean up their temp directory.
- `SCRIPT_INTERP` is exported only for tests, which widens the module's public surface.

### Wording and stale references

- Stale references to `printFlagLine` (in `token-audit.js` and `tests/config.test.js`) and to a
  fixed "top 4" flags (`tests/summary-budget.test.js`); comments say "normally 4" where
  REFERENCE says 4–5.
- Some comments contain a literal `\-`; the comment in `wrapWords()` says `RangeError` where an
  out-of-memory error is meant.
- REFERENCE.md: in the "Activity table vs Q9 hand estimates" section, "(commit …, ~N more turns)"
  should read "(~N turns)"; the
  POLLING and BOILERPLATE definitions could be stated more tightly; the "Subagent distribution —
  population" reason wraps badly after a reflow.

### Privacy guard

- Privacy guard skips path-shape checks for REFERENCE.md and token-audit.js (NO_PATH_CHECK). A real
  user path there would pass unless the name is in the hashed term list. A future fix: capture the
  path's user segment and check it against an allowlist of synthetic names, then drop NO_PATH_CHECK.
- POSIX_USER_PATH uses a case-insensitive flag, so a URL containing `/users/` in docs would trip the
  guard. Dropping the flag would fix it.
- Two guard test names in tests/manifest.test.js do not mention the path and UUID checks.
- WIN_USER_PATH covers only drive C:. Use a drive-letter class.
