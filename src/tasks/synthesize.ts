/**
 * Task synthesis (DESIGN decision 17).
 *
 * The judge model reads the server's `tools/list` schemas plus its `instructions`
 * string and emits PARAMETERIZED tasks with machine-checkable success predicates
 * (`TaskCheck`). Parameterization is real: the model returns a `promptTemplate`
 * plus a bound `params` map, and we render the template here, at generation time.
 * Everything downstream (the answer-leak gate, the suite hash, the runner) sees
 * only the RENDERED prompt, which is the string an agent will actually read.
 *
 * Prior art: MCPEval (Liu et al., "MCPEval: Automatic MCP-based Deep Evaluation
 * for AI Agent Models", arXiv:2507.12806) established LLM-generated,
 * schema-grounded task suites over live MCP servers with automatic verification.
 * We take that generation loop and differ on what happens next: MCPEval reports a
 * number for every suite it generates, and we refuse to. Our deltas are the
 * validity gates that can withhold a score (DESIGN 11/12), signed replayable
 * evidence for every finding (DESIGN 4-7), and causal rewrite diffs (DESIGN 18).
 * Cite MCPEval in METHODS copy, not just here.
 *
 * What this module enforces locally, before any gate runs:
 *   - answer-leak: the rendered prompt may never contain the answer key. Offenders
 *     get exactly ONE regeneration attempt and are then DROPPED (DESIGN 11, FREE
 *     tier). Related: `answerLeaks()` in src/gates/fixtures.ts is the boolean
 *     reference form of the same check used by the audit bed; this one also
 *     reports WHICH token leaked so the regeneration request can name it.
 *   - handle chaining: stateful surfaces where a create-style tool returns a
 *     handle that a later tool consumes. A task that calls a consumer without its
 *     producer is repaired when the producer is unambiguous, dropped otherwise.
 *   - destructive marking: recomputed here from the spec-default rule (DESIGN 10)
 *     via `declaredDestructive()`; the model's own claim can only ADD, never
 *     clear, the flag.
 *   - minimum suite size (DESIGN 13): fewer than 8 viable tasks does not throw and
 *     does not silently ship a 2-task suite. It comes back as `insufficient: true`
 *     on the LOCAL result wrapper so the pipeline can refuse with
 *     INSUFFICIENT_SURFACE.
 *
 * The Anthropic client is INJECTED. Nothing here constructs one, reads an API key,
 * or touches the network on import, so the unit tests run with a canned stub.
 */

import { createHash } from 'node:crypto';

import type Anthropic from '@anthropic-ai/sdk';

import { declaredDestructive } from '../score/metrics.js';
import type { FitnessTask, TaskCheck, TaskSuite } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** DESIGN decision 3: the judge model. Pinned, and hashed into the suite. */
export const DEFAULT_JUDGE_MODEL = 'claude-opus-5';

/** DESIGN decision 13: refuse to score below this. Render REFUSED, never a 2-task 100%. */
export const MIN_VIABLE_TASKS = 8;

/** Ask for headroom over the minimum: leak drops and repairs eat into the yield. */
export const DEFAULT_TARGET_TASK_COUNT = 12;

/**
 * Bumped whenever the prompt, the validation rules or the hash inputs change.
 * It is part of the generator config, so a synthesizer change is a NEW suite
 * (new suiteHash) and therefore a new run, never a retry of an old one.
 */
export const SYNTHESIZER_VERSION = 1;

/**
 * Shortest answer-key token the leak check will look for. Below this, matches are
 * overwhelmingly coincidental ("id", "3") and every task in the suite would be
 * dropped. Same floor as the reference check in src/gates/fixtures.ts.
 */
export const MIN_LEAK_TOKEN_LENGTH = 3;

const DEFAULT_MAX_TOKENS = 16000;

// ---------------------------------------------------------------------------
// Tool surface (local shape; structurally accepts MCP `Tool` and FixtureTool)
// ---------------------------------------------------------------------------

/**
 * Deliberately a type alias and not an interface: object-literal types carry an
 * implicit index signature, so these values stay assignable to the scoring
 * module's `ToolDescriptor` without a cast.
 */
export type ToolAnnotationsLike = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/** One `tools/list` entry, narrowed to what synthesis actually reads. */
export type ToolSurfaceEntry = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: ToolAnnotationsLike;
};

// ---------------------------------------------------------------------------
// Injected client seam
// ---------------------------------------------------------------------------

/**
 * The narrowing seam for the judge model. A real `new Anthropic()` satisfies it;
 * so does a two-line stub. We take the non-streaming Messages surface only: task
 * synthesis is one bounded JSON response, not a long generation.
 */
export type JudgeClient = {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
};

// ---------------------------------------------------------------------------
// Options and result
// ---------------------------------------------------------------------------

export interface SynthesizeOptions {
  /** Server slug, copied onto the suite. */
  serverSlug: string;
  /** The advertised `tools/list` surface. */
  tools: readonly ToolSurfaceEntry[];
  /** `getInstructions()` from the connection (DESIGN 17). Injected into the prompt. */
  instructions?: string | null;
  /** Suite seed. Hashed; also handed to the model so re-generation is comparable. */
  seed: number;
  /** Judge model id. Defaults to `claude-opus-5`. */
  generatorModel?: string;
  /** How many tasks to ask for. Defaults to 12. */
  targetTaskCount?: number;
  /** Minimum viable suite size. Defaults to `MIN_VIABLE_TASKS` (8). */
  minTasks?: number;
  /** Drop tasks whose correct solution needs a destructive tool. Default false. */
  excludeDestructive?: boolean;
  /** Effort for the judge call. Default 'high'. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** `max_tokens` for the judge call. Default 16000. */
  maxTokens?: number;
}

export type DropReason =
  | 'malformed'
  | 'duplicate-id'
  | 'no-expected-tools'
  | 'unknown-tool'
  | 'invalid-check'
  | 'unchained-handle'
  | 'destructive-excluded'
  | 'answer-leak';

export interface DroppedTask {
  id: string;
  reason: DropReason;
  detail: string;
}

export interface TaskRepair {
  id: string;
  kind: 'handle-chain';
  detail: string;
}

/** A create-returns-handle edge on a stateful surface. */
export interface HandleChain {
  /** Tool that mints the handle. */
  producer: string;
  /** Tool that consumes it. */
  consumer: string;
  /** The consuming parameter, e.g. `record_id`. */
  param: string;
  /** True when the consumer cannot be called at all without the handle. */
  required: boolean;
}

export interface AnswerLeak {
  taskId: string;
  /** The answer-key token found verbatim in the rendered prompt. */
  token: string;
}

/**
 * LOCAL wrapper around `TaskSuite` (src/types.ts is frozen for this module).
 *
 * `insufficient` is DESIGN decision 13 at suite level: the pipeline reads it and
 * refuses with outcome INSUFFICIENT_SURFACE. The suite is still returned, hash
 * and all, so the refusal can name a real suiteHash and link a real record.
 */
export interface SynthesisResult {
  suite: TaskSuite;
  /** True when fewer than `minTasks` tasks survived validation. */
  insufficient: boolean;
  minTasks: number;
  /** Raw tasks the model emitted across both attempts. Feeds the admission rate. */
  generated: number;
  /** Tasks admitted to the suite. */
  admitted: number;
  dropped: readonly DroppedTask[];
  repairs: readonly TaskRepair[];
  handleChains: readonly HandleChain[];
  /** True when at least one leaking task triggered the single regeneration pass. */
  regenerationAttempted: boolean;
  /** Leaks found on the first pass, whether or not regeneration fixed them. */
  leaksFound: readonly AnswerLeak[];
}

export class TaskSynthesisError extends Error {
  readonly kind: 'refusal' | 'unparseable' | 'empty';
  constructor(kind: 'refusal' | 'unparseable' | 'empty', message: string) {
    super(message);
    this.name = 'TaskSynthesisError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// Canonical JSON + suite hash
// ---------------------------------------------------------------------------

/**
 * JSON with every object key sorted, recursively. Two structurally equal values
 * serialize identically regardless of key insertion order, which is what makes
 * `suiteHash` reproducible across processes.
 *
 * `undefined` object properties are dropped (they are absent, per DESIGN 15's
 * absent-not-null discipline); `undefined` inside an array becomes `null`, which
 * is what `JSON.stringify` does and what the wire would carry anyway.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonicalize(v)));
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    const v = src[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The generator config that goes into the hash. Everything here changes the
 * suite the model would produce, so a change here must change the hash.
 */
export interface GeneratorConfig {
  synthesizerVersion: number;
  generatorModel: string;
  serverSlug: string;
  targetTaskCount: number;
  minTasks: number;
  excludeDestructive: boolean;
  /** sha256 over the canonical tool surface: a new surface is a new suite. */
  toolSurfaceDigest: string;
  /** sha256 over the server `instructions` string, or null when absent. */
  instructionsDigest: string | null;
}

/** sha256 over canonical JSON of tasks + generator config + seed (DESIGN 17). */
export function computeSuiteHash(
  tasks: readonly FitnessTask[],
  generator: GeneratorConfig,
  seed: number,
): string {
  return sha256Hex(canonicalJson({ generator, seed, tasks }));
}

export function toolSurfaceDigest(tools: readonly ToolSurfaceEntry[]): string {
  const normalized = [...tools]
    .map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
      annotations: t.annotations,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sha256Hex(canonicalJson(normalized));
}

// ---------------------------------------------------------------------------
// Destructive rule (DESIGN 10)
// ---------------------------------------------------------------------------

/**
 * Spec-default destructiveness for one tool. Delegates to the single
 * implementation of the rule in src/score/metrics.ts: destructive unless it
 * declares `readOnlyHint: true` or `destructiveHint: false`, and an UNKNOWN tool
 * (not on the surface) is destructive too.
 */
export function toolIsDestructive(
  toolName: string,
  index: ReadonlyMap<string, ToolSurfaceEntry>,
): boolean {
  return declaredDestructive(index.get(toolName));
}

/** A task is destructive when any tool a correct solution needs is destructive. */
export function taskIsDestructive(
  expectedTools: readonly string[],
  index: ReadonlyMap<string, ToolSurfaceEntry>,
): boolean {
  return expectedTools.some((t) => toolIsDestructive(t, index));
}

// ---------------------------------------------------------------------------
// Handle chaining
// ---------------------------------------------------------------------------

const PRODUCER_VERBS = [
  'create',
  'new',
  'add',
  'insert',
  'register',
  'open',
  'start',
  'begin',
  'make',
  'upload',
  'import',
  'submit',
  'provision',
];

const HANDLE_SUFFIXES = ['id', 'ids', 'handle', 'uuid', 'ref', 'key', 'token'];

/** Credential-shaped params that look like handles but are not. */
const HANDLE_DENYLIST = new Set([
  'api_key',
  'apikey',
  'auth_token',
  'access_token',
  'bearer_token',
  'secret_key',
  'session_token',
]);

/** `record_id`, `id`, `handle`, `documentId` -> true. `api_key` -> false. */
export function isHandleParam(name: string): boolean {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
  if (HANDLE_DENYLIST.has(snake)) return false;
  const parts = snake.split('_').filter(Boolean);
  const last = parts[parts.length - 1];
  return last !== undefined && HANDLE_SUFFIXES.includes(last);
}

function schemaProperties(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return {};
  const props = (schema as { properties?: unknown }).properties;
  if (!props || typeof props !== 'object') return {};
  return props as Record<string, unknown>;
}

function schemaRequired(schema: unknown): readonly string[] {
  if (!schema || typeof schema !== 'object') return [];
  const req = (schema as { required?: unknown }).required;
  if (!Array.isArray(req)) return [];
  return req.filter((r): r is string => typeof r === 'string');
}

function looksLikeProducer(tool: ToolSurfaceEntry): boolean {
  const head = tool.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] ?? '';
  if (PRODUCER_VERBS.includes(head)) return true;
  const desc = (tool.description ?? '').toLowerCase();
  return /returns?[^.]{0,40}\b(id|handle|identifier|token)\b/.test(desc);
}

/** `record_id` -> "record"; `id` -> "" (no entity affinity). */
function entityOf(param: string): string {
  const snake = param
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
  const parts = snake.split('_').filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join('_') : '';
}

/**
 * Create-returns-handle edges on a stateful surface (DESIGN 17). A consumer is a
 * tool with a handle-shaped parameter; its producer is the create-style tool
 * whose name carries the same entity token, or the only producer on the surface
 * when there is exactly one.
 */
export function detectHandleChains(tools: readonly ToolSurfaceEntry[]): HandleChain[] {
  const producers = tools.filter(looksLikeProducer);
  const chains: HandleChain[] = [];
  for (const consumer of tools) {
    const required = new Set(schemaRequired(consumer.inputSchema));
    for (const param of Object.keys(schemaProperties(consumer.inputSchema))) {
      if (!isHandleParam(param)) continue;
      const entity = entityOf(param);
      const candidates = producers.filter((p) => p.name !== consumer.name);
      if (candidates.length === 0) continue;
      const byEntity =
        entity.length > 0 ? candidates.filter((p) => p.name.toLowerCase().includes(entity)) : [];
      const chosen = byEntity.length === 1 ? byEntity[0] : candidates.length === 1 ? candidates[0] : undefined;
      if (!chosen) continue;
      chains.push({
        producer: chosen.name,
        consumer: consumer.name,
        param,
        required: required.has(param),
      });
    }
  }
  return chains;
}

// ---------------------------------------------------------------------------
// Answer-leak check (FREE gate, run at generation time)
// ---------------------------------------------------------------------------

function normalizeForLeak(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Every scalar leaf of an answer key, as a string. A structured key
 * (`{invoice: "INV-1042", total: 90.5}`) leaks if ANY of its leaves shows up in
 * the prompt, so the whole tree is walked, not just the top-level string form.
 */
export function leakTokens(answerKey: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      out.push(v);
      return;
    }
    if (typeof v === 'number' && Number.isFinite(v)) {
      out.push(String(v));
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (v && typeof v === 'object') {
      for (const item of Object.values(v as Record<string, unknown>)) walk(item);
    }
  };
  walk(answerKey);
  return out.filter((t) => normalizeForLeak(t).length >= MIN_LEAK_TOKEN_LENGTH);
}

/**
 * The answer-leak string check. Returns the offending token, or null.
 *
 * Only the answer key is scanned. `check` literals are deliberately NOT scanned:
 * a `substring` check very often echoes an identifier the prompt legitimately
 * supplies ("look up INV-1042" / expect "INV-1042 is paid"), so scanning them
 * would drop sound tasks and shrink the suite below DESIGN 13's floor for no
 * validity gain.
 */
export function findAnswerLeak(task: Pick<FitnessTask, 'prompt' | 'answerKey'>): string | null {
  if (task.answerKey === undefined || task.answerKey === null) return null;
  const prompt = normalizeForLeak(task.prompt);
  if (prompt.length === 0) return null;
  for (const token of leakTokens(task.answerKey)) {
    if (prompt.includes(normalizeForLeak(token))) return token;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prompt templating (the "parameterized" in parameterized tasks)
// ---------------------------------------------------------------------------

/** Substitutes `{{param}}` placeholders. Unknown placeholders are left verbatim. */
export function renderPrompt(template: string, params: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (whole, key: string) => {
    const value = params[key];
    return value === undefined ? whole : value;
  });
}

// ---------------------------------------------------------------------------
// Model I/O
// ---------------------------------------------------------------------------

const CHECK_SCHEMA = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'where', 'value'],
      properties: {
        kind: { const: 'substring' },
        where: { const: 'final_text' },
        value: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'where', 'pattern'],
      properties: {
        kind: { const: 'regex' },
        where: { const: 'final_text' },
        pattern: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'tool'],
      properties: { kind: { const: 'tool_called' }, tool: { type: 'string' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'tool', 'pattern'],
      properties: {
        kind: { const: 'tool_result_matches' },
        tool: { type: 'string' },
        pattern: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'rubric'],
      properties: { kind: { const: 'judge' }, rubric: { type: 'string' } },
    },
  ],
} as const;

const TASKS_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'promptTemplate', 'params', 'expectedTools', 'check', 'answerKey', 'destructive'],
        properties: {
          id: { type: 'string' },
          promptTemplate: { type: 'string' },
          // The Claude structured-output API rejects `additionalProperties` carrying a
          // schema object ("Please set 'additionalProperties' to false"), so an open
          // string map is not expressible. Params travel as {name,value} pairs on the
          // wire; the parser folds them back into a Record.
          params: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'value'],
              properties: {
                name: { type: 'string' },
                value: { type: 'string' },
              },
            },
          },
          expectedTools: { type: 'array', items: { type: 'string' } },
          check: CHECK_SCHEMA,
          answerKey: { type: 'string' },
          destructive: { type: 'boolean' },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = [
  'You generate evaluation tasks for an MCP (Model Context Protocol) server.',
  'A task is one job a competent agent should be able to finish using ONLY the tools listed,',
  'and whose success can be decided by a machine with no human in the loop.',
  '',
  'Hard rules:',
  '1. Every task must be solvable with the advertised tools alone. Never invent a tool.',
  '2. Every task carries a machine-checkable check. Prefer substring/regex over judge rubrics;',
  '   use a judge rubric only when no literal string can decide the outcome.',
  '3. The answerKey is the fact the agent must discover by CALLING tools. It must never appear,',
  '   in whole or in part, in the rendered prompt. If the prompt already states the answer,',
  '   a model with no tools at all passes the task and the suite is worthless.',
  '4. Write the prompt as a template with {{placeholders}} and supply the bound params. The',
  '   placeholders carry inputs the agent is GIVEN (a search term, a record name), never the answer.',
  '5. On stateful surfaces, chain handles: if a tool consumes an id/handle, the task must also',
  '   expect the tool that creates it, listed first in expectedTools.',
  '6. Set destructive:true when a correct solution requires a tool that writes, deletes, sends or',
  '   transfers. When a tool carries no annotations, assume it is destructive.',
  '7. Vary difficulty: single-call lookups, multi-call chains, and at least one task that requires',
  '   choosing between two similar tools.',
  '',
  'Return JSON only. No prose, no code fences.',
].join('\n');

function toolSurfaceForPrompt(
  tools: readonly ToolSurfaceEntry[],
  index: ReadonlyMap<string, ToolSurfaceEntry>,
): unknown {
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? null,
    inputSchema: t.inputSchema ?? null,
    outputSchema: t.outputSchema ?? null,
    annotations: t.annotations ?? null,
    destructiveUnderSpecDefault: toolIsDestructive(t.name, index),
  }));
}

export function buildGenerationPrompt(
  opts: SynthesizeOptions,
  index: ReadonlyMap<string, ToolSurfaceEntry>,
  chains: readonly HandleChain[],
  target: number,
): string {
  const parts: string[] = [
    `Server: ${opts.serverSlug}`,
    `Seed: ${opts.seed} (use it to vary concrete parameter values deterministically)`,
    `Generate exactly ${target} tasks.`,
    '',
    'Server instructions (verbatim; the runner agent gets these too):',
    opts.instructions && opts.instructions.trim().length > 0
      ? opts.instructions.trim()
      : '(the server advertised no instructions)',
    '',
    'Tool surface (tools/list):',
    JSON.stringify(toolSurfaceForPrompt(opts.tools, index), null, 2),
  ];
  if (chains.length > 0) {
    parts.push(
      '',
      'Detected create-returns-handle chains. Any task using a consumer MUST also expect its producer:',
      JSON.stringify(chains, null, 2),
    );
  } else {
    parts.push('', 'No create-returns-handle chains detected: this surface looks stateless.');
  }
  if (opts.excludeDestructive === true) {
    parts.push('', 'This run excludes destructive work. Do not write tasks that need a destructive tool.');
  }
  parts.push(
    '',
    'Respond with {"tasks": [...]} where each task has: id (slug, unique), promptTemplate,',
    'params (array of {name, value} string pairs bound into the template), expectedTools',
    '(array of tool names), check, answerKey (short string the agent must discover),',
    'destructive (boolean).',
  );
  return parts.join('\n');
}

function buildRepairPrompt(offenders: readonly { task: RawTask; token: string }[]): string {
  return [
    'These tasks leak their answer key into the rendered prompt. A no-tools baseline would pass them,',
    'so they are invalid as written.',
    '',
    'Rewrite ONLY the promptTemplate and params of each. Keep the same id, expectedTools, check and',
    'answerKey. The rewritten prompt must state the job and the inputs, and must not contain the',
    'answer key or any part of it. Do not paraphrase the answer either: if the key is "4.2.1",',
    'the prompt may not say "four point two point one".',
    '',
    JSON.stringify(
      offenders.map((o) => ({
        id: o.task.id,
        leakedToken: o.token,
        answerKey: o.task.answerKey,
        promptTemplate: o.task.promptTemplate,
        params: o.task.params,
        expectedTools: o.task.expectedTools,
        check: o.task.check,
      })),
      null,
      2,
    ),
    '',
    'Respond with {"tasks": [...]} carrying the full rewritten task objects. JSON only.',
  ].join('\n');
}

interface RawTask {
  id: string;
  promptTemplate?: string;
  prompt?: string;
  params?: Record<string, string>;
  expectedTools?: unknown;
  check?: unknown;
  answerKey?: unknown;
  destructive?: unknown;
}

function textOf(message: Anthropic.Message): string {
  const chunks: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text' && typeof block.text === 'string') chunks.push(block.text);
  }
  return chunks.join('\n').trim();
}

/** Tolerant JSON extraction: bare JSON, fenced JSON, or JSON with prose around it. */
export function parseTaskPayload(text: string): RawTask[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new TaskSynthesisError('empty', 'judge returned no text');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidates = [fenced?.[1], trimmed].filter((c): c is string => typeof c === 'string');
  for (const candidate of candidates) {
    const start = candidate.search(/[[{]/);
    if (start < 0) continue;
    const openChar = candidate[start];
    const endChar = openChar === '[' ? ']' : '}';
    const end = candidate.lastIndexOf(endChar);
    if (end <= start) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.slice(start, end + 1));
    } catch {
      continue;
    }
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object'
        ? (parsed as { tasks?: unknown }).tasks
        : undefined;
    if (!Array.isArray(list)) continue;
    return list.filter((t): t is RawTask => !!t && typeof t === 'object') as RawTask[];
  }
  throw new TaskSynthesisError('unparseable', 'judge response contained no task JSON');
}

async function askJudge(
  client: JudgeClient,
  opts: SynthesizeOptions,
  userPrompt: string,
): Promise<RawTask[]> {
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: opts.generatorModel ?? DEFAULT_JUDGE_MODEL,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    thinking: { type: 'adaptive' },
    output_config: {
      effort: opts.effort ?? 'high',
      format: { type: 'json_schema', schema: TASKS_JSON_SCHEMA },
    },
  };
  // No server-side refusal fallback on purpose: a fallback would silently swap the
  // judge model out from under `generatorModel`/`suiteHash`, and DESIGN 3's pinned
  // -model discipline says refuse rather than quietly change the record.
  const message = await client.messages.create(params);
  if (message.stop_reason === 'refusal') {
    throw new TaskSynthesisError('refusal', 'judge model refused to generate the task suite');
  }
  return parseTaskPayload(textOf(message));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateCheck(raw: unknown, surface: ReadonlySet<string>): TaskCheck | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  switch (c.kind) {
    case 'substring':
      return c.where === 'final_text' && typeof c.value === 'string' && c.value.length > 0
        ? { kind: 'substring', where: 'final_text', value: c.value }
        : null;
    case 'regex': {
      if (c.where !== 'final_text' || typeof c.pattern !== 'string' || c.pattern.length === 0) return null;
      try {
        new RegExp(c.pattern);
      } catch {
        return null;
      }
      return { kind: 'regex', where: 'final_text', pattern: c.pattern };
    }
    case 'tool_called':
      return typeof c.tool === 'string' && surface.has(c.tool)
        ? { kind: 'tool_called', tool: c.tool }
        : null;
    case 'tool_result_matches': {
      if (typeof c.tool !== 'string' || !surface.has(c.tool)) return null;
      if (typeof c.pattern !== 'string' || c.pattern.length === 0) return null;
      try {
        new RegExp(c.pattern);
      } catch {
        return null;
      }
      return { kind: 'tool_result_matches', tool: c.tool, pattern: c.pattern };
    }
    case 'judge':
      return typeof c.rubric === 'string' && c.rubric.trim().length > 0
        ? { kind: 'judge', rubric: c.rubric }
        : null;
    default:
      return null;
  }
}

function slugId(raw: unknown, fallbackIndex: number): string {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const slug = text.replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : `task-${fallbackIndex + 1}`;
}

interface ValidationContext {
  index: ReadonlyMap<string, ToolSurfaceEntry>;
  surface: ReadonlySet<string>;
  chains: readonly HandleChain[];
  excludeDestructive: boolean;
  seen: Set<string>;
  dropped: DroppedTask[];
  repairs: TaskRepair[];
}

/**
 * Repairs a task whose expectedTools consume a REQUIRED handle without listing
 * the producer that mints it. Returns null when the producer is ambiguous, which
 * is a drop: an unchained handle task fails for a reason that has nothing to do
 * with the server's fitness.
 */
function chainExpectedTools(
  id: string,
  expected: readonly string[],
  ctx: ValidationContext,
): readonly string[] | null {
  const present = new Set(expected);
  const out = [...expected];
  for (const tool of expected) {
    const needed = ctx.chains.filter((c) => c.consumer === tool && c.required);
    for (const chain of needed) {
      if (present.has(chain.producer)) continue;
      const producers = new Set(
        ctx.chains.filter((c) => c.consumer === tool && c.param === chain.param).map((c) => c.producer),
      );
      if (producers.size !== 1) {
        ctx.dropped.push({
          id,
          reason: 'unchained-handle',
          detail: `${tool} requires ${chain.param} and no unambiguous producer is expected`,
        });
        return null;
      }
      out.unshift(chain.producer);
      present.add(chain.producer);
      ctx.repairs.push({
        id,
        kind: 'handle-chain',
        detail: `prepended ${chain.producer} so ${tool} has a ${chain.param} to consume`,
      });
    }
  }
  return out;
}

function validateTask(raw: RawTask, position: number, ctx: ValidationContext): FitnessTask | null {
  const id = slugId(raw.id, position);
  if (ctx.seen.has(id)) {
    ctx.dropped.push({ id, reason: 'duplicate-id', detail: 'a task with this id was already admitted' });
    return null;
  }

  const template = typeof raw.promptTemplate === 'string' && raw.promptTemplate.length > 0
    ? raw.promptTemplate
    : typeof raw.prompt === 'string'
      ? raw.prompt
      : '';
  const params: Record<string, string> = {};
  if (Array.isArray(raw.params)) {
    // Wire shape from the structured-output schema: [{name, value}, ...].
    for (const entry of raw.params as readonly unknown[]) {
      if (entry && typeof entry === 'object') {
        const { name, value } = entry as { name?: unknown; value?: unknown };
        if (typeof name === 'string' && name.length > 0) {
          if (typeof value === 'string') params[name] = value;
          else if (typeof value === 'number' || typeof value === 'boolean') params[name] = String(value);
        }
      }
    }
  } else if (raw.params && typeof raw.params === 'object') {
    // Legacy/stub shape: an open string map.
    for (const [k, v] of Object.entries(raw.params as Record<string, unknown>)) {
      if (typeof v === 'string') params[k] = v;
      else if (typeof v === 'number' || typeof v === 'boolean') params[k] = String(v);
    }
  }
  const prompt = renderPrompt(template, params).trim();
  if (prompt.length === 0) {
    ctx.dropped.push({ id, reason: 'malformed', detail: 'empty rendered prompt' });
    return null;
  }

  const expectedRaw = Array.isArray(raw.expectedTools)
    ? raw.expectedTools.filter((t): t is string => typeof t === 'string')
    : [];
  if (expectedRaw.length === 0) {
    ctx.dropped.push({ id, reason: 'no-expected-tools', detail: 'task expects no tool call at all' });
    return null;
  }
  const unknown = expectedRaw.filter((t) => !ctx.surface.has(t));
  if (unknown.length > 0) {
    ctx.dropped.push({
      id,
      reason: 'unknown-tool',
      detail: `not on the advertised surface: ${unknown.join(', ')}`,
    });
    return null;
  }

  const check = validateCheck(raw.check, ctx.surface);
  if (!check) {
    ctx.dropped.push({ id, reason: 'invalid-check', detail: 'no machine-checkable success predicate' });
    return null;
  }

  const expected = chainExpectedTools(id, expectedRaw, ctx);
  if (!expected) return null;

  // DESIGN 10: the spec-default rule decides. The model's own claim may only ADD
  // the flag, never clear one the annotations imply.
  const destructive = taskIsDestructive(expected, ctx.index) || raw.destructive === true;
  if (destructive && ctx.excludeDestructive) {
    ctx.dropped.push({
      id,
      reason: 'destructive-excluded',
      detail: 'correct solution requires a destructive tool and this run excludes them',
    });
    return null;
  }

  const task: FitnessTask = {
    id,
    prompt,
    expectedTools: expected,
    check,
    destructive,
    ...(raw.answerKey === undefined || raw.answerKey === null ? {} : { answerKey: raw.answerKey }),
  };
  ctx.seen.add(id);
  return task;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Generate a task suite for one server's tool surface.
 *
 * Never throws on a small surface: too few viable tasks comes back as
 * `insufficient: true` so the caller refuses with INSUFFICIENT_SURFACE (DESIGN 13)
 * instead of publishing a 2-task 100%.
 */
export async function synthesizeTaskSuite(
  client: JudgeClient,
  opts: SynthesizeOptions,
): Promise<SynthesisResult> {
  const generatorModel = opts.generatorModel ?? DEFAULT_JUDGE_MODEL;
  const target = opts.targetTaskCount ?? DEFAULT_TARGET_TASK_COUNT;
  const minTasks = opts.minTasks ?? MIN_VIABLE_TASKS;
  const excludeDestructive = opts.excludeDestructive === true;

  const index = new Map<string, ToolSurfaceEntry>(opts.tools.map((t) => [t.name, t]));
  const surface = new Set(index.keys());
  const chains = detectHandleChains(opts.tools);

  const raw = await askJudge(client, opts, buildGenerationPrompt(opts, index, chains, target));
  let generated = raw.length;

  // FREE gate, at generation time: the answer key may not be in the rendered
  // prompt. Offenders get one regeneration pass, then they are dropped.
  const leaksFound: AnswerLeak[] = [];
  const offenders: { task: RawTask; token: string }[] = [];
  for (const [i, task] of raw.entries()) {
    const rendered = renderPrompt(
      typeof task.promptTemplate === 'string' ? task.promptTemplate : (task.prompt ?? ''),
      normalizeParams(task.params),
    );
    const token = findAnswerLeak({ prompt: rendered, answerKey: task.answerKey });
    if (token !== null) {
      const id = slugId(task.id, i);
      leaksFound.push({ taskId: id, token });
      offenders.push({ task, token });
    }
  }

  let candidates = raw;
  let regenerationAttempted = false;
  if (offenders.length > 0) {
    regenerationAttempted = true;
    let rewrites: RawTask[] = [];
    try {
      rewrites = await askJudge(client, opts, buildRepairPrompt(offenders));
      generated += rewrites.length;
    } catch {
      // A failed repair pass is not fatal: the offenders simply stay dropped.
      rewrites = [];
    }
    const byId = new Map<string, RawTask>();
    for (const [i, r] of rewrites.entries()) byId.set(slugId(r.id, i), r);
    candidates = raw.map((task, i) => {
      const id = slugId(task.id, i);
      if (!offenders.some((o) => o.task === task)) return task;
      const replacement = byId.get(id);
      return replacement ? { ...replacement, id: task.id } : task;
    });
  }

  const ctx: ValidationContext = {
    index,
    surface,
    chains,
    excludeDestructive,
    seen: new Set<string>(),
    dropped: [],
    repairs: [],
  };

  const tasks: FitnessTask[] = [];
  for (const [i, candidate] of candidates.entries()) {
    const task = validateTask(candidate, i, ctx);
    if (!task) continue;
    // Re-run the leak check on the FINAL rendered prompt. Anything still leaking
    // after its one regeneration is dropped; there is no second attempt.
    const token = findAnswerLeak(task);
    if (token !== null) {
      ctx.dropped.push({
        id: task.id,
        reason: 'answer-leak',
        detail: `answer key token ${JSON.stringify(token)} appears in the rendered prompt`,
      });
      ctx.seen.delete(task.id);
      continue;
    }
    tasks.push(task);
  }

  const generator: GeneratorConfig = {
    synthesizerVersion: SYNTHESIZER_VERSION,
    generatorModel,
    serverSlug: opts.serverSlug,
    targetTaskCount: target,
    minTasks,
    excludeDestructive,
    toolSurfaceDigest: toolSurfaceDigest(opts.tools),
    instructionsDigest:
      opts.instructions && opts.instructions.length > 0 ? sha256Hex(opts.instructions) : null,
  };

  const suite: TaskSuite = {
    serverSlug: opts.serverSlug,
    suiteHash: computeSuiteHash(tasks, generator, opts.seed),
    generatorModel,
    seed: opts.seed,
    tasks,
  };

  return {
    suite,
    insufficient: tasks.length < minTasks,
    minTasks,
    generated,
    admitted: tasks.length,
    dropped: ctx.dropped,
    repairs: ctx.repairs,
    handleChains: chains,
    regenerationAttempted,
    leaksFound,
  };
}

function normalizeParams(params: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
      else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    }
  }
  return out;
}
