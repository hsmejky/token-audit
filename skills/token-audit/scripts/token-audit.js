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
const CLAUDE = path.resolve(flagStr('--claude-dir', path.join(HOME, '.claude')));
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
// filter to, or null when scanning everything.
const SCOPE_PROJECT = ALL ? null : projectFolder(PROJECT_ARG !== undefined ? PROJECT_ARG : process.cwd());
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
function rateFor(model) {
  const m = model.toLowerCase();
  if (m.includes('opus-5-5') || m.includes('opus-5.5')) return ['Opus', PRICES.opus55];
  if (m.includes('opus')) return ['Opus', PRICES.opus];
  if (m.includes('fable-5-1') || m.includes('fable-5.1')) return ['Fable', PRICES.fable51];
  if (m.includes('fable-5')) return ['Fable', PRICES.fable5];
  if (m.includes('fable')) return ['Fable', PRICES.fable51];
  if (m.includes('sonnet-4-6') || m.includes('sonnet-4.6')) return ['Sonnet', PRICES.sonnet46];
  if (m.includes('sonnet')) return ['Sonnet', PRICES.sonnet];
  if (m.includes('haiku')) return ['Haiku', PRICES.haiku];
  return null;
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
  const segs = shellSegments(s)
    // `NAME=value cmd` env prefixes. A value with `$(`/`(` is not matched, so a
    // standalone `TOKEN=$(… | git credential fill)` assignment stays.
    .map(g => ({ ...g, text: g.text.replace(/\s+/g, ' ')
      .replace(/^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^\s;&|()$]*) )+(?=\S)/, '') }))
    .filter(g => g.text && !/^(?:cd|Set-Location)(?: \S+)?$/i.test(g.text)); // cwd is not the command
  s = segs.map((g, i) => (i < segs.length - 1 ? `${g.text} ${g.sep} ` : g.text)).join('');
  return s.replace(/[-]/g, ch => kept[ch.charCodeAt(0) - 0xE000]);
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
    out[open.at] = out[open.at].replace('￿', keep(`[heredoc ${hash}]`));
    open = null;
  };
  for (const line of s.split('\n')) {
    if (open) { if (line.trim() === open.tag) close(); else open.body.push(line); continue; }
    const m = /(?<!<)<<-?\s*(['"]?)([\w-]+)\1/.exec(line);
    if (!m) { out.push(line); continue; }
    const end = m.index + m[0].length;
    out.push(`${line.slice(0, end)} ￿${line.slice(end)}`);
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
// `-X val` / `-W val` (take a value), any other single-letter flag (`-u`, `-B`,
// `-O`, …), or a `py`-launcher version selector (`-3`, `-3.N`).
const PY_OPT = String.raw`(?:-X \S+|-W \S+|-[A-Za-z]|-N(?:\.N)?)`;
const WRAPPERS = String.raw`do|then|else|\{|!|time|nice|env(?: [A-Za-z_]\w*=\S*)*|timeout(?: -\S+)* \S+|` +
  String.raw`xargs(?: -\S+)*|python(?:N(?:\.N)?)?(?: ${PY_OPT})* -m|py(?: ${PY_OPT})* -m|uv run|poetry run|` +
  String.raw`npx(?: -y| --yes)?|bunx|(?:pnpm|yarn) (?:dlx|exec)|npm exec`;
// Word lists the rules share (regex alternations).
const POLLERS = String.raw`sleep|Start-Sleep|gh pr checks|gh run (?:watch|view)`;
const RUNNERS = String.raw`(?:pnpm|npm|yarn|bun)(?: -{1,2}[\w-]+(?:[ =][^\s${CMD}-]\S*)?)*(?: run| exec)? ` +
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
const SHOT_EXEC = String.raw`(?:node|python\S*|bun|deno|tsx|ts-node|bash|sh|pwsh)(?:\s+\S+)*?\s+`;
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
const WRAPPED = new RegExp(String.raw`${CMD}(${WRAPPERS}) (?!${CMD})`, 'gi');
// Key → the same text with CMD before every command start (see above).
function markCommands(key) {
  const at = [0];
  shellScan(key, (i, sep) => at.push(i + sep.length));
  let s = at.reverse().reduce((t, i) => `${t.slice(0, i)}${CMD}${t.slice(i).trimStart()}`, key);
  for (let prev; prev !== s;) { prev = s; s = s.replace(WRAPPED, `${CMD}$1 ${CMD}`); }
  return s;
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
// stays with the session where it was first seen.
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
      } else if (out > seen.out) {
        Object.assign(seen, { family, model: modelName, cost, ctx: row.ctx, out });
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
  };
}

// ------------------------------------------------------------------- flags
const DAY = 86400e3;
// LONG_AGENT thresholds (design.md Q5) — provisional, Slice 15 re-tunes both
// on real data. Named constants so re-tuning is a one-line change.
const LONG_AGENT_TURNS = 150; // "over N turns" -> strictly greater than N
const LONG_AGENT_CTX = 300e3; // "peak context > 300k" -> strictly greater than
function flags(cur, prev, cfg, span) {
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
    add('NO_RETENTION', 'cleanupPeriodDays unset — no cleanup runs, transcripts (customer code included) sit in plaintext indefinitely');
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

async function main() {
  if (!fs.existsSync(ROOT)) {
    console.error('no transcripts at ' + ROOT);
    process.exit(1);
  }
  if (SCOPE_PROJECT && !fs.existsSync(SCOPE_ROOT)) {
    console.error(`no project '${SCOPE_PROJECT}' under ${ROOT}` +
      (PROJECT_ARG !== undefined ? ` (--project ${PROJECT_ARG})` : ` (cwd ${process.cwd()})`));
    process.exit(1);
  }
  const { rows, unpriced: unprizedRows, tasks } = await collect();
  if (!rows.length && !unprizedRows.length) {
    console.error('no transcripts found in ' + ROOT);
    process.exit(1);
  }

  const now = Date.now();
  const curFrom = now - DAYS * DAY;
  const prevFrom = now - 2 * DAYS * DAY;
  const curRows = rows.filter(r => r.ts >= curFrom);
  const cur = summarize(curRows);
  const prev = summarize(rows.filter(r => r.ts >= prevFrom && r.ts < curFrom));
  const all = summarize(rows);
  // Windowed the same as SPEND (cur), not all-time — otherwise UNPRICED prints
  // all-history totals under a header that says "this window".
  const unpriced = aggregateUnpriced(unprizedRows, curFrom);
  const cfg = config();
  // spans measured over full history, not clipped to the window. Keyed by
  // (parent, sid) same as summarize() — a bare sid would collide across
  // parents for a repeated subagent id.
  const spans = new Map(all.sessions.map(s => [sessionKey(s), s.last - s.first]));
  const span = s => spans.get(sessionKey(s)) || 0;
  const fl = flags(cur, prev, cfg, span);
  const secFl = securityFlags(cfg);

  const scope = { mode: SCOPE_PROJECT ? 'project' : 'all', project: SCOPE_PROJECT };
  const det = DETAIL ? detail(cur, tasks, all, curRows) : null;

  if (JSON_OUT) {
    const trim = s => ({ ...s, sessions: s.sessions.slice(0, TOP) });
    console.log(JSON.stringify({ windowDays: DAYS, scope, cur: trim(cur), prev: trim(prev),
      all: { cost: all.cost, msgs: all.msgs, sessions: all.sessions.length },
      weeks: weeks(rows), config: cfg, flags: fl, securityFlags: secFl, unpriced,
      ...(det ? { detail: det } : {}) }, null, 2));
    return;
  }

  console.log(`TOKEN AUDIT   scope ${SCOPE_PROJECT ? SCOPE_PROJECT : 'all projects'}   ` +
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
    for (const u of unpriced)
      console.log(`  ${u.model.padEnd(28)} rows=${String(u.rows).padStart(6)}  tokens=${(u.tokens / 1e6).toFixed(2)}M`);
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
module.exports = { projectFolder, commandKey, shellSegments, activityCategory };
