/**
 * Fitness Report leaderboard renderer.
 *
 * Vanilla ES module, no framework, no build step. It reads an array of
 * `fitness-report/1` records (see src/types.ts, FitnessReportJson) and renders
 * one row per run.
 *
 * Three rules are load bearing here and are enforced in code, not in copy:
 *
 *   1. A refusal is a first class row. When a gate stops a run there is no
 *      score field in the record at all, so every cell that would have held a
 *      number instead holds the named gate, its counts and its reason string.
 *      No cell is ever left blank.
 *   2. First try success is rendered as its Wilson interval. Ordering uses the
 *      point estimate, but rows whose intervals overlap are marked tied and
 *      share one position. Overlapping intervals are not a ranking.
 *   3. Every finding links to the recorded session behind it. A finding with no
 *      published trace says so rather than standing as a bare count.
 *
 * The page never recomputes statistics. Intervals, verdicts and p values are
 * read from the record exactly as the harness wrote them, because a second copy
 * of that math is a second thing that can drift.
 */

export const DATA_URL = 'data/runs.json';
export const VIEWER_BASE = 'https://mcpreplay.dev/';

/** Human labels for the gate ids in src/types.ts (GateId). */
export const GATE_LABELS = {
  structural: 'structural',
  answer_leak: 'answer leak',
  suite_size: 'suite size',
  plan_power: 'plan power',
  null_baseline: 'null baseline',
  construct: 'construct',
  variance: 'variance',
  order_invariance: 'order invariance',
  protocol_hygiene: 'protocol hygiene'
};

/** One line of plain language per RunOutcome. */
export const OUTCOME_NOTES = {
  SCORED: 'gates passed, run scored',
  GATE_FAILED: 'a validity gate failed',
  DEGENERATE: 'a null model reached the answers, so the suite measures nothing',
  INDETERMINATE: 'the baseline could not be resolved either way',
  EXTEND_EXHAUSTED: 'evidence never became decisive within the extension budget',
  COMPROMISED: 'oracle error rate above 0.05, the measurement did not complete',
  INSUFFICIENT_SURFACE: 'task suite below the minimum size of 8'
};

export const CREDENTIAL_NOTES = {
  anonymous: 'collected with no credentials',
  'free-key': 'collected with a free tier key',
  'owner-key': 'collected with a key held by the server owner'
};

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/** A finite number, or null. Never NaN, never null read as zero. */
export function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function fmtPct(value, digits = 1) {
  const n = finite(value);
  if (n === null) return 'not reported';
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtNum(value, digits = 1) {
  const n = finite(value);
  if (n === null) return 'not reported';
  return n.toFixed(digits);
}

export function fmtInt(value) {
  const n = finite(value);
  if (n === null) return 'not reported';
  return String(Math.round(n));
}

export function fmtUsd(value) {
  const n = finite(value);
  if (n === null) return 'no price on file';
  return `$${n.toFixed(4)}`;
}

export function gateLabel(id) {
  if (typeof id !== 'string' || id.length === 0) return 'unnamed gate';
  return GATE_LABELS[id] || id.replace(/_/g, ' ');
}

/** The score block, only when the record really carries one. */
export function scoreOf(run) {
  return run && typeof run.score === 'object' && run.score !== null ? run.score : null;
}

/** First try Wilson interval, or null when the run carries no usable one. */
export function firstTryInterval(run) {
  const score = scoreOf(run);
  const w = score && typeof score.firstTrySuccess === 'object' ? score.firstTrySuccess : null;
  if (!w) return null;
  const rate = finite(w.rate);
  const low = finite(w.low);
  const high = finite(w.high);
  const n = finite(w.n);
  if (rate === null || low === null || high === null || n === null || n <= 0) return null;
  return { rate, low, high, k: finite(w.k) ?? 0, n };
}

/** A run is rankable only when it is SCORED and carries a usable interval. */
export function isRankable(run) {
  return run && run.outcome === 'SCORED' && firstTryInterval(run) !== null;
}

/** Wilson intervals overlap when neither one sits entirely above the other. */
export function intervalsOverlap(a, b) {
  if (!a || !b) return false;
  return a.low <= b.high && b.low <= a.high;
}

/** a is separated from b only when a's whole interval sits above b's. */
export function separates(a, b) {
  return Boolean(a && b) && a.low > b.high;
}

/**
 * Order the rankable runs and mark everything that is not actually separated.
 *
 * Rows are listed by point estimate, descending, but the POSITION is a
 * dominance rank: one plus the number of rows whose interval lies entirely
 * above this one. A row therefore only drops below another when the evidence
 * separates them, and rows nobody separates share a position.
 *
 * Sorting still puts one overlapping row above another, which on its own would
 * read as a ranking. So each row also carries `overlapsAbove`, and the renderer
 * prints that on the row. Between them, the two marks mean no pair of
 * overlapping intervals is ever presented on this page as a settled ordering.
 */
export function rankRuns(runs) {
  const rows = runs
    .filter(isRankable)
    .map((run) => ({ run, interval: firstTryInterval(run) }))
    .sort((a, b) => b.interval.rate - a.interval.rate || slugOf(a.run).localeCompare(slugOf(b.run)));

  const out = rows.map((row) => ({
    ...row,
    rank: 1 + rows.filter((other) => other !== row && separates(other.interval, row.interval)).length,
    tied: false,
    groupSize: 1,
    overlapsAbove: false
  }));

  for (const row of out) {
    // Sharing a position is only a tie when the intervals really do overlap.
    const peers = out.filter(
      (other) => other !== row && other.rank === row.rank && intervalsOverlap(other.interval, row.interval)
    );
    row.tied = peers.length > 0;
    row.groupSize = peers.length + 1;
    row.groupId = row.rank;
  }
  for (let i = 1; i < out.length; i++) {
    out[i].overlapsAbove = intervalsOverlap(out[i - 1].interval, out[i].interval);
  }
  return out;
}

/** Rankable runs, split by runner model. Rankings hold only within one model. */
export function rankByRunnerModel(runs) {
  const models = [];
  for (const run of runs) {
    if (!isRankable(run)) continue;
    const model = runnerModelOf(run);
    if (!models.includes(model)) models.push(model);
  }
  return models.map((model) => ({
    runnerModel: model,
    rows: rankRuns(runs.filter((run) => runnerModelOf(run) === model))
  }));
}

export function runnerModelOf(run) {
  const score = scoreOf(run);
  if (score && typeof score.runnerModel === 'string' && score.runnerModel) return score.runnerModel;
  if (run && run.run && typeof run.run.runnerModel === 'string' && run.run.runnerModel) {
    return run.run.runnerModel;
  }
  return 'unrecorded runner model';
}

export function slugOf(run) {
  const server = run && run.server ? run.server : null;
  if (server && typeof server.slug === 'string' && server.slug) return server.slug;
  if (server && typeof server.url === 'string' && server.url) return server.url;
  return run && run.run && run.run.id ? String(run.run.id) : 'unnamed server';
}

/**
 * The refusal, described the way the row prints it. Returns null for a scored
 * run. Never returns an empty object: an outcome with no gate record still
 * yields the outcome and its note, because a blank refusal cell is the failure
 * this function exists to prevent.
 */
export function refusalOf(run) {
  if (!run || run.outcome === 'SCORED') return null;
  const gates = run.gates && typeof run.gates === 'object' ? run.gates : {};
  const records = Array.isArray(gates.records) ? gates.records : [];
  const refusedAt = typeof gates.refusedAt === 'string' ? gates.refusedAt : null;
  let record = records.find((r) => r && r.gate === refusedAt) || null;
  if (!record) record = records.find((r) => r && r.ok === false) || null;
  const gate = record ? record.gate : refusedAt;
  return {
    outcome: typeof run.outcome === 'string' ? run.outcome : 'UNKNOWN_OUTCOME',
    note: OUTCOME_NOTES[run.outcome] || 'outcome not recognised by this page',
    gate: gate || null,
    gateLabel: gate ? gateLabel(gate) : 'no gate recorded',
    reason: record && typeof record.reason === 'string' ? record.reason : null,
    costTier: record && typeof record.costTier === 'string' ? record.costTier : null,
    verdict: record && record.verdict && typeof record.verdict === 'object' ? record.verdict : null,
    detail: record ? record.detail : null
  };
}

/** "22 of 30 vs 0.90, p = 0.0078". Returns null when there is no verdict. */
export function verdictLine(verdict) {
  if (!verdict || typeof verdict !== 'object') return null;
  const k = finite(verdict.k);
  const n = finite(verdict.n);
  const threshold = finite(verdict.threshold);
  if (k === null || n === null) return null;
  const parts = [`${k} of ${n}`];
  if (threshold !== null) parts.push(`against a threshold of ${threshold.toFixed(2)}`);
  const p = finite(verdict.pValue);
  if (p !== null) parts.push(`p = ${p < 0.0001 ? p.toExponential(2) : p.toFixed(4)}`);
  const alpha = finite(verdict.alpha);
  if (alpha !== null) parts.push(`alpha = ${alpha}`);
  return parts.join(', ');
}

export function probeFindings(run) {
  const probes = run && typeof run.probes === 'object' && run.probes !== null ? run.probes : {};
  return Array.isArray(probes.findings) ? probes.findings.filter((f) => f && typeof f === 'object') : [];
}

/** Passed, failed and could-not-check counts. Unknown never counts as a pass. */
export function hygieneOf(run) {
  const findings = probeFindings(run);
  const passed = findings.filter((f) => f.pass === true);
  const failed = findings.filter((f) => f.pass === false);
  const unknown = findings.filter((f) => f.pass !== true && f.pass !== false);
  return { findings, passed, failed, unknown, checked: passed.length + failed.length };
}

export function specCurrencyOf(run) {
  const probes = run && typeof run.probes === 'object' && run.probes !== null ? run.probes : {};
  const version = typeof probes.specCurrency === 'string' && probes.specCurrency ? probes.specCurrency : null;
  const server = run && run.server ? run.server : null;
  const era = server && (server.era === 'modern' || server.era === 'legacy') ? server.era : null;
  return { version, era };
}

/** Only https links are ever put in the DOM. Anything else is not a link. */
export function safeUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Merged two plane viewer link, per the published trace scheme. The semicolon
 * is the separator, so a trace URL that contains one cannot be linked.
 */
export function buildViewerUrl(mcpUrl, agentUrl) {
  const mcp = safeUrl(mcpUrl);
  const agent = safeUrl(agentUrl);
  const usable = [mcp, agent].filter((u) => u !== null && !u.includes(';'));
  if (usable.length === 0) return null;
  const trace = usable.map((u) => encodeURIComponent(u)).join(';');
  return `${VIEWER_BASE}?trace=${trace}#view=calls`;
}

/** The replay link for a run, preferring the one the harness recorded. */
export function replayUrlOf(run) {
  const links = run && typeof run.traceLinks === 'object' && run.traceLinks !== null ? run.traceLinks : null;
  if (!links) return null;
  const viewer = safeUrl(links.viewer);
  if (viewer) return viewer;
  return buildViewerUrl(links.mcp, links.agent);
}

export function intervalAriaLabel(interval) {
  return [
    `first try success ${fmtPct(interval.rate)}`,
    `Wilson 95 percent interval ${fmtPct(interval.low)} to ${fmtPct(interval.high)}`,
    `${interval.k} of ${interval.n} tasks`
  ].join(', ');
}

// ---------------------------------------------------------------------------
// tiny DOM helpers
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function link(href, text, className) {
  const url = safeUrl(href);
  if (!url) return el('span', className ? `${className} is-missing` : 'is-missing', text);
  const a = el('a', className, text);
  a.href = url;
  a.rel = 'noopener noreferrer';
  a.target = '_blank';
  return a;
}

/**
 * An evidence link for one finding. When no trace was published the caller gets
 * a plain "no recording published" marker instead of a live link, so a finding
 * never stands on this page as a bare count.
 */
function evidenceLink(run, label) {
  const url = replayUrlOf(run);
  if (!url) return el('span', 'evidence is-missing', 'no recording published');
  const a = link(url, label || 'evidence', 'evidence');
  a.title = 'Open the recorded session behind this finding';
  return a;
}

function definition(parent, term, value) {
  const dt = el('dt', null, term);
  const dd = el('dd', null, value);
  parent.appendChild(dt);
  parent.appendChild(dd);
  return dd;
}

// ---------------------------------------------------------------------------
// cells
// ---------------------------------------------------------------------------

function serverCell(run, placement) {
  const td = el('td', 'cell-server');
  const chip = el('span', 'rank-chip');
  if (placement && placement.rank) {
    chip.classList.add(placement.tied ? 'rank-tied' : 'rank-solo');
    chip.textContent = placement.tied ? `Tied at ${placement.rank}` : `Rank ${placement.rank}`;
    if (placement.tied) {
      chip.title = `${placement.groupSize} servers whose 95% intervals overlap. They share this position.`;
    }
  } else {
    chip.classList.add('rank-none');
    chip.textContent = 'Not ranked';
    chip.title = 'This run produced no score, so it takes no position.';
  }
  td.appendChild(chip);

  const name = el('div', 'server-name', slugOf(run));
  td.appendChild(name);

  const server = run.server && typeof run.server === 'object' ? run.server : {};
  const url = el('div', 'server-url');
  url.appendChild(el('code', null, typeof server.url === 'string' ? server.url : 'url not recorded'));
  td.appendChild(url);

  const bits = [];
  if (server.era) bits.push(`${server.era} era`);
  if (server.transportShape) bits.push(server.transportShape === 'sse' ? 'SSE framed' : 'plain JSON');
  if (typeof server.sessionful === 'boolean') bits.push(server.sessionful ? 'session-ful' : 'stateless');
  td.appendChild(el('div', 'server-meta', bits.join(' / ') || 'transport not recorded'));
  return td;
}

function outcomeCell(run) {
  const td = el('td', 'cell-outcome');
  const refusal = refusalOf(run);
  if (!refusal) {
    const pill = el('span', 'pill pill-scored', 'SCORED');
    td.appendChild(pill);
    const score = scoreOf(run) || {};
    const dl = el('dl', 'mini-figures');
    definition(dl, 'calls per task', fmtNum(score.meanCallsPerCompletedTask, 1));
    definition(dl, 'tokens per task', fmtInt(score.meanTokensPerCompletedTask));
    definition(dl, 'cost per task', fmtUsd(score.meanCostPerCompletedTaskUsd));
    td.appendChild(dl);
    td.appendChild(el('div', 'runner-note', `runner ${runnerModelOf(run)}`));
    return td;
  }

  td.classList.add('is-refused');
  const pill = el('span', 'pill pill-refused', 'REFUSED');
  td.appendChild(pill);
  td.appendChild(el('div', 'refusal-outcome', refusal.outcome));
  td.appendChild(el('div', 'refusal-gate', `stopped at the ${refusal.gateLabel} gate`));
  if (refusal.reason) {
    const reason = el('div', 'refusal-reason');
    reason.appendChild(el('code', null, refusal.reason));
    td.appendChild(reason);
  }
  const vline = verdictLine(refusal.verdict);
  if (vline) td.appendChild(el('div', 'refusal-counts', vline));
  else td.appendChild(el('div', 'refusal-counts', detailLine(refusal.detail) || refusal.note));
  return td;
}

/** Flat primitive details render as "min tasks 8". Anything deeper is skipped. */
function detailLine(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const parts = [];
  for (const [key, value] of Object.entries(detail)) {
    if (value === null || typeof value === 'object') continue;
    const label = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
    parts.push(`${label} ${value}`);
  }
  return parts.length ? parts.join(', ') : null;
}

function intervalCell(run, placement) {
  const td = el('td', 'cell-interval');
  const interval = firstTryInterval(run);
  if (!interval) {
    td.classList.add('is-refused');
    const refusal = refusalOf(run);
    td.appendChild(el('div', 'no-score', 'No score'));
    td.appendChild(
      el(
        'div',
        'no-score-why',
        refusal
          ? `${refusal.gateLabel} gate refused this run, so no success rate exists to report`
          : 'this record carries no first try interval'
      )
    );
    return td;
  }

  const figure = el('div', 'interval');
  figure.setAttribute('role', 'img');
  figure.setAttribute('aria-label', intervalAriaLabel(interval));
  const track = el('div', 'interval-track');
  const band = el('div', 'interval-band');
  band.style.setProperty('--low', `${(interval.low * 100).toFixed(2)}%`);
  band.style.setProperty('--high', `${(interval.high * 100).toFixed(2)}%`);
  const point = el('div', 'interval-point');
  point.style.setProperty('--rate', `${(interval.rate * 100).toFixed(2)}%`);
  track.appendChild(band);
  track.appendChild(point);
  figure.appendChild(track);
  td.appendChild(figure);

  const nums = el('div', 'interval-nums');
  nums.appendChild(el('span', 'interval-rate', fmtPct(interval.rate)));
  nums.appendChild(el('span', 'interval-ci', `95% CI ${fmtPct(interval.low)} to ${fmtPct(interval.high)}`));
  td.appendChild(nums);
  td.appendChild(el('div', 'interval-kn', `${interval.k} of ${interval.n} tasks solved on the first try`));
  if (placement && placement.overlapsAbove) {
    td.appendChild(
      el('div', 'interval-overlap', 'Not separated from the row above. The order between them carries no information.')
    );
  }
  return td;
}

function specCell(run) {
  const td = el('td', 'cell-spec');
  const { version, era } = specCurrencyOf(run);
  if (version) {
    td.appendChild(el('div', 'spec-version', version));
  } else {
    td.appendChild(el('div', 'spec-version is-missing', 'not negotiated'));
  }
  td.appendChild(el('div', 'spec-era', era ? `${era} era` : 'era not recorded'));
  return td;
}

function hygieneCell(run) {
  const td = el('td', 'cell-hygiene');
  const { findings, passed, failed, unknown, checked } = hygieneOf(run);
  if (findings.length === 0) {
    td.appendChild(el('div', 'is-missing', 'no probes recorded'));
    return td;
  }
  const head = el('div', 'hygiene-count');
  head.textContent = `${passed.length} of ${checked} checks passed`;
  if (failed.length > 0) head.classList.add('has-failures');
  td.appendChild(head);
  if (unknown.length > 0) {
    td.appendChild(el('div', 'hygiene-unknown', `${unknown.length} could not be checked`));
  }
  if (failed.length > 0) {
    const list = el('ul', 'hygiene-list');
    for (const finding of failed) {
      const li = el('li');
      li.appendChild(el('span', 'finding-id', String(finding.id || 'unnamed check')));
      li.appendChild(evidenceLink(run, 'evidence'));
      list.appendChild(li);
    }
    td.appendChild(list);
  }
  return td;
}

function credentialCell(run) {
  const td = el('td', 'cell-cred');
  const server = run.server && typeof run.server === 'object' ? run.server : {};
  const context = typeof server.credentialContext === 'string' ? server.credentialContext : null;
  if (!context) {
    td.appendChild(el('span', 'badge badge-unknown', 'not stamped'));
    return td;
  }
  const badge = el('span', `badge badge-${context.replace(/[^a-z-]/gi, '')}`, context);
  badge.title = CREDENTIAL_NOTES[context] || 'credential context recorded with this run';
  td.appendChild(badge);
  const score = scoreOf(run);
  const delta = score && Array.isArray(score.toolSurfaceDeltaByCredential) ? score.toolSurfaceDeltaByCredential : null;
  if (delta && delta.length > 0) {
    td.appendChild(el('div', 'cred-delta', `${delta.length} tools differ by credential`));
  }
  return td;
}

function replayCell(run) {
  const td = el('td', 'cell-replay');
  const url = replayUrlOf(run);
  if (!url) {
    td.appendChild(el('span', 'is-missing', 'no tape published'));
    return td;
  }
  const a = link(url, 'Open replay', 'replay-link');
  a.title = 'Opens the merged MCP and agent tapes in the viewer, in a new tab';
  td.appendChild(a);
  td.appendChild(el('div', 'replay-note', 'two planes, opens on click'));
  return td;
}

// ---------------------------------------------------------------------------
// detail panel
// ---------------------------------------------------------------------------

function gateTable(run) {
  const gates = run.gates && typeof run.gates === 'object' ? run.gates : {};
  const records = Array.isArray(gates.records) ? gates.records : [];
  const wrap = el('div', 'panel-block');
  wrap.appendChild(el('h4', null, 'Gate ledger'));
  if (records.length === 0) {
    wrap.appendChild(el('p', 'is-missing', 'no gate records in this run'));
    return wrap;
  }
  const table = el('table', 'panel-table');
  const thead = el('thead');
  const hrow = el('tr');
  for (const heading of ['Gate', 'Cost', 'Result', 'Reason', 'Counts']) {
    const th = el('th', null, heading);
    th.scope = 'col';
    hrow.appendChild(th);
  }
  thead.appendChild(hrow);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const tr = el('tr');
    tr.appendChild(el('td', null, gateLabel(record.gate)));
    tr.appendChild(el('td', null, record.costTier || 'not recorded'));
    const result = el('td');
    result.appendChild(el('span', record.ok === false ? 'tag tag-fail' : 'tag tag-ok', record.ok === false ? 'refused' : 'passed'));
    tr.appendChild(result);
    const reason = el('td');
    reason.appendChild(el('code', null, record.reason || 'no reason string'));
    tr.appendChild(reason);
    tr.appendChild(el('td', null, verdictLine(record.verdict) || detailLine(record.detail) || 'no counts'));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  const policy = gates.extensionPolicy && typeof gates.extensionPolicy === 'object' ? gates.extensionPolicy : null;
  if (policy) {
    wrap.appendChild(
      el(
        'p',
        'panel-note',
        policy.maxExtensions === 0
          ? 'Extension policy fixed before the first call: no extension batches are run, so a gate the data cannot resolve resolves immediately and the run is refused rather than extended.'
          : `Extension policy fixed before the first call: ${fmtInt(policy.extensionSize)} tasks per extension, at most ${fmtInt(policy.maxExtensions)} extensions.`
      )
    );
  }
  return wrap;
}

function findingsBlock(run) {
  const wrap = el('div', 'panel-block');
  wrap.appendChild(el('h4', null, 'Probe findings'));
  const findings = probeFindings(run);
  if (findings.length === 0) {
    wrap.appendChild(el('p', 'is-missing', 'no probes recorded for this run'));
    return wrap;
  }
  const list = el('ul', 'finding-list');
  for (const finding of findings) {
    const li = el('li', finding.pass === false ? 'finding is-fail' : finding.pass === true ? 'finding is-pass' : 'finding is-unknown');
    const head = el('div', 'finding-head');
    head.appendChild(
      el('span', 'tag', finding.pass === true ? 'pass' : finding.pass === false ? 'fail' : 'could not check')
    );
    head.appendChild(el('span', 'finding-id', String(finding.id || 'unnamed check')));
    head.appendChild(evidenceLink(run, 'evidence'));
    li.appendChild(head);
    li.appendChild(el('p', 'finding-detail', String(finding.detail || 'no detail recorded')));
    list.appendChild(li);
  }
  wrap.appendChild(list);
  return wrap;
}

function toolsBlock(run) {
  const score = scoreOf(run);
  const tools = score && Array.isArray(score.tools) ? score.tools : [];
  const wrap = el('div', 'panel-block');
  wrap.appendChild(el('h4', null, 'Per tool attribution'));
  if (tools.length === 0) {
    wrap.appendChild(el('p', 'is-missing', 'no tool level numbers exist for a run that was refused before the drive'));
    return wrap;
  }
  const table = el('table', 'panel-table');
  const thead = el('thead');
  const hrow = el('tr');
  for (const heading of ['Tool', 'Calls', 'Errors', 'p50', 'p95', 'Destructive declared', 'Destructive inferred']) {
    const th = el('th', null, heading);
    th.scope = 'col';
    hrow.appendChild(th);
  }
  thead.appendChild(hrow);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const tr = el('tr');
    tr.appendChild(el('td', null, String(tool.tool || 'unnamed tool')));
    tr.appendChild(el('td', null, fmtInt(tool.calls)));
    const errors = el('td');
    const classes = tool.failureClasses && typeof tool.failureClasses === 'object' ? Object.entries(tool.failureClasses) : [];
    errors.appendChild(el('span', null, fmtInt(tool.errors)));
    if (classes.length > 0) {
      errors.appendChild(el('div', 'failure-classes', classes.map(([k, v]) => `${k} ${v}`).join(', ')));
    }
    tr.appendChild(errors);
    tr.appendChild(el('td', null, tool.p50Ms === null ? 'not timed' : `${fmtInt(tool.p50Ms)} ms`));
    tr.appendChild(el('td', null, tool.p95Ms === null ? 'not timed' : `${fmtInt(tool.p95Ms)} ms`));
    tr.appendChild(el('td', null, tool.declaredDestructive ? 'yes' : 'no'));
    tr.appendChild(
      el('td', null, tool.inferredDestructive === null || tool.inferredDestructive === undefined ? 'not judged' : tool.inferredDestructive ? 'yes' : 'no')
    );
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  wrap.appendChild(
    el(
      'p',
      'panel-note',
      'A tool counts as destructive unless it declares readOnlyHint true or destructiveHint false, because those are the spec defaults. Declared and inferred disagreement is itself a finding.'
    )
  );
  return wrap;
}

function scoreBlock(run) {
  const score = scoreOf(run);
  const wrap = el('div', 'panel-block');
  wrap.appendChild(el('h4', null, 'Run record'));
  const dl = el('dl', 'panel-dl');
  const meta = run.run && typeof run.run === 'object' ? run.run : {};
  definition(dl, 'run id', String(meta.id || 'not recorded'));
  definition(dl, 'started', String(meta.startedAt || 'not recorded'));
  definition(dl, 'harness', String(meta.harnessVersion || 'not recorded'));
  definition(dl, 'runner model', runnerModelOf(run));
  definition(dl, 'judge model', String(meta.judgeModel || 'not recorded'));
  definition(dl, 'suite hash', String(meta.suiteHash || 'not recorded'));
  definition(dl, 'task budget', fmtInt(meta.taskBudget));
  if (score) {
    const eventual = score.eventualSuccess && typeof score.eventualSuccess === 'object' ? score.eventualSuccess : null;
    if (eventual) {
      definition(
        dl,
        'eventual success',
        `${fmtPct(eventual.rate)} (95% CI ${fmtPct(eventual.low)} to ${fmtPct(eventual.high)}), ${fmtInt(eventual.k)} of ${fmtInt(eventual.n)}`
      );
    }
    definition(dl, 'destructive calls without confirmation', fmtInt(score.destructiveWithoutConfirmation));
    const drift = score.schemaDrift && typeof score.schemaDrift === 'object' ? score.schemaDrift : null;
    if (drift) {
      definition(
        dl,
        'output schema drift',
        drift.checked ? (drift.drifted ? String(drift.detail || 'drift observed') : 'checked, none observed') : 'not checked'
      );
    }
  }
  wrap.appendChild(dl);

  const ambiguous = score && Array.isArray(score.ambiguousParameters) ? score.ambiguousParameters : [];
  if (ambiguous.length > 0) {
    wrap.appendChild(el('h4', null, 'Ambiguous parameters'));
    const list = el('ul', 'finding-list');
    for (const item of ambiguous) {
      const li = el('li', 'finding is-fail');
      const head = el('div', 'finding-head');
      head.appendChild(el('span', 'finding-id', `${item.tool}.${item.param}`));
      head.appendChild(evidenceLink(run, 'recorded session'));
      li.appendChild(head);
      li.appendChild(el('p', 'finding-detail', String(item.why || 'no explanation recorded')));
      list.appendChild(li);
    }
    wrap.appendChild(list);
  }

  const rewrites = Array.isArray(run.rewrites) ? run.rewrites : [];
  if (rewrites.length > 0) {
    wrap.appendChild(el('h4', null, 'Proposed rewrites'));
    const list = el('ul', 'rewrite-list');
    for (const rewrite of rewrites) {
      const li = el('li');
      li.appendChild(el('div', 'rewrite-tool', String(rewrite.tool || 'unnamed tool')));
      li.appendChild(el('p', 'rewrite-current', `current: ${String(rewrite.current || '')}`));
      li.appendChild(el('p', 'rewrite-proposed', `proposed: ${String(rewrite.proposed || '')}`));
      const why = el('p', 'rewrite-why');
      why.appendChild(el('span', null, String(rewrite.causalEvidence || 'no causal evidence recorded')));
      why.appendChild(evidenceLink(run, 'recorded sessions'));
      li.appendChild(why);
      list.appendChild(li);
    }
    wrap.appendChild(list);
  }

  const links = run.traceLinks && typeof run.traceLinks === 'object' ? run.traceLinks : null;
  wrap.appendChild(el('h4', null, 'Tapes'));
  if (!links) {
    wrap.appendChild(el('p', 'is-missing', 'no tapes were published for this run'));
  } else {
    const list = el('ul', 'trace-list');
    const mcp = el('li');
    mcp.appendChild(el('span', null, 'MCP wire plane: '));
    mcp.appendChild(link(links.mcp, String(links.mcp || 'not published')));
    list.appendChild(mcp);
    const agent = el('li');
    agent.appendChild(el('span', null, 'agent plane: '));
    agent.appendChild(link(links.agent, String(links.agent || 'not published')));
    list.appendChild(agent);
    wrap.appendChild(list);
  }
  return wrap;
}

function detailPanel(run, panelId) {
  const tr = el('tr', 'detail-row');
  tr.id = panelId;
  tr.hidden = true;
  const td = el('td', 'detail-cell');
  td.colSpan = 7;
  const inner = el('div', 'detail-inner');
  inner.appendChild(scoreBlock(run));
  inner.appendChild(gateTable(run));
  inner.appendChild(findingsBlock(run));
  inner.appendChild(toolsBlock(run));
  td.appendChild(inner);
  tr.appendChild(td);
  return tr;
}

// ---------------------------------------------------------------------------
// rows and board
// ---------------------------------------------------------------------------

function bandRow(text, note, className) {
  const tr = el('tr', `band-row ${className || ''}`.trim());
  const th = el('th');
  th.colSpan = 7;
  th.scope = 'colgroup';
  th.appendChild(el('span', 'band-title', text));
  if (note) th.appendChild(el('span', 'band-note', note));
  tr.appendChild(th);
  return tr;
}

function runRow(run, placement, index) {
  const rows = [];
  const refused = run.outcome !== 'SCORED';
  const tr = el('tr', refused ? 'run-row is-refused-row' : 'run-row is-scored-row');
  const panelId = `detail-${index}`;
  if (placement && placement.tied) {
    tr.classList.add('is-tied');
    tr.dataset.tieGroup = String(placement.groupId);
  }
  tr.appendChild(serverCell(run, placement));
  tr.appendChild(outcomeCell(run));
  tr.appendChild(intervalCell(run, placement));
  tr.appendChild(specCell(run));
  tr.appendChild(hygieneCell(run));
  tr.appendChild(credentialCell(run));
  const replay = replayCell(run);
  const toggle = el('button', 'toggle', 'Details');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', panelId);
  replay.appendChild(toggle);
  tr.appendChild(replay);

  const panel = detailPanel(run, panelId);
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
    toggle.textContent = open ? 'Details' : 'Hide details';
    panel.hidden = open;
    tr.classList.toggle('is-open', !open);
  });

  rows.push(tr, panel);
  return rows;
}

export function summarise(runs) {
  const scored = runs.filter((run) => run && run.outcome === 'SCORED').length;
  const refused = runs.length - scored;
  const servers = new Set(runs.map((run) => slugOf(run))).size;
  return { total: runs.length, scored, refused, servers };
}

export function summaryText(runs) {
  const { total, scored, refused, servers } = summarise(runs);
  if (total === 0) return 'No runs published yet.';
  const noun = servers === 1 ? 'server' : 'servers';
  return `${total} runs across ${servers} ${noun}. ${scored} scored, ${refused} refused. Refusals are rows, not gaps.`;
}

/** Render the whole table body. Pure in, DOM out. */
export function renderBoard(tbody, runs) {
  tbody.textContent = '';
  const usable = Array.isArray(runs) ? runs.filter((run) => run && typeof run === 'object') : [];
  if (usable.length === 0) {
    const tr = el('tr', 'state-row');
    const td = el('td', null, 'No runs in data/runs.json yet.');
    td.colSpan = 7;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  let index = 0;
  const groups = rankByRunnerModel(usable);
  const multiModel = groups.length > 1;
  for (const group of groups) {
    tbody.appendChild(
      bandRow(
        `Ranked under runner model ${group.runnerModel}`,
        multiModel
          ? 'Ranked only within this model. Token accounting is not comparable across runner models.'
          : 'Rankings hold within one runner model. The model is pinned into every score record.',
        'band-model'
      )
    );
    for (const row of group.rows) {
      for (const node of runRow(row.run, row, index++)) tbody.appendChild(node);
    }
  }

  const unranked = usable.filter((run) => !isRankable(run));
  if (unranked.length > 0) {
    tbody.appendChild(
      bandRow(
        'Refused, and published as such',
        'A gate stopped these runs before a score existed, or the record carries no usable interval. The gate, its counts and its reason stand in place of the number.',
        'band-refused'
      )
    );
    const sorted = unranked.slice().sort((a, b) => slugOf(a).localeCompare(slugOf(b)));
    for (const run of sorted) {
      for (const node of runRow(run, null, index++)) tbody.appendChild(node);
    }
  }
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

export async function loadRuns(url = DATA_URL, fetchImpl) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new Error('no fetch implementation available');
  const response = await doFetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`could not load ${url}: HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error(`${url} must contain an array of fitness-report/1 records`);
  return data;
}

export async function main(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return;
  const tbody = doc.getElementById('board-body');
  const summary = doc.getElementById('summary-line');
  if (!tbody) return;
  try {
    const runs = await loadRuns();
    renderBoard(tbody, runs);
    if (summary) summary.textContent = summaryText(runs);
  } catch (error) {
    tbody.textContent = '';
    const tr = el('tr', 'state-row is-error');
    const td = el('td');
    td.colSpan = 7;
    td.textContent = `Could not render the leaderboard: ${error && error.message ? error.message : String(error)}`;
    tr.appendChild(td);
    tbody.appendChild(tr);
    if (summary) summary.textContent = 'The run data did not load. Nothing below is current.';
  }
}

function documentReady() {
  return typeof document !== 'undefined' && document.readyState !== 'loading';
}

// Browser only. Importing this module in Node (tests, checks) runs no DOM code.
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (documentReady()) main();
  else document.addEventListener('DOMContentLoaded', () => main());
}
