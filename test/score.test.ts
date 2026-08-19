/**
 * Scoring: pairing core (src/score/stats.ts) and the ScoreBlock
 * (src/score/metrics.ts).
 *
 * Every fixture here is a synthetic TWO-PLANE run: an mcp plane of JSON-RPC
 * wire frames and an agent plane of llm turns, exactly as the run writes them.
 * The two are never concatenated, because they describe the same tool calls
 * from opposite sides and a mixed list double-counts every one of them.
 *
 * No network, no API key, no clock: every oracle is a local function.
 */

import { describe, expect, it } from 'vitest';

import {
  buildMcpPairs,
  buildTurnPairs,
  computeStats,
  computeTraceStats,
  isInputRequired,
  liveTurns,
  percentile,
  resolvePrice,
  toolResultError,
  type TraceRecord,
} from '../src/score/stats.js';
import {
  computeScore,
  declaredDestructive,
  extractToolCatalog,
  toolDefinitionOverhead,
  type RunnerTaskOutcome,
  type ScoreInputs,
} from '../src/score/metrics.js';
import type { ScoreBlock, TaskSuite, ToolAttribution } from '../src/types.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const DAY = '2026-08-19T12:00';
/** `sec` like '01.100' -> a full ISO stamp inside the fixture minute. */
const at = (sec: string): string => `${DAY}:${sec}Z`;

function metaLine(kind: 'mcp' | 'llm'): TraceRecord {
  return {
    v: 1,
    type: 'meta',
    startedAt: at('00.000'),
    label: 'canary',
    command: ['fitness-report', 'https://canary.local/mcp'],
    kind,
    source: 'fitness-report@0.1.0',
    producer: { name: 'fitness-report', version: '0.1.0', configHash: 'suite-hash' },
  };
}

function endLine(t: string): TraceRecord {
  return { t, type: 'end', reason: 'eval_complete', durationMs: 6000 };
}

function callReq(t: string, id: number, tool: string, corr: string, args: unknown = {}): TraceRecord {
  return {
    t,
    dir: 'in',
    corr_id: corr,
    raw: { jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } },
  };
}

function okRes(t: string, id: number, corr: string, text = 'ok'): TraceRecord {
  return {
    t,
    dir: 'out',
    corr_id: corr,
    raw: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } },
  };
}

/** The common failure: isError TRUE on a SUCCESSFUL JSON-RPC response. */
function isErrorRes(t: string, id: number, corr: string, text: string): TraceRecord {
  return {
    t,
    dir: 'out',
    corr_id: corr,
    raw: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } },
  };
}

function rpcErrRes(t: string, id: number, corr: string, code: number, message: string): TraceRecord {
  return { t, dir: 'out', corr_id: corr, raw: { jsonrpc: '2.0', id, error: { code, message } } };
}

function inputRequiredRes(t: string, id: number, corr: string): TraceRecord {
  return {
    t,
    dir: 'out',
    corr_id: corr,
    raw: {
      jsonrpc: '2.0',
      id,
      result: { input_required: { message: 'Confirm this transfer' }, requestState: 'state-abc' },
    },
  };
}

const TOOLS_LIST = [
  { name: 'doc_search', description: 'search the docs', annotations: { readOnlyHint: true } },
  { name: 'get_invoice', description: 'fetch an invoice', annotations: { readOnlyHint: true } },
  // UNANNOTATED on purpose: the spec default makes it destructive (DESIGN 10).
  { name: 'transfer_funds', description: 'move money between accounts' },
  { name: 'flaky_search', description: 'sometimes 500s' },
  { name: 'delete_record', description: 'delete a record', annotations: { destructiveHint: true } },
];

function toolsListFrames(): TraceRecord[] {
  return [
    { t: at('00.100'), dir: 'in', raw: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } },
    { t: at('00.200'), dir: 'out', raw: { jsonrpc: '2.0', id: 1, result: { tools: TOOLS_LIST } } },
  ];
}

function assistantTurn(
  t: string,
  corr: string,
  usage: Record<string, number>,
  blocks: unknown[] = [],
  extra: Partial<TraceRecord> = {},
): TraceRecord {
  return {
    t,
    type: 'turn',
    role: 'assistant',
    model: 'claude-sonnet-5',
    corr_id: corr,
    usage,
    blocks,
    ...extra,
  };
}

function userTurn(t: string, corr: string, blocks: unknown[]): TraceRecord {
  return { t, type: 'turn', role: 'user', corr_id: corr, blocks };
}

/**
 * The canonical fixture run.
 *
 *  t1  doc_search x4 (100/200/300/400 ms), first-try success
 *  t2  get_invoice returns isError, retried, succeeds  -> recovered
 *  t3  transfer_funds executes with no confirmation    -> destructive finding
 *  t4  flaky_search request with NO response (pending), budget exhausted
 */
function mcpPlane(): TraceRecord[] {
  return [
    metaLine('mcp'),
    ...toolsListFrames(),
    callReq(at('01.000'), 10, 'doc_search', 't1', { q: 'a' }),
    okRes(at('01.100'), 10, 't1'),
    callReq(at('01.200'), 11, 'doc_search', 't1', { q: 'b' }),
    okRes(at('01.400'), 11, 't1'),
    callReq(at('01.500'), 12, 'doc_search', 't1', { q: 'c' }),
    okRes(at('01.800'), 12, 't1'),
    callReq(at('02.000'), 13, 'doc_search', 't1', { q: 'd' }),
    okRes(at('02.400'), 13, 't1'),
    callReq(at('03.000'), 20, 'get_invoice', 't2', { id: 'wrong' }),
    isErrorRes(at('03.050'), 20, 't2', 'invoice not found; try the invoice number'),
    callReq(at('03.100'), 21, 'get_invoice', 't2', { id: 'INV-1' }),
    okRes(at('03.150'), 21, 't2'),
    callReq(at('04.000'), 30, 'transfer_funds', 't3', { amount: 100 }),
    okRes(at('04.100'), 30, 't3', 'transferred'),
    callReq(at('05.000'), 40, 'flaky_search', 't4', { q: 'boom' }),
    endLine(at('06.000')),
  ];
}

function agentPlane(): TraceRecord[] {
  return [
    metaLine('llm'),
    assistantTurn(at('00.900'), 't1', { input_tokens: 1000, output_tokens: 100 }, [
      { type: 'tool_use', id: 'tu_1', name: 'doc_search', input: { q: 'a' } },
    ]),
    userTurn(at('01.150'), 't1', [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }]),
    // The client re-sending prior context. Same tool_use block, verbatim.
    assistantTurn(
      at('01.160'),
      't1',
      { input_tokens: 1200, output_tokens: 50 },
      [{ type: 'tool_use', id: 'tu_1', name: 'doc_search', input: { q: 'a' } }],
      { echoed: true },
    ),
    assistantTurn(at('01.200'), 't1', { input_tokens: 1300, output_tokens: 80 }, [
      { type: 'text', text: 'the answer is 42' },
    ]),
    assistantTurn(at('02.900'), 't2', { input_tokens: 900, output_tokens: 60 }),
    assistantTurn(at('03.900'), 't3', { input_tokens: 800, output_tokens: 40 }),
    assistantTurn(at('04.900'), 't4', { input_tokens: 700, output_tokens: 30 }),
    endLine(at('06.000')),
  ];
}

const SUITE: TaskSuite = {
  serverSlug: 'canary',
  suiteHash: 'sha256:fixture',
  generatorModel: 'claude-opus-5',
  seed: 7,
  tasks: [
    { id: 't1', prompt: 'find the answer', expectedTools: ['doc_search'], check: { kind: 'substring', where: 'final_text', value: '42' }, destructive: false },
    { id: 't2', prompt: 'get invoice INV-1', expectedTools: ['get_invoice'], check: { kind: 'tool_called', tool: 'get_invoice' }, destructive: false },
    { id: 't3', prompt: 'move 100 to savings', expectedTools: ['transfer_funds'], check: { kind: 'tool_called', tool: 'transfer_funds' }, destructive: true },
    { id: 't4', prompt: 'search for boom', expectedTools: ['flaky_search'], check: { kind: 'tool_called', tool: 'flaky_search' }, destructive: false },
  ],
};

const OUTCOMES: RunnerTaskOutcome[] = [
  { taskId: 't1', firstTrySuccess: true, success: true },
  { taskId: 't2', firstTrySuccess: false, success: true },
  { taskId: 't3', firstTrySuccess: true, success: true },
  { taskId: 't4', firstTrySuccess: false, success: false, budgetExhausted: true, failureTool: 'flaky_search' },
];

function inputs(over: Partial<ScoreInputs> = {}): ScoreInputs {
  return {
    runnerModel: 'claude-sonnet-5',
    suite: SUITE,
    outcomes: OUTCOMES,
    mcpRecords: mcpPlane(),
    agentRecords: agentPlane(),
    ...over,
  };
}

/** Deep scan: a NaN or an Infinity anywhere in the block is a contract break. */
function nonFinitePaths(value: unknown, path = '$'): string[] {
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => nonFinitePaths(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => nonFinitePaths(v, `${path}.${k}`));
  }
  return [];
}

const toolOf = (score: ScoreBlock, name: string): ToolAttribution | undefined =>
  score.tools.find((t) => t.tool === name);

// ---------------------------------------------------------------------------

describe('pairing core', () => {
  it('counts isError:true on a SUCCESSFUL response as a failure', () => {
    const pairs = buildMcpPairs(mcpPlane().filter((r) => r.dir === 'in' || r.dir === 'out'));
    const failed = pairs.find((p) => p.tool === 'get_invoice' && p.error != null);
    expect(failed).toBeDefined();
    expect(failed!.executionError).toBe(true);
    expect(failed!.protocolError).toBe(false);
    expect(failed!.error).toContain('invoice not found');

    // The trap this exists to avoid: raw.error is absent on exactly this frame.
    const raw = { jsonrpc: '2.0', id: 20, result: { content: [{ type: 'text', text: 'nope' }], isError: true } };
    expect((raw as Record<string, unknown>).error).toBeUndefined();
    expect(toolResultError(raw)).toBe('nope');
    expect(toolResultError({ jsonrpc: '2.0', id: 1, result: { content: [] } })).toBeNull();
    // isError with no text still reports a failure, never silence.
    expect(toolResultError({ result: { isError: true } })).toBe('tool reported an error');
  });

  it('keeps a JSON-RPC error separate from a tool-reported error', () => {
    const plane = [
      callReq(at('01.000'), 5, 'delete_record', 'tX'),
      rpcErrRes(at('01.010'), 5, 'tX', -32602, 'Invalid params'),
    ];
    const [pair] = buildMcpPairs(plane);
    expect(pair.protocolError).toBe(true);
    expect(pair.executionError).toBe(false);
    expect(pair.error).toBe('Invalid params (code -32602)');
  });

  it('does not double-count an echoed turn', () => {
    const agent = agentPlane();
    expect(agent.filter((r) => r.echoed === true)).toHaveLength(1);

    const live = liveTurns(agent);
    expect(live.some((t) => t.echoed === true)).toBe(false);

    const pairs = buildTurnPairs(live);
    expect(pairs.filter((p) => p.tool === 'doc_search')).toHaveLength(1);

    // ...and the same list WITHOUT the echoed filter is where the double count
    // comes from, which is the bug this filter exists to prevent.
    const unfiltered = buildTurnPairs(agent.filter((r) => r.type === 'turn'));
    expect(unfiltered.filter((p) => p.tool === 'doc_search')).toHaveLength(2);

    const stats = computeStats(agent);
    expect(stats.models?.summary.echoedTurns).toBe(1);
    expect(stats.models?.summary.assistantTurns).toBe(5);
    // Echoed usage is excluded from the aggregates too.
    expect(stats.models?.summary.inputTokens).toBe(1000 + 1300 + 900 + 800 + 700);
  });

  it('keeps an unmatched call as pending rather than dropping it', () => {
    const pairs = buildMcpPairs(mcpPlane().filter((r) => r.dir === 'in' || r.dir === 'out'));
    const pending = pairs.find((p) => p.tool === 'flaky_search');
    expect(pending).toBeDefined();
    expect(pending!.pending).toBe(true);
    expect(pending!.latencyMs).toBeNull();
    expect(pending!.error).toBeNull();

    const stats = computeStats(mcpPlane());
    const flaky = stats.tools.find((t) => t.name === 'flaky_search');
    expect(flaky).toMatchObject({ calls: 1, pending: 1, errors: 0, p50Ms: null, p95Ms: null });
  });

  it('keys pairs by source AND id so two producers cannot cross-pair', () => {
    const plane: TraceRecord[] = [
      { ...callReq(at('01.000'), 1, 'alpha_tool', 'tA'), source: 'server-a' },
      { ...callReq(at('01.100'), 1, 'beta_tool', 'tB'), source: 'server-b' },
      { ...okRes(at('01.500'), 1, 'tA'), source: 'server-a' },
      { ...okRes(at('01.900'), 1, 'tB'), source: 'server-b' },
    ];
    const pairs = buildMcpPairs(plane);
    expect(pairs).toHaveLength(2);
    const alpha = pairs.find((p) => p.tool === 'alpha_tool')!;
    const beta = pairs.find((p) => p.tool === 'beta_tool')!;
    expect(alpha.latencyMs).toBe(500);
    expect(beta.latencyMs).toBe(800);
    expect(pairs.some((p) => p.pending)).toBe(false);
  });

  it('reads MRTR input_required rounds without treating them as executions', () => {
    expect(isInputRequired({ result: { input_required: { message: 'confirm?' } } })).toBe(true);
    expect(isInputRequired({ result: { requestState: 'abc' } })).toBe(true);
    expect(isInputRequired({ result: { content: [] } })).toBe(false);
    expect(isInputRequired({ error: { code: -1, message: 'x' } })).toBe(false);
  });

  it('takes percentiles by nearest rank over the timed calls only', () => {
    expect(percentile([100, 200, 300, 400], 50)).toBe(200);
    expect(percentile([100, 200, 300, 400], 95)).toBe(400);
    expect(percentile([], 50)).toBeNull();
  });
});

describe('trace_stats block', () => {
  it('is mcp-tape.stats/1 shaped and never sums the two planes', () => {
    const stats = computeTraceStats({ mcp: mcpPlane(), agent: agentPlane() });
    expect(stats.schema).toBe('mcp-tape.stats/1');
    expect(stats.toolsPlane).toBe('mcp');
    // 8 wire calls on the mcp plane. The agent plane's tool_use block describes
    // one of those same calls: summing the planes would report 9.
    const totalCalls = stats.tools.reduce((sum, t) => sum + t.calls, 0);
    expect(totalCalls).toBe(8);
    expect(stats.planes.agent.tools.reduce((s, t) => s + t.calls, 0)).toBe(1);
    expect(stats.planes.mcp.models).toBeNull(); // a pure wire plane generates nothing
    expect(stats.models?.summary.assistantTurns).toBe(5);
    expect(stats.session.kind).toBe('mcp+llm');
    expect(stats.session.exitCode).toBeNull(); // we wrap no child process
    expect(nonFinitePaths(stats)).toEqual([]);
  });

  it('prices only known models and never invents a rate', () => {
    expect(resolvePrice('claude-sonnet-5')?.inputPerMTok).toBe(2);
    expect(resolvePrice('claude-sonnet-5-20260514')?.outputPerMTok).toBe(10);
    expect(resolvePrice('claude-opus-5')).toMatchObject({ inputPerMTok: 5, outputPerMTok: 25 });
    expect(resolvePrice('claude-haiku-4-5')).toMatchObject({ inputPerMTok: 1, outputPerMTok: 5 });
    expect(resolvePrice('mystery-model-1')).toBeNull();
    expect(resolvePrice(null)).toBeNull();
  });
});

describe('tool catalogue and the destructive default rule', () => {
  it('reads tools/list off the wire', () => {
    const catalog = extractToolCatalog(mcpPlane());
    expect(catalog.map((t) => t.name).sort()).toEqual([
      'delete_record',
      'doc_search',
      'flaky_search',
      'get_invoice',
      'transfer_funds',
    ]);
  });

  it('treats a tool as destructive unless it opts out', () => {
    // Spec defaults are aggressive: destructiveHint TRUE, readOnlyHint FALSE.
    expect(declaredDestructive({ name: 'transfer_funds' })).toBe(true); // unannotated
    expect(declaredDestructive({ name: 'x', annotations: {} })).toBe(true);
    expect(declaredDestructive({ name: 'x', annotations: { readOnlyHint: true } })).toBe(false);
    expect(declaredDestructive({ name: 'x', annotations: { destructiveHint: false } })).toBe(false);
    expect(declaredDestructive({ name: 'x', annotations: { destructiveHint: true } })).toBe(true);
    expect(declaredDestructive(undefined)).toBe(true); // never listed: still destructive
  });
});

describe('computeScore', () => {
  it('scores the canonical two-plane run', () => {
    const { score, traceStats } = computeScore(inputs());

    expect(score.runnerModel).toBe('claude-sonnet-5');
    expect(score.firstTrySuccess).toMatchObject({ k: 2, n: 4 });
    expect(score.firstTrySuccess.rate).toBeCloseTo(0.5, 12);
    expect(score.firstTrySuccess.low).toBeLessThan(score.firstTrySuccess.rate);
    expect(score.firstTrySuccess.high).toBeGreaterThan(score.firstTrySuccess.rate);
    expect(score.eventualSuccess).toMatchObject({ k: 3, n: 4 });

    // Calls per COMPLETED task: t1 4, t2 2, t3 1. t4 failed, so it is excluded.
    expect(score.meanCallsPerCompletedTask).toBeCloseTo(7 / 3, 12);

    // Tokens net of the per-request tool-definition overhead (sonnet-5: 354).
    // t1: (1000+100)+(1300+80) - 2*354 = 1772  (the echoed turn contributes 0)
    // t2: 960 - 354 = 606, t3: 840 - 354 = 486
    expect(score.meanTokensPerCompletedTask).toBeCloseTo((1772 + 606 + 486) / 3, 9);

    // $2/MTok in, $10/MTok out, on the gross billed tokens.
    expect(score.meanCostPerCompletedTaskUsd).toBeCloseTo((0.0064 + 0.0024 + 0.002) / 3, 12);

    expect(score.tasks.map((t) => t.taskId)).toEqual(['t1', 't2', 't3', 't4']);
    expect(nonFinitePaths(score)).toEqual([]);
    expect(traceStats.schema).toBe('mcp-tape.stats/1');
  });

  it('attributes per-tool calls, errors and latency percentiles', () => {
    const { score } = computeScore(inputs());

    const search = toolOf(score, 'doc_search')!;
    expect(search).toMatchObject({ calls: 4, errors: 0, p50Ms: 200, p95Ms: 400, declaredDestructive: false });
    expect(search.inferredDestructive).toBeNull(); // judge signal not run

    const invoice = toolOf(score, 'get_invoice')!;
    expect(invoice).toMatchObject({ calls: 2, errors: 1, p50Ms: 50, p95Ms: 50 });
    // The agent retried and succeeded, so the isError is RECOVERED, not fatal.
    expect(invoice.failureClasses).toEqual({ 'execution-error-recovered': 1 });

    const flaky = toolOf(score, 'flaky_search')!;
    expect(flaky).toMatchObject({ calls: 1, p50Ms: null, p95Ms: null });
    expect(flaky.failureClasses['budget-exhausted']).toBe(1);

    expect(score.tasks.find((t) => t.taskId === 't2')!.failure).toBe('execution-error-recovered');
    expect(score.tasks.find((t) => t.taskId === 't4')!.failure).toBe('budget-exhausted');
  });

  it('classifies an unrecovered isError as fatal', () => {
    const outcomes: RunnerTaskOutcome[] = OUTCOMES.map((o) =>
      o.taskId === 't2' ? { ...o, success: false } : o,
    );
    const { score } = computeScore(inputs({ outcomes }));
    expect(toolOf(score, 'get_invoice')!.failureClasses).toEqual({ 'execution-error-fatal': 1 });
    expect(score.tasks.find((t) => t.taskId === 't2')!.failure).toBe('execution-error-fatal');
  });

  it('flags a destructive call that was never confirmed', () => {
    const { score } = computeScore(inputs());
    // transfer_funds carries NO annotations, so the spec default makes it
    // destructive, and nothing on the wire asked before it executed.
    expect(toolOf(score, 'transfer_funds')!.declaredDestructive).toBe(true);
    expect(score.destructiveWithoutConfirmation).toBe(1);
    expect(score.tasks.find((t) => t.taskId === 't3')!.destructiveWithoutConfirmation).toBe(1);
    // Read-only tools are never counted, and a pending call never executed.
    expect(score.tasks.find((t) => t.taskId === 't1')!.destructiveWithoutConfirmation).toBe(0);
    expect(score.tasks.find((t) => t.taskId === 't4')!.destructiveWithoutConfirmation).toBe(0);
  });

  it('does not let a confirmation about one tool clear a destructive call to another', () => {
    // An mrtr_round on lookup_user in t3, then an UNANNOTATED transfer_funds
    // executes in the same task. Task-scoped, tool-agnostic evidence read that
    // as "confirmed" and published zero for the flagship metric while the
    // recording held an unconfirmed money transfer.
    const mcp: TraceRecord[] = [
      ...mcpPlane(),
      {
        t: at('03.060'),
        dir: 'event',
        kind: 'fitness.mrtr_round',
        corr_id: 't3',
        raw: { tool: 'lookup_user', rounds: 1, reason: 'caller-declined' },
      } as TraceRecord,
    ];
    const { score } = computeScore(inputs({ mcpRecords: mcp }));
    expect(score.destructiveWithoutConfirmation).toBe(1);
    expect(score.tasks.find((t) => t.taskId === 't3')!.destructiveWithoutConfirmation).toBe(1);
  });

  it('accepts a same-tool confirmation event that lands before the call', () => {
    const mcp: TraceRecord[] = [
      ...mcpPlane(),
      {
        t: at('03.060'),
        dir: 'event',
        kind: 'fitness.mrtr_round',
        corr_id: 't3',
        raw: { tool: 'transfer_funds', rounds: 1, reason: 'caller-declined' },
      } as TraceRecord,
    ];
    expect(computeScore(inputs({ mcpRecords: mcp })).score.destructiveWithoutConfirmation).toBe(0);
  });

  it('never counts a failure class more times than the errors that produced it', () => {
    // The runner reports a terminal class AND the tool it is attributable to
    // for every failed task, so a wire-derived class bumped again from the
    // outcome published double the real count.
    const outcomes: RunnerTaskOutcome[] = [
      { taskId: 't1', firstTrySuccess: true, success: true },
      { taskId: 't2', firstTrySuccess: false, success: false, failure: 'execution-error-fatal', failureTool: 'get_invoice' },
      { taskId: 't3', firstTrySuccess: true, success: true },
      { taskId: 't4', firstTrySuccess: false, success: false, budgetExhausted: true, failure: 'budget-exhausted', failureTool: 'flaky_search' },
    ];
    const { score } = computeScore(inputs({ outcomes }));
    expect(toolOf(score, 'get_invoice')!.failureClasses).toEqual({ 'execution-error-fatal': 1 });
    expect(toolOf(score, 'get_invoice')!.errors).toBe(1);

    for (const tool of score.tools) {
      const classSum = Object.values(tool.failureClasses).reduce((a, b) => a + b, 0);
      const terminal = score.tasks.filter(
        (t) => (t.failure === 'budget-exhausted' || t.failure === 'mrtr-abandoned') && t.toolCalls > 0,
      ).length;
      expect(classSum).toBeLessThanOrEqual(tool.errors + terminal);
    }
  });

  it('does not flag a destructive call the server asked about first', () => {
    const mcp = mcpPlane().flatMap((r): TraceRecord[] => {
      // Insert an input_required round before the execution of transfer_funds.
      if (r.dir === 'in' && (r.raw as { id?: number }).id === 30) {
        return [callReq(at('03.900'), 29, 'transfer_funds', 't3', { amount: 100 }), inputRequiredRes(at('03.950'), 29, 't3'), r];
      }
      return [r];
    });
    const { score } = computeScore(inputs({ mcpRecords: mcp }));
    expect(score.destructiveWithoutConfirmation).toBe(0);
    expect(toolOf(score, 'transfer_funds')!.calls).toBe(2);
    expect(score.tasks.find((t) => t.taskId === 't3')!.mrtrRounds).toBe(1);
  });

  it('returns nulls, never NaN, when no task completed', () => {
    const outcomes: RunnerTaskOutcome[] = OUTCOMES.map((o) => ({ ...o, firstTrySuccess: false, success: false }));
    const { score } = computeScore(inputs({ outcomes }));

    expect(score.meanCallsPerCompletedTask).toBeNull();
    expect(score.meanTokensPerCompletedTask).toBeNull();
    expect(score.meanCostPerCompletedTaskUsd).toBeNull();
    expect(score.firstTrySuccess).toMatchObject({ k: 0, n: 4, rate: 0 });
    expect(score.eventualSuccess).toMatchObject({ k: 0, n: 4, rate: 0 });
    expect(nonFinitePaths(score)).toEqual([]);
  });

  it('returns nulls, never NaN, on an empty run', () => {
    const { score, traceStats } = computeScore({
      runnerModel: 'claude-sonnet-5',
      suite: { ...SUITE, tasks: [] },
      outcomes: [],
      mcpRecords: [],
      agentRecords: [],
    });
    expect(score.tasks).toHaveLength(0);
    expect(score.tools).toHaveLength(0);
    expect(score.firstTrySuccess).toEqual({ rate: 0, low: 0, high: 1, k: 0, n: 0 });
    expect(score.meanCallsPerCompletedTask).toBeNull();
    expect(score.meanTokensPerCompletedTask).toBeNull();
    expect(score.meanCostPerCompletedTaskUsd).toBeNull();
    expect(nonFinitePaths(score)).toEqual([]);
    expect(nonFinitePaths(traceStats)).toEqual([]);
  });

  it('fails closed on an unknown model: no cost, and it says so', () => {
    const agent = agentPlane().map((r) => (r.type === 'turn' && r.role === 'assistant' ? { ...r, model: 'mystery-model-1' } : r));
    const { score, notes } = computeScore(inputs({ agentRecords: agent }));

    for (const task of score.tasks) expect(task.costUsd).toBeNull();
    expect(score.meanCostPerCompletedTaskUsd).toBeNull();
    expect(notes.some((n) => n.includes('price row'))).toBe(true);

    // Unknown model also means no tool-definition overhead constant: tokens are
    // reported as an upper bound and the note says which way it is wrong.
    expect(toolDefinitionOverhead('mystery-model-1')).toBeNull();
    expect(score.meanTokensPerCompletedTask).toBeCloseTo((2480 + 960 + 840) / 3, 9);
    expect(notes.some((n) => n.includes('overhead'))).toBe(true);
    expect(nonFinitePaths(score)).toEqual([]);
  });

  it('knows the per-model tool-definition overhead constants', () => {
    expect(toolDefinitionOverhead('claude-sonnet-5')).toBe(354);
    expect(toolDefinitionOverhead('claude-opus-5')).toBe(286);
    expect(toolDefinitionOverhead('claude-haiku-4-5')).toBe(496);
    expect(toolDefinitionOverhead('claude-sonnet-5-20260514')).toBe(354);
    expect(toolDefinitionOverhead(undefined)).toBeNull();
  });

  it('counts a protocol error as protocol-error, not an execution failure', () => {
    const mcp = mcpPlane().map((r) =>
      r.dir === 'out' && (r.raw as { id?: number }).id === 30
        ? rpcErrRes(at('04.100'), 30, 't3', -32601, 'Method not found')
        : r,
    );
    const outcomes = OUTCOMES.map((o) => (o.taskId === 't3' ? { ...o, success: false, firstTrySuccess: false } : o));
    const { score } = computeScore(inputs({ mcpRecords: mcp, outcomes }));
    expect(toolOf(score, 'transfer_funds')!.failureClasses).toEqual({ 'protocol-error': 1 });
    expect(score.tasks.find((t) => t.taskId === 't3')!.failure).toBe('protocol-error');
    // A call that errored on the wire never executed: no destructive finding.
    expect(score.destructiveWithoutConfirmation).toBe(0);
  });

  it('records a schema-validation reject against the server, not the agent', () => {
    const mcp = [
      ...mcpPlane(),
      {
        t: at('05.500'),
        dir: 'event',
        kind: 'fitness.schema_reject',
        corr_id: 't4',
        data: { tool: 'flaky_search', detail: 'structuredContent does not match outputSchema' },
      } as TraceRecord,
    ];
    const { score } = computeScore(inputs({ mcpRecords: mcp }));
    expect(toolOf(score, 'flaky_search')!.failureClasses['schema-validation-reject']).toBe(1);
  });

  it('falls back to the agent plane when no wire frames were captured', () => {
    const { score, notes } = computeScore(inputs({ mcpRecords: [], toolCatalog: TOOLS_LIST }));
    expect(toolOf(score, 'doc_search')!.calls).toBe(1); // the echoed repeat is not a second call
    expect(notes.some((n) => n.includes('fell back to the agent plane'))).toBe(true);
  });

  it('carries the judge destructiveness signal and the passthrough findings', () => {
    const { score } = computeScore(
      inputs({
        inferredDestructive: { transfer_funds: true, doc_search: false },
        ambiguousParameters: [{ tool: 'lookup_user', param: 'user', why: 'ambiguous; use user_id', evidence: 'run/mcp.jsonl#L12' }],
        schemaDrift: { checked: true, drifted: false, detail: null },
        toolSurfaceDeltaByCredential: ['owner-key adds delete_record'],
      }),
    );
    expect(toolOf(score, 'transfer_funds')!.inferredDestructive).toBe(true);
    expect(toolOf(score, 'doc_search')!.inferredDestructive).toBe(false);
    expect(score.ambiguousParameters).toHaveLength(1);
    expect(score.schemaDrift).toEqual({ checked: true, drifted: false, detail: null });
    expect(score.toolSurfaceDeltaByCredential).toEqual(['owner-key adds delete_record']);
  });

  it('defaults the passthrough findings without inventing values', () => {
    const { score } = computeScore(inputs());
    expect(score.ambiguousParameters).toEqual([]);
    expect(score.schemaDrift).toEqual({ checked: false, drifted: false, detail: null });
    expect(score.toolSurfaceDeltaByCredential).toBeNull();
  });

  it('counts a suite task the runner never reported as a failure, never shrinking n', () => {
    // DESIGN 12a's stance: a measurement that did not complete never shrinks
    // the denominator. Dropping t4 here would publish 2 of 3 = 67% where the
    // honest number is 2 of 4 = 50%, and the honesty note lives in scoreNotes,
    // which the leaderboard row does not render.
    const { score, notes } = computeScore(inputs({ outcomes: OUTCOMES.filter((o) => o.taskId !== 't4') }));
    expect(score.firstTrySuccess.n).toBe(4);
    expect(score.eventualSuccess.n).toBe(4);
    const t4 = score.tasks.find((t) => t.taskId === 't4');
    expect(t4).toMatchObject({ firstTrySuccess: false, success: false });
    expect(notes.some((n) => n.includes('t4'))).toBe(true);
    expect(notes.some((n) => n.includes('counted as failures'))).toBe(true);
  });

  it('counts a tool call exactly once when its task has no runner outcome', () => {
    // t4's flaky_search request is on the wire. It must be attributed once,
    // not once by the per-task pass and again by the leftover pass.
    const { score } = computeScore(inputs({ outcomes: OUTCOMES.filter((o) => o.taskId !== 't4') }));
    expect(toolOf(score, 'flaky_search')!.calls).toBe(1);
  });

  it('never lets first-try success exceed eventual success', () => {
    const outcomes: RunnerTaskOutcome[] = [{ taskId: 't1', firstTrySuccess: true, success: false }];
    const { score, notes } = computeScore(inputs({ outcomes }));
    expect(score.firstTrySuccess.k).toBe(0);
    expect(score.eventualSuccess.k).toBe(0);
    expect(notes.some((n) => n.includes('first-try'))).toBe(true);
  });
});
