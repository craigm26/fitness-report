/**
 * Pairing, attribution and `mcp-tape.stats/1` emission for Fitness Report.
 *
 * PORTED from mcp-tape `src/stats-model.ts` (MIT, github.com/craigm26/mcp-tape)
 * and, through it, from mcp-replay's `js/insights-model.js` / `js/trace-model.js`.
 * Copyright (c) the mcp-tape authors. Kept structurally faithful so the oracle
 * test in DESIGN decision 5 (`npx mcp-tape stats <file> --json` must agree with
 * our own counts, per plane) can stay honest.
 *
 * Deltas from the upstream port, all deliberate:
 *
 *  1. KEYING FIX. Upstream keys JSON-RPC pairs by `String(raw.id)` alone. Ids are
 *     only unique per producer connection, so two interleaved producers (the
 *     format-extensions §1 `source` field, and our own two-plane runs merged in
 *     the viewer) can collide and cross-pair a request from one server with a
 *     response from another. We key by `${source}::${id}`, where an absent
 *     `source` means `mcp-tape` per format-extensions §1.
 *  2. The pair row carries the fields scoring needs that upstream drops:
 *     `corr_id` (task attribution), raw arguments, protocol-vs-execution error
 *     separation, and the MRTR `input_required` marker.
 *  3. Prices are OUR table (DESIGN decision 3), not mcp-tape's, and resolve
 *     fail-closed: an unknown model id yields no cost, never a default rate.
 *  4. `percentile` is re-exported from `../gates/stats.js` rather than
 *     redefined. Same nearest-rank definition; one copy of one fact.
 *  5. `dir:"command"` and `dir:"telemetry"` count as `event` records rather than
 *     `other` (format-extensions §2 lists all three as one-way producer frames).
 *     Unreachable for our own tapes, which only ever emit `dir:"event"` for
 *     harness-native lines (DESIGN decision 5), so the oracle comparison is
 *     unaffected; noted because it is a real difference from upstream counts.
 *
 * HONESTY DISCIPLINE (DESIGN decision 15): every metric is a finite number or
 * null. null renders "n/a" and means "we have no data", which is NOT the claim
 * that the value is 0. Never NaN, never Infinity.
 *
 * ECHOED TURNS: a turn with `echoed: true` is the client re-sending prior
 * context, not a generation. It is excluded from model aggregates AND from tool
 * pairing; an echoed assistant turn repeats its `tool_use` blocks verbatim, so
 * counting them double-counts every call.
 */

import { percentile } from '../gates/stats.js';

export { percentile };

// ---------------------------------------------------------------------------
// Record shapes (structurally tolerant: unknown-anything must be readable)
// ---------------------------------------------------------------------------

export interface TraceRecord {
  type?: unknown;
  t?: unknown;
  dir?: unknown;
  kind?: unknown;
  raw?: unknown;
  role?: unknown;
  model?: unknown;
  blocks?: unknown;
  usage?: unknown;
  timing?: unknown;
  echoed?: unknown;
  source?: unknown;
  corr_id?: unknown;
  data?: unknown;
  [k: string]: unknown;
}

export interface Block {
  type?: unknown;
  thinking?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
}

export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  thinking_tokens?: number | null;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Result shapes (the `mcp-tape.stats/1` contract)
// ---------------------------------------------------------------------------

export const STATS_SCHEMA = 'mcp-tape.stats/1';

export interface RecordCounts {
  total: number;
  meta: number;
  message: number;
  event: number;
  turn: number;
  end: number;
  other: number;
}

export interface SessionStats {
  label: string | null;
  kind: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  command: string[] | null;
  producer: string | null;
  records: RecordCounts;
  skippedLines: number;
  endReason: string | null;
  /** Always null for us: we wrap no child process (DESIGN decision 5). */
  exitCode: number | null;
}

export interface ModelStats {
  model: string;
  calls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  thinkingTokens: number | null;
  thinkingEstimated: boolean;
  cacheHitRate: number | null;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  estCostUsd: number | null;
  /** True when no price-table row matched this model id. */
  priced: boolean;
}

export interface ModelSummary {
  models: number;
  assistantTurns: number;
  turns: number;
  echoedTurns: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  thinkingExactTokens: number | null;
  thinkingEstimatedTokens: number | null;
  cacheHitRate: number | null;
  totalModelTimeMs: number | null;
}

export interface CostStats {
  /** Always true. List-price estimates, never billing data. */
  estimated: true;
  currency: 'USD';
  totalUsd: number | null;
  /** True when some usage could not be priced: the total is a lower bound. */
  partial: boolean;
  unpricedModels: string[];
  asOf: string | null;
  source: 'bundled' | string;
}

export interface ToolStats {
  name: string;
  calls: number;
  errors: number;
  p50Ms: number | null;
  p95Ms: number | null;
  /** 'mcp' (JSON-RPC pairs), 'turn' (tool_use blocks), or 'mixed'. */
  origin: 'mcp' | 'turn' | 'mixed';
  /** Calls with no matching result yet (interrupted session). */
  pending: number;
}

export interface ErrorStats {
  t: string | null;
  source: 'tool' | 'jsonrpc' | 'llm';
  name: string;
  message: string;
}

export interface Stats {
  schema: typeof STATS_SCHEMA;
  file: string | null;
  session: SessionStats;
  /** null when the plane carries no non-echoed assistant turns (a pure MCP plane). */
  models: { perModel: ModelStats[]; summary: ModelSummary; cost: CostStats } | null;
  tools: ToolStats[];
  errors: ErrorStats[];
}

/**
 * Two-plane stats. Shaped as `mcp-tape.stats/1` at the top level (unknown extra
 * fields are tolerated by the format), with each plane's own block preserved:
 * the planes are NEVER concatenated into one record list, because the mcp plane
 * and the agent plane describe the SAME tool calls from opposite sides and
 * summing them double-counts every call (DESIGN decision 4, verified upstream).
 */
export interface TraceStats extends Stats {
  planes: { mcp: Stats; agent: Stats };
  /** Which plane the tool table was taken from. */
  toolsPlane: 'mcp' | 'agent' | null;
}

// ---------------------------------------------------------------------------
// Prices (DESIGN decision 3). Fail closed: unknown model => no cost, ever.
// ---------------------------------------------------------------------------

export interface PriceEntry {
  /** Canonical model id; a dated variant (`<id>-20260514`) also matches. */
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  asOf: string;
}

/** Per-MTok list prices. Sonnet 5 is a permanent price per DESIGN decision 3. */
export const PRICE_TABLE: readonly PriceEntry[] = [
  { model: 'claude-sonnet-5', inputPerMTok: 2, outputPerMTok: 10, asOf: '2026-08-19' },
  { model: 'claude-opus-5', inputPerMTok: 5, outputPerMTok: 25, asOf: '2026-08-19' },
  { model: 'claude-haiku-4-5', inputPerMTok: 1, outputPerMTok: 5, asOf: '2026-08-19' },
];

/**
 * Standard Anthropic cache multipliers over the base input rate. Named
 * constants, not a guess at a missing price: a 5m cache write bills at 1.25x
 * input and a cache read at 0.1x input. Ignoring cache tokens outright would
 * report a cached run as nearly free, which is the wrong direction of lie.
 */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/** Exact id or dated variant. Returns null for anything unrecognised. */
export function resolvePrice(
  model: string | null | undefined,
  table: readonly PriceEntry[] = PRICE_TABLE,
): PriceEntry | null {
  if (typeof model !== 'string' || model.length === 0) return null;
  for (const entry of table) {
    if (model === entry.model || model.startsWith(`${entry.model}-`)) return entry;
  }
  return null;
}

/**
 * Dollar estimate for one usage block. `null` when the model has no price row
 * (fail closed, DESIGN decision 15) or when there is no usage to price.
 */
export function estimateCostUsd(usage: Usage | null | undefined, price: PriceEntry | null): number | null {
  if (!price || !usage || typeof usage !== 'object') return null;
  const input = num(usage.input_tokens) ?? 0;
  const output = num(usage.output_tokens) ?? 0;
  const cacheRead = num(usage.cache_read_input_tokens) ?? 0;
  const cacheWrite = num(usage.cache_creation_input_tokens) ?? 0;
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null;
  const usd =
    (input / 1e6) * price.inputPerMTok +
    (cacheRead / 1e6) * price.inputPerMTok * CACHE_READ_MULTIPLIER +
    (cacheWrite / 1e6) * price.inputPerMTok * CACHE_WRITE_MULTIPLIER +
    (output / 1e6) * price.outputPerMTok;
  return Number.isFinite(usd) ? usd : null;
}

function newestAsOf(table: readonly PriceEntry[]): string | null {
  let newest: string | null = null;
  for (const e of table) if (newest === null || e.asOf > newest) newest = e.asOf;
  return newest;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function msBetween(aIso: unknown, bIso: unknown): number | null {
  const a = str(aIso);
  const b = str(bIso);
  if (!a || !b) return null;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.max(0, tb - ta);
}

/** Producer namespace for id keying. Absent `source` means mcp-tape (§1). */
function sourceKey(r: TraceRecord): string {
  return str(r?.source) ?? 'mcp-tape';
}

/** Correlation id (our task id) if the line carries one. */
export function corrId(r: TraceRecord | undefined): string | null {
  return r ? str(r.corr_id) : null;
}

/**
 * Thinking magnitude for one turn:
 *   1. usage.thinking_tokens  -> exact
 *   2. thinking block chars/4 -> estimated
 *   3. neither                -> null
 */
export function thinkingMagnitude(turn: TraceRecord): { tokens: number; estimated: boolean } | null {
  const usage = obj(turn?.usage) as Usage | undefined;
  const exact = num(usage?.thinking_tokens);
  if (exact != null) return { tokens: exact, estimated: false };
  const blocks = Array.isArray(turn?.blocks) ? (turn.blocks as Block[]) : [];
  let chars = 0;
  for (const b of blocks) {
    if (b?.type === 'thinking' && typeof b.thinking === 'string') chars += b.thinking.length;
  }
  if (chars > 0) return { tokens: Math.max(1, Math.round(chars / 4)), estimated: true };
  return null;
}

function reportsCache(usage: Usage | null): boolean {
  if (!usage || typeof usage !== 'object') return false;
  return num(usage.cache_read_input_tokens) != null || num(usage.cache_creation_input_tokens) != null;
}

/** cache hit rate = cache_read / (input + cache_read + cache_creation); null, never 0. */
function hitRate(cacheRead: number, input: number, cacheCreation: number, reportedTurns: number): number | null {
  if (!reportedTurns) return null;
  const denom = input + cacheRead + cacheCreation;
  if (!(denom > 0)) return null;
  return cacheRead / denom;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

function recordKind(r: TraceRecord): keyof Omit<RecordCounts, 'total'> {
  if (r?.type === 'meta') return 'meta';
  if (r?.type === 'end') return 'end';
  if (r?.type === 'turn') return 'turn';
  if (r?.dir === 'event' || r?.dir === 'command' || r?.dir === 'telemetry') return 'event';
  if (r?.dir === 'in' || r?.dir === 'out') return 'message';
  return 'other'; // tolerance rule: unknown record types are counted, never fatal
}

function producerLabel(meta: TraceRecord | null): string | null {
  if (!meta) return null;
  const source = str(meta.source);
  if (source) return source;
  const p = meta.producer;
  if (typeof p === 'string') return str(p);
  const po = obj(p);
  if (po) {
    const name = str(po.name);
    const version = str(po.version);
    if (name) return version ? `${name}@${version}` : name;
  }
  const v = str(meta.mcpTapVersion);
  return v ? `mcp-tape@${v}` : null;
}

function buildSession(records: readonly TraceRecord[], skippedLines: number): SessionStats {
  const meta = records.find((r) => r?.type === 'meta') ?? null;
  const end = records.find((r) => r?.type === 'end') ?? null;

  const counts: RecordCounts = { total: records.length, meta: 0, message: 0, event: 0, turn: 0, end: 0, other: 0 };
  let lastT: string | null = null;
  for (const r of records) {
    counts[recordKind(r)] += 1;
    const t = str(r?.t);
    if (t && (lastT === null || t > lastT)) lastT = t;
  }

  const startedAt = str(meta?.startedAt);
  const endedAt = str(end?.t) ?? lastT;
  const durationMs = num(end?.durationMs) ?? msBetween(startedAt, endedAt);

  const command = Array.isArray(meta?.command)
    ? (meta.command as unknown[]).filter((c): c is string => typeof c === 'string')
    : null;

  return {
    label: str(meta?.label),
    // Consumers MUST assume "mcp" when meta.kind is absent (format.md).
    kind: meta ? str(meta.kind) ?? 'mcp' : null,
    startedAt,
    endedAt,
    durationMs,
    command: command && command.length > 0 ? command : null,
    producer: producerLabel(meta),
    records: counts,
    skippedLines,
    endReason: str(end?.reason),
    exitCode: num(end?.exitCode),
  };
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

interface ModelSlot {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  usageTurns: number;
  cacheReportedTurns: number;
  cacheReadReportedTurns: number;
  cacheCreationReportedTurns: number;
  thinkingExact: number;
  thinkingEstimated: number;
  ttfts: number[];
}

function newSlot(model: string): ModelSlot {
  return {
    model,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    usageTurns: 0,
    cacheReportedTurns: 0,
    cacheReadReportedTurns: 0,
    cacheCreationReportedTurns: 0,
    thinkingExact: 0,
    thinkingEstimated: 0,
    ttfts: [],
  };
}

function buildModels(turns: readonly TraceRecord[], table: readonly PriceEntry[], priceSource: string): Stats['models'] {
  const byModel = new Map<string, ModelSlot>();
  let assistantTurns = 0;
  let echoedTurns = 0;
  let totalDurationMs = 0;
  let sawDuration = false;

  for (const turn of turns) {
    if (turn?.role !== 'assistant') continue;
    if (turn.echoed === true) {
      echoedTurns += 1;
      continue;
    }
    assistantTurns += 1;

    const key = str(turn.model) ?? '(no model)';
    let slot = byModel.get(key);
    if (!slot) {
      slot = newSlot(key);
      byModel.set(key, slot);
    }
    slot.calls += 1;

    const usage = (obj(turn.usage) ?? null) as Usage | null;
    if (usage) {
      slot.usageTurns += 1;
      slot.inputTokens += num(usage.input_tokens) ?? 0;
      slot.outputTokens += num(usage.output_tokens) ?? 0;
      if (reportsCache(usage)) {
        slot.cacheReportedTurns += 1;
        const read = num(usage.cache_read_input_tokens);
        const creation = num(usage.cache_creation_input_tokens);
        if (read != null) slot.cacheReadReportedTurns += 1;
        if (creation != null) slot.cacheCreationReportedTurns += 1;
        slot.cacheReadTokens += read ?? 0;
        slot.cacheCreationTokens += creation ?? 0;
      }
    }

    const think = thinkingMagnitude(turn);
    if (think) {
      if (think.estimated) slot.thinkingEstimated += think.tokens;
      else slot.thinkingExact += think.tokens;
    }

    const timing = obj(turn.timing);
    const ttft = num(timing?.ttft_ms);
    if (ttft != null) slot.ttfts.push(ttft);
    const dur = num(timing?.duration_ms);
    if (dur != null) {
      totalDurationMs += dur;
      sawDuration = true;
    }
  }

  if (assistantTurns === 0) return null;

  const unpriced: string[] = [];
  let totalUsd = 0;
  let anyPriced = false;

  const perModel: ModelStats[] = [];
  for (const s of byModel.values()) {
    const price = resolvePrice(s.model, table);
    const agg: Usage = {
      input_tokens: s.usageTurns > 0 ? s.inputTokens : null,
      output_tokens: s.usageTurns > 0 ? s.outputTokens : null,
      cache_read_input_tokens: s.cacheReadReportedTurns > 0 ? s.cacheReadTokens : null,
      cache_creation_input_tokens: s.cacheCreationReportedTurns > 0 ? s.cacheCreationTokens : null,
    };
    const cost = s.usageTurns > 0 ? estimateCostUsd(agg, price) : null;
    if (price == null) {
      if (s.usageTurns > 0) unpriced.push(s.model);
    } else if (cost != null) {
      anyPriced = true;
      totalUsd += cost;
    }

    const thinkingTotal = s.thinkingExact + s.thinkingEstimated;
    perModel.push({
      model: s.model,
      calls: s.calls,
      inputTokens: s.usageTurns > 0 ? s.inputTokens : null,
      outputTokens: s.usageTurns > 0 ? s.outputTokens : null,
      cacheReadTokens: s.cacheReadReportedTurns > 0 ? s.cacheReadTokens : null,
      cacheCreationTokens: s.cacheCreationReportedTurns > 0 ? s.cacheCreationTokens : null,
      thinkingTokens: thinkingTotal > 0 ? thinkingTotal : null,
      thinkingEstimated: s.thinkingEstimated > 0,
      cacheHitRate: hitRate(s.cacheReadTokens, s.inputTokens, s.cacheCreationTokens, s.cacheReportedTurns),
      ttftP50Ms: percentile(s.ttfts, 50),
      ttftP95Ms: percentile(s.ttfts, 95),
      estCostUsd: cost,
      priced: price != null,
    });
  }
  perModel.sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let thinkingExact = 0;
  let thinkingEstimated = 0;
  let anyUsage = false;
  let anyCache = false;
  let anyCacheRead = false;
  let anyCacheCreation = false;
  for (const s of byModel.values()) {
    inputTokens += s.inputTokens;
    outputTokens += s.outputTokens;
    cacheRead += s.cacheReadTokens;
    cacheCreation += s.cacheCreationTokens;
    thinkingExact += s.thinkingExact;
    thinkingEstimated += s.thinkingEstimated;
    if (s.usageTurns > 0) anyUsage = true;
    if (s.cacheReportedTurns > 0) anyCache = true;
    if (s.cacheReadReportedTurns > 0) anyCacheRead = true;
    if (s.cacheCreationReportedTurns > 0) anyCacheCreation = true;
  }

  const summary: ModelSummary = {
    models: perModel.length,
    assistantTurns,
    turns: turns.length,
    echoedTurns,
    inputTokens: anyUsage ? inputTokens : null,
    outputTokens: anyUsage ? outputTokens : null,
    cacheReadTokens: anyCacheRead ? cacheRead : null,
    cacheCreationTokens: anyCacheCreation ? cacheCreation : null,
    thinkingExactTokens: thinkingExact > 0 ? thinkingExact : null,
    thinkingEstimatedTokens: thinkingEstimated > 0 ? thinkingEstimated : null,
    cacheHitRate: hitRate(cacheRead, inputTokens, cacheCreation, anyCache ? 1 : 0),
    totalModelTimeMs: sawDuration ? totalDurationMs : null,
  };

  const cost: CostStats = {
    estimated: true,
    currency: 'USD',
    // No priced model resolved -> n/a, not $0.00. An absent rate is not a free call.
    totalUsd: anyPriced ? totalUsd : null,
    partial: unpriced.length > 0 && anyPriced,
    unpricedModels: unpriced.sort((a, b) => a.localeCompare(b)),
    asOf: newestAsOf(table),
    source: priceSource,
  };

  return { perModel, summary, cost };
}

// ---------------------------------------------------------------------------
// Tool pairing
// ---------------------------------------------------------------------------

export interface PairRow {
  id: unknown;
  tool: string;
  /** Request timestamp (ISO) when known. */
  t: string | null;
  /** Response timestamp (ISO) when known. */
  endT: string | null;
  latencyMs: number | null;
  /** Human-readable failure reason, or null when the call succeeded. */
  error: string | null;
  /** JSON-RPC transport/protocol error (never a tool-reported failure). */
  protocolError: boolean;
  /** `result.isError: true` on a SUCCESSFUL response: the common failure class. */
  executionError: boolean;
  /** MRTR round: the server asked for more input instead of executing. */
  inputRequired: boolean;
  pending: boolean;
  origin: 'mcp' | 'turn';
  corrId: string | null;
  args: unknown;
}

/**
 * A tool that fails does NOT return a JSON-RPC error: per the MCP spec it
 * returns a SUCCESSFUL response carrying `result.isError: true`, with the
 * reason in the content blocks, precisely so the model can read the failure and
 * react. Reading only `raw.error` therefore misses the most common failure on a
 * real trace (DESIGN decision 9). Returns the reason, or null on success.
 */
export function toolResultError(raw: Record<string, unknown> | undefined): string | null {
  const result = obj(raw?.result);
  if (!result || result.isError !== true) return null;
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks
    .map((b) => str(obj(b)?.text))
    .filter((t): t is string => !!t)
    .join(' ')
    .trim();
  return text || 'tool reported an error';
}

/** True when a tools/call response is an MRTR round rather than an execution. */
export function isInputRequired(raw: Record<string, unknown> | undefined): boolean {
  const result = obj(raw?.result);
  if (!result) return false;
  if (result.input_required != null) return true;
  if (str(result.status) === 'input_required') return true;
  // A byte-exact `requestState` echo is the modern-era continuation marker
  // (DESIGN decision 8): the server wants another round, it has not executed.
  if (result.requestState != null && result.isError !== true) return true;
  return false;
}

export function errorMessage(err: unknown): string {
  if (err == null) return 'error';
  if (typeof err === 'string') return err;
  const e = obj(err);
  if (e) {
    const msg = str(e.message);
    const code = e.code;
    if (msg) return code !== undefined && code !== null ? `${msg} (code ${String(code)})` : msg;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/** Flatten a tool_result `content` (string | block array) to text. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : str((c as Block)?.text) ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/**
 * Pair `tools/call` requests with their responses.
 *
 * KEYED BY `${source}::${id}` (the fix): JSON-RPC ids are unique only within
 * one producer's connection, so a bare id can cross-pair frames from two
 * interleaved producers.
 */
export function buildMcpPairs(messages: readonly TraceRecord[]): PairRow[] {
  const requestsByKey = new Map<string, TraceRecord>();
  for (const m of messages) {
    const raw = obj(m?.raw);
    if (m?.dir === 'in' && raw?.method === 'tools/call' && raw?.id != null) {
      requestsByKey.set(`${sourceKey(m)}::${String(raw.id)}`, m);
    }
  }

  const rows: PairRow[] = [];
  for (const m of messages) {
    const raw = obj(m?.raw);
    if (m?.dir !== 'out' || raw?.id == null) continue;
    const key = `${sourceKey(m)}::${String(raw.id)}`;
    const req = requestsByKey.get(key);
    if (!req) continue; // response with no paired tools/call request
    const reqRaw = obj(req.raw) ?? {};
    const params = obj(reqRaw.params);
    const protocolError = raw.error != null;
    const execError = toolResultError(raw);
    rows.push({
      id: raw.id,
      tool: str(params?.name) ?? '(unknown)',
      t: str(req.t),
      endT: str(m.t),
      latencyMs: msBetween(req.t, m.t),
      error: protocolError ? errorMessage(raw.error) : execError,
      protocolError,
      executionError: !protocolError && execError != null,
      inputRequired: !protocolError && isInputRequired(raw),
      pending: false,
      origin: 'mcp',
      corrId: corrId(req) ?? corrId(m),
      args: params?.arguments,
    });
    requestsByKey.delete(key);
  }

  // Requests with no response: real calls, unknown latency. Never dropped.
  for (const req of requestsByKey.values()) {
    const reqRaw = obj(req.raw) ?? {};
    const params = obj(reqRaw.params);
    rows.push({
      id: reqRaw.id,
      tool: str(params?.name) ?? '(unknown)',
      t: str(req.t),
      endT: null,
      latencyMs: null,
      error: null,
      protocolError: false,
      executionError: false,
      inputRequired: false,
      pending: true,
      origin: 'mcp',
      corrId: corrId(req),
      args: params?.arguments,
    });
  }
  return rows;
}

/**
 * Pair assistant `tool_use` blocks with the later `tool_result` block carrying
 * the matching `tool_use_id`. Echoed turns MUST already be filtered out by the
 * caller (`liveTurns`); an echoed turn repeats its tool_use blocks verbatim.
 * Keyed by `${source}::${tool_use_id}` for the same reason as the MCP plane.
 */
export function buildTurnPairs(turns: readonly TraceRecord[]): PairRow[] {
  const rows: PairRow[] = [];
  const open = new Map<string, PairRow>();
  for (const turn of turns) {
    const blocks = Array.isArray(turn?.blocks) ? (turn.blocks as Block[]) : [];
    const ns = sourceKey(turn);
    // Results first: a turn's tool_result always references an EARLIER turn's
    // tool_use, never one from the same turn.
    for (const b of blocks) {
      if (b?.type !== 'tool_result' || b.tool_use_id == null) continue;
      const key = `${ns}::${String(b.tool_use_id)}`;
      const row = open.get(key);
      if (!row) continue; // orphan result: tolerate, never throw
      row.latencyMs = msBetween(row.t, turn.t);
      row.endT = str(turn.t);
      row.error = b.is_error ? resultText(b.content) || 'tool error' : null;
      row.executionError = b.is_error === true;
      row.pending = false;
      open.delete(key);
    }
    for (const b of blocks) {
      if (b?.type !== 'tool_use' || b.id == null) continue;
      const row: PairRow = {
        id: b.id,
        tool: str(b.name) ?? '(unknown)',
        t: str(turn.t),
        endT: null,
        latencyMs: null,
        error: null,
        protocolError: false,
        executionError: false,
        inputRequired: false,
        pending: true,
        origin: 'turn',
        corrId: corrId(turn),
        args: b.input,
      };
      rows.push(row);
      open.set(`${ns}::${String(b.id)}`, row);
    }
  }
  return rows;
}

/** Turns in chronological order with echoed turns removed. */
export function liveTurns(records: readonly TraceRecord[]): TraceRecord[] {
  return records
    .filter((r) => r?.type === 'turn')
    .slice()
    .sort((a, b) => (str(a.t) ?? '').localeCompare(str(b.t) ?? ''))
    .filter((t) => t.echoed !== true);
}

export function buildToolStats(pairs: readonly PairRow[]): ToolStats[] {
  interface Slot {
    name: string;
    calls: number;
    errors: number;
    pending: number;
    latencies: number[];
    origins: Set<'mcp' | 'turn'>;
  }
  const byTool = new Map<string, Slot>();
  for (const row of pairs) {
    let s = byTool.get(row.tool);
    if (!s) {
      s = { name: row.tool, calls: 0, errors: 0, pending: 0, latencies: [], origins: new Set() };
      byTool.set(row.tool, s);
    }
    s.calls += 1;
    if (row.error != null) s.errors += 1;
    if (row.pending) s.pending += 1;
    if (row.latencyMs != null) s.latencies.push(row.latencyMs);
    s.origins.add(row.origin);
  }
  const out: ToolStats[] = [];
  for (const s of byTool.values()) {
    out.push({
      name: s.name,
      calls: s.calls,
      errors: s.errors,
      // Absent latency is not zero: percentiles cover the calls we timed, and
      // are null when we timed none.
      p50Ms: percentile(s.latencies, 50),
      p95Ms: percentile(s.latencies, 95),
      origin: s.origins.size > 1 ? 'mixed' : s.origins.values().next().value ?? 'mcp',
      pending: s.pending,
    });
  }
  out.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  return out;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function buildErrors(records: readonly TraceRecord[], pairs: readonly PairRow[]): ErrorStats[] {
  const out: ErrorStats[] = [];

  // 1. Failed tool calls (JSON-RPC errors on tools/call, isError results, and
  //    turn tool_result blocks flagged is_error).
  const toolErrorIds = new Set<string>();
  for (const row of pairs) {
    if (row.error == null) continue;
    if (row.origin === 'mcp') toolErrorIds.add(String(row.id));
    out.push({ t: row.t, source: 'tool', name: row.tool, message: row.error });
  }

  // 2. JSON-RPC errors that are NOT tools/call responses (initialize failing,
  //    tools/list failing). tools/call ids are skipped to avoid double-listing.
  const methodById = new Map<string, string>();
  for (const m of records) {
    const raw = obj(m?.raw);
    if (m?.dir === 'in' && raw?.id != null && str(raw.method)) {
      methodById.set(String(raw.id), str(raw.method)!);
    }
  }
  for (const m of records) {
    const raw = obj(m?.raw);
    if (m?.dir !== 'out' || raw?.error == null) continue;
    const id = raw.id != null ? String(raw.id) : null;
    if (id != null && toolErrorIds.has(id)) continue;
    out.push({
      t: str(m.t),
      source: 'jsonrpc',
      name: (id != null ? methodById.get(id) : null) ?? (id != null ? `id ${id}` : '(notification)'),
      message: errorMessage(raw.error),
    });
  }

  // 3. llm.error event lines.
  for (const m of records) {
    if (m?.dir !== 'event' || m?.kind !== 'llm.error') continue;
    const raw = obj(m.raw) ?? obj(m.data) ?? {};
    const status = raw.status;
    const message =
      raw.error != null ? errorMessage(raw.error) : status != null ? `HTTP ${String(status)}` : 'llm error';
    out.push({
      t: str(m.t),
      source: 'llm',
      name: str(raw.endpoint) ?? str(raw.url) ?? '(llm)',
      message,
    });
  }

  out.sort((a, b) => (a.t ?? '').localeCompare(b.t ?? ''));
  return out;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export interface ComputeOptions {
  file?: string | null;
  skippedLines?: number;
  priceTable?: readonly PriceEntry[];
  priceSource?: string;
}

/**
 * Full `mcp-tape.stats/1` for ONE plane. Tolerant by contract: unknown record
 * types are counted, never fatal. This is the function the mcp-tape oracle test
 * compares against, one file at a time.
 */
export function computeStats(records: readonly TraceRecord[], opts: ComputeOptions = {}): Stats {
  const list = Array.isArray(records) ? records.filter((r) => r && typeof r === 'object') : [];

  const session = buildSession(list, opts.skippedLines ?? 0);
  const messages = list.filter((r) => r?.dir === 'in' || r?.dir === 'out');
  const sortedTurns = list
    .filter((r) => r?.type === 'turn')
    .slice()
    .sort((a, b) => (str(a.t) ?? '').localeCompare(str(b.t) ?? ''));
  const live = sortedTurns.filter((t) => t.echoed !== true);

  const pairs = [...buildMcpPairs(messages), ...buildTurnPairs(live)];

  return {
    schema: STATS_SCHEMA,
    file: opts.file ?? null,
    session,
    models: buildModels(sortedTurns, opts.priceTable ?? PRICE_TABLE, opts.priceSource ?? 'bundled'),
    tools: buildToolStats(pairs),
    errors: buildErrors(list, pairs),
  };
}

export interface TwoPlaneInput {
  mcp: readonly TraceRecord[];
  agent: readonly TraceRecord[];
}

function mergeCounts(a: RecordCounts, b: RecordCounts): RecordCounts {
  return {
    total: a.total + b.total,
    meta: a.meta + b.meta,
    message: a.message + b.message,
    event: a.event + b.event,
    turn: a.turn + b.turn,
    end: a.end + b.end,
    other: a.other + b.other,
  };
}

function minIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * The report's `trace_stats` block for a two-plane run.
 *
 * The planes are computed SEPARATELY and the tool table is taken from exactly
 * one of them (the mcp plane when it saw any call, otherwise the agent plane):
 * both planes describe the same calls, so a concatenated list double-counts.
 */
export function computeTraceStats(input: TwoPlaneInput, opts: ComputeOptions = {}): TraceStats {
  const mcp = computeStats(input.mcp ?? [], { ...opts, file: null });
  const agent = computeStats(input.agent ?? [], { ...opts, file: null });

  const toolsFromMcp = mcp.tools.length > 0;
  const toolsPlane: 'mcp' | 'agent' | null = toolsFromMcp ? 'mcp' : agent.tools.length > 0 ? 'agent' : null;

  const tools = toolsFromMcp ? mcp.tools : agent.tools;
  const errors = (
    toolsFromMcp
      ? [...mcp.errors, ...agent.errors.filter((e) => e.source !== 'tool')]
      : [...mcp.errors.filter((e) => e.source !== 'tool'), ...agent.errors]
  ).sort((a, b) => (a.t ?? '').localeCompare(b.t ?? ''));

  const startedAt = minIso(mcp.session.startedAt, agent.session.startedAt);
  const endedAt = maxIso(mcp.session.endedAt, agent.session.endedAt);
  const session: SessionStats = {
    label: mcp.session.label ?? agent.session.label,
    kind: 'mcp+llm',
    startedAt,
    endedAt,
    durationMs: msBetween(startedAt, endedAt) ?? mcp.session.durationMs ?? agent.session.durationMs,
    command: mcp.session.command ?? agent.session.command,
    producer: mcp.session.producer ?? agent.session.producer,
    records: mergeCounts(mcp.session.records, agent.session.records),
    skippedLines: mcp.session.skippedLines + agent.session.skippedLines,
    endReason: mcp.session.endReason ?? agent.session.endReason,
    exitCode: null,
  };

  return {
    schema: STATS_SCHEMA,
    file: opts.file ?? null,
    session,
    // Only the agent plane carries generations.
    models: agent.models ?? mcp.models,
    tools,
    errors,
    planes: { mcp, agent },
    toolsPlane,
  };
}
