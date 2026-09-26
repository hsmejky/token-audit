#!/usr/bin/env node
// token-audit — spend + usage audit over local Claude Code transcripts.
// Node, no deps.  Usage: node token-audit.js [--days N] [--top N] [--json] [--no-detail] [--claude-dir DIR]
// Tests: `node --test` from the repo root (fixtures in tests/fixtures/).
//
// Costs are LIST-PRICE EQUIVALENTS (Claude API $/MTok). On Pro/Max nothing is
// billed per token — the number is a proxy for what eats the plan limit.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const argv = process.argv.slice(2);
const flagStr = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const flagVal = (name, def) => Number(flagStr(name, def));
const DAYS = flagVal('--days', 14);
const TOP = flagVal('--top', 8);
const JSON_OUT = argv.includes('--json');
const ALL = argv.includes('--all');
const DETAIL = !argv.includes('--no-detail');

// `--project <path> --json` (or any other flag right after --project) must
// not take that following flag as the path value — flagStr()/flagVal() would
// happily do that. undefined = --project not passed; null = passed with no
// (or a flag-shaped) value, which is an error; otherwise the path string.
function projectArg() {
  const i = argv.indexOf('--project');
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return (v === undefined || v === '' || v.startsWith('--')) ? null : v;
}
const PROJECT_ARG = projectArg();
if (PROJECT_ARG === null) {
  console.error('--project requires a value (a project path)');
  process.exit(1);
}

const HOME = process.env.USERPROFILE || process.env.HOME;

// --claude-dir precedence (Slice 23): explicit flag wins, then
// CLAUDE_CONFIG_DIR (the real Claude Code env var that relocates ~/.claude),
// then ~/.claude as the default. claudeDirSource feeds the MCP user-config
// lookup below — real Claude Code keeps `.claude.json` INSIDE the relocated
// dir when CLAUDE_CONFIG_DIR is set, not beside it like the ~/.claude
// default.
const claudeDirFlag = flagStr('--claude-dir', undefined);
let claudeDirSource, claudeDirRaw;
if (claudeDirFlag !== undefined) {
  claudeDirRaw = claudeDirFlag; claudeDirSource = 'flag';
} else if (process.env.CLAUDE_CONFIG_DIR) {
  claudeDirRaw = process.env.CLAUDE_CONFIG_DIR; claudeDirSource = 'env';
} else {
  claudeDirRaw = path.join(HOME, '.claude'); claudeDirSource = 'default';
}
const CLAUDE = path.resolve(claudeDirRaw);
const ROOT = path.join(CLAUDE, 'projects');

// ------------------------------------------------------------------- scope
// Claude Code names each project's transcript folder after the absolute,
// resolved working directory it was launched from, with every character
// that isn't a-z/A-Z/0-9 replaced by `-` (this is Claude Code's own rule,
// from its binary: `p.replace(/[^a-zA-Z0-9]/g, '-')`):
//   C:\Users\user\project  ->  C--Users-user-project  (colon AND the
//                                 backslash after it each become their own
//                                 `-`, hence the doubled dash)
//   /Users/user/project    ->  -Users-user-project
// path.resolve() first so relative values (`.`, `..`, `sub/dir`) and `--project
// .` behave like the cwd they refer to, rather than being mapped as literal
// text (which previously left `.` and `..` scoping to the wrong thing, or to
// everything).
// Names over 200 chars: Claude Code truncates to 200 chars and appends
// `-<base36 hash>`. We don't reimplement that hash — instead we take the
// same 200-char prefix and look for exactly one existing projects/ folder
// starting with `<prefix>-`. Zero or multiple matches fall through to the
// (non-existent) prefix itself, which surfaces as the normal "unknown
// project" error.
function projectFolder(p, root = ROOT) {
  const mapped = path.resolve(String(p)).replace(/[^a-zA-Z0-9]/g, '-');
  if (mapped.length <= 200) return mapped;
  const prefix = mapped.slice(0, 200);
  let entries;
  try { entries = fs.readdirSync(root); } catch { entries = []; }
  const matches = entries.filter(e => e.startsWith(prefix + '-'));
  return matches.length === 1 ? matches[0] : prefix;
}

// Default scope = cwd's project. --project <path> overrides it. --all scans
// every project (pre-Slice-6 behaviour). SCOPE_PROJECT is the folder name to
// filter to, or null when scanning everything. SCOPE_DIR is the same target
// as an unmangled absolute path (not the `projects/` folder name) — needed
// for CONFIG's MCP lookup, which reads real on-disk paths (`.mcp.json`,
// `~/.claude.json`'s `projects[<path>]` key), not the transcript folder.
const SCOPE_DIR = ALL ? null : path.resolve(PROJECT_ARG !== undefined ? PROJECT_ARG : process.cwd());
const SCOPE_PROJECT = ALL ? null : projectFolder(SCOPE_DIR);
const SCOPE_ROOT = SCOPE_PROJECT ? path.join(ROOT, SCOPE_PROJECT) : ROOT;

// ---------------------------------------------------------------- pricing
// $/MTok: [input, cacheWrite5m, cacheWrite1h, cacheRead, output]
// Source: https://claude.com/pricing (lookup 2026-09-25). Opus 5.5 has its own
// row — it is NOT the same price as Opus 5 (cheaper across the board), so it
// gets a distinct rate here even though it still rolls into the "Opus" family
// bucket in SPEND (see REFERENCE.md).
// Fable 5 (legacy) also has its own row — a plain `includes('fable')` match
// used to catch both Fable 5 and Fable 5.1 under the Fable 5.1 rate, but the
// source page prices Fable 5's cache read at $1/MTok, not $0.25 — 4x off.
// Both still roll into the single "Fable" SPEND family.
const PRICES = {
  opus: [5, 6.25, 10, 0.5, 25],
  opus55: [4, 5, 8, 0.2, 20],
  fable51: [10, 12.5, 20, 0.25, 50],
  fable5: [10, 12.5, 20, 1, 50],
  sonnet46: [3, 3.75, 6, 0.3, 15],
  sonnet: [2, 2.5, 4, 0.2, 10],
  haiku: [1, 1.25, 2, 0.1, 5],
};
// Exact known-version matching (Slice 25) — not prefix/`includes()`. Loose matching used to
// let an unlisted version fall through to the wrong row (an Opus fallback for any `opus-*`,
// a plain `includes('fable-5')` catching `fable-5-2`, `sonnet-4-5` matching the `includes
// ('sonnet')` fallback and pricing at the Sonnet 5 rate). Every id below is matched exactly
// after normalizing the raw model string: `claude-` prefix stripped, a trailing 8-digit date
// suffix stripped (`-20251001` on a known id must still match), dots folded to hyphens
// (`opus-5.5` == `opus-5-5`). Anything left over — a genuinely new/renamed family, or a
// version not in this list — is UNPRICED and triggers the new-model warning in the text
// report (see REFERENCE.md "Unknown models — UNPRICED") instead of being guessed at.
const KNOWN_MODELS = {
  'opus-5-5': ['Opus', PRICES.opus55],
  'opus-5': ['Opus', PRICES.opus],
  'fable-5-1': ['Fable', PRICES.fable51],
  'fable-5': ['Fable', PRICES.fable5],
  'sonnet-4-6': ['Sonnet', PRICES.sonnet46],
  'sonnet-5': ['Sonnet', PRICES.sonnet],
  'haiku-4-5': ['Haiku', PRICES.haiku],
};
function rateFor(model) {
  const stripped = String(model).toLowerCase()
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/\./g, '-');
  return KNOWN_MODELS[stripped] || null;
}

// --------------------------------------------------------------- activity
// Bash / PowerShell command → normalized key, so the same command run against
// a different PR number, commit, path or cwd groups together (design decision Q9).
// The key is the unit POLLING counts per session and BOILERPLATE takes a
// prefix of: top-level segments (shellSegments(), quote- and subshell-aware)
// joined by canonical separators (` && `, ` || `, ` | `, ` ; `), so
// shellSegments(key)[0].text is the first segment. Steps and reasons:
// REFERENCE "Cost by activity — command key".
const isPathText = t => /^(?:[A-Za-z]:[\\/]|[\\/~]|\.\.?[\\/])/.test(t) || /^[\w.-]+(?:[\\/][\w.-]+)+$/.test(t);
function commandKey(command) {
  // Text that must survive the number/id rewrites (heredoc hashes, sed line
  // ranges) is parked as one private-use char and restored at the end.
  const kept = [];
  const keep = t => String.fromCharCode(0xE000 + kept.push(t) - 1);
  let s = hashHeredocBodies(String(command || '').replace(/\r\n/g, '\n'), keep).replace(/\\\n/g, ' ');
  s = s.replace(/\bsed\s+-n\s+('[^']*'|"[^"]*"|[^\s;&|'"]+)/g, (m, script) => m.replace(script, keep(script)));
  // Quoted paths: absolute / home / dot-relative, or a bare `dir/file` of
  // path characters only. Other quoted text (grep patterns, printf bodies,
  // sed scripts) is kept — it is what tells two commands apart.
  s = s.replace(/"([^"]*)"|'([^']*)'/g, (m, dq, sq) => (isPathText(dq ?? sq) ? '<path>' : m));
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>');
  s = s.replace(/\b[0-9a-f]{7,}\b/gi, m => (/\d/.test(m) ? '<id>' : m)); // commit SHAs, hex ids
  s = s.replace(/\d+/g, 'N');
  s = stripCdAndEnv(s);
  return s.replace(/[\uE000-\uF8FF]/g, ch => kept[ch.charCodeAt(0) - 0xE000] ?? ch);
}
// A segment that is only `cd <dir>` / `Set-Location [-Path] <dir>` — cwd is not the
// command, and any argument text (flags, an unquoted path with spaces) would leak
// the project path (Slice 12 prints keys).
const isCdCmd = t => /^(?:cd|Set-Location)\b(?:\s.*)?$/i.test(t);
// Strips `NAME=value` env prefixes and cd/Set-Location segments — at the top level
// and, recursively, inside a `(…)` group that is a whole segment on its own (a
// group's contents are not split by shellSegments(), so `(cd /tmp && ls)` never
// reaches the top-level filter as a bare `cd` segment).
// depth caps the `(…)` recursion below — pathological input (thousands of
// nested groups) must never blow the call stack; beyond the cap the inner
// text is kept as-is (unstripped) rather than throwing.
const STRIP_DEPTH_MAX = 200;
function stripCdAndEnv(s, depth = 0) {
  const segs = shellSegments(s)
    // `NAME=value cmd` env prefixes. A value with `$(`/`(` is not matched, so a
    // standalone `TOKEN=$(… | git credential fill)` assignment stays.
    .map(g => {
      let text = g.text.replace(/\s+/g, ' ')
        .replace(/^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^\s;&|()$'"]*) )+(?=\S)/, '');
      const grp = /^\((.*)\)$/s.exec(text);
      if (grp) text = `(${depth < STRIP_DEPTH_MAX ? stripCdAndEnv(grp[1], depth + 1) : grp[1]})`;
      return { ...g, text };
    })
    .filter(g => g.text && !isCdCmd(g.text));
  return segs.map((g, i) => (i < segs.length - 1 ? `${g.text} ${g.sep} ` : g.text)).join('');
}
// Top-level segments of a shell string: [{ text, sep }], sep = the separator
// after it (`&&`, `||`, `|`, `;` — a newline counts as `;` — or '' at the end).
// Separators inside quotes, backticks or (…) / $(…) do not split.
function shellSegments(s) {
  const segs = [];
  let from = 0;
  shellScan(String(s), (i, sep, depth) => {
    if (depth || sep === '(') return;
    segs.push({ text: s.slice(from, i).trim(), sep: sep === '\n' ? ';' : sep });
    from = i + sep.length;
  });
  segs.push({ text: s.slice(from).trim(), sep: '' });
  return segs.filter((g, i) => g.text || i === segs.length - 1);
}
// Walks s outside quotes/backticks; calls fn(i, sep, depth) at each separator
// and at each `(` (sep '('), depth = (…) nesting at that point.
function shellScan(s, fn) {
  let q = null, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; continue; }
    if (c === '\\') { i++; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '(') { fn(i, '(', depth++); continue; }
    if (c === ')') { if (depth) depth--; continue; }
    const two = s.slice(i, i + 2);
    const sep = two === '&&' || two === '||' ? two : '|;\n'.includes(c) ? c : null;
    if (sep) { fn(i, sep, depth); i += sep.length - 1; }
  }
}
// `<<TAG` / `<<'TAG'` / `<<-TAG`: keep the line that opens the heredoc, replace
// the body through the closing TAG line by `[heredoc <8 hex of sha1(body)>]`
// right after the `<<TAG` — two inline scripts or commit messages are two
// commands, the same script run again is one.
function hashHeredocBodies(s, keep) {
  const out = [];
  let open = null;
  const close = () => {
    const hash = crypto.createHash('sha1').update(open.body.join('\n')).digest('hex').slice(0, 8);
    out[open.at] = out[open.at].replace('\uFFFF', keep(`[heredoc ${hash}]`));
    open = null;
  };
  for (const line of s.split('\n')) {
    if (open) { if (line.trim() === open.tag) close(); else open.body.push(line); continue; }
    const m = /(?<!<)<<-?\s*(['"]?)([\w-]+)\1/.exec(line);
    if (!m) { out.push(line); continue; }
    const end = m.index + m[0].length;
    out.push(`${line.slice(0, end)} \uFFFF${line.slice(end)}`);
    open = { tag: m[2], at: out.length - 1, body: [] };
  }
  if (open) close();
  return out.join('\n');
}

// Tool call → activity category (design decision Q9). ONE table, first match wins,
// so order is priority: a compound `pnpm test && git commit` is test, a
// `curl …/check-runs` is wait/poll before it is GitHub. Adding a category =
// one line. Each rule's regex runs over the call's subject: `<Tool> <key>`,
// key = commandKey() for Bash/PowerShell, file_path for other tools (so a
// Read of a .png can count as image). In a shell key every command start is
// marked with `CMD` (‣): each segment, each `(…)` / `$(…)` body, and after a
// wrapper (`do`, `timeout N`, `python -m`, `uv run`, `npx`, …; see
// markCommands()) — never inside quotes. So `cat foo.test.ts` is not a test
// run, `grep "a|git"` is not git, `uv run pytest | tail` is a test run.
// No match → ACTIVITY_OTHER.
const CMD = '‣';
// Slice 15 fix (review, real data, BLOCKER): a command boundary opened by a bare `|`
// (as opposed to `;`, `&&`, `||`, newline or `(`) gets this marker instead of CMD, so
// the read rule's READERS alt (below) can tell "ls" (a command) from "| tail" (a filter
// piped onto some other command's output) — same character class otherwise, so every
// OTHER rule (git, test/lint/build, script run, …) still matches through ANY_CMD and
// behaves exactly as if pipes and other separators were the same marker.
const CMD_PIPE = '‥';
const ANY_CMD = `[${CMD}${CMD_PIPE}]`;
// The two marker chars, for use *inside* an existing `[^...]` exclusion class (a bare-word
// alternative like SCRIPT_INTERP/SCRIPT_FILE/SHOT_EXEC/SHOT_TARGET/RUNNERS below) — not a
// class of its own, so no surrounding `[...]`.
const NOT_CMD = String.raw`${CMD}${CMD_PIPE}`;
// Interpreter options allowed before `-m` (numbers already N'd by commandKey):
// `-X val` / `-W val` (take a value; the value can't itself start with `-`,
// so `-x -m` is never swallowed as `-X`'s value — it falls through to the
// single-letter alt below instead, e.g. `python -x -m pytest` → test/lint/
// build), any other single-letter flag (`-u`, `-B`, `-O`, lowercase `-x`,
// …), or a `py`-launcher version selector (`-3`, `-3.N`, already N'd to
// `-N`/`-N.N`). The three alternatives are kept disjoint: the single-letter
// alt excludes N (it would otherwise also match `-N`, e.g. `-3` → `-N` —
// that overlap is what made `-3 ` × 24 backtrack exponentially) and excludes
// `m` (the WRAPPERS alt below ends in a mandatory literal ` -m`, so without
// this exclusion every `-m` in a repeated `-m -m -m …` run could be parsed
// either as a PY_OPT or as the terminal `-m`, and the engine tried every
// split — that ambiguity is what made `python -m ` × 10k backtrack
// exponentially; Slice 30). Deliberately avoids inline regex-modifier groups
// (a newer syntax for toggling flags like case-insensitivity mid-pattern) —
// unsupported before Node 23, throws `SyntaxError: Invalid group` on older
// engines, e.g. Node 22 LTS, crashing the whole script.
const PY_OPT = String.raw`(?:-[XW] (?!-)\S+|-(?!N|m)[A-Za-z]|-N(?:\.N)?)`;
const WRAPPERS = String.raw`do|then|else|\{|!|time|nice|env(?: [A-Za-z_]\w*=\S*)*|timeout(?: -\S+)* \S+|` +
  String.raw`xargs(?: -\S+)*|python(?:N(?:\.N)?)?(?: ${PY_OPT})* -m|py(?: ${PY_OPT})* -m|uv run|poetry run|` +
  String.raw`npx(?: -y| --yes)?|bunx|(?:pnpm|yarn) (?:dlx|exec)|npm exec`;
// Word lists the rules share (regex alternations).
const POLLERS = String.raw`sleep|Start-Sleep|gh pr checks|gh run (?:watch|view)`;
// Slice 15 HITL: the two "burn a turn on purpose to wait" patterns found on real data
// (`echo waiting-N` / `echo idle-check-N`, `tasklist` / `Get-Process` busy-polls), so
// they count as wait/poll instead of falling to `other`. Kept out of POLLERS/the main
// wait/poll rule above and checked in their own lower-priority rule (below git) — a
// real compound like `git status; Get-Process` is a status check with a process check
// tacked on, not a wait, and git (like test/lint/build) is real work that must win;
// review finding: with these two patterns inside the high-priority wait/poll rule,
// that compound fell to wait/poll instead of git. `sleep`/`gh pr checks`/`gh run
// watch|view`/check-runs/actions-runs stay in the high-priority rule — those are the
// command's whole point, not a side check bolted onto real work.
const BUSY_POLLERS = String.raw`echo (?:waiting|idle)\S*|tasklist|Get-Process`;
// Harness tools that are neither agent spawns nor real work: skills, tool search,
// interactive UI, task/queue management, plan mode, worktrees, scheduling. Slice 15
// HITL: these used to fall to `other`, which hid most of `other`'s real composition.
const HARNESS_TOOLS = String.raw`Skill|ToolSearch|AskUserQuestion|TaskStop|TaskCreate|TaskUpdate|TaskList|` +
  String.raw`TodoWrite|ListAgents|EnterPlanMode|ExitPlanMode|EnterWorktree|ExitWorktree|CronCreate|` +
  String.raw`CronDelete|ScheduleWakeup`;
// A bare interpreter or script-file run (Slice 15 HITL): `python foo.py`, `node x.mjs`,
// `sh script.sh` — as opposed to a runner/checker (RUNNERS/CHECKERS above, e.g.
// `python -m pytest`) or a screenshot script (SHOT_RUN above), both of which are
// checked first in ACTIVITY_RULES and so win. Catches the "rerun the same script while
// iterating" turns that used to collapse into `other` (and, at low enough POLLING N,
// looked like false-positive polling).
// `python[^\s CMD]*`, not `python\S*`: an unbounded `\S*` crosses CMD markers into the
// next command, so 40k chained `${CMD}python` segments with no whitespace between them
// force one giant \S* match that then backtracks one char at a time hunting for
// `(?: |$)` — O(n^2), ~21s on real data. Bounding the class at CMD (both marker chars,
// CMD and CMD_PIPE — Slice 15 fix, see their definitions above) stops each attempt at
// the very next command boundary, same fix as SCRIPT_FILE above.
const SCRIPT_INTERP = String.raw`python[^\s${NOT_CMD}]*|py|node|deno|bun|tsx|ts-node|sh|bash|pwsh|powershell`;
// Bare-file alternative's target, bounded like SHOT_TARGET above: `[^\s${NOT_CMD}]*`,
// not `\S+` — a `\S+` anchored at every CMD (e.g. every `(` of 50k nested parens, none of
// them whitespace) backtracks per anchor across the rest of the string, O(n^2)/worse;
// excluding both marker chars too stops each attempt at the very next command boundary.
const SCRIPT_FILE = String.raw`[^\s${NOT_CMD}]*\.(?:m?js|py|sh|ps1)\b`;
// `-{1,2}[\w]…`, not `-{1,2}[\w-]…`: a flag's leading dashes and its name must not both
// be able to absorb `-`, or a repeated `--a --a --a …` has many ways to split the same
// run of dashes between the two and the engine tries them all (exponential; Slice 30).
const RUNNERS = String.raw`(?:pnpm|npm|yarn|bun)(?: -{1,2}\w[\w-]*(?:[ =][^\s${NOT_CMD}-]\S*)?)*(?: run| exec)? ` +
  String.raw`(?:test|lint|build|typecheck|vitest|jest|eslint|prettier|tsc|playwright test)`;
const CHECKERS = String.raw`vitest|jest|pytest|unittest|ruff|mypy|eslint|prettier|tsc|playwright test|` +
  String.raw`node --test|make|cargo (?:test|build|check|clippy|nextest)|go (?:test|build|vet)`;
const READERS = String.raw`cat|sed -n|grep|rg|head|tail|ls|find|wc|awk|Get-Content`;
const IMAGE = String.raw`^Read .*\.(?:png|jpe?g|gif|webp|bmp)$`;
// A screenshot script *run* (by an interpreter or directly), not a read / edit / git of it.
// Token-bounded (whitespace vs. non-whitespace never overlap), so this is
// linear even over a long non-matching command — the old `[^CMD]*?` scan
// overlapped with the target's own `[^\s CMD]*` char class, which meant
// O(n^2) backtracking on e.g. `node ` + 200k non-matching chars.
const SHOT_EXEC = String.raw`(?:node|python\S*|bun|deno|tsx|ts-node|bash|sh|pwsh)(?:\s+[^\s${NOT_CMD}]+)*?\s+`;
const SHOT_TARGET = String.raw`[^\s${NOT_CMD}]*(?:screenshot[\w.-]*\.(?:m?js|ts|py|sh)\b|\.screenshot\()`;
const SHOT_RUN = String.raw`${ANY_CMD}(?:${SHOT_EXEC})?${SHOT_TARGET}`;
const rx = (strings, ...vals) => new RegExp(String.raw(strings, ...vals), 'i');
const ACTIVITY_RULES = [
  [rx`^(?:Agent|Task|SendMessage) `, 'agent spawn'],
  [rx`^(?:${HARNESS_TOOLS}) `, 'harness'],
  [rx`^(?:WebFetch|WebSearch) `, 'web'],
  [rx`${IMAGE}|^\S*screenshot\S* |${SHOT_RUN}`, 'screenshot/image'],
  [rx`^(?:Monitor|TaskOutput|BashOutput) |${ANY_CMD}(?:${POLLERS})\b|check-runs|actions/runs`, 'wait/poll'],
  [rx`api\.github\.com|${ANY_CMD}gh `, 'github'],
  [rx`${ANY_CMD}(?:${RUNNERS}|${CHECKERS})\b`, 'test/lint/build'],
  [rx`${ANY_CMD}git\b`, 'git'],
  [rx`${ANY_CMD}(?:${BUSY_POLLERS})\b`, 'wait/poll'],
  [rx`^(?:Edit|Write|MultiEdit|NotebookEdit) |${ANY_CMD}(?:sed -i|cat >|tee )`, 'edit'],
  // Slice 15 fix (review, real data, BLOCKER): READERS uses the strict CMD marker, not
  // ANY_CMD — a reader word reached only via a `|` filter (`… | tail -20`) is a filter
  // on some other command's output, not a read of its own, so it must NOT count as
  // `read`; that CMD_PIPE-marked occurrence simply doesn't match this branch and falls
  // through to `script run` (or whatever the piped-from command is). `ls; python x.py`
  // still stays `read`: `;` keeps the plain CMD marker, unaffected by this change.
  [rx`^(?:Read|Grep|Glob) |${CMD}(?:${READERS})\b`, 'read'],
  // Slice 15 fix (review, real data): `script run` below edit/read, not above. A
  // `python - <<EOF … EOF` heredoc editing a file, or `python -c "…"` reading one,
  // is edit/read work, not "run a script" — but SCRIPT_INTERP's bare `python[^\s CMD]*`
  // also matches the interpreter token at the front of those, so when this rule ran
  // BEFORE edit/read it stole those turns. Moving this rule after edit/read means it
  // only claims turns edit/read didn't already recognize (e.g. `python foo.py`,
  // `node x.mjs` with no heredoc/`-c` payload, or a piped `python foo.py | tail -20`,
  // now that READERS above no longer steals the `tail` half of that pipeline) — i.e.
  // `script run` only takes share from `other` (and, after the CMD_PIPE fix, from the
  // false `read` share piped script re-runs used to get). Measured (`--all --days
  // 3650`, real data): read 29.3%, script run 16.0%, edit 15.2%, other 0.5% — see
  // REFERENCE.md's activity table section.
  [rx`${ANY_CMD}(?:${SCRIPT_INTERP})(?: |$)|${ANY_CMD}${SCRIPT_FILE}`, 'script run'],
];
const ACTIVITY_OTHER = 'other';
// A turn with no tool_use at all (final answer, plan, question to the user) — Slice 15
// HITL: split out of `other` so `other` reflects only genuinely uncategorized tool calls.
const ACTIVITY_REPLY = 'reply';
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// Sticky (sticks to lastIndex, no scanning forward to find a match) so a chain of wrapper
// words is consumed word-by-word in markCommands() without slicing the remaining string.
const WRAP_RE = new RegExp(String.raw`(?:${WRAPPERS}) `, 'iy');
// Key → the same text with CMD before every command start (see above). Two linear passes:
//  1. insert CMD at each shellScan() boundary by building an array of pieces and joining
//     once. The old code did this with a `reduce` that re-sliced the WHOLE string at every
//     boundary (`t.slice(0, i) + CMD + t.slice(i)`) — O(n) work per boundary, quadratic on
//     e.g. 50k nested `(…)` (~50k boundaries, ~10 s). Building pieces and joining once is
//     O(n) total.
//  2. swallow each wrapper-word chain (`time time … cmd`) in one left-to-right scan with a
//     sticky regex anchored right after each CMD. The old code was a `.replace(WRAPPED, …)`
//     fixed-point loop: each pass finds only the FIRST wrapper in a chain (the rest aren't
//     yet preceded by a fresh CMD), so it re-scanned the whole string once per chained
//     wrapper word — quadratic on e.g. 8000 chained `time ` (~0.9 s). A wrapper match whose
//     end already abuts an existing CMD (from step 1, or a shorter alternative the sticky
//     regex could also have matched) is left unmarked, same as the old lookahead
//     `(?!${CMD})` — it is already a command boundary, so re-marking it would duplicate CMD.
function markCommands(key) {
  const at = [0];
  // Slice 15 fix: remember which marker each boundary gets — CMD_PIPE for a bare `|`,
  // CMD for every other separator (`;`, `&&`, `||`, newline, `(`) — so a piped-into
  // filter (`| tail`) is distinguishable from a real new command (`; tail`).
  const markers = [CMD];
  shellScan(key, (i, sep) => { at.push(i + sep.length); markers.push(sep === '|' ? CMD_PIPE : CMD); });
  const pieces = [];
  for (let k = 0; k < at.length; k++) {
    const start = at[k];
    const end = k + 1 < at.length ? at[k + 1] : key.length;
    const seg = key.slice(start, end);
    pieces.push(markers[k], k === 0 ? seg : seg.replace(/^\s+/, ''));
  }
  const s = pieces.join('');

  const out = [];
  let i = 0;
  while (i < s.length) {
    // Single linear scan for the next marker char (CMD or CMD_PIPE). Two separate
    // `indexOf` calls (one per marker) each re-scan to the end of the string whenever
    // THEIR marker is absent from the remainder — e.g. all-`;` input has no CMD_PIPE, so
    // indexOf(CMD_PIPE, i) scans to the end on every iteration, i²-many chars total
    // (O(n²): measured 'a;'×80k 77ms → 1411ms, 'a|'×80k 62ms → 1392ms). Checking both
    // marker chars in one forward pass per boundary keeps this O(n) — Slice 15 fix.
    let mark = -1;
    for (let j = i; j < s.length; j++) {
      if (s[j] === CMD || s[j] === CMD_PIPE) { mark = j; break; }
    }
    if (mark < 0) { out.push(s.slice(i)); break; }
    const markChar = s[mark];
    out.push(s.slice(i, mark), markChar);
    i = mark + 1;
    for (;;) {
      WRAP_RE.lastIndex = i;
      const wm = WRAP_RE.exec(s);
      if (!wm || s[WRAP_RE.lastIndex] === CMD || s[WRAP_RE.lastIndex] === CMD_PIPE) break;
      // Re-emit the SAME marker the wrapper's boundary got (Slice 15 fix): a wrapper
      // right after a pipe (`| timeout 5 tail`, `| xargs grep foo`) must stay CMD_PIPE
      // so the wrapped command is still read as piped-into filter, not a fresh command.
      out.push(wm[0], markChar);
      i = WRAP_RE.lastIndex;
    }
  }
  return out.join('');
}
// One tool_use content part → { id, tool, key } as stored on a turn.
function toolCall(part) {
  const input = part.input || {};
  const key = SHELL_TOOLS.has(part.name) ? commandKey(input.command) : String(input.file_path || '');
  return { id: part.id, tool: String(part.name), key };
}
function categorize(call) {
  const subject = `${call.tool} ${SHELL_TOOLS.has(call.tool) ? markCommands(call.key) : call.key}`;
  const rule = ACTIVITY_RULES.find(([re]) => re.test(subject));
  return rule ? rule[1] : ACTIVITY_OTHER;
}
// Public form of the above: a tool_use's name + input → category.
const activityCategory = (name, input) => categorize(toolCall({ name, input }));

// Cost by activity over deduped turns. A turn's cost, turn count and context
// are split evenly over its tool calls (k of n calls in one category → k/n of
// the turn), so turns and cost both sum to the window totals and shares sum
// to 100 %. A turn with no tool_use (plain text / thinking answer) → other.
// Every category is listed (zeros included), sorted by cost desc.
function activity(rows) {
  const cats = new Map([...ACTIVITY_RULES.map(([, c]) => c), ACTIVITY_OTHER, ACTIVITY_REPLY]
    .map(c => [c, { category: c, turns: 0, ctx: 0, cost: 0 }]));
  let total = 0;
  for (const r of rows) {
    total += r.cost;
    const hit = r.calls.length ? r.calls.map(categorize) : [ACTIVITY_REPLY];
    for (const c of hit) {
      const e = cats.get(c);
      e.turns += 1 / hit.length; e.ctx += r.ctx / hit.length; e.cost += r.cost / hit.length;
    }
  }
  return [...cats.values()].sort((a, b) => b.cost - a.cost).map(({ ctx, ...e }) =>
    ({ ...e, avgCtx: e.turns ? ctx / e.turns : 0, share: total ? e.cost / total : 0 }));
}

// ---------------------------------------------------------------- collect
function walk(dir, out = []) {
  let entries;
  try {
    // sorted: readdir order is filesystem-dependent, dedupe "first seen" must not be
    entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// Subagent task text. Source order (decision + reason in REFERENCE.md,
// "Subagent task text"):
//   1. agent-*.meta.json `description` — written by Claude Code next to each
//      subagent transcript; it is the parent's Agent tool_use `description`,
//      a short label the spawner chose, so no need to scan the parent file.
//   2. first non-empty line of the subagent's first user prompt (older
//      transcripts / metas without a description).
//   3. null → the report falls back to the agent id.
function subagentMetaTask(jsonlFile) {
  const meta = readJson(jsonlFile.replace(/\.jsonl$/, '.meta.json'));
  const d = meta && typeof meta.description === 'string' ? meta.description.trim() : '';
  return d || null;
}
function promptText(message) {
  const c = message && message.content;
  const text = typeof c === 'string' ? c
    : Array.isArray(c) ? ((c.find(p => p && p.type === 'text' && p.text) || {}).text || '') : '';
  const line = text.split('\n').map(l => l.trim()).find(Boolean);
  return line || null;
}

// One API response is written as several JSONL lines (thinking / text /
// tool_use) sharing one message.id — one turn, priced once. Earlier lines carry
// a partial usage (output_tokens still streaming), so the line with the largest
// output wins. An id recurring in another file is still the same response; it
// is credited to whichever occurrence has the earliest timestamp for that id
// (not whichever file the path-sorted walk reaches first — see the dedupe
// merge below).
// Unknown models (e.g. a new family the pricing table hasn't caught up with
// yet) are counted here instead of being silently dropped: rows seen and raw
// token volume (input + cache write + cache read + output), keyed by the
// model string as it appears in the transcript. Not deduped by message.id —
// these tokens are never priced, so exact turn accounting doesn't matter,
// only "were they seen at all". Kept as raw per-row entries (with ts) rather
// than aggregated here, so the caller can window them the same way as SPEND
// (see aggregateUnpriced) instead of always counting all-time.
async function collect() {
  const rows = [];
  const byId = new Map();
  const unpriced = [];
  const tasks = new Map(); // subagent sessionKey → task text (see subagentMetaTask)
  for (const f of walk(SCOPE_ROOT)) {
    const dir = path.dirname(f);
    const isSub = path.basename(dir) === 'subagents';
    // main:     projects/<project>/<session>.jsonl              → dir = <project>
    // subagent: projects/<project>/<session-uuid>/subagents/agent-*.jsonl → dir = .../subagents,
    //           so project is two levels up and the session-uuid dir name is the parent session id.
    const project = path.basename(isSub ? path.dirname(path.dirname(dir)) : dir);
    const parent = isSub ? path.basename(path.dirname(dir)) : null;
    const sid = path.basename(f, '.jsonl');
    const metaTask = isSub ? subagentMetaTask(f) : null;
    let firstPrompt = null;
    const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (isSub && firstPrompt === null && j.type === 'user') firstPrompt = promptText(j.message);
      const u = j.message && j.message.usage;
      if (!u) continue;
      const modelName = j.message.model || '(unknown)';
      const ts = Date.parse(j.timestamp || '') || 0;
      // Claude Code writes a `<synthetic>` model, zero-usage row for locally generated
      // placeholder/error messages (not a real API call) — these are not "unpriced", they
      // were never priceable, so they must not fire UNPRICED on every single run.
      if (modelName === '<synthetic>' && !(u.input_tokens || u.cache_creation_input_tokens ||
          u.cache_read_input_tokens || u.output_tokens)) continue;
      const r = rateFor(modelName);
      if (!r) {
        const tok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) +
          (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
        unpriced.push({ ts, model: modelName, tokens: tok });
        continue;
      }
      const [family, p] = r;

      const cc = u.cache_creation;
      const ccTotal = u.cache_creation_input_tokens || 0;
      const w5 = cc ? (cc.ephemeral_5m_input_tokens || 0) : 0;
      const w1h = cc ? (cc.ephemeral_1h_input_tokens || 0) : ccTotal; // no breakdown → assume 1h
      const read = u.cache_read_input_tokens || 0;
      const out = u.output_tokens || 0;
      const inp = u.input_tokens || 0;

      const cost = (inp * p[0] + w5 * p[1] + w1h * p[2] + read * p[3] + out * p[4]) / 1e6;
      const row = { ts, sid, project, isSub, parent, family, model: modelName, cost, ctx: read + ccTotal, out,
                    calls: [] };
      const id = j.message.id;
      const seen = id && byId.get(id);
      if (!seen) {
        if (id) byId.set(id, row); // no id → can't dedupe, count the line as is
        rows.push(row);
      } else {
        if (out > seen.out) {
          Object.assign(seen, { family, model: modelName, cost, ctx: row.ctx, out });
        }
        // Credit the turn to whichever occurrence has the earliest timestamp,
        // not whichever file the (path-sorted) walk reached first. A missing
        // or unparsed timestamp (ts = 0) never outranks a real one, and an
        // exact tie keeps whichever occurrence already holds attribution
        // (i.e. degrades to path order on ties).
        if (row.ts && (!seen.ts || row.ts < seen.ts)) {
          Object.assign(seen, { ts: row.ts, sid, project, isSub, parent });
        }
      }
      // Each line of a turn carries one content part; the turn's tool calls
      // are the union over its lines (a repeated tool_use id counts once).
      const turnRow = seen || row;
      const parts = Array.isArray(j.message.content) ? j.message.content : [];
      for (const part of parts) {
        if (!part || part.type !== 'tool_use') continue;
        if (part.id && turnRow.calls.some(c => c.id === part.id)) continue;
        turnRow.calls.push(toolCall(part));
      }
    }
    if (isSub) tasks.set(sessionKey({ isSub, parent, sid }), metaTask || firstPrompt || null);
  }
  return { rows, unpriced, tasks };
}

// Aggregates raw unpriced rows into { model, rows, tokens } entries, keeping
// only rows within [fromTs, +inf) — the same window SPEND is computed over,
// so UNPRICED doesn't silently report all-time totals under a windowed header.
function aggregateUnpriced(rows, fromTs) {
  const byModel = new Map();
  for (const r of rows) {
    if (r.ts < fromTs) continue;
    const e = byModel.get(r.model) || { model: r.model, rows: 0, tokens: 0 };
    e.rows++; e.tokens += r.tokens;
    byModel.set(r.model, e);
  }
  return [...byModel.values()].sort((a, b) => b.tokens - a.tokens);
}

// A subagent id can recur under two different parent sessions (e.g. two
// separate runs both spawning an agent named `agent-shared`) — sid alone is
// not a unique session identity for subagents. Identity is (parent, sid);
// main sessions have no parent and keep keying by sid alone.
const sessionKey = r => r.isSub ? r.parent + '\u0000' + r.sid : r.sid;

// -------------------------------------------------------------- summarize
function summarize(rows) {
  const byFamily = {};
  const byChain = { main: 0, sub: 0 };
  const sessions = new Map();
  const modelCost = new Map(); // session → { modelString: cost }
  let cost = 0, ctx = 0;

  for (const r of rows) {
    cost += r.cost;
    ctx += r.ctx;
    byFamily[r.family] = (byFamily[r.family] || 0) + r.cost;
    byChain[r.isSub ? 'sub' : 'main'] += r.cost;
    const key = sessionKey(r);
    let s = sessions.get(key);
    if (!s) {
      s = { sid: r.sid, project: r.project, isSub: r.isSub, parent: r.parent, cost: 0, msgs: 0, ctx: 0,
            ctxMax: 0, first: r.ts || Infinity, last: r.ts || 0, opus: 0 };
      sessions.set(key, s);
      modelCost.set(s, {});
    }
    s.cost += r.cost;
    s.msgs++;
    s.ctx += r.ctx;
    if (r.ctx > s.ctxMax) s.ctxMax = r.ctx;
    if (r.ts) { s.first = Math.min(s.first, r.ts); s.last = Math.max(s.last, r.ts); }
    if (r.family === 'Opus') s.opus += r.cost;
    const mc = modelCost.get(s);
    mc[r.model] = (mc[r.model] || 0) + r.cost;
  }

  const list = [...sessions.values()].sort((a, b) => b.cost - a.cost);
  // A session's `model` = the model string that cost it the most (a session
  // can switch models mid-way; the dominant one is what the reader needs).
  for (const s of list) {
    const mc = modelCost.get(s);
    s.model = Object.keys(mc).sort((a, b) => mc[b] - mc[a])[0];
  }
  const msgs = rows.length;
  // Slice 15 HITL: SESSIONS' median/p90 and LONG_SESSION are main-threads-only — a
  // subagent's own turn distribution is LONG_AGENT's / subagentDistribution()'s job,
  // and mixing the two double-counted the same sessions under both flags.
  const mainList = list.filter(s => !s.isSub);
  const msgCounts = mainList.map(s => s.msgs).sort((a, b) => a - b);
  const pick = q => quantile(msgCounts, q); // shared with subagentDistribution() below

  return {
    cost, msgs, byFamily, byChain, sessions: list, mainSessions: mainList,
    avgCtx: msgs ? ctx / msgs : 0,
    costPerMsg: msgs ? cost / msgs : 0,
    medianMsgs: pick(0.5), p90Msgs: pick(0.9),
    topShare: cost ? list.slice(0, 5).reduce((a, s) => a + s.cost, 0) / cost : 0,
    longShare: cost ? mainList.filter(s => s.msgs >= LONG_SESSION_TURNS)
      .reduce((a, s) => a + s.cost, 0) / cost : 0,
    opusShare: cost ? (byFamily.Opus || 0) / cost : 0,
  };
}

function weeks(rows) {
  const buckets = new Map();
  for (const r of rows) {
    if (!r.ts) continue;
    const d = new Date(r.ts);
    const day = (d.getUTCDay() + 6) % 7; // Monday = 0
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
    const key = monday.toISOString().slice(0, 10);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  return [...buckets.entries()].sort().map(([week, rs]) => {
    const s = summarize(rs);
    return { week, sessions: s.sessions.length, cost: s.cost, avgCtx: s.avgCtx, costPerMsg: s.costPerMsg };
  });
}

// ------------------------------------------------------------------ config
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Every installed agent and skill puts its name + description into the system
// prompt of *every* request. Estimate that fixed prefix weight (~4 chars/token).
function frontmatterWeight(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8').slice(0, 4000); } catch { return 0; }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return 0;
  const fm = m[1];
  const grab = key => {
    const r = new RegExp('^' + key + ':\\s*([\\s\\S]*?)(?=\\n[a-zA-Z_-]+:|$)', 'm').exec(fm);
    return r ? r[1].trim().length : 0;
  };
  return grab('name') + grab('description');
}

function eachPluginDir(fn) {
  const cacheDir = path.join(CLAUDE, 'plugins', 'cache');
  let markets;
  try { markets = fs.readdirSync(cacheDir, { withFileTypes: true }); } catch { return; }
  for (const market of markets) {
    if (!market.isDirectory()) continue;
    const mp = path.join(cacheDir, market.name);
    for (const plugin of fs.readdirSync(mp, { withFileTypes: true })) {
      if (!plugin.isDirectory()) continue;
      const pp = path.join(mp, plugin.name);
      // plugin root is either the plugin dir or a single version dir inside it
      const roots = fs.existsSync(path.join(pp, '.claude-plugin'))
        ? [pp]
        : fs.readdirSync(pp, { withFileTypes: true })
            .filter(v => v.isDirectory() && fs.existsSync(path.join(pp, v.name, '.claude-plugin')))
            .map(v => path.join(pp, v.name));
      for (const root of roots) fn(market.name + '/' + plugin.name, root, plugin.name);
    }
  }
}

// MCP server tool definitions are fetched live over the MCP protocol when a
// session starts — they live on the server, never in any local config file
// or transcript, so this script (which only reads static files, never
// connects to a live server) cannot measure them the way PLUGIN_BLOAT
// measures agent/skill frontmatter. Counting `mcp__<server>__*` names seen in
// transcripts was the alternative (Slice 14) but undercounts
// (a server usually exposes more tools than were ever called) and reads zero
// for a configured-but-unused server — exactly the "paying for it, not using
// it" case this line exists to surface. So: a flat per-server estimate,
// clearly labelled as an estimate. ~6-10 tools/server typical, ~100-150 tok
// each (name + JSON-schema description) -> ~800 tok/server, rounded.
const MCP_SERVER_TOKENS = 800;

// Configured MCP servers for the scoped project, from the three places Claude
// Code stores them (design decision Q9, Slice 14):
//   - user scope:    the user-config file (USER_CONFIG_PATH below) ->
//                     top-level `mcpServers` (NOT settings.json — checked
//                     against a real `~/.claude.json` at implementation time;
//                     settings.json has no mcpServers key in practice)
//   - project scope:  same file -> `projects[<absProjectDir>].mcpServers`
//                     (private per-project servers, e.g. `claude mcp add`
//                     without `--scope project`); keyed with forward slashes
//                     even on Windows, matching real `~/.claude.json`
//   - mcp.json scope: `<scopeDir>/.mcp.json` -> `mcpServers` (checked into
//                     the repo, shared with the team)
// scopeDir is SCOPE_DIR (null under --all — no single project to check, so
// only user scope applies).
//
// USER_CONFIG_PATH (Slice 23): real Claude Code keeps `.claude.json` beside
// `~/.claude` by default, but MOVES it INSIDE the dir when CLAUDE_CONFIG_DIR
// relocates ~/.claude (verified against a real CLAUDE_CONFIG_DIR install).
// --claude-dir is this script's own test/scoping override, not a real Claude
// Code flag — but a dir pointed at by --claude-dir can itself be one set up
// via CLAUDE_CONFIG_DIR (its .claude.json living inside it), so under the
// flag we prefer the inside file when it actually exists and only fall back
// to the sibling convention its fixtures otherwise use (tests/harness.js
// tmpUserConfig) when it doesn't.
const INSIDE_CONFIG_PATH = path.join(CLAUDE, '.claude.json');
const USER_CONFIG_PATH =
  claudeDirSource === 'env' || (claudeDirSource === 'flag' && fs.existsSync(INSIDE_CONFIG_PATH))
    ? INSIDE_CONFIG_PATH
    : CLAUDE + '.json';

function mcpConfig(scopeDir) {
  const servers = [];
  const add = (scope, name) => servers.push({ scope, name });
  const userConfig = readJson(USER_CONFIG_PATH) || {};

  for (const name of Object.keys(userConfig.mcpServers || {})) add('user', name);

  if (scopeDir) {
    const key = scopeDir.replace(/\\/g, '/');
    const proj = (userConfig.projects && userConfig.projects[key]) || {};
    for (const name of Object.keys(proj.mcpServers || {})) add('project', name);

    const mcpJson = readJson(path.join(scopeDir, '.mcp.json')) || {};
    for (const name of Object.keys(mcpJson.mcpServers || {})) add('mcp.json', name);
  }

  return servers;
}

function config() {
  const settings = readJson(path.join(CLAUDE, 'settings.json')) || {};
  const enabledPlugins = settings.enabledPlugins || {};
  const plugins = [];
  let agentDefs = 0, skillDefs = 0, prefixChars = 0;

  eachPluginDir((name, root, pluginName) => {
    // settings.json only lists cache entries actually enabled — cache/ can
    // hold stale/uninstalled marketplaces, so skip anything not explicitly on.
    const marketName = name.slice(0, name.length - pluginName.length - 1);
    if (enabledPlugins[`${pluginName}@${marketName}`] !== true) return;
    const manifest = readJson(path.join(root, '.claude-plugin', 'plugin.json')) || {};
    const resolve = rel => path.join(root, rel.replace(/^\.\//, ''));
    let agents = (manifest.agents || []).map(resolve);
    if (!agents.length && fs.existsSync(path.join(root, 'agents'))) {
      agents = fs.readdirSync(path.join(root, 'agents'))
        .filter(f => f.endsWith('.md')).map(f => path.join(root, 'agents', f));
    }
    let skills = (manifest.skills || []).map(rel => path.join(resolve(rel), 'SKILL.md'));
    if (!skills.length && fs.existsSync(path.join(root, 'skills'))) {
      skills = fs.readdirSync(path.join(root, 'skills'))
        .map(d => path.join(root, 'skills', d, 'SKILL.md')).filter(fs.existsSync);
    }
    const chars = [...agents, ...skills].reduce((a, f) => a + frontmatterWeight(f), 0);
    agentDefs += agents.length;
    skillDefs += skills.length;
    prefixChars += chars;
    plugins.push({ name, agents: agents.length, skills: skills.length, prefixTokens: Math.round(chars / 4) });
  });

  // Root `effortLevel` / `env.EFFORT_LEVEL` is a fallback default; per-model
  // overrides live at `modelSettings.<model>.effortLevel` and take precedence
  // when reporting, since a model with its own entry is not using the root
  // default. Sorted by model name for stable output.
  const modelSettings = settings.modelSettings || {};
  const modelEffort = Object.keys(modelSettings)
    .filter(m => modelSettings[m] && modelSettings[m].effortLevel)
    .sort()
    .map(m => ({ model: m, effortLevel: modelSettings[m].effortLevel }));

  const mcpServers = mcpConfig(SCOPE_DIR);

  return {
    model: settings.model || '(unset — harness default)',
    cleanupPeriodDays: settings.cleanupPeriodDays,
    effortLevel: settings.effortLevel || (settings.env && settings.env.EFFORT_LEVEL) || null,
    modelEffort,
    pluginCount: plugins.length,
    agentDefs,
    skillDefs,
    prefixTokens: Math.round(prefixChars / 4),
    plugins: plugins.sort((a, b) => b.prefixTokens - a.prefixTokens),
    mcpServers,
    mcpPrefixTokens: mcpServers.length * MCP_SERVER_TOKENS,
  };
}

// ------------------------------------------------------------------- flags
const DAY = 86400e3;
// LONG_AGENT thresholds (design decision Q5) — Slice 15 HITL decision, re-tuned on real,
// deduped, all-history data (see REFERENCE.md "LONG_AGENT" for the percentiles).
const LONG_AGENT_TURNS = 150; // "over N turns" -> strictly greater than N
const LONG_AGENT_CTX = 400e3; // "peak context > 400k" -> strictly greater than
// LONG_SESSION threshold (Slice 15 HITL decision) — main threads only; a long
// subagent is LONG_AGENT's job instead (the two flags used to double-count the
// same sessions). See REFERENCE.md "LONG_SESSION".
const LONG_SESSION_TURNS = 200; // ">= N turns" on a main (non-subagent) session fires
// POLLING threshold (design decision Q9) — Slice 15 HITL decision, re-tuned on real data.
const POLL_MIN_CALLS = 10; // same command key >= N calls in one session
// Categories whose repeat is a wait. A repeated test run, commit or edit is
// the work itself, not polling (Slice 11 real-data check: those were most of
// the false positives). `script run` (Slice 15) is deliberately excluded too:
// a re-run of the same script while iterating is work, not a wait — see
// REFERENCE.md "POLLING".
const POLL_CATEGORIES = new Set(['wait/poll', 'github', 'read', ACTIVITY_OTHER]);
// Unquoted absolute paths left in a key (`O=/c/Users/me/…`, `{ cd /home/me/p; … }`,
// `type C:\Users\me\x`, `>/home/me/out.log`, `2>/home/me/err.log`,
// `-d @/c/Users/me/x`, `PATH=$PATH:/home/me/bin`, `scp host:/home/me/x`,
// `file:///home/me/x`, `~/me.log`, `~me/x/y`) → <path>, so redactPaths() aims
// to keep a printed key from carrying a user or project name. Trigger chars:
// start/space/`=`/`(`/quote/backtick (existing) plus `>`, `<`, `@` and `:`
// not immediately followed by `//` (scp/env/redirect targets). Still needs
// two separators after the trigger (`/c/x`, not `//FI`), so an http(s) URL
// stays readable (its `//` follows `:` with nothing between). `~`/`~user`
// need only one separator (the `~` itself signals a path). `file://` is
// redacted despite the `//`, since it names a local file, not a web
// resource. A Users/home path (`C:\Users\<name>`, `/c/Users/<name>`, …) gets
// its own rules below, because its name segment may contain a space (Explorer
// displays "First Last") and ABS_PATH stops at whitespace. Emails
// (`user@host.tld`) are redacted separately — a path trigger char never precedes them.
// (?<![\w.+-]) anchors the match to the start of a [\w.+-] run: without it, `\b`
// re-attempts the whole alternation at every non-word char inside a long unbroken
// run (`a.a.a.a…`), which is O(n^2) on a pathological 200k-char input.
const EMAIL = /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
const FILE_URL = /\bfile:\/\/\/?[^\s'"`<>|;&()]*/gi;
// WIN_USERS_PATH: `C:\Users\<name>`, any case (`c:\users`, `C:\USERS`, `\Home\`),
// single or doubled (JSON/string-escaped) backslashes (`C:\\Users\\jdoe\\x`).
// The name segment accepts a literal or backslash-escaped space
// (`Petr Svarc` / `Petr\ Svarc`) but excludes shell metacharacters, so
// `C:\Users\jdoe | tee …` stops before the pipe instead of swallowing it.
const WIN_USERS_PATH =
  /[A-Za-z]:\\\\?(?:users|home)\\\\?(?:\\ |[^\\|;&()<>'"`])+(?:\\\\?[^\s\\'"`<>|;&()]*)*/gi;
// FWD_USERS_PATH: the forward-slash forms of the same path, any case —
// `/c/Users/<name>` (git-bash), `/mnt/c/Users/<name>` (WSL), `/home/<name>`,
// `/Users/<name>` (macOS) — after the same triggers as ABS_PATH, incl. `:` not
// followed by `//` (`PATH=$PATH:/home/…`, `scp host:/home/…`, and `C:/Users/<name>`,
// which becomes `C:<path>`), and
// inside a quoted string (`"see /c/Users/Petr Svarc/x"`) — the name segment stops
// at the next `/` or a quote, so the closing quote survives.
const FWD_USERS_PATH = new RegExp(
  /(^|[\s=(`'"<>@]|:(?!\/\/))\/(?:mnt\/)?(?:[A-Za-z]\/)?(?:users|home)\//.source +
  /(?:\\ |[^\/|;&()<>'"`])+(?:\/[^\s`'"|;&()<>]*)*/.source, 'gi');
const TILDE_PATH = /(^|[\s=(`'"<>@:])~[\w.-]*(?:[\\/][^\s`'"|;&()<>]*)?/g;
// A \ before $, " or a backtick is a shell escape (`echo \"\$PW\"`), not a path separator.
const PATH_SEP = /(?:\/|\\(?![$"`]))/.source;
const ABS_PATH = new RegExp(/(^|[\s=(`'"<>@]|:(?!\/\/))(?:[A-Za-z]:|~)?/.source + PATH_SEP +
  /[^\s\\/`'"|;&()<>]+/.source + PATH_SEP + /[^\s`'"|;&()<>]*/.source, 'g');
// Value layer: whatever the patterns above miss, the current user's own name is
// redacted to <user> wherever it appears — in any path spelling (`C:\Users\x`,
// `C:/Users/x`, `/c/Users/x`, `/mnt/c/Users/x`, `C:\\Users\\x`, `x\ y`), the Claude
// project-folder form (`C--Users-Petr-Svarc-proj`) or plain text, any case.
// Terms: the login name, the home folder's last segment and git `user.name`, each
// whole and split into parts on whitespace/`.`/`_`/`-`. A term is used only when
// ≥ ID_MIN_LEN chars and not a generic account name (ID_GENERIC), and matches only
// as a whole word (not inside `Petrol`), so short or common names don't over-redact.
// Accents are folded on both sides (NFD, combining marks dropped): `Svarc` also
// redacts `Švarc` in NFC or NFD form, and an accented git name redacts its plain spelling.
const ID_MIN_LEN = 3;
const ID_GENERIC = new Set(['user', 'users', 'home', 'root', 'admin', 'administrator',
  'public', 'default', 'guest', 'owner', 'runner', 'ubuntu']);
const ID_EDGE = '[\\p{L}\\p{N}]';
function identityPattern({ username = '', home = '', name = '' } = {}) {
  const base = String(home).split(/[\\/]+/).filter(Boolean).pop() || '';
  const terms = new Set();
  for (const s of [username, base, name]) {
    for (const t of [s, ...String(s).split(/[\s._-]+/)]) {
      const w = foldText(String(t)).trim().toLowerCase();
      if (w.length >= ID_MIN_LEN && !ID_GENERIC.has(w)) terms.add(w);
    }
  }
  if (!terms.size) return null;
  const alt = [...terms].sort((a, b) => b.length - a.length)
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(?<!${ID_EDGE})(?:${alt})(?!${ID_EDGE})`, 'giu');
}
const foldText = t => t.normalize('NFD').replace(/\p{M}/gu, '');
// Accent-folded copy u of s and pos[k] = index in s that u[k] comes from
// (pos[u.length] = s.length), so a match on u maps back onto s. One pass per code point.
function foldAccents(s) {
  let u = '';
  const pos = [];
  for (let i = 0; i < s.length;) {
    const n = s.codePointAt(i) > 0xffff ? 2 : 1;
    const f = foldText(s.slice(i, i + n));
    for (let j = 0; j < f.length; j++) pos.push(i);
    u += f;
    i += n;
  }
  pos.push(s.length);
  return { u, pos };
}
function redactIdentity(s, id) {
  if (/^[\x00-\x7f]*$/.test(s)) return s.replace(id, '<user>');
  const { u, pos } = foldAccents(s);
  let out = '', at = 0;
  for (const m of u.matchAll(id)) {
    out += s.slice(at, pos[m.index]) + '<user>';
    at = pos[m.index + m[0].length];
  }
  return out + s.slice(at);
}
// The machine's identity, read once on first use (git only if a key is redacted).
let machineIdentity = null;
function currentIdentity() {
  if (machineIdentity) return machineIdentity;
  const os = require('os');
  let username = '', name = '';
  try { username = os.userInfo().username; } catch { /* no passwd entry */ }
  try {
    name = require('child_process').execFileSync('git', ['config', 'user.name'],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch { /* no git or no user.name */ }
  return (machineIdentity = { username, home: os.homedir(), name });
}
// Secret layer (runs first): a credential typed or pasted into a command → <secret>,
// so a secret repeated in ≥ 20 calls (POLLING) or ≥ 5 sessions (BOILERPLATE) never
// prints. commandKey() already turned digits into N, so shapes allow any word char.
// A value that is a reference (`$VAR`, `${VAR}`, `$(…)`) is not a secret and stays;
// a single-quoted `'$foo'` is a shell literal (no expansion), not a reference.
// Every pattern starts at the start of a run (lookbehind) and bounds its name part,
// so a 200k-char run can't make it quadratic. See REFERENCE.md "POLLING".
const TOK_CHAR = '(?:[\\w-]|<id>)';
const SECRET_SHAPE = new RegExp('(?<![\\w-])(?:gh[opsu]_|github_pat_|sk-|xox[bpas]-)' +
  `${TOK_CHAR}{12,}|(?<![\\w-])AKIA[A-Z0-9]{8,}|(?<![\\w-])eyJ${TOK_CHAR}{4,}\\.${TOK_CHAR}{4,}\\.${TOK_CHAR}*`, 'g');
// header `Name: [scheme ]value` — Authorization, Cookie, *Token / *Api-Key / *Secret
// headers. Value runs to the next quote/backtick/newline (not just whitespace), so
// `Cookie: a=1; b=Zqxv` redacts the whole header, not just its first `;`-pair.
const SECRET_HEADER = new RegExp(
  /(?<![\w-])((?:Proxy-)?Authorization|Cookie|[\w-]{0,40}?(?:Token|Api-?Key|Secret)):/.source +
  /([ \t]*)((?:Bearer|Basic|Token|Digest)[ \t]+)?([^\n'"`]{0,512})/.source, 'gi');
const SECRET_BEARER = /(?<![\w-])(Bearer[ \t]+)([^\s'"`]+)/gi;
// `-u`/`--user user:pass` — pass may be `"…"`/`'…'` with spaces, redacted whole.
const SECRET_USERPASS = new RegExp(/(?<![\w-])(-u|--user)([ \t]+|=)/.source +
  '(?:' + /"([^"\n]{0,256}):([^"\n]{0,256})"/.source + '|' + /'([^'\n]{0,256}):([^'\n]{0,256})'/.source +
  '|' + /(['"]?)([^\s'"`:]{0,256}):([^\s'"`]+)/.source + ')', 'g');
const SECRET_FLAG_WORD =
  /password|passwd|passphrase|pwd|token|secret|api[-_]?key|access[-_]?key|private[-_]?key|creds?|bearer/;
// `--flag value` where flag name carries a credential word — value may be `"…"`/`'…'`
// with spaces, redacted whole (not just its first word).
const SECRET_FLAG = new RegExp(`(?<![\\w-])(--?[\\w-]{0,40}?(?:${SECRET_FLAG_WORD.source})[\\w-]{0,40})` +
  /(=|[ \t]+)(?:"([^"\n]{0,512})"|'([^'\n]{0,512})'|(['"]?)([^\s'"`<>|;&()]+))/.source, 'gi');
// Shared lookahead: only at a name that looks like a credential (also `export …`,
// `$env:…`, `?access_token=`). Starts after start/space/separator/quote/`?`/`:`
// only, so `s/^password=//p` stays; bounds the name so a 200k run stays linear.
const SECRET_NAME_LA = /(?<=^|[\s;&|(?"'`:])(?=\w{0,63}?(?:token|key|secret|pass|pwd|auth|cred))/.source;
// `NAME=value` where NAME looks like a credential.
const SECRET_ASSIGN = new RegExp(SECRET_NAME_LA +
  /([A-Za-z_]\w{0,63})([ \t]?=[ \t]?)("[^"\n]{0,512}"|'[^'\n]{0,512}'|[^\s'"`;&|()<>]+)/.source, 'gi');
const SECRET_URL_CRED = /(\/\/[^\s/:@'"`]{1,256}):([^\s/@'"`]{1,256})@/g;
// A secret-named assignment whose value is a literal `echo`/`printf` (no `|`, so a
// real fetch like `$(printf … | git credential fill)` is untouched).
const SECRET_CMD_LITERAL = new RegExp(SECRET_NAME_LA +
  /([A-Za-z_]\w{0,63}[ \t]?=[ \t]?\$\((?:echo|printf)[ \t]+)([^|()]{0,512})(\))/.source, 'gi');
// Secret-named JSON key: `"password":"x"`, `{"token": "x"}`. Key part bounded like a
// flag name, so a long run of `"` in a 200k-char input stays linear.
const SECRET_JSON = new RegExp(
  `"(\\w{0,40}?(?:${SECRET_FLAG_WORD.source})\\w{0,40})"([ \\t]*:[ \\t]*)"([^"\\n]{0,512})"`, 'gi');
// `gh secret set NAME --body X` / `-b X` / `-bX` / `-b'X'` (short form, attached too).
const SECRET_GH_BODY = new RegExp(
  '(' + /(?<![\w-])gh[ \t]+secret[ \t]+set\b[^\n]{0,100}?/.source +
  /(?:(?<![\w-])--body(?:=|[ \t]+)|(?<![\w-])-b(?:=|[ \t]+)?)/.source + ')' +
  /(?:"([^"\n]{0,512})"|'([^'\n]{0,512})'|([^\s'"`<>|;&()]+))/.source, 'gi');
// npm's `:_authToken TOKEN` (space form; the `=` form is already SECRET_ASSIGN).
const SECRET_NPM_AUTHTOKEN = /(?<![\w-])(:_authToken)([ \t]+)([^\s'"`]+)/gi;
// A value is a reference — `$VAR`, `${VAR}`, `$(…)`, unquoted or double-quoted —
// and stays. A single-quoted value (`'$foo'`) is a shell literal: no expansion,
// so a single-quoted `quote` always redacts, regardless of the value's text.
const isRef = (v, quote) => (quote === "'" ? false : /^\$/.test(v) || /^"\$/.test(v));
const firstDefined = (...vs) => vs.find(v => v !== undefined);
// `mysql -pX` / `sshpass -p X` / `docker login -p X` — not a regex but a small token
// scan per command segment (split at `;` `&` `|` `(` `)` backtick newline), so `-p`
// is a password only inside that command: `mkdir -p a`, `ssh -p 22 host` and a later
// `ssh -p N` in another segment (or the command sshpass wraps) stay readable, every
// password occurrence in the segment redacts, and all other tokens are kept byte for
// byte. `-p` is case-sensitive (`mysql -P 3306` is the port). mysql's password is
// attached only (`-pX`) — `mysql -p db` is the prompt form, not a secret. One pass
// over the words, plus one re-scan of each quoted part's inside (`bash -c "mysql -pX"`,
// `--cmd="…"`, `\"` unescaped) up to SHORT_P_DEPTH levels, so a 200k-char run stays linear.
const SHORT_P_DEPTH = 4;
const SHORT_P_BREAK = new Set([';', '&', '|', '(', ')', '`', '\n']);
const SHORT_P_SPACE = new Set([' ', '\t', '\r']);
const MYSQL_CMD = /^(?:mysql|mysqldump|mysqladmin|mariadb)$/;
// Words of s as { start, end, brk } spans: quotes group, `\` escapes, and a segment
// break is its own one-char word with brk: true.
function shellWords(s) {
  const words = [];
  let i = 0;
  while (i < s.length) {
    if (SHORT_P_SPACE.has(s[i])) { i++; continue; }
    if (SHORT_P_BREAK.has(s[i])) { words.push({ start: i, end: ++i, brk: true }); continue; }
    const start = i;
    while (i < s.length && !SHORT_P_SPACE.has(s[i]) && !SHORT_P_BREAK.has(s[i])) {
      const q = s[i++];
      if (q === '\\') i++;
      else if (q === '"' || q === "'") {
        while (i < s.length && s[i] !== q) i += q === '"' && s[i] === '\\' ? 2 : 1;
        i++;
      }
    }
    words.push({ start, end: Math.min(i, s.length), brk: false });
  }
  return words;
}
// End of the quoted part opening at s[i] (index of its closing quote, or `end` when
// unterminated — it then runs to the end); `\` escapes inside double quotes only.
function quoteEnd(s, i, end) {
  const q = s[i];
  let j = i + 1;
  while (j < end && s[j] !== q) j += q === '"' && s[j] === '\\' ? 2 : 1;
  return Math.min(j, end);
}
// Secret [a, b) ranges of a `-p` value v: the text of each quoted or bare part up to an
// unquoted `<`/`>` (a redirect); quotes and the redirect stay as typed. None when v is
// a reference (`$X`, `"$X"`) — a single-quoted `'$X'` is a literal and redacts.
function passwordRanges(v) {
  const ranges = [];
  for (let i = 0; i < v.length && v[i] !== '<' && v[i] !== '>';) {
    const q = v[i] === '"' || v[i] === "'" ? v[i] : '';
    let a = i, b;
    if (q) { a = i + 1; b = quoteEnd(v, i, v.length); i = b + 1; } else {
      b = i;
      while (b < v.length && !'"\'<>'.includes(v[b])) b += v[b] === '\\' ? 2 : 1;
      i = b = Math.min(b, v.length);
    }
    const inner = v.slice(a, b);
    if (isRef(inner, q || undefined)) continue; // a reference part stays, a literal one redacts
    if (inner && inner !== '<secret>') ranges.push([a, b]);
  }
  return ranges;
}
// Double-quoted text with `\"` `\\` `\$` `` \` `` unescaped, and pos[k] = index in t
// where u[k]'s source starts (pos[u.length] = t.length), to map edits back.
function unescapeDq(t) {
  const out = [], pos = [];
  for (let i = 0; i < t.length; i++) {
    pos.push(i);
    if (t[i] === '\\' && i + 1 < t.length && '"\\$`'.includes(t[i + 1])) i++;
    out.push(t[i]);
  }
  pos.push(t.length);
  return { u: out.join(''), pos };
}
// Command name of a word: quotes dropped (`& "C:\…\mysql.exe"`), dir and .exe stripped.
const cmdName = w => w.replace(/["']/g, '').split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase();
function redactShortP(s) {
  let out = '', at = 0;
  for (const [a, b, r] of shortPEdits(s, 0)) { out += s.slice(at, a) + r; at = b; }
  return out + s.slice(at);
}
// Sorted [start, end, replacement] edits of s.
function shortPEdits(s, depth) {
  const words = shellWords(s), edits = [];
  const text = w => s.slice(w.start, w.end);
  const word = j => (j < words.length && !words[j].brk ? text(words[j]) : null);
  const redact = (from, v) => { for (const [a, b] of passwordRanges(v)) edits.push([from + a, from + b, '<secret>']); };
  // `-pX` (attached, `-p=X` too) at word j, or `-p X` taking word j+1; → words used.
  const password = (j, spaced) => {
    const t = text(words[j]), eq = t[2] === '=' ? 1 : 0;
    if (t.length > 2) { redact(words[j].start + 2 + eq, t.slice(2 + eq)); return 1; }
    const v = spaced ? word(j + 1) : null;
    if (v === null) return 1;
    redact(words[j + 1].start, v);
    return 2;
  };
  // Each quoted part of word w is shell text too (`bash -c "…"`, `--cmd="…"`): scan inside.
  const nested = w => {
    for (let j = w.start; j < w.end;) {
      if (s[j] === '\\') { j += 2; continue; }
      if (s[j] !== '"' && s[j] !== "'") { j++; continue; }
      const a = j + 1, b = quoteEnd(s, j, w.end);
      if (b > a && depth < SHORT_P_DEPTH) {
        const { u, pos } = s[j] === '"' ? unescapeDq(s.slice(a, b)) : { u: s.slice(a, b), pos: null };
        for (const [x, y, r] of shortPEdits(u, depth + 1)) {
          edits.push([a + (pos ? pos[x] : x), a + (pos ? pos[y] : y), r]);
        }
      }
      j = b + 1;
    }
  };
  let mode = null; // 'mysql' | 'docker': rest of this segment is that command's args
  for (let i = 0; i < words.length; i++) {
    const w = words[i], t = text(w);
    if (w.brk) { mode = null; continue; }
    if (mode && t.startsWith('-p')) { i += password(i, mode === 'docker') - 1; continue; }
    nested(w);
    const name = cmdName(t);
    if (MYSQL_CMD.test(name)) mode = 'mysql';
    else if (name === 'docker' && word(i + 1) === 'login') { mode = 'docker'; i++; }
    else if (name === 'sshpass') {
      // sshpass's own options, up to the command it wraps (whose `-p` is its own).
      let j = i + 1;
      for (let o = word(j); o !== null && o.startsWith('-'); o = word(j)) {
        if (o.startsWith('-p')) j += password(j, true);
        else j += o === '-f' || o === '-d' || o === '-P' ? 2 : 1;
      }
      i = Math.min(j, words.length) - 1;
    }
  }
  return edits;
}
function redactSecrets(s) {
  return redactShortP(s
    .replace(SECRET_URL_CRED, '$1:<secret>@')
    .replace(SECRET_SHAPE, '<secret>')
    .replace(SECRET_HEADER, (m, name, sp, scheme = '', v, off, str) => {
      const quote = str[off + m.length] === "'" ? "'" : undefined;
      return isRef(v, quote) ? m : `${name}:${sp}${scheme}<secret>`;
    })
    .replace(SECRET_BEARER, (m, b, v, off, str) => {
      const quote = str[off + m.length] === "'" ? "'" : undefined;
      return isRef(v, quote) ? m : `${b}<secret>`;
    })
    .replace(SECRET_USERPASS, (m, f, sep, dqU, dqP, sqU, sqP, lq, bareU, bareP) => {
      const user = firstDefined(dqU, sqU, bareU), v = firstDefined(dqP, sqP, bareP);
      const quote = dqU !== undefined ? '"' : sqU !== undefined ? "'" : undefined;
      const q = quote || lq || '';
      return isRef(v, quote) || isRef(q + user, quote) ? m : `${f}${sep}${q}${user}:<secret>${q}`;
    })
    .replace(SECRET_FLAG, (m, f, sep, dq, sq, lq, bare) => {
      const v = firstDefined(dq, sq, bare);
      const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : undefined;
      const q = quote || lq || '';
      return isRef(v, quote) || v === '<secret>' ? m : `${f}${sep}${q}<secret>${q}`;
    })
    .replace(SECRET_ASSIGN, (m, name, eq, v) => (isRef(v) || v === '<secret>' ? m : `${name}${eq}<secret>`))
    .replace(SECRET_CMD_LITERAL, (m, pre, v, close) => (isRef(v) ? m : `${pre}<secret>${close}`))
    .replace(SECRET_JSON, (m, k, sep, v) => (isRef(v) || v === '<secret>' ? m : `"${k}"${sep}"<secret>"`))
    .replace(SECRET_GH_BODY, (m, pre, dq, sq, bare) => {
      const v = firstDefined(dq, sq, bare);
      const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : undefined;
      const q = quote || '';
      return isRef(v, quote) ? m : `${pre}${q}<secret>${q}`;
    })
    .replace(SECRET_NPM_AUTHTOKEN, (m, f, sep, v) => (isRef(v) ? m : `${f}${sep}<secret>`)));
}
const idPatterns = new WeakMap();
// identity = { username, home, name } — injectable for tests; defaults to this machine.
// Layers in order: secrets, then paths/emails, then this user's name (value layer).
function redactPaths(key, identity = currentIdentity()) {
  if (!idPatterns.has(identity)) idPatterns.set(identity, identityPattern(identity));
  const id = idPatterns.get(identity);
  const out = redactSecrets(key)
    .replace(EMAIL, '<email>')
    .replace(FILE_URL, '<path>')
    .replace(WIN_USERS_PATH, '<path>')
    .replace(FWD_USERS_PATH, '$1<path>')
    .replace(TILDE_PATH, '$1<path>')
    .replace(ABS_PATH, '$1<path>');
  return id ? redactIdentity(out, id) : out;
}
// Polling runs in this window: Bash/PowerShell calls of a POLL_CATEGORIES
// category, grouped per session (sessionKey) by commandKey; a group of
// >= POLL_MIN_CALLS calls is a run. cost = 1/n of each n-call turn (as in
// activity()), share = of window spend; most expensive run first.
// `groups[].key` is path-redacted. `groups[].parent` is the parent sid for a
// subagent group (null for a main session), since one subagent id spawned
// under two different parents is two groups sharing the same `sid`.
// See REFERENCE.md "POLLING".
function polling(rows) {
  const groups = new Map();
  let total = 0;
  for (const r of rows) {
    total += r.cost;
    for (const c of r.calls) {
      if (!SHELL_TOOLS.has(c.tool) || !POLL_CATEGORIES.has(categorize(c))) continue;
      const id = sessionKey(r) + '\u0000' + c.key;
      const g = groups.get(id) ||
        { sid: r.sid, parent: r.isSub ? r.parent : null, key: redactPaths(c.key), count: 0, cost: 0 };
      g.count++;
      g.cost += r.cost / r.calls.length; // 1/n of the turn, as in activity()
      groups.set(id, g);
    }
  }
  return [...groups.values()].filter(g => g.count >= POLL_MIN_CALLS)
    .map(g => ({ ...g, share: total ? g.cost / total : 0 }))
    .sort((a, b) => b.cost - a.cost || b.count - a.count);
}
// BOILERPLATE threshold (design decision Q9) — provisional, Slice 15 re-tunes it.
const BOILER_MIN_SESSIONS = 5; // same setup prefix in >= N distinct sessions
// Setup prefixes of a command key: each top-level segment of its leading run of
// variable assignments (`NAME=…`, `export NAME=…`, PowerShell `$env:NAME=…`), when a
// non-assignment segment follows the run — the setup a command needs before it can
// run (`TOKEN=$(… | git credential fill …) && curl …`, `export PYTHONIOENCODING=…
// && python …`). Each assignment is its own prefix, so `export X=… && TOKEN=$(…) &&
// curl` groups its fetch with a bare `TOKEN=$(…) && curl`. A value that is only a path
// (`S=<path>`, `S=/c/…/scratchpad`, `F="$HOME/x"`) is a shorthand for a location, not a
// missing tool → skipped (the run goes on past it).
// Real-data numbers and the definitions that were tried: REFERENCE.md "BOILERPLATE".
const SETUP_ASSIGN = /^((?:export |\$env:)?[A-Za-z_]\w* ?= ?)(.*)$/s;
const VAR_ROOTED_PATH = /^(?:<path>|\$\{?\w+\}?)(?:[\\/]|$)/;
const unquote = v => v.replace(/^(["'])(.*)\1$/s, '$2');
function setupPrefixes(key) {
  const segs = shellSegments(key);
  const out = [];
  let i = 0;
  for (; i < segs.length; i++) {
    const m = SETUP_ASSIGN.exec(segs[i].text);
    if (!m) break;
    const value = unquote(m[2]);
    if (value && !isPathText(value) && !VAR_ROOTED_PATH.test(value)) out.push(segs[i].text);
  }
  return i < segs.length ? [...new Set(out)] : [];
}
// Printed form of a setup prefix: a literal value (not `$(…)` / `$VAR` / `${VAR}`) may
// be a pasted secret, so it prints as `NAME=<value>`; any other value goes through
// redactPaths() (secret, path and name layers). Grouping stays on the raw prefix.
function showPrefix(prefix) {
  const m = SETUP_ASSIGN.exec(prefix);
  return m && !/^\$[({\w]/.test(unquote(m[2])) ? `${m[1]}<value>` : redactPaths(prefix);
}
// Boilerplate prefixes in this window: Bash/PowerShell calls grouped by each of
// their setupPrefixes() (raw, unredacted) over all sessions (sessionKey); a prefix
// seen in >= BOILER_MIN_SESSIONS sessions is a hit. Per group: turns = distinct turns
// with the prefix; cost = k/n of a turn with k of its n calls carrying it (as in
// activity()); share = of window spend. Top-level cost/share count a call once even
// when it carries two hit prefixes. `groups[].prefix` = showPrefix(); most
// expensive first. See REFERENCE.md "BOILERPLATE".
function boilerplate(rows) {
  const groups = new Map();
  const calls = []; // [prefixes, cost part] per call with a setup prefix
  let total = 0;
  for (const r of rows) {
    total += r.cost;
    for (const c of r.calls) {
      const ps = SHELL_TOOLS.has(c.tool) ? setupPrefixes(c.key) : [];
      if (!ps.length) continue;
      const part = r.cost / r.calls.length;
      calls.push([ps, part]);
      for (const p of ps) {
        const g = groups.get(p) || { prefix: p, sessions: new Set(), turns: new Set(), cost: 0 };
        g.sessions.add(sessionKey(r));
        g.turns.add(r);
        g.cost += part;
        groups.set(p, g);
      }
    }
  }
  const hits = [...groups.values()].filter(g => g.sessions.size >= BOILER_MIN_SESSIONS);
  const hit = new Set(hits.map(g => g.prefix));
  const cost = calls.reduce((a, [ps, part]) => a + (ps.some(p => hit.has(p)) ? part : 0), 0);
  return { cost, share: total ? cost / total : 0, groups: hits
    .map(g => ({ prefix: showPrefix(g.prefix), sessions: g.sessions.size, turns: g.turns.size,
      cost: g.cost, share: total ? g.cost / total : 0 }))
    .sort((a, b) => b.cost - a.cost || b.sessions - a.sessions || (a.prefix < b.prefix ? -1 : 1)) };
}
// ------------------------------------------------------------ GitHub polling
// GH_POLLING threshold (Slice 31, HITL-set final value — see REFERENCE.md "GH_POLLING"
// threshold" for the percentile data behind it). One endpoint shape with >= N read calls
// summed over every session and subagent in the window fires, however few of them land
// in any one session.
const GH_POLL_MIN_CALLS = 20;
// Same two categories Slice 15 considered for a per-session any-key count: a status poll
// (`check-runs`, `actions/runs`, `gh pr checks`, `gh run view`) is wait/poll, any other
// `api.github.com` / `gh` call is github. Everything else (git push, plain sleep) never counts.
const GH_POLL_CATEGORIES = new Set(['wait/poll', 'github']);
// GH_POLLING counts state QUERIES only (HITL decision): a call that changes state is excluded,
// even though its category is still wait/poll or github. Keeps `gh pr create`/`gh pr merge`
// spam from ever tripping the flag. The HTTP-level test runs on ONE command occurrence's own
// argv (argWords() + walkArgs()), never on raw text: a flag-shaped string inside another
// option's value (`-H 'X: -d'`) or inside a different command is never read as a flag, and
// curl rules apply only to `curl`, `gh api` rules only to `gh api`.
const GH_WRITE_HTTP = /^(?:post|put|patch|delete)$/i;
// curl short options that take a value — case-sensitive (`-X` is the method, `-x` `--proxy`;
// `-d` a body, `-D` `--dump-header`). One of them ends a combined cluster: `-sXPOST` is
// `-s -X POST`, `-sd q` is `-s -d q`.
const CURL_SHORT_VAL = new Set('AbcCdDeEFHKmoPQrtTuUwxXyYz');
// curl long options that take the next word as their value (`--name=value` always carries it).
const CURL_LONG_VAL = new Set(('--data --data-raw --data-binary --data-ascii --data-urlencode --json ' +
  '--form --form-string --header --request --url --url-query --output --output-dir --user-agent --user ' +
  '--cookie --cookie-jar --max-time --connect-timeout --retry --retry-delay --retry-max-time --write-out ' +
  '--proxy --proxy-user --referer --cert --key --cacert --capath --config --range --upload-file ' +
  '--dump-header --resolve --connect-to --limit-rate --max-filesize --max-redirs --oauth2-bearer ' +
  '--variable --interface --continue-at --time-cond --speed-limit --speed-time --trace --trace-ascii ' +
  '--stderr --unix-socket --proxy-header --aws-sigv4 --request-target --doh-url --dns-servers --noproxy ' +
  '--preproxy --socks4 --socks4a --socks5 --socks5-hostname --proxy-cacert --proxy-cert --proxy-key ' +
  '--proxy-pass --proxy-service-name --cert-type --key-type --ciphers --pass --pinnedpubkey --pubkey ' +
  '--crlfile --tls-max --tlsuser --tlspassword --proto --proto-redir --proto-default --netrc-file ' +
  '--local-port --keepalive-time --expect100-timeout --happy-eyeballs-timeout-ms --parallel-max --rate ' +
  '--create-file-mode --etag-compare --etag-save --hsts --alt-svc --login-options --sasl-authzid ' +
  '--service-name --delegation --mail-from --mail-rcpt --mail-auth --ftp-port --ftp-account ' +
  '--ftp-method --ftp-alternative-to-user --hostpubmd5 --hostpubsha256 --krb --ech --ipfs-gateway ' +
  '--trace-config --engine --random-file --egd-file').split(' '));
// curl upload options: an implicit PUT (a write) unless an explicit `-X`/`--request` says otherwise.
const CURL_UPLOAD = new Set(['-T', '--upload-file']);
// curl request-body options: an implicit POST unless `-G`/`--get` turns them into a query string.
const CURL_BODY = new Set(('-d -F --data --data-raw --data-binary --data-ascii --data-urlencode --json ' +
  '--form --form-string').split(' '));
// `gh api` options that take a value (pflag: `-XGET` fused or `-X GET`, `--method=GET` or spaced).
const GH_API_SHORT_VAL = new Set('XHfFqtp');
const GH_API_LONG_VAL = new Set(('--method --header --raw-field --field --jq --template --input ' +
  '--preview --hostname --cache').split(' '));
// `gh api` field flags: form/JSON body fields, an implicit POST unless the method says otherwise.
const GH_API_FIELDS = new Set(['-f', '-F', '--field', '--raw-field']);
// `gh <group> <verb>` verbs that write; anything else in a whitelisted GH_GROUPS command is
// a query (`checks`, `view`, `watch`, `list`, `status`, `diff`, …), so an unlisted verb
// defaults to read rather than needing its own whitelist entry. `run`/`set`/`fork` write
// only for the groups that actually have them (`gh workflow run`, `gh secret|variable set`,
// `gh repo fork`); no other whitelisted group has that verb.
const GH_WRITE_VERBS = new Set(('create merge close delete edit comment reopen lock unlock transfer review ' +
  'approve ready draft rerun cancel sync upload pin unpin disable enable request-review run set fork')
  .split(' '));
// Privacy: the word after `gh <group>` is free text in real use
// (a branch name for `gh browse`, a mistyped repo name, an issue title, …) unless it is one
// of these known read verbs for that group — anything else becomes `*`, in text and in
// `--json groups[]`. A group missing here always prints `*` (its own next word is never a
// verb). A write verb (GH_WRITE_VERBS) is excluded before this table is consulted, so it
// only ever needs to list reads.
const GH_GROUP_VERBS = {
  pr: new Set('checks view status list diff'.split(' ')),
  issue: new Set('view status list'.split(' ')),
  run: new Set('view watch list'.split(' ')),
  workflow: new Set('view list'.split(' ')),
  repo: new Set('view list'.split(' ')),
  release: new Set('view list'.split(' ')),
  gist: new Set('view list'.split(' ')),
  label: new Set('list'.split(' ')),
  project: new Set('view list'.split(' ')),
  org: new Set('list'.split(' ')),
  secret: new Set('list'.split(' ')),
  variable: new Set('list'.split(' ')),
  ruleset: new Set('view list'.split(' ')),
  search: new Set('commits issues prs repos code'.split(' ')),
  auth: new Set('status'.split(' ')),
};
// gh global/local flags that take a separate value token, skipped along with it when
// scanning past them for the group/verb words: `-R o/r`,
// `--repo o/r`, `--hostname h`, wherever they land — `gh -R o/r pr merge`, `gh pr --repo o/r
// merge`. Any other `-`-flag (`--json`, `-w`, `--repo=o/r`) is skipped alone.
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname']);
// First non-flag word after `gh` is the group; for `api` the rest is the path argument
// argv (parsed by ghApiCall()); for any other group, the next non-flag word after the group is
// the verb. Returns `{ group, verb }` or `{ group, restWords }` for `api`; either can be
// `undefined`/missing when the command has no more words.
function ghGroupVerb(words) {
  let i = 1;
  const skip = () => {
    while (i < words.length && words[i].startsWith('-')) i += GH_VALUE_FLAGS.has(words[i]) ? 2 : 1;
  };
  skip();
  const group = words[i] !== undefined ? words[i].toLowerCase() : undefined;
  if (group === undefined) return { group };
  i++;
  if (group === 'api') return { group, restWords: words.slice(i) };
  skip();
  const verb = words[i] !== undefined ? words[i].toLowerCase() : undefined;
  return { group, verb };
}
// Shape text for a non-`api` `gh <group> <verb>` call: the verb is only printed when it is
// a known word — that group's own read whitelist, or a write verb (GH_WRITE_VERBS, a bounded
// vocabulary too, e.g. `gh pr create`) — anything else (a branch
// name, a mistyped repo name, an issue title, …) falls back to `*`; no verb at all stays as
// just the group.
function ghGroupShape(group, verb) {
  if (verb === undefined) return `gh ${group}`;
  const known = (GH_GROUP_VERBS[group] && GH_GROUP_VERBS[group].has(verb)) || GH_WRITE_VERBS.has(verb);
  return `gh ${group} ${known ? verb : '*'}`;
}
// REST path words kept in a shape. Any other segment (owner, repo, PR number, SHA, branch,
// file path, `$VAR`, `<id>`) becomes `*`, so a shape never prints a name — only these words.
const GH_PATH_WORDS = new Set(('pulls commits check-runs check-suites actions runs jobs logs workflows ' +
  'artifacts attempts rerun cancel dispatches secrets variables merge reviews comments issues labels ' +
  'milestones assignees events timeline branches protection contents readme releases latest tags ' +
  'statuses status git refs heads trees blobs rulesets deployments environments hooks collaborators ' +
  'compare files requested_reviewers repos user users orgs teams members graphql repositories search ' +
  'code settings billing notifications gists forks stargazers topics languages pages rate_limit').split(' '));
// `gh` command groups kept in a shape (`gh pr checks`); an unknown word is not printed.
const GH_GROUPS = new Set(('alias api attestation auth browse cache codespace config copilot extension gist ' +
  'issue label org pr project release repo ruleset run search secret ssh-key status variable ' +
  'workflow').split(' '));
// One literal anchor, then one negated class up to the first char that can't be in a URL
// path in a shell key (whitespace, quote, `?`/`#`, shell metachar) — linear.
const GH_URL = /api\.github\.com(\/[^\s'"`?#|;&()\\]*)?/gi;
// Each command occurrence in a (possibly compound) key: the text from right after one
// markCommands() marker to right before the next — one per `&&`/`;`/`|`/subshell-opened
// command, wrapper words already collapsed into it. One negated class, linear; used to
// scope write detection to the ONE command it belongs to (a
// `grep -x post f && gh pr view` must not read `-x post` as this `gh`'s method flag).
const CMD_OCC = new RegExp(`${ANY_CMD}([^${NOT_CMD}]*)`, 'g');
function commandOccurrences(key) {
  return [...markCommands(String(key)).matchAll(CMD_OCC)].map(m => m[1]);
}
function githubPathShape(p) {
  let segs = p.split('/').filter(Boolean);
  if (!segs.length) return null;
  if (segs[0].toLowerCase() === 'repos') {
    if (segs.length <= 3) return 'repos/*'; // the repository itself (metadata, settings)
    segs = segs.slice(3); // owner/repo are never printed
  }
  const out = [];
  for (const s of segs) {
    const w = GH_PATH_WORDS.has(s.toLowerCase()) ? s.toLowerCase() : '*';
    if (w !== '*' || out[out.length - 1] !== '*') out.push(w);
  }
  return out.join('/');
}
// One command occurrence → its shell words, quotes removed: `'…'`/`"…"` group (whitespace and
// newlines inside stay in the word). As in bash, inside `"…"` a backslash escapes only `"`, `\`,
// `$`, a backtick or a newline (dropped) and otherwise stays; inside `'…'` nothing is escaped.
// Outside quotes a backslash escapes the next char and backslash-newline joins lines — except
// before a letter/digit, where it stays (a Windows path `C:\tools\curl.exe`; bash would only
// drop it). One pass, no regex — linear however many quotes; an unclosed quote runs to the end.
function argWords(s) {
  const out = [];
  let cur = null, q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = '';
      else if (q === '"' && c === '\\' && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1])) {
        if (s[++i] !== '\n') cur += s[i];
      } else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; if (cur === null) cur = ''; continue; }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (cur !== null) out.push(cur);
      cur = null;
      continue;
    }
    if (c === '\\' && i + 1 < s.length && !/[A-Za-z0-9]/.test(s[i + 1]) && s[++i] === '\n') continue;
    cur = (cur === null ? '' : cur) + s[i];
  }
  if (cur !== null) out.push(cur);
  return out;
}
// Walks a command's argv (the words after the command) the way curl and gh (pflag) parse it:
// a short cluster is split letter by letter until the first value-taking letter (`shortVal`),
// whose value is the rest of the cluster or else the next word (`-sXPOST`, `-sd q`); a long
// option's value is after `=` or, for `longVal` names, the next word. A value is consumed, never
// read as an option itself. Calls onOpt(name, value) per option, onArg(word) per positional.
function walkArgs(words, shortVal, longVal, onOpt, onArg = () => {}) {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === '--') { for (const a of words.slice(i + 1)) onArg(a); return; }
    if (w.startsWith('--')) {
      const eq = w.indexOf('=');
      const name = eq < 0 ? w : w.slice(0, eq);
      onOpt(name, eq >= 0 ? w.slice(eq + 1) : longVal.has(name) ? words[++i] : undefined);
    } else if (w.length > 1 && w[0] === '-') {
      for (let j = 1; j < w.length; j++) {
        if (!shortVal.has(w[j])) { onOpt(`-${w[j]}`); continue; }
        onOpt(`-${w[j]}`, j + 1 < w.length ? w.slice(j + 1) : words[++i]);
        break;
      }
    } else onArg(w);
  }
}
// curl's write test over its argv: an explicit `-X`/`--request` method (the last one) wins
// outright — POST/PUT/PATCH/DELETE write, anything else (GET, HEAD) reads even alongside a body;
// with no method, an upload (`-T`/`--upload-file`, implicit PUT) writes, and a body option
// (CURL_BODY) writes unless `-G`/`--get` is also present.
function isCurlWrite(args) {
  let method, body = false, get = false, upload = false;
  walkArgs(args, CURL_SHORT_VAL, CURL_LONG_VAL, (f, v) => {
    if (f === '-X' || f === '--request') method = v;
    else if (CURL_BODY.has(f)) body = true;
    else if (CURL_UPLOAD.has(f)) upload = true;
    else if (f === '-G' || f === '--get') get = true;
  });
  return method !== undefined ? GH_WRITE_HTTP.test(method) : upload || (body && !get);
}
// `gh api` argv (after `api`) → { path, isWrite }. Path = first positional; a full
// `https://api.github.com/…` URL keeps only its path; query/fragment dropped. An explicit
// `-X`/`--method` wins outright (POST/PUT/PATCH/DELETE write; GET reads even with fields or
// `--input`). Otherwise `graphql` writes only when an inline `query=` field value contains the
// word `mutation` (case-sensitive: `__type(name: "Mutation")` reads) — a `@file` or `$(…)`
// value's text is not visible, so it reads — and any other
// path writes on a field flag (GH_API_FIELDS) or `--input` (implicit POST).
function ghApiCall(args) {
  let method, path, body = false, mutation = false;
  walkArgs(args, GH_API_SHORT_VAL, GH_API_LONG_VAL, (f, v) => {
    // pflag drops one `=` after a shorthand: `-X=POST`, `-f=query=…` (curl has no such form).
    if (f.length === 2 && typeof v === 'string' && v[0] === '=') v = v.slice(1);
    if (f === '-X' || f === '--method') method = v;
    else if (f === '--input') body = true;
    else if (GH_API_FIELDS.has(f)) {
      body = true;
      const q = typeof v === 'string' && v.startsWith('query=') ? v.slice(6) : '';
      if (!/^[@$]/.test(q) && /\bmutation\b/.test(q)) mutation = true; // GraphQL keyword: lowercase
    }
  }, w => { if (path === undefined) path = w; });
  path = (path || '').replace(/^https?:\/\/api\.github\.com(?![^/?#])/i, '').split(/[?#]/)[0];
  const graphql = path.replace(/^\/+/, '').toLowerCase() === 'graphql';
  return { path, isWrite: method !== undefined ? GH_WRITE_HTTP.test(method) : graphql ? mutation : body };
}
// Any other command naming an `api.github.com` URL (wget, Invoke-RestMethod, …): a write only on
// an explicit write method option — `-X`/`--request`/`--method`/`-Method`, fused, `=`/`:` or next
// word.
function explicitWriteMethod(words) {
  for (let i = 0; i < words.length; i++) {
    const m = /^(?:-X|--request|--method|-Method)[=:]?(.*)$/i.exec(words[i]);
    if (m && GH_WRITE_HTTP.test(m[1] || words[i + 1] || '')) return true;
  }
  return false;
}
// One command occurrence (commandOccurrences()) → its GitHub shape(s) and whether each is a
// write, scoped to just that command. The command is its first `gh` / `curl` word (it need not
// open the occurrence: `until gh pr checks 12; do … done`). `gh api <path>` → the path's shape
// (write test = ghApiCall()); any other `gh` command → `gh <group> <verb>` (write test =
// GH_WRITE_VERBS, verb printed only if known — GH_GROUP_VERBS); an `api.github.com` URL in any
// other command → its REST path with ids, owner/repo, branches and paths collapsed to `*`
// (`commits/*/check-runs`, `pulls/*/merge`, `repos/*`; write test = isCurlWrite() for curl,
// explicitWriteMethod() otherwise). See REFERENCE.md "GH_POLLING".
function occurrenceGithub(occText) {
  const words = argWords(occText);
  // The command word by basename, `.exe` dropped: `/usr/bin/curl`, `C:\…\curl.exe`, `gh.exe` (a
  // URL ending in `/gh` is an argument, not the command).
  const base = w => (w.includes('://') ? '' : w.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, ''));
  const k = words.findIndex(w => base(w) === 'gh' || base(w) === 'curl');
  const cmd = k < 0 ? '' : base(words[k]);
  const gv = cmd === 'gh' ? ghGroupVerb(words.slice(k)) : {};
  if (gv.group === 'api') {
    const { path, isWrite } = ghApiCall(gv.restWords);
    return [{ shape: githubPathShape(path) || 'gh api', isWrite }];
  }
  const out = [];
  const write = cmd === 'curl' ? isCurlWrite(words.slice(k + 1)) : explicitWriteMethod(words);
  for (const m of occText.matchAll(GH_URL)) {
    const s = githubPathShape(m[1] || '');
    if (s) out.push({ shape: s, isWrite: write });
  }
  if (gv.group && GH_GROUPS.has(gv.group)) {
    out.push({ shape: ghGroupShape(gv.group, gv.verb), isWrite: GH_WRITE_VERBS.has(gv.verb) });
  }
  return out;
}
// Command key → the distinct GitHub endpoint shapes it calls, write and read alike (used
// where read/write doesn't matter, e.g. REFERENCE examples). See occurrenceGithub().
function githubShapes(key) {
  const out = new Set();
  for (const occ of commandOccurrences(key)) {
    for (const { shape } of occurrenceGithub(occ)) out.add(shape);
  }
  return [...out];
}
// Command key → only the shapes of its READ (non-write) occurrences — what GH_POLLING
// counts. A compound call mixing a read and a write (`until gh pr checks 12; do sleep 30;
// done && gh pr merge 12`, a curl check-runs loop next to `curl -X PUT …/merge`) keeps the
// read occurrence's shape and drops only the write one, instead
// of the whole call.
function githubReadShapes(key) {
  const out = new Set();
  for (const occ of commandOccurrences(key)) {
    for (const { shape, isWrite } of occurrenceGithub(occ)) if (!isWrite) out.add(shape);
  }
  return [...out];
}
// True when ANY occurrence in this key changes state rather than queries it (HITL decision,
// Slice 31) — an explicit write HTTP method, an implicit-POST curl body flag, or a `gh
// <group> <verb>` whose verb is in GH_WRITE_VERBS. No method/body flag and no matching verb
// defaults to a read. Scoped per occurrence, so an unrelated flag elsewhere in
// the same compound command (`grep -x post f && gh pr view`) can't false-positive this.
function isGhWrite(key) {
  for (const occ of commandOccurrences(key)) {
    if (occurrenceGithub(occ).some(o => o.isWrite)) return true;
  }
  return false;
}
// GitHub polling in this window: Bash/PowerShell calls of a GH_POLL_CATEGORIES category,
// grouped by githubReadShapes() over ALL sessions and subagents (sessionKey) — not per
// session like POLLING, so a few calls per subagent across many subagents add up. A shape
// with >= GH_POLL_MIN_CALLS calls is a hit. Per group: calls, sessions (main + subagent),
// subagents, cost = 1/n of each n-call turn (as in activity()), share = of window spend.
// Top-level totals count a call once even when it hits two shapes (or a read and a write in
// the same call — the write contributes no shape, so it never inflates the count). Most
// expensive first.
function ghPolling(rows) {
  const groups = new Map();
  const found = []; // { shapes, part, sk, isSub } per call with a shape
  let total = 0;
  for (const r of rows) {
    total += r.cost;
    for (const c of r.calls) {
      if (!SHELL_TOOLS.has(c.tool) || !GH_POLL_CATEGORIES.has(categorize(c))) continue;
      const shapes = githubReadShapes(c.key);
      if (!shapes.length) continue;
      const call = { shapes, part: r.cost / r.calls.length, sk: sessionKey(r), isSub: r.isSub };
      found.push(call);
      for (const s of shapes) {
        const g = groups.get(s) || { shape: s, calls: [] };
        g.calls.push(call);
        groups.set(s, g);
      }
    }
  }
  const sum = calls => {
    const sess = new Map(calls.map(c => [c.sk, c.isSub]));
    const cost = calls.reduce((a, c) => a + c.part, 0);
    return { calls: calls.length, sessions: sess.size, subagents: [...sess.values()].filter(Boolean).length,
      cost, share: total ? cost / total : 0 };
  };
  const hits = [...groups.values()].filter(g => g.calls.length >= GH_POLL_MIN_CALLS);
  const hit = new Set(hits.map(g => g.shape));
  return { ...sum(found.filter(c => c.shapes.some(s => hit.has(s)))), groups: hits
    .map(g => ({ shape: g.shape, ...sum(g.calls) }))
    .sort((a, b) => b.cost - a.cost || b.calls - a.calls || (a.shape < b.shape ? -1 : 1)) };
}
// `amount` is the dollar figure each flag represents, used by rankFlags() for
// the summary's top-N cap (Slice 28). REGRESSION: extra cost vs the previous
// window's cost/message; POLLING/BOILERPLATE: cost of those turns (the saving's
// upper bound, REFERENCE.md); the rest: the flagged spend (0 when a flag has no
// dollar figure). Not printed in text; --json carries it.
function flags(cur, prev, cfg, span, polls = [], boiler = { groups: [] }, gh = { groups: [] }) {
  const out = [];
  const add = (id, text, amount = 0) => out.push({ id, text, amount });

  const multiday = cur.sessions.filter(s => span(s) > DAY);
  if (multiday.length) {
    const w = multiday.slice().sort((a, b) => b.cost - a.cost)[0];
    add('MULTIDAY', `${multiday.length} session(s) span >1 day — worst ${w.sid.slice(0, 8)} ` +
      `${(span(w) / DAY).toFixed(1)}d ${money(w.cost)}`,
      multiday.reduce((a, s) => a + s.cost, 0));
  }
  // Slice 15 HITL: main threads only — a long subagent fires LONG_AGENT instead
  // (mixing the two double-counted the same sessions under both flags).
  const long = cur.mainSessions.filter(s => s.msgs >= LONG_SESSION_TURNS);
  if (long.length) {
    add('LONG_SESSION',
      `${long.length} session(s) ≥${LONG_SESSION_TURNS} msgs = ${(100 * cur.longShare).toFixed(0)}% of spend`,
      long.reduce((a, s) => a + s.cost, 0));
  }
  // Subagents over LONG_AGENT_TURNS turns or with a peak context over
  // LONG_AGENT_CTX — the main lever design decision Q5 identifies. Share is of
  // this window's total spend (cur.cost), same meaning as LONG_SESSION's share.
  const longAgents = cur.sessions.filter(s =>
    s.isSub && (s.msgs > LONG_AGENT_TURNS || s.ctxMax > LONG_AGENT_CTX));
  if (longAgents.length) {
    const agentCost = longAgents.reduce((a, s) => a + s.cost, 0);
    const share = cur.cost ? agentCost / cur.cost : 0;
    add('LONG_AGENT', `${longAgents.length} subagent(s) over ${LONG_AGENT_TURNS} turns or ` +
      `${(LONG_AGENT_CTX / 1e3).toFixed(0)}k peak ctx = ${(100 * share).toFixed(0)}% of spend`, agentCost);
  }
  if (polls.length) {
    const cost = polls.reduce((a, g) => a + g.cost, 0);
    const share = polls.reduce((a, g) => a + g.share, 0);
    const head = `${polls.length} run(s) ≥${POLL_MIN_CALLS}×/session = ${money(cost)}, ` +
      `${sharePct(share)} of spend; top ${polls[0].count}× `;
    out.push({ id: 'POLLING', text: head + fitMiddle(polls[0].key, FLAG_TEXT_WIDTH - head.length),
      amount: cost, groups: polls });
  }
  const boilers = boiler.groups;
  if (boilers.length) {
    const { cost, share } = boiler;
    const b = boilers[0];
    const head = `${boilers.length} prefix(es) = ${money(cost)}, ${sharePct(share)} of spend; ` +
      `top ${b.sessions} sess/${b.turns} turns `;
    out.push({ id: 'BOILERPLATE', text: head + fitPrefix(b.prefix, FLAG_TEXT_WIDTH - head.length),
      amount: cost, groups: boilers });
  }
  if (gh.groups.length) {
    // Slice 31: the cross-session counterpart of POLLING — GitHub read calls by endpoint
    // shape summed over every session/subagent (REFERENCE.md "GH_POLLING").
    const { groups, ...tot } = gh;
    const g = groups[0];
    const more = groups.length > 1 ? ` +${groups.length - 1} more` : '';
    const head = `${tot.calls} calls in ${tot.sessions} sessions (${tot.subagents} subagents) = ` +
      `${money(tot.cost)}, ${sharePct(tot.share)} of spend; top ${g.calls}× `;
    const shape = fitMiddle(g.shape, FLAG_TEXT_WIDTH - head.length - more.length);
    out.push({ id: 'GH_POLLING', text: head + shape + more,
      amount: tot.cost, ...tot, groups });
  }
  if (cur.avgCtx > 150e3) {
    add('BIG_CTX', `avg context/message ${(cur.avgCtx / 1e3).toFixed(0)}k (threshold 150k)`);
  }
  if (cur.topShare > 0.5) {
    add('CONCENTRATION', `top 5 sessions = ${(100 * cur.topShare).toFixed(0)}% of spend`,
      cur.sessions.slice(0, 5).reduce((a, s) => a + s.cost, 0));
  }
  if (prev && prev.costPerMsg > 0 && cur.costPerMsg > prev.costPerMsg * 1.25) {
    // amount = extra cost vs the previous window's cost/message (Slice 28 HITL Q-B).
    add('REGRESSION', `cost/message +${(100 * (cur.costPerMsg / prev.costPerMsg - 1)).toFixed(0)}% vs previous window`,
      Math.max(0, cur.cost - prev.costPerMsg * cur.msgs));
  }
  if (cur.opusShare > 0.9) {
    add('OPUS_HEAVY', `Opus = ${(100 * cur.opusShare).toFixed(0)}% of spend — no model-per-phase split visible`,
      cur.byFamily.Opus || 0);
  }
  if (cfg.agentDefs > 20 || cfg.prefixTokens > 5000) {
    // Slice 20 3rd review, finding 6 (pre-existing): p.name is attacker/author
    // controlled (same as elsewhere in CONFIG) and was printed here with no length
    // cap — fit it same as the CONFIG plugin listing does, so 3 worst-case names
    // can't alone blow the FLAGS line (wrapWords()'s hard-break below is the
    // second line of defense for anything that still gets through too long).
    add('PLUGIN_BLOAT', `${cfg.agentDefs} agent + ${cfg.skillDefs} skill definitions ≈ ` +
      `${(cfg.prefixTokens / 1e3).toFixed(1)}k tokens in every request prefix ` +
      `(worst: ${cfg.plugins.slice(0, 3).map(p => fit(p.name.split('/').pop(), 40)).join(', ')})`);
  }
  if (!out.length) add('CLEAN', 'no threshold breached in this window');
  return out;
}

// ------------------------------------------------------------ security flags
// Separate from flags() on purpose: these are confidentiality risks, not cost
// or habit signals, and must never be reported mixed in with the spend-driven
// FLAGS block (see SKILL.md rule 5).
function securityFlags(cfg) {
  const out = [];
  const add = (id, text) => out.push({ id, text });
  if (cfg.cleanupPeriodDays == null) {
    add('NO_RETENTION', 'cleanupPeriodDays unset — no cleanup runs, ' +
      'transcripts (customer code included) sit in plaintext indefinitely');
  }
  return out;
}

// ------------------------------------------------------------------ report
const money = n => '$' + n.toFixed(n < 1 ? 3 : n < 10 ? 2 : n < 100 ? 1 : 0);
const k = n => (n / 1e3).toFixed(0) + 'k';
const pct = n => (100 * n).toFixed(1) + '%';
const date = ms => new Date(ms).toISOString().slice(0, 10);
// Model string as shown in tables: `claude-opus-5-5-20260101` → `opus-5-5`.
const shortModel = m => String(m || '?').replace(/^claude-/, '').replace(/-\d{8}$/, '');
// One line, at most n code points (never splits a surrogate pair); a cut
// string ends in `…` so truncation is visible.
function fit(text, n) {
  const chars = [...String(text).replace(/\s+/g, ' ').trim()];
  return chars.length <= n ? chars.join('') : chars.slice(0, n - 1).join('').trimEnd() + '…';
}

// ------------------------------------------------------------------ detail
// DETAIL = drill-down printed below the summary (off with --no-detail).
// Data and layout are split so each later section (distribution line, cost by
// activity) adds one field in detail() + one renderer in DETAIL_SECTIONS. No
// blank lines between sections: the whole block has a line budget (see
// REFERENCE "DETAIL"). Every line ≤ 120 chars.
// Like fit(), but cuts the middle: a command key's head (the program) and
// tail (e.g. the `…/check-runs` endpoint) both carry meaning.
function fitMiddle(text, n) {
  const chars = [...String(text).replace(/\s+/g, ' ').trim()];
  if (chars.length <= n) return chars.join('');
  const tail = Math.floor((n - 1) / 2);
  return chars.slice(0, n - 1 - tail).join('') + '…' + chars.slice(chars.length - tail).join('');
}
// A BOILERPLATE prefix too long for its line loses its values before its command
// words: quoted strings → '…', then (for `NAME=$(…)`) each stage keeps only its leading
// command words (`TOKEN=$(printf … | git credential fill | sed …)`), then one-word stages → `…`,
// then fitMiddle().
const QUOTED = /'[^']*'|"[^"]*"/g;
function fitPrefix(prefix, n) {
  const one = String(prefix).replace(/\s+/g, ' ').trim();
  if ([...one].length <= n) return one;
  const unq = one.replace(QUOTED, q => (q.length > 3 ? `${q[0]}…${q[0]}` : q));
  if ([...unq].length <= n) return unq;
  const m = /^([^=]*=\$\()(.*)\)$/s.exec(unq);
  const stage = t => {
    const w = t.split(' ');
    const k = w.findIndex(x => !/^[A-Za-z_][\w.-]*$/.test(x));
    return k < 1 ? t : `${w.slice(0, k).join(' ')} …`;
  };
  const words = m && m[1] + shellSegments(m[2])
    .map((g, i, a) => (i < a.length - 1 ? `${stage(g.text)} ${g.sep} ` : stage(g.text))).join('') + ')';
  if (!words || [...words].length <= n) return fitMiddle(words || unq, n);
  // still too long: a one-word stage (`printf …`) → `…`, so a multi-word command stays whole
  return fitMiddle(words.replace(/(?<=\$\(| [|&;]+ )[A-Za-z_][\w.-]* …(?= [|&;]+ |\)$)/g, '…'), n);
}
// Share of spend as a whole percent; a non-zero share under 0.5 % prints `<1%`, not `0%`.
const sharePct = share => `${share > 0 && share < 0.005 ? '<1' : (100 * share).toFixed(0)}%`;
// FLAGS lines are `  <id padded to 14> <text>`; text keeps the line ≤ 120 chars.
const FLAG_TEXT_WIDTH = 120 - 17;
// Most flag text already fits FLAG_TEXT_WIDTH (POLLING/BOILERPLATE are pre-fit with
// fitMiddle/fitPrefix, both bounded to FLAG_TEXT_WIDTH). A static message (e.g.
// NO_RETENTION) can still run long; rather than truncate advice text with `…`, wrap it
// onto continuation lines indented to FLAG_TEXT_WIDTH's own margin, so every line stays
// ≤ 120 chars and no words are lost. Greedy word wrap; only hard-breaks a single
// word (below) when it alone is longer than width.
function wrapWords(text, width) {
  // 4th review, finding 4: width < 1 makes the hard-break loop below a no-op
  // forever (chars.slice(0, width) is '' and chars.slice(width) is unchanged) —
  // an infinite loop for any non-empty word, RangeError (stack overflow) for text
  // callers building up wrapWords() output. Every real caller passes a fixed
  // positive width (FLAG_TEXT_WIDTH), so this is a defensive floor, not a live bug.
  width = Math.max(1, width);
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let cur = '';
  for (let w of words) {
    // Slice 20 3rd review, finding 6 (pre-existing): a single "word" longer than
    // width (e.g. an attacker-controlled plugin/MCP-server name with no spaces)
    // can't be wrapped by breaking *between* words — the old loop just let it
    // ride through as its own overlong line. Hard-break it into width-sized
    // chunks instead, so no returned line ever exceeds width regardless of what
    // the source text contains.
    while ([...w].length > width) {
      const chars = [...w];
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(chars.slice(0, width).join(''));
      w = chars.slice(width).join('');
    }
    const next = cur ? `${cur} ${w}` : w;
    if ([...next].length > width && cur) { lines.push(cur); cur = w; }
    else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}
// Builds the printed row(s) for one FLAGS/SECURITY entry; wraps f.text (already
// redacted/fit upstream) instead of letting it overrun 120 chars. Callers
// either console.log() these directly (printFlagLine, below) or fold them into
// a larger array first (main()'s summary/SECURITY blocks, continuedFlagLines())
// so the hard line-budget guards can count them before anything is printed.
// POLLING/BOILERPLATE text is a literal shell command, pre-fit to FLAG_TEXT_WIDTH by
// fitMiddle()/fitPrefix() when built (see flags()) — it's guaranteed to already fit on
// one line. Running it through wrapWords() anyway would risk splitting the command
// across lines (breaking copy-paste) if that guarantee is ever violated, so these two
// print unmodified whenever they're within budget; wrapWords() only kicks in as a
// safety net if one somehow arrives too long, same as any other flag.
function flagLines(f) {
  if ((f.id === 'POLLING' || f.id === 'BOILERPLATE') && [...f.text].length <= FLAG_TEXT_WIDTH)
    return [`  ${f.id.padEnd(14)} ${f.text}`];
  const lines = wrapWords(f.text, FLAG_TEXT_WIDTH);
  return [`  ${f.id.padEnd(14)} ${lines[0] ?? ''}`, ...lines.slice(1).map(l => `${' '.repeat(17)}${l}`)];
}
// Slice 28 review, finding 1: SUMMARY_MAX_LINES/DETAIL_MAX_LINES are hard guards,
// not just a hope that the pieces below happen to add up. The summary shows as
// many flags (in rankFlags() order) as fit the lines left after every fixed
// line — SPEND/CONFIG/... and the *whole* SECURITY block, computed first so
// SECURITY is never displaced (fitFlags() below; normally 4 flags on the
// worst-case fixture, fewer if SECURITY needs more room, more if it doesn't)
// — plus one "+N more: IDs" line for the rest; those continue in DETAIL (inside
// DETAIL_MAX_LINES, same fitFlags() guard) and always in --json.
const SUMMARY_MAX_LINES = 24;
const DETAIL_MAX_LINES = 40;
// Slice 28 (design decision Q5, HITL Q-B): rank by extra cost where that decision defines
// one — REGRESSION (extra cost vs previous cost/msg) and POLLING/BOILERPLATE/GH_POLLING
// (cost of those turns; GH_POLLING Slice 31) share tier 0, by $ — then a fixed priority for flags
// whose $ is only the flagged spend, $ as tie-break inside a tier: LONG_AGENT
// (Q5's main lever) above (LONG_SESSION, MULTIDAY — tied) above (OPUS_HEAVY,
// CONCENTRATION — tied) above (BIG_CTX, PLUGIN_BLOAT — tied, no $) above CLEAN;
// id last, for a stable order.
const FLAG_TIER = { REGRESSION: 0, POLLING: 0, BOILERPLATE: 0, GH_POLLING: 0, LONG_AGENT: 1, LONG_SESSION: 2,
  MULTIDAY: 2, OPUS_HEAVY: 3, CONCENTRATION: 3, BIG_CTX: 4, PLUGIN_BLOAT: 4, CLEAN: 5 };
const flagTier = f => FLAG_TIER[f.id] ?? 4;
function rankFlags(fl) {
  return fl.slice().sort((a, b) => flagTier(a) - flagTier(b) || (b.amount || 0) - (a.amount || 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
// One "  … +N more: ID, ID (where)" line; the ID list is cut with ", …" to stay ≤ 120.
function moreIdsLine(moved, where) {
  if (!moved.length) return null;
  const head = `  … +${moved.length} more: `, tail = ` (${where})`;
  const budget = 120 - [...head].length - [...tail].length;
  const ids = moved.map(f => f.id);
  let list = ids.join(', ');
  if ([...list].length > budget) {
    const kept = [];
    for (const id of ids) {
      if ([...[...kept, id, '…'].join(', ')].length > budget) break;
      kept.push(id);
    }
    list = [...kept, '…'].join(', ');
  }
  return head + list + tail;
}
const flagsMoreLine = (moved, inDetail) => moreIdsLine(moved, inDetail ? 'DETAIL / --json' : '--json');
// Slice 28 review, finding 6: appends the FLAGS "+N more" marker onto `flagRows`
// (mutating and returning it) whenever flags were moved out of the summary —
// even if `flagRoom` (SUMMARY_MAX_LINES - preLen - postLen - 1, computed by the
// caller) was clamped to 0 because pre/post already used the whole
// SUMMARY_MAX_LINES budget between them. fitFlags() reserves a line for this
// marker while flags remain whenever room > 0, so this only changes behavior in
// that room === 0 edge case (not reachable today — SPEND/CONFIG/... and
// SECURITY are each capped to a handful of fixed lines — but not asserted
// against either): unconditionally naming what's left is better than a bare
// "FLAGS" header with nothing under it and no explanation.
function appendFlagsMore(flagRows, flagsMoved, inDetail) {
  if (flagsMoved.length) flagRows.push(flagsMoreLine(flagsMoved, inDetail));
  return flagRows;
}
// Shared hard-guard fitter (Slice 28 review, finding 1): fills `ranked` flags,
// in rank order, into `room` lines via flagLines() (1 line normally, more if a
// flag's text wraps), reserving a line ahead of time for the eventual "+N more"
// marker while any flag remains unshown — so the budget is enforced by
// construction, never by assuming every flag renders as exactly one line or
// that a fixed count (e.g. "top 4") always fits. `room <= 0` shows nothing.
// Used by both the summary's FLAGS block and DETAIL's "FLAGS (continued)".
function fitFlags(ranked, room) {
  const rows = [];
  let shown = 0;
  for (const f of ranked) {
    const ls = flagLines(f);
    const need = ls.length + (shown + 1 < ranked.length ? 1 : 0);
    if (rows.length + need > room) break;
    rows.push(...ls);
    shown++;
  }
  return { rows, moved: ranked.slice(shown) };
}
// FLAGS (continued) block for DETAIL, never more than `room` lines (review of
// ff55682, finding 1: it counts against DETAIL_MAX_LINES). Flags that don't fit
// are named on a "+N more: IDs (--json)" line; no room for even one flag -> [].
function continuedFlagLines(moved, room) {
  const header = `FLAGS (continued, ranked, ${moved.length} total)`;
  const { rows, moved: stillMoved } = fitFlags(moved, room - 1);
  if (!rows.length) return [];
  const out = [header, ...rows];
  if (stillMoved.length) out.push(moreIdsLine(stillMoved, '--json'));
  return out;
}
// TREND (Slice 28): one line for the whole history. "span N wk" = calendar weeks
// from the first to the last week with data; "(M with data)" = weeks with rows.
function trendLine(wks) {
  if (!wks.length) return 'TREND        no data';
  const first = wks[0], last = wks[wks.length - 1];
  if (wks.length === 1)
    return `TREND        week of ${first.week} only  ${money(first.costPerMsg)}/msg   full table in --json`;
  const delta = first.costPerMsg > 0
    ? `${last.costPerMsg >= first.costPerMsg ? '+' : ''}${(100 * (last.costPerMsg / first.costPerMsg - 1)).toFixed(0)}%`
    : 'n/a';
  const span = Math.round((Date.parse(last.week) - Date.parse(first.week)) / (7 * DAY)) + 1;
  return `TREND        ${first.week} ${money(first.costPerMsg)}/msg → ${last.week} ${money(last.costPerMsg)}/msg ` +
    `${delta}   span ${span} wk (${wks.length} with data)   full table in --json`;
}
// Slice 28 (design decision Q3, HITL D): CONFIG, UNPRICED and the SPEND family split
// print one line each (≤ 120 chars); a list that doesn't fit ends in one
// "+N more" marker, and --json carries every entry. fit()/textOf() run here, at
// print time, on the already show()n (redacted/sanitized) values (Slice 20/29).
function joinFit(parts, budget, sep, more) {
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const rest = parts.length - i - 1;
    if ([...[...out, parts[i], ...(rest ? [more(rest)] : [])].join(sep)].length > budget) break;
    out.push(parts[i]);
  }
  if (out.length < parts.length) out.push(more(parts.length - out.length));
  return out.join(sep);
}
// Slice 28 review, finding 3: no model family this window (an empty cur, e.g. a
// scope/window with zero cost) used to print a bare "  " (two spaces, no text) —
// return null instead so main() skips the line entirely rather than printing
// nothing meaningful.
function familyLine(cur) {
  const fams = Object.entries(cur.byFamily).sort((a, b) => b[1] - a[1])
    .map(([f, v]) => `${f} ${money(v)} ${pct(v / (cur.cost || 1))}`);
  return fams.length ? '  ' + joinFit(fams, 118, '   ', n => `+${n} more (--json)`) : null;
}
function unpricedLine(unpriced) {
  const tok = unpriced.reduce((a, u) => a + u.tokens, 0);
  const head = `UNPRICED     ${unpriced.length} model(s) ${(tok / 1e6).toFixed(2)}M tok: `;
  const tail = ' -- add prices to PRICES + REFERENCE.md';
  const budget = Math.max(20, 120 - [...head].length - [...tail].length);
  return head + joinFit(unpriced.map(u => fit(u.model, 40)), budget, ', ', n => `+${n} more (--json)`) + tail;
}
// effort= lists the root effortLevel (the default for models without their own
// entry) first, then each modelSettings.<model>.effortLevel as model:level with
// the "claude-" prefix dropped; prefix≈ is the fixed tokens/request that
// plugins (agent + skill definitions) and MCP servers add; retention =
// cleanupPeriodDays (left out when unset: SECURITY's NO_RETENTION says so).
function configLine(cfg) {
  const head = 'CONFIG       ';
  const tail = ` plugins=${cfg.pluginCount}` + (cfg.mcpServers.length ? ` mcp=${cfg.mcpServers.length}` : '') +
    ` prefix≈${(((cfg.prefixTokens || 0) + (cfg.mcpPrefixTokens || 0)) / 1e3).toFixed(1)}k` +
    (textOf(cfg.cleanupPeriodDays) == null ? '' : ` retention=${fit(textOf(cfg.cleanupPeriodDays), 12)}`);
  const rest = 120 - [...head].length - [...tail].length;
  const root = cfg.effortLevel ? [fit(textOf(cfg.effortLevel), 12)] : [];
  const perModel = cfg.modelEffort.map(m =>
    `${fit(String(textOf(m.model)).replace(/^claude-/, ''), 20)}:${fit(textOf(m.effortLevel), 10)}`);
  // effort is fit first (it carries the per-model levels), model gets the rest (12..30).
  const budget = rest - ' effort='.length - 'model='.length - 12;
  const effort = root.length || perModel.length ? joinFit([...root, ...perModel], budget, ',', n => `+${n}`) : 'unset';
  const modelRoom = rest - ' effort='.length - [...effort].length - 'model='.length;
  const model = 'model=' + fit(textOf(cfg.model) ?? 'unset', Math.max(12, Math.min(30, modelRoom)));
  return `${head}${model} effort=${effort}${tail}`;
}
const TOP_SUBAGENTS = 10;
const TASK_WIDTH = 70;
const TOP_UNITS = 10;
const TOP_ACTIVITIES = 6;

// A "work unit" = one main (non-sub) session rolled up with the subagents it
// spawned (sub.parent === main.sid), per design decision Q3. Keyed by main sid so a
// main session with no subagent rows still forms its own unit (sub 0%); a
// subagent whose parent main session has no priced turns in this window (rare
// — e.g. the main thread was entirely outside the window) still rolls up
// under its parent id, giving an orphan unit with mainCost 0.
// `turns` = total msgs across every session in the unit (main + all its
// subagents) — the unit's total turn volume, matching how `cost` is a sum.
// `peakCtx` = the single largest context hit by any session in the unit.
// `span` = full-history first-seen -> last-seen across every session in the
// unit (not clipped to the window, same convention as the per-session `span`
// on cur.sessions/--json, Slice 28 dropped the printed table) — looked up from
// `all`, not `cur`, so a unit whose
// activity started before this window still reports its real span.
function workUnits(cur, all) {
  const allByKey = new Map(all.sessions.map(s => [sessionKey(s), s]));
  const units = new Map();
  for (const s of cur.sessions) {
    const key = s.isSub ? s.parent : s.sid;
    let u = units.get(key);
    if (!u) {
      u = { key, project: s.project, mainCost: 0, subCost: 0, agents: 0, turns: 0,
            peakCtx: 0, first: Infinity, last: 0 };
      units.set(key, u);
    }
    if (s.isSub) { u.subCost += s.cost; u.agents++; } else { u.mainCost += s.cost; }
    u.turns += s.msgs;
    if (s.ctxMax > u.peakCtx) u.peakCtx = s.ctxMax;
    const full = allByKey.get(sessionKey(s));
    if (full) {
      if (full.first < u.first) u.first = full.first;
      if (full.last > u.last) u.last = full.last;
    }
  }
  // `first`/`last` are scratch fields used only to compute `span` below — drop them
  // before returning so they don't leak into --json (REFERENCE.md's documented
  // detail.units[] shape does not list them).
  return [...units.values()].map(({ first, last, ...u }) => {
    const cost = u.mainCost + u.subCost;
    return { ...u, cost, subShare: cost ? u.subCost / cost : 0,
      span: (last > first) ? last - first : 0 };
  }).sort((a, b) => b.cost - a.cost).slice(0, TOP_UNITS);
}

// Shared quantile helper: SESSIONS' median/p90 (`pick` above) calls this too,
// so both read the same way. q=1 clamps to the last (= max) element.
function quantile(sortedAsc, q) {
  return sortedAsc.length ? sortedAsc[Math.min(sortedAsc.length - 1, Math.floor(q * sortedAsc.length))] : 0;
}

// Distribution of subagent turns and peak context, per design decision Q3. Spec
// does not say which population feeds it; decided (REFERENCE.md "Subagent
// distribution — population"): every subagent in the current window scope
// (`cur`), not just the TOP_SUBAGENTS-by-cost list above — the top-10 is a
// leaderboard, this is the population it was drawn from, so a reader can
// tell whether e.g. "288 turns" is typical or an outlier.
function subagentDistribution(cur) {
  const subs = cur.sessions.filter(s => s.isSub);
  const turnsAsc = subs.map(s => s.msgs).sort((a, b) => a - b);
  const ctxAsc = subs.map(s => s.ctxMax).sort((a, b) => a - b);
  return {
    count: subs.length,
    turns: { median: quantile(turnsAsc, 0.5), p90: quantile(turnsAsc, 0.9), max: quantile(turnsAsc, 1) },
    peakCtx: { median: quantile(ctxAsc, 0.5), p90: quantile(ctxAsc, 0.9), max: quantile(ctxAsc, 1) },
  };
}

// curRows = this window's deduped turns (the rows `cur` was summarized from).
function detail(cur, tasks, all, curRows) {
  const topSubagents = cur.sessions.filter(s => s.isSub).slice(0, TOP_SUBAGENTS).map(s => ({
    sid: s.sid, parent: s.parent, project: s.project, task: tasks.get(sessionKey(s)) || null,
    model: s.model, turns: s.msgs, peakCtx: s.ctxMax, cost: s.cost,
  }));
  return { topSubagents, units: workUnits(cur, all), distribution: subagentDistribution(cur),
    activity: activity(curRows) };
}

const DETAIL_SECTIONS = [
  // Work units: parent + subagent rollup. Columns: 2+8+2+7+2+6+2+3+2+5+2+5+2+5+2+proj.
  d => d.units.length ? [
    `TOP ${TOP_UNITS} WORK UNITS (this window, parent + subagents; span = full history)`,
    `  ${'sid'.padEnd(8)}  ${'cost'.padStart(7)}  ${'sub%'.padStart(6)}  ${'#ag'.padStart(3)}  ` +
      `${'turns'.padStart(5)}  ${'peak'.padStart(5)}  ${'span'.padStart(5)}  project`,
    ...d.units.map(u =>
      `  ${String(u.key).slice(0, 8).padEnd(8)}  ${money(u.cost).padStart(7)}  ${pct(u.subShare).padStart(6)}  ` +
      `${String(u.agents).padStart(3)}  ${String(u.turns).padStart(5)}  ${k(u.peakCtx).padStart(5)}  ` +
      `${(u.span > 0 ? (u.span / DAY).toFixed(1) + 'd' : '<1d').padStart(5)}  ${fit(u.project, 40)}`),
  ] : ['TOP WORK UNITS  none in this window'],
  // Top subagents by cost. Columns: 2+7+2+5+2+5+2+10+2+8+2+70 = 117 chars max.
  d => d.topSubagents.length ? [
    `TOP ${TOP_SUBAGENTS} SUBAGENTS (this window, by cost)`,
    `  ${'cost'.padStart(7)}  ${'turns'.padStart(5)}  ${'peak'.padStart(5)}  ${'model'.padEnd(10)}  ` +
      `${'parent'.padEnd(8)}  task`,
    ...d.topSubagents.map(a =>
      `  ${money(a.cost).padStart(7)}  ${String(a.turns).padStart(5)}  ${k(a.peakCtx).padStart(5)}  ` +
      `${fit(shortModel(a.model), 10).padEnd(10)}  ${String(a.parent).slice(0, 8).padEnd(8)}  ` +
      fit(a.task || a.sid, TASK_WIDTH)),
  ] : ['TOP SUBAGENTS  none in this window'],
  // Subagent turn / peak-ctx distribution — population stats over every
  // subagent in this window (see subagentDistribution()), not just the
  // TOP_SUBAGENTS list above.
  d => d.distribution.count ? [
    `SUBAGENT DISTRIBUTION (${d.distribution.count} in this window)`,
    `  turns     median ${String(d.distribution.turns.median).padStart(5)}  ` +
      `p90 ${String(d.distribution.turns.p90).padStart(5)}  max ${String(d.distribution.turns.max).padStart(5)}`,
    `  peak ctx  median ${k(d.distribution.peakCtx.median).padStart(5)}  ` +
      `p90 ${k(d.distribution.peakCtx.p90).padStart(5)}  max ${k(d.distribution.peakCtx.max).padStart(5)}`,
  ] : ['SUBAGENT DISTRIBUTION  none in this window'],
  // Cost by activity, top TOP_ACTIVITIES by cost (full list in --json). Turns
  // are fractional after the per-call split; shown rounded, a fraction below one as `<1` so a
  // category with a cost never shows 0 turns.
  // Columns: 2+16+2+6+2+7+2+7+2+6 = 52 chars.
  d => {
    const top = d.activity.filter(a => a.turns > 0).slice(0, TOP_ACTIVITIES);
    return top.length ? [
      `COST BY ACTIVITY (this window, top ${TOP_ACTIVITIES}; a turn's cost split evenly over its tool calls)`,
      `  ${'category'.padEnd(16)}  ${'turns'.padStart(6)}  ${'avg ctx'.padStart(7)}  ${'cost'.padStart(7)}  ` +
        `${'share'.padStart(6)}`,
      ...top.map(a => `  ${a.category.padEnd(16)}  ${turnsText(a.turns).padStart(6)}  ` +
        `${k(a.avgCtx).padStart(7)}  ${money(a.cost).padStart(7)}  ${pct(a.share).padStart(6)}`),
    ] : ['COST BY ACTIVITY  none in this window'];
  },
];

const turnsText = t => (t > 0 && t < 1 ? '<1' : String(Math.round(t)));
// Slice 28 review, finding 1: hard guard on DETAIL's own line count — capped
// here explicitly rather than relying on TOP_UNITS/TOP_SUBAGENTS/TOP_ACTIVITIES
// happening to add up under DETAIL_MAX_LINES by construction. main()'s
// continuedFlagLines() room is DETAIL_MAX_LINES - this result's length, so this
// guard protects that budget too, not just DETAIL's own.
function renderDetail(d) {
  const lines = ['DETAIL', ...DETAIL_SECTIONS.flatMap(section => section(d))];
  return lines.length <= DETAIL_MAX_LINES ? lines :
    [...lines.slice(0, DETAIL_MAX_LINES - 1), '… DETAIL truncated, full data in --json'];
}

// ------------------------------------------------------------ redacted view
// Every printed field that can carry a path or the user's identity (scope, project
// folders, subagent task text, model / plugin / MCP server names) goes through
// redactPaths(), in text and --json alike (Slice 29). Grouping and keys ran on the
// raw values; only the copies that get printed are rewritten.
const shown = new Map();
// Slice 20 review: an MCP server / plugin / modelSettings-key name can be
// attacker- or author-controlled text (e.g. a stray key in a cloned repo's
// .mcp.json or settings.json), not this machine's own data. A raw control
// char (newline, etc.) in it must never reach console.log — it could inject
// a fake extra line into the printed report (e.g. forging a bogus SECURITY
// block). Collapse to a single space here, once, for every show()n string;
// callers that also need a length cap still run the result through fit()/
// fitMiddle() at print time.
// Slice 20 re-review: [\x00-\x1f\x7f] only covers C0 controls + DEL. C1 controls
// (U+0080-U+009F, e.g. U+0085 NEL, U+009B CSI) and other Unicode format/bidi
// characters (\p{Cf}, e.g. U+202E RIGHT-TO-LEFT OVERRIDE) sit outside that range
// and could still forge layout or reorder printed text. \p{Cc} covers C0+C1,
// \p{Cf} covers the format/bidi class; \u2028/\u2029 (line/paragraph separator)
// aren't in either category but are still line breaks to a terminal.
// Slice 20 3rd review: \p{Cf} is broad \- it also matches ZWNJ/ZWJ/SHY (U+200C,
// U+200D, U+00AD), which show up legitimately in Persian/Arabic names and emoji
// ZWJ sequences. Collapsing them to a space is a display-only tradeoff (this
// regex only runs inside show(), on the printed copy); grouping/keys are computed
// off the raw value beforehand and are unaffected.
const CONTROL_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]+/gu;
const show = v => {
  if (typeof v !== 'string') return v;
  if (!shown.has(v)) shown.set(v, redactPaths(v).replace(CONTROL_CHARS, ' '));
  return shown.get(v);
};
// Slice 20 3rd review, finding 2: fit()/fitMiddle() must run only at print time
// (text report) \- showConfig() feeds --json too, and truncating a value there
// silently drops data from the JSON contract (REFERENCE.md:375, "the full prefix
// is in --json"). This is the JSON-safe counterpart to show() for a config value
// that isn't necessarily a string: strings/numbers/booleans/null pass through
// show()/unchanged so --json keeps their real type.
// Slice 20 4th review, finding 1: an object/array (a forged settings.json value
// where a string was expected) used to be JSON.stringify()'d *before* show() ran
// \- turning a real control char (\n, \t, ...) into a literal backslash+letter
// escape sequence first. That trailing letter then sits right next to a name/
// login in the stringified text and blocks redactPaths()'s ID_EDGE boundary
// check, so the name survives un-redacted (e.g. `"x\nSvarc"` -> the `n` before
// `Svarc` defeats the boundary). Fix (dispatcher decision): --json keeps the
// live type \- walk the object/array recursively and run show() on every string
// leaf (keys and values, since a forged key is just as untrusted as a value);
// numbers/booleans/null pass through unchanged. Serializing to text (via
// JSON.stringify(), for the text report only) happens after this, on the
// already-redacted/sanitized result \- see textOf() below.
const showAny = v => {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return show(v);
  if (Array.isArray(v)) return v.map(showAny);
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[show(k)] = showAny(val);
    return out;
  }
  try { return show(String(v)); } catch { return v; }
};
// Text report only: turns an already-redacted showAny() result back into a
// string right before fit() truncates it for display \- fit() itself does a
// naive String(x) internally, which would print an object as the useless
// "[object Object]" (the same bug finding 1 fixed for --json). --json never
// calls this: it prints the live object via the top-level JSON.stringify() of
// the whole payload, keeping the real type per the dispatcher decision above.
const textOf = v => (v == null || typeof v !== 'object') ? v : JSON.stringify(v);
// Slice 20 re-review: settings.json is as untrusted as an MCP server / plugin
// name (config(), :767/:773-774) — effortLevel and cleanupPeriodDays were
// printed raw, letting a forged value inject a fake extra line (e.g. a bogus
// SECURITY block) the same way an unsanitized key could. effortLevel is a
// closed vocabulary, so a value outside it is already suspect; print it
// sanitized rather than hide it. cleanupPeriodDays should be a plain number;
// anything else prints sanitized too, instead of silently passing through.
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'max']);
const showEffortLevel = v => v == null ? v : (EFFORT_LEVELS.has(v) ? v : showAny(v));
const showCleanupPeriodDays = v =>
  (v == null || (typeof v === 'number' && Number.isFinite(v))) ? v : showAny(v);
const showSessions = sum => ({ ...sum,
  sessions: sum.sessions.map(s => ({ ...s, project: show(s.project), model: show(s.model) })) });
const showConfig = c => ({ ...c, model: showAny(c.model),
  cleanupPeriodDays: showCleanupPeriodDays(c.cleanupPeriodDays),
  effortLevel: showEffortLevel(c.effortLevel),
  modelEffort: c.modelEffort.map(m => ({ ...m, model: show(m.model), effortLevel: showEffortLevel(m.effortLevel) })),
  plugins: c.plugins.map(p => ({ ...p, name: show(p.name) })),
  mcpServers: c.mcpServers.map(m => ({ ...m, name: show(m.name) })) });
const showDetail = d => d && { ...d,
  topSubagents: d.topSubagents.map(a => ({ ...a, project: show(a.project), task: show(a.task), model: show(a.model) })),
  units: d.units.map(u => ({ ...u, project: show(u.project) })) };
const fail = msg => { console.error(show(msg)); process.exit(1); };

async function main() {
  if (!fs.existsSync(ROOT)) {
    fail('no transcripts at ' + ROOT);
  }
  if (SCOPE_PROJECT && !fs.existsSync(SCOPE_ROOT)) {
    fail(`no project '${SCOPE_PROJECT}' under ${ROOT}` +
      (PROJECT_ARG !== undefined ? ` (--project ${PROJECT_ARG})` : ` (cwd ${process.cwd()})`));
  }
  const { rows, unpriced: unprizedRows, tasks } = await collect();
  if (!rows.length && !unprizedRows.length) {
    fail('no transcripts found in ' + ROOT);
  }

  const now = Date.now();
  const curFrom = now - DAYS * DAY;
  const prevFrom = now - 2 * DAYS * DAY;
  const curRows = rows.filter(r => r.ts >= curFrom);
  const cur = showSessions(summarize(curRows));
  const prev = showSessions(summarize(rows.filter(r => r.ts >= prevFrom && r.ts < curFrom)));
  const all = summarize(rows);
  // ALL-TIME (summary line + --json `all`) mixes two populations on purpose (Slice 15
  // HITL, re-review decision): `cost` is all.cost — every row incl. subagents, over all
  // history — so the invariant SPEND (cur.cost, which also includes subagents) ≤
  // ALL-TIME cost always holds; `sessions`/`msgs` stay main-sessions-only, the same
  // population SESSIONS' count/median/p90 uses, so "N sessions" never counts a subagent
  // as a session. Don't swap these: main-only cost would let a window's subagent spend
  // exceed the all-time total; all-inclusive sessions/msgs would no longer match SESSIONS.
  const allMainMsgs = all.mainSessions.reduce((a, s) => a + s.msgs, 0);
  // Windowed the same as SPEND (cur), not all-time — otherwise UNPRICED prints
  // all-history totals under a header that says "this window".
  const unpriced = aggregateUnpriced(unprizedRows, curFrom).map(u => ({ ...u, model: show(u.model) }));
  const cfg = showConfig(config());
  // spans measured over full history, not clipped to the window. Keyed by
  // (parent, sid) same as summarize() — a bare sid would collide across
  // parents for a repeated subagent id.
  const spans = new Map(all.sessions.map(s => [sessionKey(s), s.last - s.first]));
  const span = s => spans.get(sessionKey(s)) || 0;
  const fl = flags(cur, prev, cfg, span, polling(curRows), boilerplate(curRows),
    ghPolling(curRows));
  const secFl = securityFlags(cfg);

  const scope = { mode: SCOPE_PROJECT ? 'project' : 'all', project: show(SCOPE_PROJECT) };
  const det = DETAIL ? showDetail(detail(cur, tasks, all, curRows)) : null;

  if (JSON_OUT) {
    // mainSessions (Slice 15: SESSIONS/LONG_SESSION's main-threads-only view) is an
    // internal computation detail, dropped here rather than redacted+trimmed like
    // sessions — it holds the same objects sessions does, just filtered, and no
    // --json field currently reads it (median/p90/LONG_SESSION are already their own
    // redacted/summarized fields).
    const trim = ({ mainSessions, ...s }) => ({ ...s, sessions: s.sessions.slice(0, TOP) });
    console.log(JSON.stringify({ windowDays: DAYS, scope, cur: trim(cur), prev: trim(prev),
      // Matches the ALL-TIME summary line: `cost` is all-time spend incl. subagents
      // (all.cost); `msgs`/`sessions` count main sessions only (all.mainSessions), not
      // all.sessions (raw sessions, internally used by cur/prev/detail, includes
      // subagents and is intentionally not exposed here). all.msgs isn't used
      // internally at all — kept only for this trimmed json field.
      all: { cost: all.cost, msgs: allMainMsgs, sessions: all.mainSessions.length },
      weeks: weeks(rows), config: cfg, flags: fl, securityFlags: secFl, unpriced,
      ...(det ? { detail: det } : {}) }, null, 2));
    return;
  }

  // Slice 28 review, finding 1 (hard guard): the summary is assembled into `pre`
  // (everything up to and including the "FLAGS" header) and `post` (the blank
  // line + the *entire* SECURITY block) before a single flag-row is chosen, so
  // the room left for FLAGS is whatever SUMMARY_MAX_LINES minus those two
  // actually costs — not a static guess (a fixture that happens to need 0
  // spare lines is no longer "lucky"; an extra SECURITY row or a flag whose
  // text wraps to 2 lines simply shrinks FLAGS' room, never SECURITY's).

  // Budget the project name against whatever's left of the 120-char line after the
  // fixed prefix/suffix (window range width varies with DAYS's digit count), rather
  // than a static guess that could itself run the line past 120 (Slice 20 review).
  const bannerPrefix = 'TOKEN AUDIT   scope ';
  const bannerSuffix = `   window ${date(curFrom)} → ${date(now)} (${DAYS}d)   list-price equivalent`;
  const bannerBudget = Math.max(10, 120 - [...bannerPrefix].length - [...bannerSuffix].length);
  const shownProject = scope.project ? fitMiddle(scope.project, bannerBudget) : 'all projects';

  // Slice 28 review, finding 5: familyLine(cur) is not free (sorts + joinFit()s
  // byFamily) and its result is used twice below (the line itself, and the
  // conditional that decides whether to include it) — compute it once.
  const famLine = familyLine(cur);
  const pre = [
    bannerPrefix + shownProject + bannerSuffix,
    '',
    `SPEND        ${money(cur.cost)}   prev window ${money(prev.cost)}` +
      (prev.cost ? `  ${cur.cost >= prev.cost ? '+' : ''}${(100 * (cur.cost / prev.cost - 1)).toFixed(0)}%` : ''),
    ...(famLine ? [famLine] : []),
    `  main ${money(cur.byChain.main)} (${pct(cur.byChain.main / (cur.cost || 1))})   ` +
      `subagents ${money(cur.byChain.sub)} (${pct(cur.byChain.sub / (cur.cost || 1))})`,
    ...(unpriced.length ? [unpricedLine(unpriced)] : []),
    '',
    `PER MESSAGE  ctx ${k(cur.avgCtx)} avg   cost ${money(cur.costPerMsg)}` +
      (prev.msgs ? `   prev ${k(prev.avgCtx)} / ${money(prev.costPerMsg)}` : ''),
    // Slice 15 HITL: main threads only (see LONG_SESSION_TURNS) — subagents are
    // LONG_AGENT's / DETAIL's "Subagent distribution" territory.
    `SESSIONS     ${cur.mainSessions.length}   median ${cur.medianMsgs} msgs   p90 ${cur.p90Msgs}   ` +
      `≥${LONG_SESSION_TURNS} msgs: ${cur.mainSessions.filter(s => s.msgs >= LONG_SESSION_TURNS).length}`,
    // Slice 15 HITL (re-review decision): cost is all-time incl. subagents (all.cost,
    // so SPEND ≤ ALL-TIME always holds); sessions/messages stay main-only, matching
    // SESSIONS above (all.mainSessions) — see the comment where allMainMsgs is built.
    `ALL-TIME     ${money(all.cost)} over ${all.mainSessions.length} sessions, ${allMainMsgs} messages`,
    // Slice 28 (design decision Q3, HITL decision): TOP SESSIONS dropped from the summary —
    // it overlapped WORK UNITS / TOP SUBAGENTS in DETAIL and was one of the two biggest
    // overrun sources on real --all data. Still in --json as cur.sessions (trimmed to
    // --top, unchanged). WEEKS (a full per-week table, unbounded with history length)
    // is replaced by one TREND line spanning all history; --json keeps the full table
    // under `weeks`.
    trendLine(weeks(rows)),
    configLine(cfg),
    '',
    'FLAGS',
  ];
  const secLines = ['SECURITY (confidentiality, not cost)',
    ...(secFl.length ? secFl.flatMap(flagLines) : ['  none'])];
  const post = ['', ...secLines];
  // The blank line before DETAIL prints only when DETAIL runs, but the room
  // budget reserves it either way, so FLAGS' cap doesn't depend on --no-detail:
  // the summary picks the same ranked flags whether or not DETAIL ends up
  // printing, and only the "+N more" line's "(DETAIL / --json)" vs "(--json)"
  // suffix differs (see `flagsMoreLine` below).
  const detSeparator = det ? [''] : [];

  // Slice 28 (design decision Q3/Q5, HITL Q-B/Q-C): flags in rankFlags() order fill
  // whatever room is left (fitFlags(), same hard guard DETAIL's "FLAGS
  // (continued)" uses); the rest continue there within its own line budget.
  // --json's `flags` always carries every flag (unranked).
  const rankedFlags = rankFlags(fl);
  const flagRoom = Math.max(0, SUMMARY_MAX_LINES - pre.length - post.length - 1);
  const { rows: flagRows, moved: flagsMoved } = fitFlags(rankedFlags, flagRoom);
  const detLines = det ? renderDetail(det) : [];
  const contFlags = det ? continuedFlagLines(flagsMoved, DETAIL_MAX_LINES - detLines.length) : [];
  appendFlagsMore(flagRows, flagsMoved, contFlags.length > 0);

  for (const l of [...pre, ...flagRows, ...post, ...detSeparator]) console.log(l);

  if (det) {
    for (const l of [...detLines, ...contFlags]) console.log(l);
  }
}

if (require.main === module) main();
module.exports = {
  projectFolder, commandKey, shellSegments, activityCategory, redactPaths, setupPrefixes, githubShapes,
  githubReadShapes, isGhWrite, GH_POLL_MIN_CALLS,
  rankFlags, flagLines, flagsMoreLine, continuedFlagLines, trendLine, fitFlags, appendFlagsMore,
  familyLine, renderDetail,
  SUMMARY_MAX_LINES, DETAIL_MAX_LINES,
  // Test-only: lets tests (activity.test.js) probe the `script run` rule's own regex in
  // isolation, without going through the whole ACTIVITY_RULES priority chain — the
  // `screenshot/image` rule (checked first) has its own, separate, still-unbounded
  // `python\S*` inside SHOT_EXEC (pre-Slice-15, out of scope here) that would otherwise
  // dominate the timing of any input built to stress SCRIPT_INTERP's own fix.
  SCRIPT_INTERP,
};
