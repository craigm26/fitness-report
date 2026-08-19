/**
 * The runner loop (DESIGN decisions 1, 4, 8, 9, 10, 19).
 *
 * ENGINE CHOICE. We drive `@anthropic-ai/sdk`'s `beta.messages.toolRunner()`
 * with the `mcpTools()` helper, exactly as DESIGN decision 1 specifies. The
 * documented `MCPClientLike` narrowing seam is one method wide
 *
 *     callTool(params: { name, arguments? }): Promise<MCPCallToolResultLike>
 *
 * so our v2 `McpConnection` adapts to it in a few lines (`toolAdapter` below)
 * and every tool call still goes through our own client: our frame hook, our
 * cacheMode discipline, our `_meta` logLevel injection, our manual MRTR
 * surface. Nothing is hand-rolled that the SDK already owns, and no wire frame
 * escapes the recorder. The Anthropic MCP connector (`mcp_servers`) remains
 * rejected as engine: it yields tool calls, not frames.
 *
 * WHAT THE ADAPTER BUYS US. `mcpTool()` turns an MCP `isError:true` result into
 * a thrown `ToolError`, which the runner converts back into an error
 * `tool_result` block, so the model sees the failure and may recover. That is
 * the `execution-error-recovered` vs `execution-error-fatal` split in decision
 * 9, for free and on the SDK's own code path. We classify BEFORE handing the
 * result over, so the taxonomy is ours and the recovery behaviour is theirs.
 *
 * TWO PLANES (decision 4). Wire frames reach `<run>/mcp.jsonl` through the
 * connection's `onFrame` hook (wired by the caller, not here). Model turns reach
 * `<run>/agent.jsonl` from this module. Every line carries a correlation id
 * (the task id on the scored drive, `<taskId>::<phase>` on a null baseline or
 * the construct reference pass) and a caller-observed timestamp; the writer
 * never stamps a wall clock.
 *
 * MRTR (decision 8). Auto-fulfil is off at the client. A tool call that returns
 * `input_required` is recorded as a `fitness.mrtr_round` event and then
 * DECLINED: v0 has no confirmation channel, so the round becomes an honest
 * `mrtr-abandoned` datum rather than a fabricated answer. The manual multi-round
 * driver (`conn.driveToolCall`) is deliberately not used here because
 * `conn.callTool` keeps SDK outputSchema validation on the path, and a
 * validation rejection is a SERVER finding we must not lose.
 */

import Anthropic from '@anthropic-ai/sdk';
import { mcpTools, type MCPCallToolResultLike, type MCPToolLike } from '@anthropic-ai/sdk/helpers/beta/mcp';

import { httpLayerFailure } from '../mcp/connect.js';
import type { McpConnection, ToolCallOutcome } from '../mcp/connect.js';
import { declaredDestructive, type ToolDescriptor, type RunnerTaskOutcome } from '../score/metrics.js';
import type { TapeWriter } from '../tape/writer.js';
import type { FailureClass, FitnessTask, TaskCheck } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** DESIGN decision 3: the runner model is pinned into every score record. */
export const DEFAULT_RUNNER_MODEL = 'claude-sonnet-5';

/** DESIGN decision 19. */
export const TASK_BUDGET_BETA = 'task-budgets-2026-03-13';

/** The API's own floor for `output_config.task_budget.total`. */
export const MIN_TASK_BUDGET_TOKENS = 20_000;

/**
 * Fallback cap when the task-budget beta is rejected, and a hard backstop even
 * when it is accepted: a task budget is advisory (the model paces itself), so a
 * server that traps the agent still needs a countable stop.
 */
export const DEFAULT_MAX_ITERATIONS = 10;

export const DEFAULT_MAX_TOKENS = 16_000;

/** Claude tool names: `^[a-zA-Z0-9_-]{1,128}$`. MCP names are wider. */
const TOOL_NAME_OK = /^[a-zA-Z0-9_-]{1,128}$/;

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

type ToolRunnerParams = Anthropic.Beta.Messages.BetaToolRunnerParams;

/** What we consume of a `BetaToolRunner`. A real runner satisfies it. */
export interface ToolRunnerLike {
  [Symbol.asyncIterator](): AsyncIterator<Anthropic.Beta.BetaMessage>;
  readonly params: Readonly<ToolRunnerParams>;
}

/**
 * The narrowing seam for the runner model. A real `new Anthropic()` satisfies
 * it; a test stub is a dozen lines. Nothing here constructs a client or reads a
 * key.
 */
export interface RunnerClient {
  beta: {
    messages: {
      toolRunner(body: ToolRunnerParams & { stream?: false }, options?: { headers?: Record<string, string> }): ToolRunnerLike;
    };
  };
}

/** Answers a `judge` check. Returns null when no judge is wired. */
export type JudgeCheck = (rubric: string, finalText: string, task: FitnessTask) => Promise<boolean | null>;

/** How the runner is allowed to touch the server on this pass. */
export type ToolMode =
  /** real tools against the real server */
  | 'live'
  /** tools declared, every call answered with an empty result, server untouched */
  | 'stub'
  /** no tools at all */
  | 'none';

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type ToolCallStatus =
  | 'ok'
  | 'tool-error'
  | 'protocol-error'
  | 'schema-validation-reject'
  | 'mrtr-abandoned';

export interface ToolCallRecord {
  taskId: string;
  /** The MCP tool name, never the sanitized Claude-facing alias. */
  tool: string;
  args: Record<string, unknown>;
  status: ToolCallStatus;
  detail: string | null;
  startedAt: string;
  endedAt: string;
  /** DESIGN decision 10 spec-default rule, evaluated against tools/list. */
  declaredDestructive: boolean;
  /** v0: a destructive call with no confirmation channel in front of it. */
  unconfirmedDestructive: boolean;
}

export interface TaskRun {
  taskId: string;
  outcome: RunnerTaskOutcome;
  finalText: string;
  stopReason: string | null;
  toolCallRecords: readonly ToolCallRecord[];
  /** Assistant turns observed. Excludes the tool-result turns we authored. */
  assistantTurns: number;
  /** Output tokens generated across the task, the budget-relevant count. */
  outputTokens: number;
  inputTokens: number;
  /** v0 destructive-without-confirmation count for this task. */
  unconfirmedDestructiveCalls: number;
  /** Set when the loop itself failed (transport death, refusal, API error). */
  error: string | null;
  /** True when this task ran without `output_config.task_budget`. */
  budgetDeclined: boolean;
}

export interface SuiteRun {
  runs: readonly TaskRun[];
  outcomes: readonly RunnerTaskOutcome[];
  /** False once the API rejected the task-budget beta; the cap took over. */
  taskBudgetSupported: boolean;
  notes: readonly string[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DriveOptions {
  client: RunnerClient;
  conn: McpConnection;
  /**
   * The advertised tool surface. List it with `cacheMode:'refresh'`: 'bypass'
   * skips cache WRITES, which leaves the SDK unable to validate
   * `structuredContent` and silently retires the `schema-validation-reject`
   * class. See the INTEGRATION FIX note in src/cli.ts.
   */
  tools: readonly ToolDescriptor[];
  model?: string;
  /** `getInstructions()` from the server, injected into the system prompt. */
  instructions?: string | null;
  agentTape?: TapeWriter;
  /** Harness-native `fitness.*` events land on the mcp plane beside the frames. */
  mcpTape?: TapeWriter;
  /** Injectable clock. Every recorded timestamp comes from here. */
  now?: () => Date;
  toolMode?: ToolMode;
  /** Total tokens for `output_config.task_budget`. `null` disables the beta. */
  taskBudgetTokens?: number | null;
  maxIterations?: number;
  maxTokens?: number;
  /** Judge-backed checks. Unwired judge => `judge` checks resolve to null. */
  judge?: JudgeCheck;
  /**
   * Construct-gate mode (DESIGN decision 11, PAID tier): the reference agent is
   * given the answer key, so a failure means the answer key is unreachable even
   * with full information.
   */
  revealAnswerKey?: boolean;
  /** Extra system-prompt text (null-model framing, construct framing). */
  systemSuffix?: string;
  /**
   * Correlation id for every frame, turn and event this pass produces.
   * Defaults to the task id, which is what the scored drive wants. The null
   * baselines and the construct reference pass override it with
   * `<taskId>::<phase>` so their real wire traffic stays in the recording
   * without being counted as the scored run's calls or tokens.
   */
  corrId?: string;
}

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------

const BASE_SYSTEM = [
  'You are evaluating whether an MCP server can be driven to complete a task.',
  'Use the available tools to do the work. Do not guess an answer you could look up with a tool.',
  'When you are done, state the answer plainly in your final message.'
].join(' ');

export function buildSystemPrompt(opts: {
  instructions?: string | null;
  toolMode: ToolMode;
  answerKey?: unknown;
  suffix?: string;
}): string {
  const parts = [BASE_SYSTEM];
  if (opts.toolMode === 'none') {
    parts.push('No tools are available on this run. Answer from what you already know, or say that you cannot.');
  }
  if (typeof opts.instructions === 'string' && opts.instructions.trim().length > 0) {
    parts.push(`Server instructions:\n${opts.instructions.trim()}`);
  }
  if (opts.answerKey !== undefined && opts.answerKey !== null) {
    parts.push(
      'Reference pass: the intended answer is given below. Reach it through the tools and state it. ' +
        `Intended answer: ${stringifyKey(opts.answerKey)}`
    );
  }
  if (opts.suffix) parts.push(opts.suffix);
  return parts.join('\n\n');
}

function stringifyKey(key: unknown): string {
  return typeof key === 'string' ? key : JSON.stringify(key);
}

// ---------------------------------------------------------------------------
// Check evaluation
// ---------------------------------------------------------------------------

export interface CheckContext {
  finalText: string;
  /** Successful tool calls, in order. */
  calls: readonly { tool: string; ok: boolean; text: string }[];
}

/**
 * Evaluate a machine-checkable success predicate. Text checks are
 * case-insensitive over whitespace-collapsed text: a server is not being scored
 * on the model's capitalisation. A malformed regex is a suite defect, not a
 * server failure, so it resolves to `null` (not checkable) rather than false.
 */
export async function evaluateCheck(
  check: TaskCheck,
  ctx: CheckContext,
  task: FitnessTask,
  judge?: JudgeCheck
): Promise<boolean | null> {
  switch (check.kind) {
    case 'substring':
      return norm(ctx.finalText).includes(norm(check.value));
    case 'regex': {
      const re = safeRegex(check.pattern);
      return re === null ? null : re.test(ctx.finalText);
    }
    case 'tool_called':
      return ctx.calls.some((c) => c.tool === check.tool && c.ok);
    case 'tool_result_matches': {
      const re = safeRegex(check.pattern);
      if (re === null) return null;
      return ctx.calls.some((c) => c.tool === check.tool && c.ok && re.test(c.text));
    }
    case 'judge':
      return judge === undefined ? null : await judge(check.rubric, ctx.finalText, task);
    default:
      return null;
  }
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tool surface adaptation
// ---------------------------------------------------------------------------

interface ToolAlias {
  /** Name the model sees. */
  alias: string;
  /** Name on the wire. */
  name: string;
  descriptor: ToolDescriptor;
}

export function aliasTools(tools: readonly ToolDescriptor[]): ToolAlias[] {
  const used = new Set<string>();
  const out: ToolAlias[] = [];
  for (const tool of tools) {
    const name = typeof tool.name === 'string' ? tool.name : '';
    if (name.length === 0) continue;
    let alias = TOOL_NAME_OK.test(name) ? name : name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
    if (alias.length === 0) alias = 'tool';
    let n = 2;
    while (used.has(alias)) alias = `${alias.slice(0, 120)}_${n++}`;
    used.add(alias);
    out.push({ alias, name, descriptor: tool });
  }
  return out;
}

function toMcpToolLike(entry: ToolAlias): MCPToolLike {
  const raw = (entry.descriptor as { inputSchema?: unknown }).inputSchema;
  const schema = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const description = (entry.descriptor as { description?: unknown }).description;
  return {
    name: entry.alias,
    ...(typeof description === 'string' ? { description } : {}),
    inputSchema: {
      ...schema,
      type: 'object',
      properties: (schema['properties'] as Record<string, unknown> | undefined) ?? {},
      required: Array.isArray(schema['required']) ? (schema['required'] as string[]) : []
    }
  };
}

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

function resultText(result: { content?: unknown; structuredContent?: unknown }): string {
  const parts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string') parts.push(text);
      }
    }
  }
  if (parts.length === 0 && result.structuredContent && typeof result.structuredContent === 'object') {
    parts.push(JSON.stringify(result.structuredContent));
  }
  return parts.join('\n');
}

/**
 * The SDK rejects `structuredContent` that violates the tool's own
 * `outputSchema`. DESIGN decision 9 is explicit that this is a SERVER finding
 * and is never attributed to the agent, so it gets its own class.
 */
function isSchemaValidationReject(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /output ?schema|structured ?content/i.test(message) && /(match|valid|invalid|reject)/i.test(message);
}

// ---------------------------------------------------------------------------
// Driving one task
// ---------------------------------------------------------------------------

export async function driveTask(task: FitnessTask, opts: DriveOptions): Promise<TaskRun> {
  const now = opts.now ?? ((): Date => new Date());
  const nowIso = (): string => now().toISOString();
  const model = opts.model ?? DEFAULT_RUNNER_MODEL;
  const toolMode: ToolMode = opts.toolMode ?? 'live';
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const budget =
    opts.taskBudgetTokens === null || opts.taskBudgetTokens === undefined
      ? null
      : Math.max(MIN_TASK_BUDGET_TOKENS, Math.floor(opts.taskBudgetTokens));

  const aliases = aliasTools(opts.tools);
  const byAlias = new Map(aliases.map((a) => [a.alias, a]));
  const records: ToolCallRecord[] = [];
  const callTexts: { tool: string; ok: boolean; text: string }[] = [];

  const corrId = opts.corrId ?? task.id;

  const event = async (kind: string, payload: unknown): Promise<void> => {
    // `raw` is where docs/format.md puts the payload of any line carrying a
    // `dir`; a consumer reading `data` sees nothing.
    await opts.mcpTape?.writeEvent({ t: nowIso(), dir: 'event', kind, raw: payload, corr_id: corrId });
  };

  // -- the MCPClientLike seam ------------------------------------------------

  const liveAdapter = {
    async callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<MCPCallToolResultLike> {
      const entry = byAlias.get(params.name);
      const wireName = entry?.name ?? params.name;
      const args = params.arguments ?? {};
      const startedAt = nowIso();
      const destructive = declaredDestructive(entry?.descriptor);

      const push = (status: ToolCallStatus, detail: string | null): void => {
        const unconfirmed = destructive && status !== 'mrtr-abandoned';
        records.push({
          taskId: task.id,
          tool: wireName,
          args,
          status,
          detail,
          startedAt,
          endedAt: nowIso(),
          declaredDestructive: destructive,
          unconfirmedDestructive: unconfirmed
        });
        if (unconfirmed) {
          void event('fitness.destructive_call', { tool: wireName, confirmed: false, status });
        }
      };

      let outcome: ToolCallOutcome;
      try {
        outcome = await opts.conn.callTool(wireName, args);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (isSchemaValidationReject(error)) {
          push('schema-validation-reject', detail);
          // The scorer reads this event line to raise the SERVER finding.
          await event('fitness.schema_reject', { tool: wireName, detail });
        } else {
          // Everything else that throws out of the client is a protocol error,
          // and DESIGN decision 9 keeps it that way whether the JSON-RPC layer
          // answered with an error or never got to speak at all. An HTTP-layer
          // death (the aws-knowledge gateway 400) has already been recorded by
          // the connection as its own `fitness.http_error` line; repeating the
          // status here is what ties that transport observation to the task
          // this call belonged to.
          const http = httpLayerFailure(error);
          push('protocol-error', detail);
          await event('fitness.protocol_error', {
            tool: wireName,
            detail,
            ...(http === null ? {} : { http })
          });
        }
        throw error;
      }

      if (outcome.kind === 'input_required' || outcome.kind === 'mrtr-abandoned') {
        const rounds = outcome.kind === 'mrtr-abandoned' ? outcome.rounds.length : 1;
        await event('fitness.mrtr_round', {
          tool: wireName,
          rounds,
          reason: outcome.kind === 'mrtr-abandoned' ? outcome.reason : 'caller-declined',
          inputRequests: outcome.kind === 'input_required' ? outcome.inputRequests : undefined
        });
        push('mrtr-abandoned', 'server asked for additional input; v0 has no confirmation channel');
        callTexts.push({ tool: wireName, ok: false, text: '' });
        return {
          content: [
            {
              type: 'text',
              text:
                'The server asked for additional input before running this tool. ' +
                'This harness cannot supply it, so the call was abandoned.'
            }
          ],
          isError: true
        };
      }

      const result = outcome.result as { content?: unknown; structuredContent?: unknown; isError?: boolean };
      const text = resultText(result);
      const isError = result.isError === true;
      push(isError ? 'tool-error' : 'ok', isError ? text.slice(0, 500) : null);
      callTexts.push({ tool: wireName, ok: !isError, text });
      return {
        content: (Array.isArray(result.content) ? result.content : []) as MCPCallToolResultLike['content'],
        ...(result.structuredContent && typeof result.structuredContent === 'object'
          ? { structuredContent: result.structuredContent as object }
          : {}),
        ...(isError ? { isError: true } : {})
      };
    }
  };

  const stubAdapter = {
    async callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<MCPCallToolResultLike> {
      const entry = byAlias.get(params.name);
      const wireName = entry?.name ?? params.name;
      callTexts.push({ tool: wireName, ok: true, text: '' });
      return { content: [{ type: 'text', text: '' }] };
    }
  };

  const runnable =
    toolMode === 'none'
      ? []
      : mcpTools(aliases.map(toMcpToolLike), toolMode === 'live' ? liveAdapter : stubAdapter);

  // -- the loop --------------------------------------------------------------

  const system = buildSystemPrompt({
    instructions: opts.instructions,
    toolMode,
    answerKey: opts.revealAnswerKey ? task.answerKey : undefined,
    suffix: opts.systemSuffix
  });

  opts.conn.setCorrelationId(corrId);
  await event('fitness.task_start', { taskId: task.id, toolMode, model, budget, maxIterations });

  const params: ToolRunnerParams & { stream?: false } = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: task.prompt }],
    tools: runnable,
    max_iterations: maxIterations,
    thinking: { type: 'adaptive' },
    ...(budget === null
      ? {}
      : {
          betas: [TASK_BUDGET_BETA],
          output_config: { task_budget: { type: 'tokens' as const, total: budget } }
        })
  };

  await opts.agentTape?.writeTurn({
    t: nowIso(),
    type: 'turn',
    role: 'user',
    blocks: [{ type: 'text', text: task.prompt }],
    corr_id: corrId
  });

  let assistantTurns = 0;
  let outputTokens = 0;
  let inputTokens = 0;
  let stopReason: string | null = null;
  let loopError: string | null = null;
  let budgetDeclined = budget === null;
  /** Text of the last assistant turn that said anything: the answer surface. */
  let lastAssistantText: string | null = null;

  const consume = async (runner: ToolRunnerLike): Promise<void> => {
    let flushed = 1; // messages[0] is the prompt we already recorded
    const flushAuthored = async (): Promise<void> => {
      const messages = runner.params.messages;
      for (let i = flushed; i < messages.length; i += 1) {
        const message = messages[i];
        if (message === undefined || message.role !== 'user') continue;
        const blocks = Array.isArray(message.content)
          ? message.content
          : [{ type: 'text', text: String(message.content) }];
        await opts.agentTape?.writeTurn({
          t: nowIso(),
          type: 'turn',
          role: 'user',
          blocks,
          corr_id: corrId
        });
      }
      flushed = messages.length;
    };

    for await (const message of runner) {
      // Tool results for the PREVIOUS assistant turn land in params before the
      // next one is requested, so flushing here keeps the plane in wire order.
      await flushAuthored();
      assistantTurns += 1;
      stopReason = message.stop_reason ?? null;
      const said = assistantText(message.content);
      if (said.length > 0) lastAssistantText = said;
      outputTokens += message.usage?.output_tokens ?? 0;
      inputTokens +=
        (message.usage?.input_tokens ?? 0) +
        (message.usage?.cache_read_input_tokens ?? 0) +
        (message.usage?.cache_creation_input_tokens ?? 0);
      await opts.agentTape?.writeTurn({
        t: nowIso(),
        type: 'turn',
        role: 'assistant',
        blocks: message.content,
        model: message.model,
        usage: message.usage,
        corr_id: corrId
      });
      flushed = runner.params.messages.length;
    }
    await flushAuthored();
  };

  try {
    await consume(opts.client.beta.messages.toolRunner(params));
  } catch (error) {
    if (budget !== null && isTaskBudgetRejection(error)) {
      // DESIGN decision 19's graceful fallback: keep the run, drop the beta,
      // and let `max_iterations` be the ceiling instead.
      await event('fitness.task_budget_unavailable', { detail: describe(error) });
      budgetDeclined = true;
      const { betas: _betas, output_config: _outputConfig, ...rest } = params;
      try {
        await consume(opts.client.beta.messages.toolRunner(rest));
      } catch (retryError) {
        loopError = describe(retryError);
      }
    } else {
      loopError = describe(error);
    }
  }

  // The last assistant text is the answer surface. Falling back to raw tool
  // output when the model said nothing at all keeps a transport death from
  // reading as "the server could not answer".
  const finalText = lastAssistantText ?? (callTexts.length === 0 ? '' : (callTexts[callTexts.length - 1]?.text ?? ''));

  const checkResult = await evaluateCheck(
    task.check,
    { finalText, calls: callTexts },
    task,
    opts.judge
  );
  const success = checkResult === true;

  const toolErrors = records.filter((r) => r.status !== 'ok');
  const mrtrAbandoned = records.some((r) => r.status === 'mrtr-abandoned');
  // A runner that stopped while the model still wanted tools ran out of room:
  // the cap fired, or the advisory budget did. Either way it is decision 19's
  // clean unrecoverable-path datum rather than an unbounded bill.
  const budgetExhausted = stopReason === 'tool_use';
  const firstTrySuccess = success && toolErrors.length === 0 && !budgetExhausted;

  const failure = classifyFailure({
    success,
    budgetExhausted,
    mrtrAbandoned,
    records,
    loopError,
    stopReason
  });

  const unconfirmedDestructiveCalls = records.filter((r) => r.unconfirmedDestructive).length;

  await event('fitness.task_end', {
    taskId: task.id,
    success,
    firstTrySuccess,
    checkResult,
    failure,
    stopReason,
    toolCalls: records.length,
    unconfirmedDestructiveCalls,
    error: loopError
  });

  const outcome: RunnerTaskOutcome = {
    taskId: task.id,
    firstTrySuccess,
    success,
    model,
    mrtrRounds: records.filter((r) => r.status === 'mrtr-abandoned').length,
    failure,
    ...(failure !== null && records.length > 0 ? { failureTool: lastFailingTool(records) } : {}),
    budgetExhausted,
    mrtrAbandoned
  };

  return {
    taskId: task.id,
    outcome,
    finalText,
    stopReason,
    toolCallRecords: records,
    assistantTurns,
    outputTokens,
    inputTokens,
    unconfirmedDestructiveCalls,
    error: loopError,
    budgetDeclined
  };
}

/** Concatenated text blocks of one assistant message. */
function assistantText(content: readonly unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n').trim();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A 400 naming the beta or the budget field. Anything else is a real error. */
export function isTaskBudgetRejection(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  if (status !== 400 && !(error instanceof Anthropic.BadRequestError)) return false;
  return /task[_ -]?budget|task-budgets-|output_config/i.test(describe(error));
}

function lastFailingTool(records: readonly ToolCallRecord[]): string {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record && record.status !== 'ok') return record.tool;
  }
  return records[records.length - 1]?.tool ?? '';
}

/**
 * DESIGN decision 9, in the order the report reads it. `budget-exhausted` and
 * `mrtr-abandoned` are terminal conditions only the loop sees, so they outrank
 * anything derived from the wire.
 */
export function classifyFailure(input: {
  success: boolean;
  budgetExhausted: boolean;
  mrtrAbandoned: boolean;
  records: readonly ToolCallRecord[];
  loopError: string | null;
  stopReason: string | null;
}): FailureClass | null {
  if (input.budgetExhausted) return 'budget-exhausted';
  if (input.mrtrAbandoned) return 'mrtr-abandoned';
  const hasSchemaReject = input.records.some((r) => r.status === 'schema-validation-reject');
  if (hasSchemaReject) return 'schema-validation-reject';
  const hasProtocolError = input.records.some((r) => r.status === 'protocol-error');
  if (hasProtocolError) return 'protocol-error';
  const hasToolError = input.records.some((r) => r.status === 'tool-error');
  if (input.success) return hasToolError ? 'execution-error-recovered' : null;
  if (hasToolError) return 'execution-error-fatal';
  if (input.loopError !== null) return 'protocol-error';
  return null;
}

// ---------------------------------------------------------------------------
// Driving a suite
// ---------------------------------------------------------------------------

export interface DriveSuiteOptions extends DriveOptions {
  tasks: readonly FitnessTask[];
  /** Called after each task so a long run prints progress. */
  onTask?: (run: TaskRun, index: number, total: number) => void;
}

/**
 * Tasks run SERIALLY. One connection, one session, one ordering: a session-ful
 * server would interleave state across concurrent tasks and the per-task
 * `corr_id` on the wire would stop meaning anything.
 */
export async function driveSuite(opts: DriveSuiteOptions): Promise<SuiteRun> {
  const runs: TaskRun[] = [];
  const notes: string[] = [];
  let budgetTokens = opts.taskBudgetTokens === undefined ? MIN_TASK_BUDGET_TOKENS : opts.taskBudgetTokens;
  let taskBudgetSupported = budgetTokens !== null;

  for (const [index, task] of opts.tasks.entries()) {
    const run = await driveTask(task, { ...opts, taskBudgetTokens: budgetTokens });
    if (run.budgetDeclined && taskBudgetSupported) {
      taskBudgetSupported = false;
      budgetTokens = null;
      notes.push(
        `The API rejected output_config.task_budget with the ${TASK_BUDGET_BETA} beta. ` +
          `Every task after ${task.id} ran under a hard cap of ${opts.maxIterations ?? DEFAULT_MAX_ITERATIONS} iterations instead.`
      );
    }
    runs.push(run);
    opts.onTask?.(run, index, opts.tasks.length);
  }

  return {
    runs,
    outcomes: runs.map((r) => r.outcome),
    taskBudgetSupported,
    notes
  };
}

// ---------------------------------------------------------------------------
// Null model: random valid args (DESIGN decision 11, CHEAP tier)
// ---------------------------------------------------------------------------

/** mulberry32, the same generator the fixtures and order probe use. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build one plausible argument bag from a JSON schema, deterministically. */
export function randomValidArgs(schema: unknown, rand: () => number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const s = schema && typeof schema === 'object' ? (schema as Record<string, unknown>) : {};
  const properties = s['properties'];
  if (!properties || typeof properties !== 'object') return out;
  const required = Array.isArray(s['required']) ? (s['required'] as string[]) : Object.keys(properties);
  for (const key of required) {
    const spec = (properties as Record<string, unknown>)[key];
    const def = spec && typeof spec === 'object' ? (spec as Record<string, unknown>) : {};
    const enumValues = def['enum'];
    if (Array.isArray(enumValues) && enumValues.length > 0) {
      out[key] = enumValues[Math.floor(rand() * enumValues.length)];
      continue;
    }
    switch (def['type']) {
      case 'number':
      case 'integer':
        out[key] = Math.floor(rand() * 100);
        break;
      case 'boolean':
        out[key] = rand() > 0.5;
        break;
      case 'array':
        out[key] = [];
        break;
      case 'object':
        out[key] = {};
        break;
      default:
        out[key] = `q${Math.floor(rand() * 1000)}`;
    }
  }
  return out;
}

/**
 * The zero-token null model: call the expected tools with seeded valid
 * arguments, no model in the loop, and run the task's own check against what
 * came back. A task that passes here passes without reasoning, which is exactly
 * what the null baseline is for.
 */
export async function driveRandomArgsBaseline(opts: {
  conn: McpConnection;
  tasks: readonly FitnessTask[];
  tools: readonly ToolDescriptor[];
  seed?: number;
  judge?: JudgeCheck;
  mcpTape?: TapeWriter;
  now?: () => Date;
}): Promise<{ k: number; n: number; passed: readonly string[] }> {
  const rand = seeded(opts.seed ?? 1);
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const passed: string[] = [];
  const now = opts.now ?? ((): Date => new Date());

  for (const task of opts.tasks) {
    opts.conn.setCorrelationId(`${task.id}::null-random`);
    const calls: { tool: string; ok: boolean; text: string }[] = [];
    for (const toolName of task.expectedTools) {
      const descriptor = byName.get(toolName);
      if (descriptor === undefined) continue;
      const args = randomValidArgs((descriptor as { inputSchema?: unknown }).inputSchema, rand);
      try {
        const outcome = await opts.conn.callTool(toolName, args);
        if (outcome.kind !== 'result') {
          calls.push({ tool: toolName, ok: false, text: '' });
          continue;
        }
        const result = outcome.result as { content?: unknown; structuredContent?: unknown; isError?: boolean };
        calls.push({ tool: toolName, ok: result.isError !== true, text: resultText(result) });
      } catch {
        calls.push({ tool: toolName, ok: false, text: '' });
      }
    }
    const finalText = calls.map((c) => c.text).join('\n');
    const result = await evaluateCheck(task.check, { finalText, calls }, task, opts.judge);
    if (result === true) passed.push(task.id);
    await opts.mcpTape?.writeEvent({
      t: now().toISOString(),
      dir: 'event',
      kind: 'fitness.null_baseline',
      raw: { model: 'random-valid-args', taskId: task.id, passed: result === true },
      // The wire frames of this pass carry `<taskId>::null-random`, and
      // format-extensions §5 groups a corr_id into ONE decision row: stamping
      // the bare task id filed null-model evidence under the scored run.
      corr_id: `${task.id}::null-random`
    });
  }

  opts.conn.setCorrelationId(undefined);
  return { k: passed.length, n: opts.tasks.length, passed };
}
