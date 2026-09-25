#!/usr/bin/env node
// token-audit — spend + usage audit over local Claude Code transcripts.
// Node, no deps.  Usage: node token-audit.js [--days N] [--top N] [--json] [--claude-dir DIR]
// Tests: `node --test` from the repo root (fixtures in tests/fixtures/).
//
// Costs are LIST-PRICE EQUIVALENTS (Claude API $/MTok). On Pro/Max nothing is
// billed per token — the number is a proxy for what eats the plan limit.

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

const HOME = process.env.USERPROFILE || process.env.HOME;
const CLAUDE = path.resolve(flagStr('--claude-dir', path.join(HOME, '.claude')));
const ROOT = path.join(CLAUDE, 'projects');

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
  for (const f of walk(ROOT)) {
    const dir = path.dirname(f);
    const isSub = path.basename(dir) === 'subagents';
    // main:     projects/<project>/<session>.jsonl              → dir = <project>
    // subagent: projects/<project>/<session-uuid>/subagents/agent-*.jsonl → dir = .../subagents,
    //           so project is two levels up and the session-uuid dir name is the parent session id.
    const project = path.basename(isSub ? path.dirname(path.dirname(dir)) : dir);
    const parent = isSub ? path.basename(path.dirname(dir)) : null;
    const sid = path.basename(f, '.jsonl');
    const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
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
      const row = { ts, sid, project, isSub, parent, family, cost, ctx: read + ccTotal, out };
      const id = j.message.id;
      const seen = id && byId.get(id);
      if (!seen) {
        if (id) byId.set(id, row); // no id → can't dedupe, count the line as is
        rows.push(row);
      } else if (out > seen.out) {
        Object.assign(seen, { family, cost, ctx: row.ctx, out });
      }
    }
  }
  return { rows, unpriced };
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

// -------------------------------------------------------------- summarize
function summarize(rows) {
  const byFamily = {};
  const byChain = { main: 0, sub: 0 };
  const sessions = new Map();
  let cost = 0, ctx = 0;

  for (const r of rows) {
    cost += r.cost;
    ctx += r.ctx;
    byFamily[r.family] = (byFamily[r.family] || 0) + r.cost;
    byChain[r.isSub ? 'sub' : 'main'] += r.cost;
    let s = sessions.get(r.sid);
    if (!s) {
      s = { sid: r.sid, project: r.project, isSub: r.isSub, parent: r.parent, cost: 0, msgs: 0, ctx: 0,
            ctxMax: 0, first: r.ts || Infinity, last: r.ts || 0, opus: 0 };
      sessions.set(r.sid, s);
    }
    s.cost += r.cost;
    s.msgs++;
    s.ctx += r.ctx;
    if (r.ctx > s.ctxMax) s.ctxMax = r.ctx;
    if (r.ts) { s.first = Math.min(s.first, r.ts); s.last = Math.max(s.last, r.ts); }
    if (r.family === 'Opus') s.opus += r.cost;
  }

  const list = [...sessions.values()].sort((a, b) => b.cost - a.cost);
  const msgs = rows.length;
  const msgCounts = list.map(s => s.msgs).sort((a, b) => a - b);
  const pick = q => msgCounts.length ? msgCounts[Math.min(msgCounts.length - 1, Math.floor(q * msgCounts.length))] : 0;

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

  return {
    model: settings.model || '(unset — harness default)',
    cleanupPeriodDays: settings.cleanupPeriodDays,
    effortLevel: settings.effortLevel || (settings.env && settings.env.EFFORT_LEVEL) || null,
    pluginCount: plugins.length,
    agentDefs,
    skillDefs,
    prefixTokens: Math.round(prefixChars / 4),
    plugins: plugins.sort((a, b) => b.prefixTokens - a.prefixTokens),
  };
}

// ------------------------------------------------------------------- flags
const DAY = 86400e3;
function flags(cur, prev, cfg, span) {
  const out = [];
  const add = (id, text) => out.push({ id, text });

  const multiday = cur.sessions.filter(s => span(s.sid) > DAY);
  if (multiday.length) {
    const w = multiday.slice().sort((a, b) => b.cost - a.cost)[0];
    add('MULTIDAY', `${multiday.length} session(s) span >1 day — worst ${w.sid.slice(0, 8)} ` +
      `${(span(w.sid) / DAY).toFixed(1)}d ${money(w.cost)}`);
  }
  const long = cur.sessions.filter(s => s.msgs >= 250);
  if (long.length) {
    add('LONG_SESSION', `${long.length} session(s) ≥250 msgs = ${(100 * cur.longShare).toFixed(0)}% of spend`);
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

(async () => {
  if (!fs.existsSync(ROOT)) {
    console.error('no transcripts at ' + ROOT);
    process.exit(1);
  }
  const { rows, unpriced: unprizedRows } = await collect();
  if (!rows.length && !unprizedRows.length) {
    console.error('no transcripts found in ' + ROOT);
    process.exit(1);
  }

  const now = Date.now();
  const curFrom = now - DAYS * DAY;
  const prevFrom = now - 2 * DAYS * DAY;
  const cur = summarize(rows.filter(r => r.ts >= curFrom));
  const prev = summarize(rows.filter(r => r.ts >= prevFrom && r.ts < curFrom));
  const all = summarize(rows);
  // Windowed the same as SPEND (cur), not all-time — otherwise UNPRICED prints
  // all-history totals under a header that says "this window".
  const unpriced = aggregateUnpriced(unprizedRows, curFrom);
  const cfg = config();
  // spans measured over full history, not clipped to the window
  const spans = new Map(all.sessions.map(s => [s.sid, s.last - s.first]));
  const span = sid => spans.get(sid) || 0;
  const fl = flags(cur, prev, cfg, span);
  const secFl = securityFlags(cfg);

  if (JSON_OUT) {
    const trim = s => ({ ...s, sessions: s.sessions.slice(0, TOP) });
    console.log(JSON.stringify({ windowDays: DAYS, cur: trim(cur), prev: trim(prev),
      all: { cost: all.cost, msgs: all.msgs, sessions: all.sessions.length },
      weeks: weeks(rows), config: cfg, flags: fl, securityFlags: secFl, unpriced }, null, 2));
    return;
  }

  console.log(`TOKEN AUDIT   window ${date(curFrom)} → ${date(now)} (${DAYS}d)   list-price equivalent`);
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
    const sp = span(s.sid) > 0 ? (span(s.sid) / DAY).toFixed(1) + 'd' : '<1d';
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
  console.log(`  model=${cfg.model}   cleanupPeriodDays=${cfg.cleanupPeriodDays ?? 'unset'}   ` +
    `effortLevel=${cfg.effortLevel ?? 'unset'}`);
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
})();
