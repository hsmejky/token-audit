const test = require('node:test');
const assert = require('node:assert/strict');
const { audit, auditText, tmpClaudeDir, turn, turns } = require('./harness');

// Real subagent layout: next to each agent-*.jsonl, Claude Code writes an
// agent-*.meta.json whose `description` is the parent's Agent tool_use
// `description` (the short label the spawner gave the task).
const SUB = 'projects/p/3ac91e04-uuid/subagents/agent-a5f00ba7';
const userLine = content => ({ type: 'user', isSidechain: true, timestamp: '2026-09-01T09:59:00.000Z',
  message: { role: 'user', content } });

// Lines of the DETAIL block (from the DETAIL header to end of output).
const detailLines = out => {
  const lines = out.split('\n');
  const i = lines.indexOf('DETAIL');
  return i < 0 ? [] : lines.slice(i).filter(l => l.trim());
};

test('DETAIL top subagents row shows the task text, not the agent id', () => {
  const dir = tmpClaudeDir({
    'projects/p/3ac91e04-uuid.jsonl': turn({ id: 'main-1' }),
    [SUB + '.jsonl']: [userLine('Repo /x. Implement slice 14g.'), ...turns(3, 'sub')],
    [SUB + '.meta.json']: { agentType: 'general-purpose', description: 'Implement slice 14g' },
  });
  const detail = detailLines(auditText(dir));
  const row = detail.find(l => l.includes('Implement slice 14g'));
  assert.ok(row, `expected a DETAIL row with the task text, got:\n${detail.join('\n')}`);
  assert.ok(!row.includes('agent-a5'), `row must not show the agent id: ${row}`);
  assert.match(row, /\s3\s.*opus-5-5\s+3ac91e04\s+Implement/, `turns, short model, 8-char parent: ${row}`);
  assert.ok(!row.includes('3ac91e04-uuid'), `parent id cut to 8 chars: ${row}`);
});

test('no meta.json description -> task = first non-empty line of the first user prompt', () => {
  const dir = tmpClaudeDir({
    [SUB + '.jsonl']: [userLine('\n  Review slice 4 in repo token-audit.\nDetails follow...'), ...turns(2, 'sub')],
    [SUB + '.meta.json']: { agentType: 'general-purpose' },
  });
  const [top] = audit(dir).detail.topSubagents;
  assert.equal(top.task, 'Review slice 4 in repo token-audit.');
  assert.equal(top.sid, 'agent-a5f00ba7');
  assert.equal(top.parent, '3ac91e04-uuid');
  assert.equal(top.turns, 2);
});

test('no meta.json at all, attachment line first, array content -> task from the first user text part', () => {
  const dir = tmpClaudeDir({
    [SUB + '.jsonl']: [
      { type: 'attachment', isSidechain: true, attachment: { type: 'instructions' } },
      userLine([{ type: 'text', text: 'Audit sample-metrics progress' }]),
      ...turns(1, 'sub'),
    ],
  });
  assert.equal(audit(dir).detail.topSubagents[0].task, 'Audit sample-metrics progress');
});

test('DETAIL lines <= 120 chars; long task text cut at 70 chars with an ellipsis', () => {
  const long = 'Skřítek 4c truhly: hlídání zapomenutého sklepa plného spletitých run, ' +
    'a ještě mnohem delší popis pohádky, která se do políčka nevejde';
  const dir = tmpClaudeDir({
    [SUB + '.jsonl']: turns(3, 'sub', { model: 'claude-sonnet-4-6-extended-preview-20260101' }),
    [SUB + '.meta.json']: { description: long },
  });
  const detail = detailLines(auditText(dir));
  for (const l of detail) assert.ok([...l].length <= 120, `line too long (${[...l].length}): ${l}`);
  const row = detail.find(l => l.includes('Skřítek 4c'));
  assert.ok(row, `expected a row with the task, got:\n${detail.join('\n')}`);
  const task = row.slice(row.indexOf('Skřítek 4c'));
  assert.equal([...task].length, 70);
  assert.ok(task.endsWith('…'), `cut task must end with an ellipsis: ${task}`);
  assert.ok(long.startsWith(task.slice(0, -1)), 'cut text is a prefix of the original');
});

test('--no-detail prints the summary only: default output minus the DETAIL block', () => {
  const dir = tmpClaudeDir({
    'projects/p/3ac91e04-uuid.jsonl': turn({ id: 'main-1' }),
    [SUB + '.jsonl']: turns(2, 'sub'),
    [SUB + '.meta.json']: { description: 'Implement slice 14g' },
  });
  const full = auditText(dir);
  const compact = auditText(dir, '--no-detail');
  assert.ok(!compact.split('\n').includes('DETAIL'), 'no DETAIL header with --no-detail');
  assert.ok(!compact.includes('Implement slice 14g'));
  assert.equal(compact.trimEnd(), full.slice(0, full.indexOf('\nDETAIL\n')).trimEnd(),
    'summary part must be identical with and without DETAIL');
  assert.equal(audit(dir, '--no-detail').detail, undefined, '--json omits detail with --no-detail');
});

test('top subagents: at most 10, by cost desc, subagents only, with model / turns / peak ctx / cost', () => {
  const files = { 'projects/p/main-sess.jsonl': turns(50, 'main') };
  for (let i = 1; i <= 12; i++) {
    const base = `projects/p/main-sess/subagents/agent-${String(i).padStart(2, '0')}`;
    files[base + '.jsonl'] = turns(i, `s${i}`, { model: i % 2 ? 'claude-opus-5-5' : 'claude-sonnet-4-6',
      usage: { input_tokens: 0, cache_read_input_tokens: 1000 * i, output_tokens: 0 } });
    files[base + '.meta.json'] = { description: `task ${i}` };
  }
  const top = audit(tmpClaudeDir(files)).detail.topSubagents;
  assert.equal(top.length, 10);
  assert.ok(top.every(a => a.parent === 'main-sess'), 'main sessions are not listed');
  const costs = top.map(a => a.cost);
  assert.deepEqual(costs, [...costs].sort((a, b) => b - a), 'sorted by cost desc');
  const t12 = top.find(a => a.sid === 'agent-12');
  assert.deepEqual({ task: t12.task, model: t12.model, turns: t12.turns, peakCtx: t12.peakCtx },
    { task: 'task 12', model: 'claude-sonnet-4-6', turns: 12, peakCtx: 12000 });
});

test('same agent id under two parents keeps each own task text', () => {
  const dir = tmpClaudeDir({
    'projects/p/parent-aaa/subagents/agent-x.jsonl': turns(1, 'a'),
    'projects/p/parent-aaa/subagents/agent-x.meta.json': { description: 'first run' },
    'projects/p/parent-bbb/subagents/agent-x.jsonl': turns(2, 'b'),
    'projects/p/parent-bbb/subagents/agent-x.meta.json': { description: 'second run' },
  });
  const byParent = Object.fromEntries(audit(dir).detail.topSubagents.map(a => [a.parent, a.task]));
  assert.deepEqual(byParent, { 'parent-aaa': 'first run', 'parent-bbb': 'second run' });
});

test('WORK UNITS: parent + 2 subagents roll up into one unit, cost = sum, main/sub split correct', () => {
  const dir = tmpClaudeDir({
    'projects/p/3ac91e04-uuid.jsonl': turns(4, 'main', { usage: { input_tokens: 1000, output_tokens: 0 } }),
    [SUB + '.jsonl']: turns(3, 'sub-a', { usage: { input_tokens: 1000, output_tokens: 0 } }),
    [SUB + '.meta.json']: { description: 'first agent' },
    'projects/p/3ac91e04-uuid/subagents/agent-second.jsonl':
      turns(2, 'sub-b', { usage: { input_tokens: 1000, output_tokens: 0 } }),
    'projects/p/3ac91e04-uuid/subagents/agent-second.meta.json': { description: 'second agent' },
  });
  const { units } = audit(dir).detail;
  assert.equal(units.length, 1);
  const [u] = units;
  assert.equal(u.agents, 2);
  assert.equal(u.turns, 4 + 3 + 2);
  // All 9 turns share the same usage and model (opus-5-5, $4/MTok input, 1000 input
  // tokens, no cache/output) so every turn costs exactly the same: 1000 * 4 / 1e6.
  // Exact numbers below pin the split so the test fails if subCost were ever
  // double-counted (e.g. 2x sub turns would give subShare 10/14, not 5/9).
  const singleTurnCost = 1000 * 4 / 1e6;
  const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: got ${a}, want ${b}`);
  close(u.mainCost, 4 * singleTurnCost, 'mainCost = 4 main turns');
  close(u.subCost, 5 * singleTurnCost, 'subCost = 5 sub turns (3 + 2), not double-counted');
  close(u.cost, 9 * singleTurnCost, 'cost = mainCost + subCost');
  close(u.subShare, 5 / 9, 'subShare = subCost / cost, exactly 5/9');
});

test('WORK UNITS: session with no subagents -> unit with sub 0%', () => {
  const dir = tmpClaudeDir({ 'projects/p/solo-sess.jsonl': turns(5, 'solo') });
  const { units } = audit(dir).detail;
  assert.equal(units.length, 1);
  assert.equal(units[0].agents, 0);
  assert.equal(units[0].subShare, 0);
  assert.equal(units[0].subCost, 0);
});

test('WORK UNITS: peak ctx = max context across main + subs; span = full-history first..last', () => {
  // sub-0 is timestamped *after* main-1 (not between main-0 and main-1) so the
  // span assertion below only passes if the subagent's own last-seen timestamp
  // is folded into the unit's span. If the code only looked at the main
  // session's first/last (ignoring the subagent's), span would stop at
  // main-1 (09-05) and this test would fail.
  const dir = tmpClaudeDir({
    'projects/p/3ac91e04-uuid.jsonl': [
      turn({ id: 'main-0', ts: '2026-09-01T09:00:00.000Z',
             usage: { input_tokens: 0, cache_read_input_tokens: 2000, output_tokens: 0 } }),
      turn({ id: 'main-1', ts: '2026-09-05T09:00:00.000Z',
             usage: { input_tokens: 0, cache_read_input_tokens: 5000, output_tokens: 0 } }),
    ].flat(),
    [SUB + '.jsonl']: turn({ id: 'sub-0', ts: '2026-09-10T09:00:00.000Z',
      usage: { input_tokens: 0, cache_read_input_tokens: 9000, output_tokens: 0 } }),
    [SUB + '.meta.json']: { description: 'peak/span agent' },
  });
  const { units } = audit(dir).detail;
  assert.equal(units.length, 1);
  const [u] = units;
  assert.equal(u.peakCtx, 9000, 'peak ctx = largest single context hit by any session in the unit');
  const expectedSpan = Date.parse('2026-09-10T09:00:00.000Z') - Date.parse('2026-09-01T09:00:00.000Z');
  assert.equal(u.span, expectedSpan,
    'span = full-history first-seen -> last-seen across the unit, including the subagent');
});

test('WORK UNITS: span covers full history back past a narrow --days window', () => {
  // The main session's first turn is years before the window; only its
  // second turn ("recent") falls inside a 7-day --days window. If `allByKey`
  // (used to look up full-history first/last) were built from cur.sessions
  // instead of all.sessions, the lookup would only see the windowed turn and
  // span would collapse to ~0 instead of spanning back to 2020.
  const dir = tmpClaudeDir({
    'projects/p/3ac91e04-uuid.jsonl': [
      ...turn({ id: 'old', ts: '2020-01-01T00:00:00.000Z' }),
      ...turn({ id: 'recent', ts: new Date().toISOString() }),
    ],
  });
  const { units } = audit(dir, '--days', '7').detail;
  assert.equal(units.length, 1);
  const [u] = units;
  const oneYear = 365 * 24 * 60 * 60 * 1000;
  assert.ok(u.span > oneYear,
    `span must reach back to the session's real first-seen turn (2020), not the 7-day window: got ${u.span}ms`);
});

test('WORK UNITS: subagent with no main-session rows forms an orphan unit keyed by parent id', () => {
  const dir = tmpClaudeDir({
    [SUB + '.jsonl']: turns(3, 'sub-only', { usage: { input_tokens: 1000, output_tokens: 0 } }),
    [SUB + '.meta.json']: { description: 'orphan agent' },
  });
  const { units } = audit(dir).detail;
  assert.equal(units.length, 1);
  const [u] = units;
  assert.equal(u.key, '3ac91e04-uuid', 'orphan unit keyed by the parent id, no main session exists');
  assert.equal(u.mainCost, 0);
  assert.equal(u.agents, 1);
  // opus-5-5 $4/MTok input, 1000 input tokens/turn, 3 sub turns, no cache/output.
  const singleTurnCost = 1000 * 4 / 1e6;
  assert.equal(u.subCost, 3 * singleTurnCost, 'subCost = exactly 3 sub turns, not inflated or zeroed');
  assert.equal(u.cost, u.subCost, 'cost = subCost only, mainCost is 0');
});

test('WORK UNITS: subagent orphans under parent id when the main session exists but is ' +
  'entirely outside the window', () => {
  // Unlike the "no main file at all" case above, here the main session is real
  // and in history (`all.sessions`), but every one of its turns predates the
  // --days window, so it has zero rows in `cur` and never gets its own unit
  // via the cur.sessions loop. Per REFERENCE.md, the subagent (whose turns
  // are inside the window) must still roll up under the parent id, mainCost 0.
  const dir = tmpClaudeDir({
    'projects/p/3ac91e04-uuid.jsonl': turn({ id: 'old-main', ts: '2020-01-01T00:00:00.000Z' }),
    [SUB + '.jsonl']: turns(3, 'sub-only', { ts: new Date().toISOString(),
      usage: { input_tokens: 1000, output_tokens: 0 } }),
    [SUB + '.meta.json']: { description: 'orphan agent, main outside window' },
  });
  const { units } = audit(dir, '--days', '7').detail;
  assert.equal(units.length, 1);
  const [u] = units;
  assert.equal(u.key, '3ac91e04-uuid',
    'orphan unit keyed by the parent id, main session has no turns in this window');
  assert.equal(u.mainCost, 0, 'main session exists in history but contributes no turns inside the window');
  assert.equal(u.agents, 1);
  const singleTurnCost = 1000 * 4 / 1e6;
  assert.equal(u.subCost, 3 * singleTurnCost);
  assert.equal(u.cost, u.subCost, 'cost = subCost only, mainCost is 0');
});

test('WORK UNITS: --json units omit the internal first/last fields', () => {
  const dir = tmpClaudeDir({
    'projects/p/3ac91e04-uuid.jsonl': turns(4, 'main'),
    [SUB + '.jsonl']: turns(3, 'sub-a'),
    [SUB + '.meta.json']: { description: 'first agent' },
  });
  const { units } = audit(dir).detail;
  assert.deepEqual(Object.keys(units[0]).sort(),
    ['agents', 'cost', 'key', 'mainCost', 'peakCtx', 'project', 'subCost', 'subShare', 'span', 'turns'].sort());
});

test('WORK UNITS: text report shows a WORK UNITS section, sorted by cost desc, lines <= 120 chars', () => {
  const dir = tmpClaudeDir({
    'projects/p/3ac91e04-uuid.jsonl': turns(4, 'main'),
    [SUB + '.jsonl']: turns(3, 'sub-a'),
    [SUB + '.meta.json']: { description: 'first agent' },
    'projects/p/solo-sess.jsonl': turns(1, 'solo', { usage: { input_tokens: 10, output_tokens: 0 } }),
  });
  const detail = detailLines(auditText(dir));
  const header = detail.find(l => l.includes('WORK UNIT'));
  assert.ok(header, `expected a WORK UNITS header, got:\n${detail.join('\n')}`);
  assert.match(header, /full history/i, 'header must flag that span is full-history, not window-clipped');
  for (const l of detail) assert.ok([...l].length <= 120, `line too long (${[...l].length}): ${l}`);
  const rows = detail.filter(l => l.includes('3ac91e04') || l.includes('solo-sess'));
  assert.equal(rows.length, 2);
  assert.ok(rows[0].includes('3ac91e04'), 'bigger unit (with subagent) sorts first');
});

test('WORK UNITS: --json includes units at top level of detail; --no-detail omits it', () => {
  const dir = tmpClaudeDir({
    'projects/p/3ac91e04-uuid.jsonl': turns(4, 'main'),
    [SUB + '.jsonl']: turns(3, 'sub-a'),
    [SUB + '.meta.json']: { description: 'first agent' },
  });
  const full = audit(dir);
  assert.ok(Array.isArray(full.detail.units));
  const compact = audit(dir, '--no-detail');
  assert.equal(compact.detail, undefined);
});

// --------------------------------------------------- subagent distribution

test('SUBAGENT DISTRIBUTION: known turn counts -> exact median / p90 / max (turns and peak ctx)', () => {
  const files = {};
  // 5 subagents under one parent, turns and peak-ctx deliberately in the
  // *same* ascending order but mixing 1/2/3-digit values (7, 15, 23, 100,
  // 200 / 7000, 15000, 23000, 100000, 200000). A plain `.sort()` (no numeric
  // comparator) would lexicographically reorder these to [100,15,200,23,7]
  // (string "100" < "15" < "200" < "23" < "7"), giving wrong quantiles — so
  // this fixture catches a missing/removed comparator, unlike an all-same-
  // digit-count fixture (e.g. 10..50) where lexicographic and numeric sort
  // happen to agree.
  // len 5 -> floor(q*5): median (q .5) -> idx 2 -> 23 / 23000;
  // p90 (q .9) -> idx 4 -> 200 / 200000; max -> idx 4 -> 200 / 200000.
  const TURNS = [7, 15, 23, 100, 200];
  const CTX = [7000, 15000, 23000, 100000, 200000];
  for (const [i, turnsN] of TURNS.entries()) {
    const base = `projects/p/parent/subagents/agent-${i}`;
    files[base + '.jsonl'] = turns(turnsN, `s${i}`,
      { usage: { input_tokens: 0, cache_read_input_tokens: CTX[i], output_tokens: 0 } });
    files[base + '.meta.json'] = { description: `agent ${i}` };
  }
  const { distribution } = audit(tmpClaudeDir(files)).detail;
  assert.equal(distribution.count, 5);
  assert.deepEqual(distribution.turns, { median: 23, p90: 200, max: 200 });
  assert.deepEqual(distribution.peakCtx, { median: 23000, p90: 200000, max: 200000 });
});

test('SUBAGENT DISTRIBUTION: population is every subagent in the window, not just the top 10 by cost', () => {
  const files = { 'projects/p/main-sess.jsonl': turns(1, 'main') };
  for (let i = 1; i <= 12; i++) {
    const base = `projects/p/main-sess/subagents/agent-${String(i).padStart(2, '0')}`;
    files[base + '.jsonl'] = turns(i, `s${i}`);
    files[base + '.meta.json'] = { description: `task ${i}` };
  }
  const { detail } = audit(tmpClaudeDir(files));
  assert.equal(detail.topSubagents.length, 10, 'leaderboard stays capped at 10');
  assert.equal(detail.distribution.count, 12, 'distribution counts every subagent, not just the top 10');
  // Cost scales 1:1 with turn count here (every turn costs the same), so the
  // top-10-by-cost leaderboard is exactly turns [3..12] and excludes [1, 2].
  // Population (turns 1..12, len 12): median idx floor(.5*12)=6 -> 7.
  // Top-10-only (turns 3..12, len 10): median idx floor(.5*10)=5 -> 8.
  // If distribution were ever computed over the top-10 slice instead of the
  // full population, this would see 8, not 7, and fail.
  assert.equal(detail.distribution.turns.median, 7,
    'median must come from all 12 subagents (7), not the top-10-by-cost slice (which would give 8)');
});

test('SUBAGENT DISTRIBUTION: no subagents in window -> count 0, text shows an explicit empty line', () => {
  const dir = tmpClaudeDir({ 'projects/p/solo.jsonl': turns(3, 'solo') });
  assert.deepEqual(audit(dir).detail.distribution, {
    count: 0, turns: { median: 0, p90: 0, max: 0 }, peakCtx: { median: 0, p90: 0, max: 0 },
  });
  const detail = detailLines(auditText(dir));
  assert.ok(detail.some(l => l.includes('SUBAGENT DISTRIBUTION') && l.includes('none in this window')),
    `expected an empty-state DISTRIBUTION line, got:\n${detail.join('\n')}`);
});

test('SUBAGENT DISTRIBUTION: text report shows turns and peak-ctx lines, <= 120 chars, --json matches', () => {
  // 11 subagents (need > 10 for p90's index to differ from max's — quantile()
  // clamps p90 to n-1 once floor(.9n) >= n-1, which only stops happening at
  // n > 10) with turns 1..11 and peak ctx 10k..110k in the same ascending
  // order, so median/p90/max land on three distinct values in both stats
  // (6/10/11 and 60k/100k/110k). A single-subagent fixture (median = p90 =
  // max) would not catch the text renderer swapping which stat prints under
  // which label; this one does.
  const files = { 'projects/p/main-sess.jsonl': turns(1, 'main') };
  for (let i = 1; i <= 11; i++) {
    const base = `projects/p/main-sess/subagents/agent-${String(i).padStart(2, '0')}`;
    files[base + '.jsonl'] = turns(i, `s${i}`,
      { usage: { input_tokens: 0, cache_read_input_tokens: 10000 * i, output_tokens: 0 } });
    files[base + '.meta.json'] = { description: `agent ${i}` };
  }
  const dir = tmpClaudeDir(files);
  const detail = detailLines(auditText(dir));
  const header = detail.find(l => l.includes('SUBAGENT DISTRIBUTION'));
  assert.ok(header && header.includes('11 in this window'), `expected count in header, got: ${header}`);
  const turnsLine = detail.find(l => l.trim().startsWith('turns'));
  const ctxLine = detail.find(l => l.trim().startsWith('peak ctx'));
  assert.match(turnsLine, /median\s+6\s+p90\s+10\s+max\s+11/);
  assert.match(ctxLine, /median\s+60k\s+p90\s+100k\s+max\s+110k/);
  for (const l of detail) assert.ok([...l].length <= 120, `line too long (${[...l].length}): ${l}`);
  const { distribution } = audit(dir).detail;
  assert.deepEqual(distribution, {
    count: 11, turns: { median: 6, p90: 10, max: 11 },
    peakCtx: { median: 60000, p90: 100000, max: 110000 },
  });
});

test('DETAIL block stays <= 30 lines with full sections: 10 work units, 10 subagents, distribution',
  () => {
    const files = {};
    for (let i = 1; i <= 10; i++) {
      const proj = `projects/p${i}`;
      files[`${proj}/main-${i}.jsonl`] = turns(5, `m${i}`);
      const base = `${proj}/main-${i}/subagents/agent-${i}`;
      files[base + '.jsonl'] = turns(i, `s${i}`, { model: i % 2 ? 'claude-opus-5-5' : 'claude-sonnet-4-6' });
      files[base + '.meta.json'] = { description: `task ${i}` };
    }
    const detail = detailLines(auditText(tmpClaudeDir(files)));
    assert.ok(detail.length <= 30, `DETAIL block has ${detail.length} lines, want <= 30:\n${detail.join('\n')}`);
  });
