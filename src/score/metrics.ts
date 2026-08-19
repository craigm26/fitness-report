/**
 * ScoreBlock computation for Fitness Report (DESIGN decisions 3, 9, 10, 15).
 *
 * Consumes the two in-memory PRE-REDACTION record planes (mcp wire frames and
 * agent turns) plus the task suite and the runner's per-task outcomes, and
 * produces the ScoreBlock in `src/types.ts`.
 *
 * THE TWO PLANES ARE NEVER CONCATENATED. Both describe the same tool calls from
 * opposite sides, so a single mixed list double-counts every call (DESIGN
 * decision 4). Tool attribution comes from the mcp plane, which is the wire
 * truth; the agent plane supplies token usage and is the fallback when a run
 * captured no wire frames.
 *
 * Honesty rules enforced here:
 *  - every metric is a finite number or null/absent, never NaN (all divisions
 *    are guarded, all means come from `mean()` which is null on an empty sample)
 *  - cost fails CLOSED: an unknown model id yields `costUsd: null`, never a
 *    guessed rate
 *  - a tool is destructive unless it declares `readOnlyHint: true` or
 *    `destructiveHint: false` (the spec defaults are aggressive; DESIGN 10)
 */

import { mean, wilson } from '../gates/stats.js';
import type { FailureClass, ScoreBlock, TaskResult, TaskSuite, ToolAttribution } from '../types.js';
import {
  buildMcpPairs,
  buildTurnPairs,
  computeTraceStats,
  corrId,
  estimateCostUsd,
  liveTurns,
  percentile,
  resolvePrice,
  type PairRow,
  type TraceRecord,
  type TraceStats,
  type Usage,
} from './stats.js';

// ---------------------------------------------------------------------------
// Model constants
// ---------------------------------------------------------------------------

/**
 * Fixed per-request tool-definition overhead, in input tokens, charged by the
 * API for the tool-use system prompt. Netted out of the tokens-per-task metric
 * so two servers are compared on the tokens THEY caused, not on a constant every
 * server pays identically (DESIGN decision 3).
 */
export const TOOL_DEFINITION_OVERHEAD_TOKENS: Readonly<Record<string, number>> = {
  'claude-sonnet-5': 354,
  'claude-opus-5': 286,
  'claude-haiku-4-5': 496,
};

/** Overhead for a model id (dated variants match), or null when unknown. */
export function toolDefinitionOverhead(model: string | null | undefined): number | null {
  if (typeof model !== 'string' || model.length === 0) return null;
  for (const [id, tokens] of Object.entries(TOOL_DEFINITION_OVERHEAD_TOKENS)) {
    if (model === id || model.startsWith(`${id}-`)) return tokens;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A tools/list entry, as declared by the server. */
export interface ToolDescriptor {
  name: string;
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/**
 * What the runner knows about one task that the tapes cannot show: whether the
 * check passed, whether it passed on the FIRST attempt, and the terminal
 * conditions only the loop sees (task budget exhausted, MRTR round cap hit).
 */
export interface RunnerTaskOutcome {
  taskId: string;
  /** Check passed on the first attempt (no retry, no repair turn). */
  firstTrySuccess: boolean;
  /** Check passed eventually. */
  success: boolean;
  /** Runner model for this task; defaults to the pinned runner model. */
  model?: string;
  /** Manual MRTR rounds driven for this task; overrides the wire count. */
  mrtrRounds?: number;
  /** Terminal failure the loop observed. Wins over wire-derived classes. */
  failure?: FailureClass | null;
  /** Tool the terminal failure is attributable to, when the loop knows it. */
  failureTool?: string;
  /** True when `output_config.task_budget` was exhausted (DESIGN decision 19). */
  budgetExhausted?: boolean;
  /** True when the MRTR round cap stopped the task. */
  mrtrAbandoned?: boolean;
  /**
   * Usage fallback, used ONLY when the agent plane carries no turn for this
   * task (so it can never double-count against recorded turns).
   */
  usage?: Usage;
}

export interface ScoreInputs {
  /** Pinned runner model id. Rankings are only valid within one runner model. */
  runnerModel: string;
  suite: TaskSuite;
  outcomes: readonly RunnerTaskOutcome[];
  /** `<run>/mcp.jsonl` records, in memory, pre-redaction. */
  mcpRecords: readonly TraceRecord[];
  /** `<run>/agent.jsonl` records, in memory, pre-redaction. */
  agentRecords: readonly TraceRecord[];
  /** tools/list entries. Parsed off the mcp plane when omitted. */
  toolCatalog?: readonly ToolDescriptor[];
  /** Judge-model destructiveness signal, by tool name. Absent tools stay null. */
  inferredDestructive?: Readonly<Record<string, boolean>>;
  ambiguousParameters?: ScoreBlock['ambiguousParameters'];
  schemaDrift?: ScoreBlock['schemaDrift'];
  toolSurfaceDeltaByCredential?: readonly string[] | null;
}

export interface ScoreOutput {
  score: ScoreBlock;
  /** Honesty notes: every degraded or defaulted decision says so out loud. */
  notes: readonly string[];
  /** `mcp-tape.stats/1`-shaped block for `FitnessReportJson.trace_stats`. */
  traceStats: TraceStats;
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

function bump(counts: Partial<Record<FailureClass, number>>, cls: FailureClass, by = 1): void {
  counts[cls] = (counts[cls] ?? 0) + by;
}

/** Finite guard for any ratio: no NaN, no Infinity, ever (DESIGN decision 15). */
function finite(v: number | null): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Tool catalogue and the destructive rule
// ---------------------------------------------------------------------------

/** Pull tools/list results off the mcp plane, keyed request -> response. */
export function extractToolCatalog(mcpRecords: readonly TraceRecord[]): ToolDescriptor[] {
  const listIds = new Set<string>();
  for (const r of mcpRecords) {
    const raw = obj(r?.raw);
    if (r?.dir === 'in' && raw?.method === 'tools/list' && raw?.id != null) {
      listIds.add(`${str(r.source) ?? 'mcp-tape'}::${String(raw.id)}`);
    }
  }
  const byName = new Map<string, ToolDescriptor>();
  for (const r of mcpRecords) {
    const raw = obj(r?.raw);
    if (r?.dir !== 'out' || raw?.id == null) continue;
    if (!listIds.has(`${str(r.source) ?? 'mcp-tape'}::${String(raw.id)}`)) continue;
    const tools = obj(raw.result)?.tools;
    if (!Array.isArray(tools)) continue;
    for (const t of tools) {
      const to = obj(t);
      const name = str(to?.name);
      if (!name) continue;
      // Later listings win: a tool surface can change mid-run (credential
      // context, DESIGN decision 14) and the latest declaration is the truth.
      byName.set(name, to as ToolDescriptor);
    }
  }
  return [...byName.values()];
}

/**
 * DESIGN decision 10. The spec defaults are aggressive: `destructiveHint`
 * defaults TRUE and `readOnlyHint` defaults FALSE, so an UNANNOTATED tool is
 * destructive. Only an explicit `readOnlyHint: true` or `destructiveHint: false`
 * opts out.
 */
export function declaredDestructive(tool: ToolDescriptor | undefined): boolean {
  const a = tool?.annotations;
  if (a && a.readOnlyHint === true) return false;
  if (a && a.destructiveHint === false) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Per-task accumulation
// ---------------------------------------------------------------------------

interface UsageAcc {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
  hasUsage: boolean;
  costUsd: number;
  costKnown: boolean;
  models: Set<string>;
}

function newUsageAcc(): UsageAcc {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    requests: 0,
    hasUsage: false,
    costUsd: 0,
    costKnown: true,
    models: new Set(),
  };
}

function addUsage(acc: UsageAcc, usage: Usage | null | undefined, model: string): void {
  acc.requests += 1;
  acc.models.add(model);
  const price = resolvePrice(model);
  if (price == null) acc.costKnown = false; // fail closed: no guessed rate
  if (!usage || typeof usage !== 'object') return;
  const input = num(usage.input_tokens) ?? 0;
  const output = num(usage.output_tokens) ?? 0;
  const cacheRead = num(usage.cache_read_input_tokens) ?? 0;
  const cacheWrite = num(usage.cache_creation_input_tokens) ?? 0;
  if (input || output || cacheRead || cacheWrite) acc.hasUsage = true;
  acc.input += input;
  acc.output += output;
  acc.cacheRead += cacheRead;
  acc.cacheWrite += cacheWrite;
  const cost = estimateCostUsd(usage, price);
  if (cost != null) acc.costUsd += cost;
}

/** All input-side tokens billed (base + cache read + cache write) plus output. */
function grossTokens(acc: UsageAcc): number {
  return acc.input + acc.cacheRead + acc.cacheWrite + acc.output;
}

// ---------------------------------------------------------------------------
// Confirmation evidence for the destructive rule
// ---------------------------------------------------------------------------

/**
 * Confirmation evidence is PER CALL, never per task.
 *
 * The published METHODS rule is that every executed call to a declared
 * destructive tool counts, because v0 has no confirmation channel to put in
 * front of it. The only thing that can clear one such call is evidence that
 * names THE SAME TOOL and lands before the call executes. Keying this by task
 * alone made one `fitness.mrtr_round` on any tool clear every later destructive
 * call in the task, which silently zeroed the flagship metric: a recorded,
 * unconfirmed money transfer would publish as "0 destructive calls with no
 * confirmation in front of them".
 */
interface ConfirmationEvidence {
  /** `${taskId} ${tool}` -> sorted ISO timestamps at which the user was asked. */
  byTaskTool: Map<string, string[]>;
  /** `${tool}` -> timestamps, for evidence carrying no corr_id (applies to any task). */
  byTool: Map<string, string[]>;
  /** Evidence that named no tool. Counted and reported, never credited to a call. */
  unattributed: number;
}

const evidenceKey = (task: string, tool: string): string => `${task} ${tool}`;

function collectConfirmations(mcpRecords: readonly TraceRecord[], pairs: readonly PairRow[]): ConfirmationEvidence {
  const byTaskTool = new Map<string, string[]>();
  const byTool = new Map<string, string[]>();
  let unattributed = 0;
  const push = (task: string | null, tool: string | null, t: string | null): void => {
    if (!t) return;
    if (tool == null) {
      // A confirmation we cannot attribute to a tool clears nothing: crediting
      // it to every call in the task is exactly the bug this shape replaces.
      unattributed += 1;
      return;
    }
    const map = task == null ? byTool : byTaskTool;
    const key = task == null ? tool : evidenceKey(task, tool);
    const list = map.get(key) ?? [];
    list.push(t);
    map.set(key, list);
  };

  for (const r of mcpRecords) {
    const raw = obj(r?.raw);
    // Server-initiated elicitation: the server asked before acting. The tool it
    // asked about is whatever the payload names; an elicitation that names no
    // tool is recorded as unattributed rather than applied to the whole task.
    if (raw && str(raw.method) === 'elicitation/create') {
      const params = obj(raw.params);
      const meta = obj(params?.['_meta']);
      push(corrId(r), str(params?.['tool']) ?? str(meta?.['tool']), str(r.t));
    }
    // Harness-native confirmation events (dir:"event", never in/out).
    if (r?.dir === 'event' && (r.kind === 'fitness.confirmation' || r.kind === 'fitness.mrtr_round')) {
      const data = obj(r.data) ?? obj(r.raw);
      push(corrId(r), str(data?.['tool']), str(r.t));
    }
  }
  // An `input_required` round IS the server asking, for that tool only: the
  // call did not execute.
  for (const p of pairs) {
    if (p.inputRequired) push(p.corrId, p.tool, p.endT ?? p.t);
  }

  for (const list of byTaskTool.values()) list.sort();
  for (const list of byTool.values()) list.sort();
  return { byTaskTool, byTool, unattributed };
}

/**
 * Was the user asked about THIS tool before THIS call executed? Evidence is
 * timestamped and must precede the call: a confirmation that arrives after the
 * fact is not a confirmation, and one about another tool never was.
 */
function wasConfirmedBefore(
  ev: ConfirmationEvidence,
  task: string | null,
  tool: string,
  t: string | null,
): boolean {
  const applies = (list: readonly string[] | undefined): boolean =>
    (list ?? []).some((stamp) => (t == null ? true : stamp <= t));
  if (applies(ev.byTool.get(tool))) return true;
  return task != null && applies(ev.byTaskTool.get(evidenceKey(task, tool)));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function computeScore(input: ScoreInputs): ScoreOutput {
  const notes: string[] = [];
  const mcpRecords = input.mcpRecords ?? [];
  const agentRecords = input.agentRecords ?? [];

  // --- planes, kept separate ------------------------------------------------
  const mcpMessages = mcpRecords.filter((r) => r?.dir === 'in' || r?.dir === 'out');
  const mcpPairs = buildMcpPairs(mcpMessages);
  const agentPairs = buildTurnPairs(liveTurns(agentRecords));

  let pairs: PairRow[];
  if (mcpPairs.length > 0) {
    pairs = mcpPairs;
  } else if (agentPairs.length > 0) {
    pairs = agentPairs;
    notes.push(
      'No tools/call frames on the mcp plane: tool attribution fell back to the agent plane tool_use blocks (latency is model-side, not wire-side).',
    );
  } else {
    pairs = [];
  }

  // --- tool catalogue -------------------------------------------------------
  const catalogList = input.toolCatalog ?? extractToolCatalog(mcpRecords);
  const catalog = new Map<string, ToolDescriptor>();
  for (const t of catalogList) if (str(t?.name)) catalog.set(t.name, t);
  const calledUnknown = new Set<string>();
  for (const p of pairs) if (!catalog.has(p.tool)) calledUnknown.add(p.tool);
  if (calledUnknown.size > 0) {
    notes.push(
      `No tools/list declaration for ${[...calledUnknown].sort().join(', ')}; treated as destructive under the spec default rule.`,
    );
  }

  // --- outcomes -------------------------------------------------------------
  const outcomes: RunnerTaskOutcome[] = [];
  const seen = new Set<string>();
  for (const o of input.outcomes ?? []) {
    if (!o || typeof o.taskId !== 'string') continue;
    if (seen.has(o.taskId)) {
      notes.push(`Duplicate runner outcome for task ${o.taskId}; the last one was used.`);
      const idx = outcomes.findIndex((x) => x.taskId === o.taskId);
      outcomes[idx] = o;
      continue;
    }
    seen.add(o.taskId);
    outcomes.push(o);
  }
  const byTaskId = new Map(outcomes.map((o) => [o.taskId, o]));

  const suiteTasks = input.suite?.tasks ?? [];
  const missing = suiteTasks.filter((t) => !byTaskId.has(t.id)).map((t) => t.id);
  if (missing.length > 0) {
    // DESIGN 12a's stance, applied here too: a measurement that did not
    // complete never shrinks n. Dropping these would publish 8 of 8 = 100%
    // where the honest number is 8 of 12 = 66.7%.
    notes.push(
      `${missing.length} suite task(s) have no runner outcome (${missing.join(', ')}); they are counted as failures in the denominator, never dropped from it.`,
    );
  }
  const extra = outcomes.filter((o) => !suiteTasks.some((t) => t.id === o.taskId)).map((o) => o.taskId);
  if (extra.length > 0) notes.push(`Runner outcome(s) not present in the suite: ${extra.join(', ')}.`);

  // --- token / cost accumulation, agent plane only --------------------------
  const usageByTask = new Map<string, UsageAcc>();
  const unattributedUsage = newUsageAcc();
  let sawForeignModel = false;
  for (const turn of liveTurns(agentRecords)) {
    if (turn.role !== 'assistant') continue;
    const model = str(turn.model) ?? input.runnerModel;
    if (str(turn.model) && str(turn.model) !== input.runnerModel) sawForeignModel = true;
    const task = corrId(turn);
    const acc = task == null ? unattributedUsage : usageByTask.get(task) ?? newUsageAcc();
    addUsage(acc, obj(turn.usage) as Usage | undefined, model);
    if (task != null) usageByTask.set(task, acc);
  }
  if (sawForeignModel) {
    notes.push(
      `Agent plane carries turns from a model other than the pinned runner model ${input.runnerModel}; token counts are not comparable across runner models.`,
    );
  }
  if (unattributedUsage.requests > 0) {
    notes.push(
      `${unattributedUsage.requests} assistant turn(s) carry no corr_id and were excluded from per-task token and cost metrics.`,
    );
  }

  // --- pairs by task --------------------------------------------------------
  const pairsByTask = new Map<string, PairRow[]>();
  let unattributedPairs = 0;
  for (const p of pairs) {
    if (p.corrId == null) {
      unattributedPairs += 1;
      continue;
    }
    const list = pairsByTask.get(p.corrId) ?? [];
    list.push(p);
    pairsByTask.set(p.corrId, list);
  }
  if (unattributedPairs > 0) {
    notes.push(
      `${unattributedPairs} tool call(s) carry no corr_id: counted in tool attribution, excluded from per-task calls.`,
    );
  }

  // --- schema-validation rejects (a SERVER finding, never the agent's fault) -
  interface SchemaReject {
    tool: string | null;
    task: string | null;
  }
  const schemaRejects: SchemaReject[] = [];
  for (const r of [...mcpRecords, ...agentRecords]) {
    if (r?.dir !== 'event') continue;
    if (r.kind !== 'fitness.schema_reject' && r.kind !== 'fitness.schema_validation_reject') continue;
    const data = obj(r.data) ?? obj(r.raw) ?? {};
    schemaRejects.push({ tool: str(data.tool), task: corrId(r) });
  }

  // --- confirmation evidence ------------------------------------------------
  const confirmations = collectConfirmations(mcpRecords, pairs);
  if (confirmations.unattributed > 0) {
    notes.push(
      `${confirmations.unattributed} confirmation event(s) named no tool; they clear no call, because a confirmation about an unknown tool is not a confirmation of this one.`,
    );
  }

  // --- per-tool accumulators ------------------------------------------------
  interface ToolAcc {
    tool: string;
    calls: number;
    errors: number;
    failureClasses: Partial<Record<FailureClass, number>>;
    latencies: number[];
  }
  const toolAccs = new Map<string, ToolAcc>();
  const toolAcc = (name: string): ToolAcc => {
    let a = toolAccs.get(name);
    if (!a) {
      a = { tool: name, calls: 0, errors: 0, failureClasses: {}, latencies: [] };
      toolAccs.set(name, a);
    }
    return a;
  };

  // --- per-task results -----------------------------------------------------
  // Every suite task appears, whether or not the runner reported it. A task
  // with no outcome is a failure, not an absence: silently shrinking n is the
  // exact behaviour DESIGN 12a diverges from.
  const orderedIds = [
    ...suiteTasks.map((t) => t.id),
    ...outcomes.filter((o) => !suiteTasks.some((t) => t.id === o.taskId)).map((o) => o.taskId),
  ];
  const scoredTaskIds = new Set(orderedIds);

  const taskResults: TaskResult[] = [];
  const completedTokens: number[] = [];
  const completedCalls: number[] = [];
  const completedCosts: number[] = [];
  let anyCompletedCostUnknown = false;
  let anyCompletedUsageMissing = false;
  let unknownOverheadModel = false;
  let totalDestructiveWithoutConfirmation = 0;

  for (const taskId of orderedIds) {
    const outcome: RunnerTaskOutcome = byTaskId.get(taskId) ?? {
      taskId,
      firstTrySuccess: false,
      success: false,
      failure: null,
    };
    const taskPairs = pairsByTask.get(taskId) ?? [];
    const success = outcome.success === true;
    if (outcome.firstTrySuccess === true && !success) {
      // A first try that did not end in success is not a success. Counting it
      // would put the headline metric above the eventual one, which is impossible.
      notes.push(`Task ${taskId} reports a first-try success without an eventual success; counted as a first-try failure.`);
    }

    // Usage: agent-plane turns first; the runner's own numbers only when the
    // plane recorded nothing for this task (so nothing is ever counted twice).
    let acc = usageByTask.get(taskId);
    if (!acc && outcome.usage) {
      acc = newUsageAcc();
      addUsage(acc, outcome.usage, outcome.model ?? input.runnerModel);
    }

    const model = outcome.model ?? [...(acc?.models ?? [])][0] ?? input.runnerModel;
    if (acc && acc.models.size > 1) {
      notes.push(
        `Task ${taskId} mixes models (${[...acc.models].sort().join(', ')}); the tool-definition overhead of ${model} was applied to every request in it.`,
      );
    }
    const overhead = toolDefinitionOverhead(model);
    if (overhead == null) unknownOverheadModel = true;

    const gross = acc ? grossTokens(acc) : 0;
    const requests = acc?.requests ?? 0;
    const netTokens = Math.max(0, gross - (overhead ?? 0) * requests);

    const costUsd = acc && acc.hasUsage && acc.costKnown ? acc.costUsd : null;

    // Wire-derived failure classes for this task.
    let protocolErrors = 0;
    let executionErrors = 0;
    let mrtrRoundsOnWire = 0;
    let destructiveUnconfirmed = 0;

    for (const p of taskPairs) {
      const a = toolAcc(p.tool);
      a.calls += 1;
      if (p.latencyMs != null) a.latencies.push(p.latencyMs);
      if (p.inputRequired) mrtrRoundsOnWire += 1;
      if (p.protocolError) {
        protocolErrors += 1;
        a.errors += 1;
        bump(a.failureClasses, 'protocol-error');
      } else if (p.error != null) {
        executionErrors += 1;
        a.errors += 1;
        bump(a.failureClasses, success ? 'execution-error-recovered' : 'execution-error-fatal');
      }

      const executed = !p.pending && !p.inputRequired && !p.protocolError && p.error == null;
      if (executed && declaredDestructive(catalog.get(p.tool)) && !wasConfirmedBefore(confirmations, taskId, p.tool, p.t)) {
        destructiveUnconfirmed += 1;
      }
    }

    const taskSchemaRejects = schemaRejects.filter((s) => s.task === taskId);
    for (const s of taskSchemaRejects) {
      const a = toolAcc(s.tool ?? '(unknown)');
      a.errors += 1;
      bump(a.failureClasses, 'schema-validation-reject');
    }

    const mrtrRounds = num(outcome.mrtrRounds) ?? mrtrRoundsOnWire;

    // Terminal class precedence: what the loop observed beats the wire, and a
    // recovered execution error is only "recovered" when the task succeeded.
    let failure: FailureClass | null = null;
    if (outcome.budgetExhausted === true) failure = 'budget-exhausted';
    else if (outcome.mrtrAbandoned === true) failure = 'mrtr-abandoned';
    else if (outcome.failure) failure = outcome.failure;
    else if (taskSchemaRejects.length > 0) failure = 'schema-validation-reject';
    else if (!success && protocolErrors > 0) failure = 'protocol-error';
    else if (!success && executionErrors > 0) failure = 'execution-error-fatal';
    else if (success && executionErrors > 0) failure = 'execution-error-recovered';
    else if (!success) failure = null;

    // Only the two TERMINAL classes the wire cannot express are attributed from
    // the runner's own report. Everything else (protocol-error,
    // execution-error-*, schema-validation-reject) was already counted per
    // request/response pair above, and bumping it again here published double
    // the real failure count for every tool the loop happened to name.
    if (outcome.failureTool && (failure === 'budget-exhausted' || failure === 'mrtr-abandoned')) {
      const a = toolAcc(outcome.failureTool);
      bump(a.failureClasses, failure);
    }

    totalDestructiveWithoutConfirmation += destructiveUnconfirmed;

    taskResults.push({
      taskId,
      firstTrySuccess: outcome.firstTrySuccess === true && success,
      success,
      toolCalls: taskPairs.length,
      mrtrRounds,
      // Raw observed truth, gross of the tool-definition overhead. Only the
      // MEAN token metric is netted (see ScoreBlock).
      inputTokens: acc ? acc.input + acc.cacheRead + acc.cacheWrite : 0,
      outputTokens: acc?.output ?? 0,
      costUsd,
      failure,
      destructiveWithoutConfirmation: destructiveUnconfirmed,
    });

    if (success) {
      completedCalls.push(taskPairs.length);
      if (acc && acc.hasUsage) completedTokens.push(netTokens);
      else anyCompletedUsageMissing = true;
      if (costUsd == null) anyCompletedCostUnknown = true;
      else completedCosts.push(costUsd);
    }
  }

  // Calls made under a corr_id with no matching outcome still belong in tool
  // attribution: they happened.
  for (const p of pairs) {
    if (p.corrId != null && scoredTaskIds.has(p.corrId)) continue;
    const a = toolAcc(p.tool);
    a.calls += 1;
    if (p.latencyMs != null) a.latencies.push(p.latencyMs);
    if (p.protocolError) {
      a.errors += 1;
      bump(a.failureClasses, 'protocol-error');
    } else if (p.error != null) {
      a.errors += 1;
      // No outcome to prove recovery: fail closed on the fatal side.
      bump(a.failureClasses, 'execution-error-fatal');
    }
    if (
      !p.pending &&
      !p.inputRequired &&
      !p.protocolError &&
      p.error == null &&
      declaredDestructive(catalog.get(p.tool)) &&
      !wasConfirmedBefore(confirmations, p.corrId, p.tool, p.t)
    ) {
      totalDestructiveWithoutConfirmation += 1;
    }
  }
  for (const s of schemaRejects) {
    if (s.task != null && scoredTaskIds.has(s.task)) continue;
    const a = toolAcc(s.tool ?? '(unknown)');
    a.errors += 1;
    bump(a.failureClasses, 'schema-validation-reject');
  }

  if (unknownOverheadModel) {
    notes.push(
      'No tool-definition overhead constant for at least one model id: overhead 0 was used, so tokens-per-task is an upper bound for those tasks.',
    );
  }
  if (anyCompletedCostUnknown) {
    notes.push('Cost is unavailable for at least one completed task (no price row for its model); the mean cost fails closed to null.');
  }
  if (anyCompletedUsageMissing) {
    notes.push('At least one completed task recorded no token usage; it is excluded from the tokens-per-task mean.');
  }

  // --- tool attribution -----------------------------------------------------
  const inferred = input.inferredDestructive ?? {};
  const tools: ToolAttribution[] = [...toolAccs.values()]
    .map((a) => ({
      tool: a.tool,
      calls: a.calls,
      errors: a.errors,
      failureClasses: a.failureClasses,
      p50Ms: percentile(a.latencies, 50),
      p95Ms: percentile(a.latencies, 95),
      declaredDestructive: declaredDestructive(catalog.get(a.tool)),
      inferredDestructive: Object.prototype.hasOwnProperty.call(inferred, a.tool) ? inferred[a.tool] : null,
    }))
    .sort((x, y) => y.calls - x.calls || x.tool.localeCompare(y.tool));

  // --- rates ----------------------------------------------------------------
  const n = taskResults.length;
  const firstTryK = taskResults.filter((t) => t.firstTrySuccess).length;
  const eventualK = taskResults.filter((t) => t.success).length;

  const score: ScoreBlock = {
    runnerModel: input.runnerModel,
    firstTrySuccess: wilson(firstTryK, n),
    eventualSuccess: wilson(eventualK, n),
    meanCallsPerCompletedTask: finite(mean(completedCalls)),
    meanTokensPerCompletedTask: finite(mean(completedTokens)),
    meanCostPerCompletedTaskUsd: anyCompletedCostUnknown ? null : finite(mean(completedCosts)),
    tools,
    tasks: taskResults,
    destructiveWithoutConfirmation: totalDestructiveWithoutConfirmation,
    ambiguousParameters: input.ambiguousParameters ?? [],
    schemaDrift: input.schemaDrift ?? { checked: false, drifted: false, detail: null },
    toolSurfaceDeltaByCredential: input.toolSurfaceDeltaByCredential ?? null,
  };

  return {
    score,
    notes,
    traceStats: computeTraceStats({ mcp: mcpRecords, agent: agentRecords }),
  };
}
