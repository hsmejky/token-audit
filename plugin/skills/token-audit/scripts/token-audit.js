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
//   C:\Users\jdoe\demo-proj  ->  C--Users-jdoe-demo-proj  (colon AND the
//                                 backslash after it each become their own
//                                 `-`, hence the doubled dash)
//   /Users/jdoe/demo-proj    ->  -Users-jdoe-demo-proj
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
// a different PR number, commit, path or cwd groups together (design.md Q9).
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

// Tool call → activity category (design.md Q9). ONE table, first match wins,
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
// `-{1,2}[\w]…`, not `-{1,2}[\w-]…`: a flag's leading dashes and its name must not both
// be able to absorb `-`, or a repeated `--a --a --a …` has many ways to split the same
// run of dashes between the two and the engine tries them all (exponential; Slice 30).
const RUNNERS = String.raw`(?:pnpm|npm|yarn|bun)(?: -{1,2}\w[\w-]*(?:[ =][^\s${CMD}-]\S*)?)*(?: run| exec)? ` +
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
const SHOT_EXEC = String.raw`(?:node|python\S*|bun|deno|tsx|ts-node|bash|sh|pwsh)(?:\s+[^\s${CMD}]+)*?\s+`;
const SHOT_TARGET = String.raw`[^\s${CMD}]*(?:screenshot[\w.-]*\.(?:m?js|ts|py|sh)\b|\.screenshot\()`;
const SHOT_RUN = String.raw`${CMD}(?:${SHOT_EXEC})?${SHOT_TARGET}`;
const rx = (strings, ...vals) => new RegExp(String.raw(strings, ...vals), 'i');
const ACTIVITY_RULES = [
  [rx`^(?:Agent|Task|SendMessage) `, 'agent spawn'],
  [rx`^(?:WebFetch|WebSearch) `, 'web'],
  [rx`${IMAGE}|^\S*screenshot\S* |${SHOT_RUN}`, 'screenshot/image'],
  [rx`^(?:Monitor|TaskOutput|BashOutput) |${CMD}(?:${POLLERS})\b|check-runs|actions/runs`, 'wait/poll'],
  [rx`api\.github\.com|${CMD}gh `, 'github'],
  [rx`${CMD}(?:${RUNNERS}|${CHECKERS})\b`, 'test/lint/build'],
  [rx`${CMD}git\b`, 'git'],
  [rx`^(?:Edit|Write|MultiEdit|NotebookEdit) |${CMD}(?:sed -i|cat >|tee )`, 'edit'],
  [rx`^(?:Read|Grep|Glob) |${CMD}(?:${READERS})\b`, 'read'],
];
const ACTIVITY_OTHER = 'other';
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
  shellScan(key, (i, sep) => at.push(i + sep.length));
  const pieces = [];
  for (let k = 0; k < at.length; k++) {
    const start = at[k];
    const end = k + 1 < at.length ? at[k + 1] : key.length;
    const seg = key.slice(start, end);
    pieces.push(CMD, k === 0 ? seg : seg.replace(/^\s+/, ''));
  }
  const s = pieces.join('');

  const out = [];
  let i = 0;
  while (i < s.length) {
    const mark = s.indexOf(CMD, i);
    if (mark < 0) { out.push(s.slice(i)); break; }
    out.push(s.slice(i, mark), CMD);
    i = mark + 1;
    for (;;) {
      WRAP_RE.lastIndex = i;
      const m = WRAP_RE.exec(s);
      if (!m || s[WRAP_RE.lastIndex] === CMD) break;
      out.push(m[0], CMD);
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
  const cats = new Map([...ACTIVITY_RULES.map(([, c]) => c), ACTIVITY_OTHER]
    .map(c => [c, { category: c, turns: 0, ctx: 0, cost: 0 }]));
  let total = 0;
  for (const r of rows) {
    total += r.cost;
    const hit = r.calls.length ? r.calls.map(categorize) : [ACTIVITY_OTHER];
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
  const msgCounts = list.map(s => s.msgs).sort((a, b) => a - b);
  const pick = q => quantile(msgCounts, q); // shared with subagentDistribution() below

  return {
    cost, msgs, byFamily, byChain, sessions: list,
    avgCtx: msgs ? ctx / msgs : 0,
    costPerMsg: msgs ? cost / msgs : 0,
    medianMsgs: pick(0.5), p90Msgs: pick(0.9),
    topShare: cost ? list.slice(0, 5).reduce((a, s) => a + s.cost, 0) / cost : 0,
    longShare: cost ? list.filter(s => s.msgs >= 250).reduce((a, s) => a + s.cost, 0) / cost : 0,
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
// transcripts was the alternative (design.md/plan.md Slice 14) but undercounts
// (a server usually exposes more tools than were ever called) and reads zero
// for a configured-but-unused server — exactly the "paying for it, not using
// it" case this line exists to surface. So: a flat per-server estimate,
// clearly labelled as an estimate. ~6-10 tools/server typical, ~100-150 tok
// each (name + JSON-schema description) -> ~800 tok/server, rounded.
const MCP_SERVER_TOKENS = 800;

// Configured MCP servers for the scoped project, from the three places Claude
// Code stores them (design.md Q9 / plan.md Slice 14):
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
// LONG_AGENT thresholds (design.md Q5) — provisional, Slice 15 re-tunes both
// on real data. Named constants so re-tuning is a one-line change.
const LONG_AGENT_TURNS = 150; // "over N turns" -> strictly greater than N
const LONG_AGENT_CTX = 300e3; // "peak context > 300k" -> strictly greater than
// POLLING threshold (design.md Q9) — provisional, Slice 15 re-tunes it.
const POLL_MIN_CALLS = 20; // same command key >= N calls in one session
// Categories whose repeat is a wait. A repeated test run, commit or edit is
// the work itself, not polling (Slice 11 real-data check: those were most of
// the false positives). See REFERENCE.md "POLLING".
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
// as a whole word (not inside `January`), so short or common names don't over-redact.
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
// BOILERPLATE threshold (design.md Q9) — provisional, Slice 15 re-tunes it.
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
function flags(cur, prev, cfg, span, polls = [], boiler = { groups: [] }) {
  const out = [];
  const add = (id, text) => out.push({ id, text });

  const multiday = cur.sessions.filter(s => span(s) > DAY);
  if (multiday.length) {
    const w = multiday.slice().sort((a, b) => b.cost - a.cost)[0];
    add('MULTIDAY', `${multiday.length} session(s) span >1 day — worst ${w.sid.slice(0, 8)} ` +
      `${(span(w) / DAY).toFixed(1)}d ${money(w.cost)}`);
  }
  const long = cur.sessions.filter(s => s.msgs >= 250);
  if (long.length) {
    add('LONG_SESSION', `${long.length} session(s) ≥250 msgs = ${(100 * cur.longShare).toFixed(0)}% of spend`);
  }
  // Subagents over LONG_AGENT_TURNS turns or with a peak context over
  // LONG_AGENT_CTX — the main lever design.md Q5 identifies. Share is of
  // this window's total spend (cur.cost), same meaning as LONG_SESSION's share.
  const longAgents = cur.sessions.filter(s =>
    s.isSub && (s.msgs > LONG_AGENT_TURNS || s.ctxMax > LONG_AGENT_CTX));
  if (longAgents.length) {
    const share = cur.cost ? longAgents.reduce((a, s) => a + s.cost, 0) / cur.cost : 0;
    add('LONG_AGENT', `${longAgents.length} subagent(s) over ${LONG_AGENT_TURNS} turns or ` +
      `${(LONG_AGENT_CTX / 1e3).toFixed(0)}k peak ctx = ${(100 * share).toFixed(0)}% of spend`);
  }
  if (polls.length) {
    const cost = polls.reduce((a, g) => a + g.cost, 0);
    const share = polls.reduce((a, g) => a + g.share, 0);
    const head = `${polls.length} run(s) ≥${POLL_MIN_CALLS}×/session = ${money(cost)}, ` +
      `${sharePct(share)} of spend; top ${polls[0].count}× `;
    out.push({ id: 'POLLING', text: head + fitMiddle(polls[0].key, FLAG_TEXT_WIDTH - head.length),
      groups: polls });
  }
  const boilers = boiler.groups;
  if (boilers.length) {
    const { cost, share } = boiler;
    const b = boilers[0];
    const head = `${boilers.length} prefix(es) = ${money(cost)}, ${sharePct(share)} of spend; ` +
      `top ${b.sessions} sess/${b.turns} turns `;
    out.push({ id: 'BOILERPLATE', text: head + fitPrefix(b.prefix, FLAG_TEXT_WIDTH - head.length),
      groups: boilers });
  }
  if (cur.avgCtx > 150e3) {
    add('BIG_CTX', `avg context/message ${(cur.avgCtx / 1e3).toFixed(0)}k (threshold 150k)`);
  }
  if (cur.topShare > 0.5) {
    add('CONCENTRATION', `top 5 sessions = ${(100 * cur.topShare).toFixed(0)}% of spend`);
  }
  if (prev && prev.costPerMsg > 0 && cur.costPerMsg > prev.costPerMsg * 1.25) {
    add('REGRESSION', `cost/message +${(100 * (cur.costPerMsg / prev.costPerMsg - 1)).toFixed(0)}% vs previous window`);
  }
  if (cur.opusShare > 0.9) {
    add('OPUS_HEAVY', `Opus = ${(100 * cur.opusShare).toFixed(0)}% of spend — no model-per-phase split visible`);
  }
  if (cfg.agentDefs > 20 || cfg.prefixTokens > 5000) {
    add('PLUGIN_BLOAT', `${cfg.agentDefs} agent + ${cfg.skillDefs} skill definitions ≈ ` +
      `${(cfg.prefixTokens / 1e3).toFixed(1)}k tokens in every request prefix ` +
      `(worst: ${cfg.plugins.slice(0, 3).map(p => p.name.split('/').pop()).join(', ')})`);
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
const TOP_SUBAGENTS = 10;
const TASK_WIDTH = 70;
const TOP_UNITS = 10;
const TOP_ACTIVITIES = 6;

// A "work unit" = one main (non-sub) session rolled up with the subagents it
// spawned (sub.parent === main.sid), per design.md Q3. Keyed by main sid so a
// main session with no subagent rows still forms its own unit (sub 0%); a
// subagent whose parent main session has no priced turns in this window (rare
// — e.g. the main thread was entirely outside the window) still rolls up
// under its parent id, giving an orphan unit with mainCost 0.
// `turns` = total msgs across every session in the unit (main + all its
// subagents) — the unit's total turn volume, matching how `cost` is a sum.
// `peakCtx` = the single largest context hit by any session in the unit.
// `span` = full-history first-seen -> last-seen across every session in the
// unit (not clipped to the window, same convention as the per-session `span`
// used in TOP SESSIONS) — looked up from `all`, not `cur`, so a unit whose
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

// Distribution of subagent turns and peak context, per design.md Q3. Spec
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
function renderDetail(d) {
  return ['DETAIL', ...DETAIL_SECTIONS.flatMap(section => section(d))];
}

// ------------------------------------------------------------ redacted view
// Every printed field that can carry a path or the user's identity (scope, project
// folders, subagent task text, model / plugin / MCP server names) goes through
// redactPaths(), in text and --json alike (Slice 29). Grouping and keys ran on the
// raw values; only the copies that get printed are rewritten.
const shown = new Map();
const show = v => {
  if (typeof v !== 'string') return v;
  if (!shown.has(v)) shown.set(v, redactPaths(v));
  return shown.get(v);
};
const showSessions = sum => ({ ...sum,
  sessions: sum.sessions.map(s => ({ ...s, project: show(s.project), model: show(s.model) })) });
const showConfig = c => ({ ...c, model: show(c.model),
  modelEffort: c.modelEffort.map(m => ({ ...m, model: show(m.model) })),
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
  // Windowed the same as SPEND (cur), not all-time — otherwise UNPRICED prints
  // all-history totals under a header that says "this window".
  const unpriced = aggregateUnpriced(unprizedRows, curFrom).map(u => ({ ...u, model: show(u.model) }));
  const cfg = showConfig(config());
  // spans measured over full history, not clipped to the window. Keyed by
  // (parent, sid) same as summarize() — a bare sid would collide across
  // parents for a repeated subagent id.
  const spans = new Map(all.sessions.map(s => [sessionKey(s), s.last - s.first]));
  const span = s => spans.get(sessionKey(s)) || 0;
  const fl = flags(cur, prev, cfg, span, polling(curRows), boilerplate(curRows));
  const secFl = securityFlags(cfg);

  const scope = { mode: SCOPE_PROJECT ? 'project' : 'all', project: show(SCOPE_PROJECT) };
  const det = DETAIL ? showDetail(detail(cur, tasks, all, curRows)) : null;

  if (JSON_OUT) {
    const trim = s => ({ ...s, sessions: s.sessions.slice(0, TOP) });
    console.log(JSON.stringify({ windowDays: DAYS, scope, cur: trim(cur), prev: trim(prev),
      all: { cost: all.cost, msgs: all.msgs, sessions: all.sessions.length },
      weeks: weeks(rows), config: cfg, flags: fl, securityFlags: secFl, unpriced,
      ...(det ? { detail: det } : {}) }, null, 2));
    return;
  }

  console.log(`TOKEN AUDIT   scope ${scope.project || 'all projects'}   ` +
    `window ${date(curFrom)} → ${date(now)} (${DAYS}d)   list-price equivalent`);
  console.log('');
  console.log(`SPEND        ${money(cur.cost)}   prev window ${money(prev.cost)}` +
    (prev.cost ? `  ${cur.cost >= prev.cost ? '+' : ''}${(100 * (cur.cost / prev.cost - 1)).toFixed(0)}%` : ''));
  for (const [f, v] of Object.entries(cur.byFamily).sort((a, b) => b[1] - a[1]))
    console.log(`  ${f.padEnd(8)} ${money(v).padStart(8)}  ${pct(v / cur.cost)}`);
  console.log(`  main ${money(cur.byChain.main)} (${pct(cur.byChain.main / (cur.cost || 1))})   ` +
    `subagents ${money(cur.byChain.sub)} (${pct(cur.byChain.sub / (cur.cost || 1))})`);
  if (unpriced.length) {
    const totTok = unpriced.reduce((a, u) => a + u.tokens, 0);
    console.log(`UNPRICED     ${unpriced.length} model(s), ${(totTok / 1e6).toFixed(2)}M tokens not in pricing table`);
    for (const u of unpriced) {
      console.log(`  ${fit(u.model, 28).padEnd(28)} rows=${String(u.rows).padStart(6)}  ` +
        `tokens=${(u.tokens / 1e6).toFixed(2)}M`);
      const name = fit(u.model, 40);
      console.log(`  WARNING: unknown model '${name}' -- add its price to PRICES + REFERENCE.md`);
    }
  }
  console.log('');
  console.log(`PER MESSAGE  ctx ${k(cur.avgCtx)} avg   cost ${money(cur.costPerMsg)}` +
    (prev.msgs ? `   prev ${k(prev.avgCtx)} / ${money(prev.costPerMsg)}` : ''));
  console.log(`SESSIONS     ${cur.sessions.length}   median ${cur.medianMsgs} msgs   p90 ${cur.p90Msgs}   ` +
    `≥250 msgs: ${cur.sessions.filter(s => s.msgs >= 250).length}`);
  console.log(`ALL-TIME     ${money(all.cost)} over ${all.sessions.length} sessions, ${all.msgs} messages`);
  console.log('');

  console.log(`TOP ${TOP} SESSIONS (this window)`);
  for (const s of cur.sessions.slice(0, TOP)) {
    const sp = span(s) > 0 ? (span(s) / DAY).toFixed(1) + 'd' : '<1d';
    console.log(`  ${s.sid.slice(0, 8)}  ${money(s.cost).padStart(7)}  ${pct(s.cost / cur.cost).padStart(6)}  ` +
      `msgs=${String(s.msgs).padStart(4)}  avgCtx=${k(s.ctx / s.msgs).padStart(5)}  ` +
      `maxCtx=${k(s.ctxMax).padStart(5)}  span=${sp.padStart(5)}  ${s.isSub ? 'sub ' : ''}${s.project}`);
  }
  console.log('');

  console.log('WEEKS (all history)');
  for (const w of weeks(rows))
    console.log(`  ${w.week}  ${String(w.sessions).padStart(4)} sess  ${money(w.cost).padStart(8)}  ` +
      `ctx ${k(w.avgCtx).padStart(5)}/msg  ${money(w.costPerMsg)}/msg`);
  console.log('');

  console.log('CONFIG');
  const effortText = cfg.modelEffort.length
    ? [...cfg.modelEffort.map(m => `${m.model}=${m.effortLevel}`),
        ...(cfg.effortLevel ? [`default=${cfg.effortLevel}`] : [])].join(', ')
    : (cfg.effortLevel ?? 'unset');
  console.log(`  model=${cfg.model}   cleanupPeriodDays=${cfg.cleanupPeriodDays ?? 'unset'}   ` +
    `effortLevel=${effortText}`);
  console.log(`  plugins=${cfg.pluginCount}   agent defs=${cfg.agentDefs}   skill defs=${cfg.skillDefs}   ` +
    `fixed prefix ≈${(cfg.prefixTokens / 1e3).toFixed(1)}k tok/request`);
  for (const p of cfg.plugins.filter(p => p.prefixTokens >= 200))
    console.log(`    ${p.name.padEnd(40)} ${String(p.agents).padStart(3)} agents ` +
      `${String(p.skills).padStart(3)} skills  ≈${(p.prefixTokens / 1e3).toFixed(1)}k tok`);
  if (cfg.mcpServers.length) {
    console.log(`  mcp servers=${cfg.mcpServers.length}   ` +
      `est. prefix ≈${(cfg.mcpPrefixTokens / 1e3).toFixed(1)}k tok/request`);
    for (const s of cfg.mcpServers)
      console.log(`    ${s.name.padEnd(30)} ${s.scope}`);
  }
  console.log('');

  console.log('FLAGS');
  for (const f of fl) console.log(`  ${f.id.padEnd(14)} ${f.text}`);
  console.log('');

  console.log('SECURITY (confidentiality, not cost)');
  if (secFl.length) {
    for (const f of secFl) console.log(`  ${f.id.padEnd(14)} ${f.text}`);
  } else {
    console.log('  none');
  }

  if (det) {
    console.log('');
    for (const l of renderDetail(det)) console.log(l);
  }
}

if (require.main === module) main();
module.exports = { projectFolder, commandKey, shellSegments, activityCategory, redactPaths, setupPrefixes };
