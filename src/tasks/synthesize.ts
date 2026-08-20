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
 * GENERATOR v2 (2026-08-19). v1's first real leaderboard pass produced zero
 * scored rows: seven servers refused DEGENERATE because the no-tools null model
 * passed 70 of 76 generated tasks, and five refused INSUFFICIENT_SURFACE because
 * admission discarded 7 to 10 of 12 of our own candidates. Both root causes are
 * generator defects, so v2 changes the GENERATOR and never a gate:
 *   - the system prompt bans the two families the null model actually beat us on
 *     (closed-vocabulary API names, stable encyclopedia facts) and requires every
 *     task to declare `serverRequiredBecause`;
 *   - the check policy rejects predicates a no-tools model satisfies by
 *     construction (bare quantified classes, one-word substrings, `tool_called`
 *     as the whole check, a literal the prompt already supplies);
 *   - a generation-time NULL SCREEN asks a cold, tool-less model every candidate
 *     and DELETES the ones it answers correctly (`null_screen`);
 *   - the parser bugs that silently manufactured drops are fixed (`bindParams`
 *     reads the wire shape of `params`; repairs match positionally when an id
 *     comes back blank; discarded payload entries are counted);
 *   - accounting is exact: `candidates === admitted + dropped + trimmed`, and the
 *     whole ledger is returned for serialization to `suite-meta.json`.
 * Nothing here touches src/gates. Every change makes TASKS HARDER or accounting
 * TRUER; no threshold, ratio, floor or alpha moves.
 *
 * GENERATOR v3 (2026-08-20). v2's sixteen published runs dropped 198 of 386
 * candidates as `invalid-check` with the detail "regex does not compile", 196 of
 * them on the `tool_result_matches` check the prompt makes mandatory. The prompt
 * never named the regex dialect and the ledger never recorded the pattern, so
 * seven servers are published as GATE_FAILED or INSUFFICIENT_SURFACE for a
 * defect in this file. v3 changes the GENERATOR and never a gate:
 *   - the prompt states the dialect (ECMAScript, compiled with the `i` flag)
 *     in the same section that requires the check kind;
 *   - `repairPattern` translates the foreign-dialect constructs that have an
 *     exact ECMAScript form and drops the ones that do not, naming them;
 *   - `compileCheckPattern` is the one door every pattern-bearing check goes
 *     through, so a pattern is compiled by a real RegExp where it is WRITTEN;
 *   - the drop ledger carries the check itself (`checkPattern`, `checkValue`,
 *     `checkTool`), so a drop caused by the judge's own output can be argued
 *     with from the published record instead of taken on trust.
 * Repair can only ever move a candidate from dropped to validated, so admission
 * rates under v3 are not comparable with the v2 rows on the board. That is what
 * the version bump is for: `generatorVersion` is the field the leaderboard
 * refuses to rank across, and no published record is touched.
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
 * The Anthropic client is INJECTED, and so is the separate null-screen client.
 * Nothing here constructs one, reads an API key, or touches the network on
 * import, so the unit tests run with canned stubs. Omit the screen client and
 * the screen does not run at all: the module's offline property is preserved by
 * construction, not by convention.
 */

import { createHash } from 'node:crypto';

import type Anthropic from '@anthropic-ai/sdk';

// The null screen decides with the SAME predicate evaluator the run uses, so a
// candidate the screen keeps and the gate then kills can never be explained by
// two divergent notions of "passing". `evaluateCheck` is pure: no network, no
// client, no key, so the module keeps its stubbable, offline-testable property.
import { evaluateCheck } from '../run/agent.js';
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
export const SYNTHESIZER_VERSION = 3;

/**
 * The generator identity that goes into the suite hash preimage. Artifacts from
 * two generator versions can never collide, and the leaderboard must never put
 * rows from two of them in the same column.
 */
export const GENERATOR_VERSION = `fitness-report-generator/${String(SYNTHESIZER_VERSION)}`;

/** Bumped when the admission check policy changes. Hashed. */
export const CHECK_POLICY_VERSION = 3;

/** Bumped when the answer-leak normalization changes. Hashed. */
export const LEAK_CHECK_MODE = 'squashed+word-boundary/2';

/**
 * v2 over-generates: the null screen deletes roughly half the candidates on a
 * public-docs surface, so asking for exactly the target guarantees a refusal.
 * Ask for `max(target * factor, floor)`.
 */
export const DEFAULT_OVER_GENERATION_FACTOR = 2;
export const MIN_OVER_GENERATION = 16;

/**
 * Shortest answer-key token the leak check will look for, measured on the
 * SQUASHED form (letters and digits only). Below this, matches are
 * overwhelmingly coincidental ("id", "3") and every task in the suite would be
 * dropped. Same floor as the reference check in src/gates/fixtures.ts.
 */
export const MIN_LEAK_TOKEN_LENGTH = 3;

/**
 * A key shorter than this (squashed) is matched only on a WORD BOUNDARY, never
 * by squashed containment: "307" and "63" appear inside unrelated numbers on
 * every documentation surface, and a false leak drop is a task lost for nothing.
 */
export const SHORT_KEY_BOUNDARY_LENGTH = 6;

/**
 * Server `instructions` and tool descriptions are PROSE and collide by accident
 * far more often than a prompt does, so the context corpus carries a longer
 * floor than the prompt does.
 */
export const MIN_CONTEXT_LEAK_TOKEN_LENGTH = 6;

/** A `substring` check shorter than this is satisfiable by chance. */
export const MIN_SUBSTRING_CHECK_LENGTH = 4;

/**
 * A regex whose longest literal run is shorter than this is a SHAPE, not an
 * answer: `[0-9]{3,}`, `\d+`, `.*` and `\[[a-zA-Z]+\]` are all passed by text a
 * no-tools model writes without knowing anything.
 */
export const MIN_REGEX_LITERAL_RUN = 3;

/** At most one judge rubric per suite (v2 check policy). */
export const MAX_JUDGE_CHECKS_PER_SUITE = 1;

const DEFAULT_MAX_TOKENS = 32000;

/** The cold probe is one short answer. It never needs a long generation. */
export const DEFAULT_SCREEN_MAX_TOKENS = 400;

/** How many cold probes are in flight at once. */
export const DEFAULT_SCREEN_CONCURRENCY = 4;

/** Longest excerpt of a cold answer kept as evidence in the ledger. */
export const SCREEN_EXCERPT_CHARS = 400;

/**
 * The cold probe's system prompt. Deliberately STRICTER than the run-time
 * no-tools null model: that one was free to hedge ("I cannot check, but from
 * prior knowledge...") and still satisfied four measured checks. This one is
 * told to commit or to say UNKNOWN, and it is given no server instructions,
 * because instructions are themselves a measured leak channel.
 */
export const NULL_SCREEN_SYSTEM_PROMPT =
  'You have no tools available. Answer the user from your own knowledge. Be direct and state ' +
  'your best answer. Do not ask for tools and do not refuse. If you genuinely do not know, ' +
  'reply with exactly UNKNOWN.';

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
    /**
     * Optional streaming surface. The real Anthropic SDK REFUSES non-streaming
     * `create` when `max_tokens` implies the request may exceed 10 minutes
     * (observed live at 32k output tokens on opus), so when a client offers
     * `stream`, askJudge uses it and awaits the final message. Stubs that only
     * implement `create` keep working: the response content is identical.
     */
    stream?(params: Anthropic.MessageCreateParamsNonStreaming): { finalMessage(): Promise<Anthropic.Message> };
  };
};

/** One judge exchange, streaming when the client supports it. */
async function judgeMessage(
  client: JudgeClient,
  params: Anthropic.MessageCreateParamsNonStreaming
): Promise<Anthropic.Message> {
  if (typeof client.messages.stream === 'function') {
    return client.messages.stream(params).finalMessage();
  }
  return client.messages.create(params);
}

/**
 * The narrowing seam for the NULL SCREEN. Structurally identical to
 * `JudgeClient`, and deliberately a separate field on the options: the screen
 * must run on the RUNNER model (the model the null_baseline gate will use), not
 * on the judge, or it lets through exactly the candidates the gate then kills.
 * Absent => no screen runs and the module keeps its no-network property.
 */
export type ScreenClient = JudgeClient;

/**
 * Grades a `judge` rubric against one answer. Structurally identical to
 * `JudgeCheck` in src/run/agent.ts, so the pipeline hands the run-time judge
 * straight in and the screen decides judge candidates the same way the run will.
 */
export type ScreenJudge = (
  rubric: string,
  finalText: string,
  task: FitnessTask,
) => Promise<boolean | null>;

/** Null-screen configuration. `client` absent => the screen is off. */
export interface NullScreenOptions {
  client?: ScreenClient;
  /** Runner model id. Hashed into the suite: a re-screen is a new suite. */
  model: string;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Probes in flight at once. Default 4. */
  concurrency?: number;
  /** Drop candidates the cold model answered correctly. Default true. */
  dropOnCold?: boolean;
  /** Grades `judge` candidates. Absent => judge candidates are not screenable. */
  judge?: ScreenJudge;
}

/** One cold probe, kept whether the candidate survived it or not. */
export interface NullScreenRecord {
  taskId: string;
  checkKind: TaskCheck['kind'];
  /** False when the check cannot be satisfied without tool calls by construction. */
  screenable: boolean;
  /** True = the cold model answered correctly. null = not screenable, or errored. */
  coldPassed: boolean | null;
  /** First 400 chars of what the cold model said. Our own text, safe to publish. */
  coldAnswerExcerpt?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Present when the probe itself failed. The candidate is KEPT in that case. */
  error?: string;
}

export interface NullScreenResult {
  enabled: boolean;
  model: string | null;
  /** Candidates that got a real cold probe. */
  screened: number;
  /** Candidates deleted because the cold model answered them correctly. */
  dropped: number;
  /** Probes that threw. Those candidates are kept, never silently deleted. */
  errors: number;
  inputTokens: number;
  outputTokens: number;
  records: readonly NullScreenRecord[];
}

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
  /**
   * v2: ask the judge for `max(target * factor, MIN_OVER_GENERATION)` candidates
   * because the null screen deletes a large fraction of them. Default 2.
   */
  overGenerationFactor?: number;
  /** v2 null screen (DESIGN 11 FREE-tier discipline, run at generation time). */
  nullScreen?: NullScreenOptions;
}

/**
 * v2: every task must name the reason the SERVER is required to answer it. A
 * task that cannot name one is a task about the model, not about the server.
 */
export const SERVER_REQUIREMENTS = [
  'volatile',
  'long-tail',
  'server-minted',
  'verbatim-quote',
  'cross-reference',
] as const;

export type ServerRequirement = (typeof SERVER_REQUIREMENTS)[number];

export type DropReason =
  | 'malformed'
  | 'duplicate-id'
  | 'no-expected-tools'
  | 'unknown-tool'
  | 'invalid-check'
  | 'unchained-handle'
  | 'destructive-excluded'
  | 'answer-leak'
  /** v2: the answer key is in the server instructions or a tool description. */
  | 'context-answer-leak'
  /** v2: the check is satisfiable without knowing the answer. */
  | 'check-too-permissive'
  /** v2: the check literal is already in the rendered prompt. */
  | 'check-matches-prompt'
  /** v2: no valid `serverRequiredBecause`. */
  | 'no-server-requirement'
  /** v2: a cold, tool-less model answered it correctly. */
  | 'null_screen';

export interface DroppedTask {
  id: string;
  reason: DropReason;
  detail: string;
  /**
   * Enough of the candidate to argue with the drop. `phrase`, never `token`:
   * the publish-time redactor erases any field literally named `token`, and
   * that would erase the evidence this record exists to carry.
   */
  evidence?: {
    expectedTools?: readonly string[];
    unknownTools?: readonly string[];
    checkKind?: string;
    /**
     * The check ITSELF, as the generator wrote it.
     *
     * WHY IT IS HERE. The ledger recorded the rule, the offending phrase, a
     * prompt excerpt and a cold answer excerpt, and nothing about the predicate
     * that did the rejecting. A drop whose whole cause is the judge's own
     * output ("regex does not compile", "matches a shape rather than an
     * answer", "the prompt already contains the check literal") could not be
     * argued with from the published record: 198 candidates were dropped for a
     * pattern nobody can read. `checkPattern` is the pattern as written,
     * `checkPatternRepaired` the ECMAScript form when the two differ,
     * `checkValue` the literal of a `substring` check, `checkTool` the tool a
     * `tool_called` or `tool_result_matches` check named.
     *
     * REDACTION. These ride inside the same `evidence` object as `phrase` and
     * go through `redactReport` on the published copy exactly like every other
     * field, and none of them is spelled with a key the descend-anywhere rules
     * erase (`token`, `secret`, `api_key`, ...).
     */
    checkPattern?: string;
    checkPatternRepaired?: string;
    checkValue?: string;
    checkTool?: string;
    phrase?: string;
    promptExcerpt?: string;
    /** What the cold, tool-less model said, when the null screen did the drop. */
    coldAnswerExcerpt?: string;
  };
}

export interface TaskRepair {
  id: string;
  kind:
    | 'handle-chain'
    | 'answer-leak-rewrite'
    | 'expected-tools-dedupe'
    /** A check pattern translated out of a foreign regex dialect into ECMAScript. */
    | 'check-pattern-dialect';
  detail: string;
  /** Only on rewrites: how the replacement was paired with its offender. */
  matchedBy?: 'id' | 'position';
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
  /**
   * The answer-key phrase found in the prompt (or in the context corpus).
   *
   * `phrase`, NOT `token`: src/tape/default-redact.json carries a descend
   * -anywhere `$..token` rule, so a field named `token` is replaced with
   * [REDACTED] in every published copy and the leak evidence disappears from
   * exactly the artifact that exists to show it.
   */
  phrase: string;
  /** Where it was found. `prompt` is the classic case. */
  source: 'prompt' | 'params' | 'context';
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
  /**
   * Raw candidates the judge emitted on the FIRST pass.
   *
   * v1 did `generated += rewrites.length`, which double-counted the repair pass:
   * a rewrite REPLACES an offender, it is not a new candidate. With 12 raw and 4
   * rewrites the reported admission rate was 0.750 where the true rate was
   * 1.000, and that inflated denominator went straight into the structural
   * gate's 0.25 floor. The gate's floor did not move; the denominator is now the
   * number of candidates that were actually validated.
   */
  generated: number;
  /** Raw candidates the judge emitted (alias of `generated`, named for the ledger). */
  emitted: number;
  /** Repair replacements the judge returned. Never added to `candidates`. */
  rewritten: number;
  /** The candidates actually put through validation. */
  candidates: number;
  /** Payload entries the parser discarded because they were not objects. */
  entriesDiscarded: number;
  /** Tasks admitted to the suite. */
  admitted: number;
  /** Valid tasks above the target count, kept out of the suite for cost. */
  trimmed: number;
  /** `candidates === admitted + dropped.length + trimmed`. */
  reconciles: boolean;
  /** Signed shortfall when the accounting does not reconcile. 0 when it does. */
  shortfall: number;
  dropped: readonly DroppedTask[];
  repairs: readonly TaskRepair[];
  handleChains: readonly HandleChain[];
  /** True when at least one leaking task triggered the single regeneration pass. */
  regenerationAttempted: boolean;
  /** Leaks found on the first pass, whether or not regeneration fixed them. */
  leaksFound: readonly AnswerLeak[];
  /** Every cold probe, kept or dropped (v2). */
  nullScreen: NullScreenResult;
  /** The exact generator config hashed into `suite.suiteHash`. */
  generator: GeneratorConfig;
  /** The surface the suite was generated against. */
  surface: { toolCount: number; toolNames: readonly string[] };
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
  /** 'fitness-report-generator/<n>'. A version bump is a new attempt, never a retry. */
  generatorVersion: string;
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
  // --- v2 knobs. Two materially different generators must never share a hash. ---
  /** Judge effort. Was unhashed in v1 while materially changing the output. */
  effort: string;
  maxTokens: number;
  overGenerationFactor: number;
  checkPolicyVersion: number;
  leakCheckMode: string;
  /**
   * The screen policy. A suite screened against sonnet-5 is not the same suite
   * as one screened against haiku-4.5, and an unscreened suite is neither.
   */
  nullScreen: {
    enabled: boolean;
    model: string | null;
    maxTokens: number;
    effort: string;
    dropOnCold: boolean;
  };
}

/** sha256 over canonical JSON of tasks + generator config + seed (DESIGN 17). */
export function computeSuiteHash(
  tasks: readonly FitnessTask[],
  generator: GeneratorConfig,
  seed: number,
): string {
  return sha256Hex(canonicalJson({ generator, seed, tasks }));
}

/**
 * The hash of a POOLED suite: the original suite plus every extension batch the
 * pre-registered protocol consumed.
 *
 * It is deliberately NOT `computeSuiteHash(pooledTasks, generator, seed)`: the
 * pooled set was produced by several generator configs (one per derived seed),
 * and stamping one config over all of them would claim a provenance the run does
 * not have. The preimage is the lineage itself, so the hash changes when the
 * original changes, when a batch changes, or when the pooled task list changes,
 * and any reader holding suite-meta.json can recompute it.
 */
export function computePooledSuiteHash(input: {
  originalSuiteHash: string;
  batchSuiteHashes: readonly (string | null)[];
  tasks: readonly FitnessTask[];
}): string {
  return sha256Hex(
    canonicalJson({
      kind: 'fitness-report.pooled-suite/1',
      originalSuiteHash: input.originalSuiteHash,
      batchSuiteHashes: input.batchSuiteHashes,
      tasks: input.tasks,
    }),
  );
}

/**
 * The CONTENT identity of a task, for pool dedupe across extension batches.
 *
 * WHY IT IS NOT THE ID. The extension protocol prefixes every batch task with a
 * deterministic `e<index>-`, which is exactly what keeps two tasks from sharing
 * a correlation id, and it is also what makes a restated task invisible: a
 * generator asked a second time for six tasks will happily hand back a task the
 * pool already holds, `t3` becomes `e1-t3`, no id collides, and the pooled n
 * grows by a trial that is perfectly correlated with one already counted. A
 * pooled denominator built that way is not a denominator.
 *
 * THE KEY, exactly: canonical JSON (keys sorted, so the ordering of the check
 * object cannot change the key) over three fields.
 *   - `prompt`: the RENDERED prompt, whitespace runs collapsed to one space,
 *     trimmed and case folded. Two statements of one task differ by spacing and
 *     capitalisation at most; anything past that is a different task.
 *   - `expectedTools`: de-duplicated and sorted, because [a,b] and [b,a] name
 *     the same solution.
 *   - `check`: verbatim. A different success predicate is a different trial
 *     even over the same prompt.
 *
 * `answerKey` is deliberately absent: two tasks that pose the same question
 * with the same predicate are the same trial, and if their keys disagree then
 * one of them is wrong, which is not a reason to count both.
 *
 * Collisions fail SAFE. A false match drops a batch task (recorded, with its
 * own reason), which shrinks a batch; it can never inflate a pooled count.
 */
export function taskContentKey(task: Pick<FitnessTask, 'prompt' | 'expectedTools' | 'check'>): string {
  return canonicalJson({
    kind: 'fitness-report.task-content/1',
    prompt: task.prompt.replace(/\s+/g, ' ').trim().toLowerCase(),
    expectedTools: [...new Set(task.expectedTools)].sort(),
    check: task.check,
  });
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

/**
 * Params that end in a handle-shaped suffix and are NOT handles.
 *
 * Two families. Credential-shaped names were always here. Pagination and
 * correlation cursors are v2 (over-breadth fix): `next_token`, `cursor` and
 * `request_id` end in a handle suffix, so v1 classified them as handles, and on
 * any surface carrying one cursor plus one create/add/open/start-prefixed tool
 * the lone-producer fallback then FABRICATED a chain, after which
 * `chainExpectedTools` either prepends a wrong producer or drops the task as
 * `unchained-handle`. Measured live: aws-knowledge advertises
 * `aws___get_regional_availability.next_token`; huggingface advertises
 * `hub_repo_details.repo_ids`. DESIGN decision 6 already records the same
 * over-broad-name mistake in the redactor ("key-name redaction destroys legit
 * args like `page_token`"). A missed chain costs one repaired task; a fabricated
 * chain costs a whole task plus a wrong finding.
 */
const HANDLE_DENYLIST = new Set([
  'api_key',
  'apikey',
  'auth_token',
  'access_token',
  'bearer_token',
  'secret_key',
  'session_token',
  // pagination and correlation cursors (v2)
  'next_token',
  'page_token',
  'continuation_token',
  'pagination_token',
  'cursor',
  'next_cursor',
  'page_cursor',
  'request_id',
  'trace_id',
  'correlation_id',
  'idempotency_key',
  'sort_key',
  'partition_key',
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
      // v2 (over-breadth fix): the entity token must MATCH. v1 also accepted
      // "there is exactly one producer on this surface", which turns any
      // handle-suffixed param on a one-producer surface into a fabricated chain.
      const chosen = byEntity.length === 1 ? byEntity[0] : undefined;
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
 * Letters and digits only. v1 normalized whitespace and case and nothing else,
 * so a prompt that handed the agent `https://www.rfc-editor.org/rfc/rfc2616.txt`
 * did not "contain" the answer key `RFC 2616` and the task was admitted. It was
 * one of only three tasks that survived on exa. Measured over all 113 admitted
 * tasks in the v1 sweep: whitespace-only normalization catches 0 leaks, this
 * one catches 4.
 */
export function squashForLeak(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does `haystack` contain `phrase`?
 *
 * Long keys match on the squashed form, which is punctuation-insensitive and
 * therefore catches `rfc2616` inside a URL. Short keys ("307", "63", "1536" are
 * all real answer keys in the v1 sweep) squash to digit runs that appear inside
 * unrelated numbers, so they must match on a WORD BOUNDARY of the
 * whitespace-normalized text instead. Tightening in the long-key direction,
 * false-positive protection in the short-key direction.
 */
function containsPhrase(haystack: string, phrase: string, minSquashed: number): boolean {
  const squashedPhrase = squashForLeak(phrase);
  if (squashedPhrase.length < minSquashed) return false;
  if (squashedPhrase.length >= SHORT_KEY_BOUNDARY_LENGTH) {
    return squashForLeak(haystack).includes(squashedPhrase);
  }
  const normalized = normalizeForLeak(haystack);
  const needle = normalizeForLeak(phrase);
  if (needle.length === 0) return false;
  const boundary = new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}($|[^a-z0-9])`);
  return boundary.test(normalized);
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
  return out.filter((t) => squashForLeak(t).length >= MIN_LEAK_TOKEN_LENGTH);
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
export function findAnswerLeak(
  task: Pick<FitnessTask, 'prompt' | 'answerKey'>,
  corpus?: LeakScanCorpus,
): string | null {
  return scanAnswerLeak(task, corpus)?.phrase ?? null;
}

/**
 * Extra text the answering model also sees, scanned alongside the prompt.
 *
 * `context` is the measured blind spot: DESIGN decision 17 injects the server's
 * `instructions` string into the runner system prompt, and huggingface's 758
 * -character instructions say "The Hugging Face tools are being used
 * anonymously" while a task's answer key was `anonymous`. The no-tools null
 * model read the answer out of its own system prompt and said so, and the
 * answer_leak gate recorded `leaks: []` because it never looked there. Widening
 * the corpus makes the FREE gate strictly stricter and costs zero tokens.
 */
export interface LeakScanCorpus {
  /** Server instructions and tool descriptions. Prose: longer floor applies. */
  context?: readonly string[];
  /** Bound parameter values, scanned even when the template never renders them. */
  params?: readonly string[];
}

/** `findAnswerLeak` with the location kept, for the drop ledger. */
export function scanAnswerLeak(
  task: Pick<FitnessTask, 'prompt' | 'answerKey'>,
  corpus?: LeakScanCorpus,
): { phrase: string; source: 'prompt' | 'params' | 'context' } | null {
  if (task.answerKey === undefined || task.answerKey === null) return null;
  const phrases = leakTokens(task.answerKey);
  if (phrases.length === 0) return null;

  for (const phrase of phrases) {
    if (task.prompt.length > 0 && containsPhrase(task.prompt, phrase, MIN_LEAK_TOKEN_LENGTH)) {
      return { phrase, source: 'prompt' };
    }
  }
  for (const value of corpus?.params ?? []) {
    for (const phrase of phrases) {
      if (containsPhrase(value, phrase, MIN_LEAK_TOKEN_LENGTH)) return { phrase, source: 'params' };
    }
  }
  for (const text of corpus?.context ?? []) {
    for (const phrase of phrases) {
      // Prose collides by accident far more often than a prompt does, so a
      // context match needs a longer key. A false drop here shrinks a suite
      // that is already fighting for the 8-task floor.
      if (containsPhrase(text, phrase, MIN_CONTEXT_LEAK_TOKEN_LENGTH)) {
        return { phrase, source: 'context' };
      }
    }
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

/**
 * Placeholders the params never bound, still sitting in the rendered prompt.
 *
 * Nothing in v1 checked this: 0 of 113 admitted prompts happened to contain
 * `{{`, so it never bit, and it becomes load-bearing the moment v2's param
 * binding actually works. The structural gate verifies it, deliberately NOT
 * admission: a gate whose property is already enforced at admission measures
 * nothing (structural.ts's own docstring says so).
 */
export function unresolvedPlaceholders(prompt: string): string[] {
  return [...prompt.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)].map((m) => m[1] ?? '');
}

// ---------------------------------------------------------------------------
// Check policy (v2). Every rule here REJECTS a candidate; none admits one that
// v1 would have rejected.
// ---------------------------------------------------------------------------

/**
 * The longest run of literal characters a regex must match.
 *
 * `[0-9]{3,}` (any three digits), `\d+`, `.*` and `\[[a-zA-Z]+\]` (any bracketed
 * word) are all SHAPES: a no-tools model satisfies them by writing plausible
 * prose. All four score 0 to 1 here. `rate-limit-policy` scores 17 and
 * `\b980\b` scores 3.
 */
export function longestLiteralRun(pattern: string): number {
  let best = 0;
  let run = 0;
  const flush = (drop: number): void => {
    const effective = Math.max(0, run - drop);
    if (effective > best) best = effective;
    run = 0;
  };
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      const next = pattern[i + 1];
      if (next === undefined) {
        flush(0);
        break;
      }
      // Class escapes (\d \w \s \b ...) match a SET, not a literal.
      if (/[dDwWsSbBnrtfvux0-9AZzGkpP]/.test(next)) flush(0);
      else run += 1;
      i += 1;
      continue;
    }
    if (ch === '[' || ch === '(' || ch === ')' || ch === '|' || ch === '^' || ch === '$' || ch === '.') {
      flush(0);
      if (ch === '[') {
        const end = pattern.indexOf(']', i + 1);
        i = end < 0 ? pattern.length : end;
      }
      continue;
    }
    if (ch === '?' || ch === '*') {
      // The preceding atom is optional, so it is not guaranteed literal text.
      flush(1);
      continue;
    }
    if (ch === '+') {
      flush(0);
      continue;
    }
    if (ch === '{') {
      const end = pattern.indexOf('}', i + 1);
      const body = end < 0 ? '' : pattern.slice(i + 1, end);
      // `{0,n}` makes the preceding atom optional; any other quantifier still
      // ends the literal run.
      flush(/^0\b/.test(body) ? 1 : 0);
      i = end < 0 ? pattern.length : end;
      continue;
    }
    run += 1;
  }
  flush(0);
  return best;
}

// ---------------------------------------------------------------------------
// Check pattern dialect (the invalid-check collapse)
// ---------------------------------------------------------------------------

/**
 * MEASURED: across the sixteen runs recorded as `fitness-report-generator/2`,
 * 198 of 386 generated candidates were dropped as `invalid-check` with the
 * detail "regex does not compile". 196 of the 198 were `tool_result_matches`,
 * which the system prompt makes REQUIRED whenever the answer lives in a tool
 * result, and which the prompt then described without ever naming the regex
 * dialect the validator would compile it in. Three runs lost 24 of 24
 * candidates, three more kept 1 of 24, and all of them are published as
 * GATE_FAILED or INSUFFICIENT_SURFACE, which reads on the board as a statement
 * about the server.
 *
 * The published ledger recorded the rule and the detail but NOT the pattern, so
 * the exact construct cannot be recovered from our own artifacts. That gap is
 * its own finding and is closed below (`checkPattern` on the drop evidence), so
 * the NEXT run answers the question this one cannot.
 *
 * Two things are fixed here regardless of which construct it was:
 *   1. the generator is told the dialect, in the same section that requires the
 *      check kind (`SYSTEM_PROMPT`);
 *   2. a pattern written in another regex dialect is REPAIRED into ECMAScript
 *      where the translation provably matches the same text, and dropped only
 *      when it does not.
 *
 * THE SAFETY PROPERTY, and it is the reason repair cannot quietly change a
 * measurement: every construct translated here is a byte sequence JavaScript's
 * RegExp parser REJECTS. A pattern that already compiles is therefore returned
 * byte-identical, and no admitted check can change meaning because this code
 * exists. `repairs the dialect only where JavaScript refuses to parse at all`
 * is pinned by test, over the real published corpus.
 */

/**
 * The flags the harness compiles every check pattern with.
 *
 * `src/run/agent.ts` `safeRegex()` compiles both `regex` and
 * `tool_result_matches` patterns with `i` and nothing else. Generation-time
 * validation uses the same string so a pattern can never compile in one place
 * and fail in the other.
 */
export const CHECK_PATTERN_FLAGS = 'i';

/** Named in the generator prompt so the model is not guessing. */
export const CHECK_PATTERN_DIALECT =
  'ECMAScript (JavaScript RegExp source), compiled with the i flag already applied';

/**
 * Inline flag letters that have an exact ECMAScript translation.
 *   i: the runtime compiles with `i` unconditionally, so an `(?i)` is already
 *      in force over the whole pattern and removing it cannot change a match.
 *   s: dot-all, translated by rewriting every unescaped `.` outside a character
 *      class to `[\s\S]`, which is what dot-all means.
 *   m: multiline `^`, translated to `(?:^|(?<=\n))`. PCRE and Python both make
 *      `^` match at the start and after a `\n` under this flag, so the rewrite
 *      is exact. A multiline `$` is NOT translated: the three dialects disagree
 *      about whether it matches before a trailing newline, so no rewrite can be
 *      shown to match the same text and the candidate is dropped instead.
 */
const REPAIRABLE_INLINE_FLAGS = new Set(['i', 's', 'm']);

/** The outcome of translating one pattern into the dialect the harness compiles. */
export interface PatternRepair {
  /** The ECMAScript pattern, or null when no exact translation exists. */
  pattern: string | null;
  /** Constructs translated, de-duplicated, in the order they were met. */
  repaired: readonly string[];
  /** Why no exact translation exists. Present exactly when `pattern` is null. */
  blockedBy?: string;
}

/**
 * Constructs from other regex dialects, named so a drop can be argued with.
 * Consulted ONLY after the ECMAScript parser has already refused the pattern,
 * so a probe that over-matches can mislabel a failure but can never cause one.
 */
const FOREIGN_CONSTRUCTS: readonly { name: string; probe: RegExp }[] = [
  { name: 'scoped inline flag group such as (?i-s:...)', probe: /\(\?[A-Za-z]*-[A-Za-z]*[:)]/ },
  { name: 'inline flag group such as (?i) or (?x)', probe: /\(\?[A-Za-z]+\)/ },
  { name: 'atomic group (?>...)', probe: /\(\?>/ },
  { name: 'conditional group (?(...)...)', probe: /\(\?\(/ },
  { name: 'subroutine or recursion call such as (?R) or (?1)', probe: /\(\?(?:R\)|[0-9]+\)|&[A-Za-z_])/ },
  { name: 'Python subroutine call (?P>name)', probe: /\(\?P>/ },
  { name: 'possessive quantifier such as .*+ or a++', probe: /(?:[*+?]|\{[0-9]+(?:,[0-9]*)?\})\+/ },
];

function describeUncompilable(pattern: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const found = FOREIGN_CONSTRUCTS.find((c) => c.probe.test(pattern));
  return found === undefined ? message : `${found.name} is not ECMAScript syntax (${message})`;
}

/**
 * Translate a check pattern into the dialect the harness compiles, or explain
 * why it cannot be translated.
 *
 * Repairs (each one a sequence ECMAScript cannot parse, so each one is a
 * no-op on a pattern that already compiles):
 *   `(?i)` anywhere        -> removed; the runtime already applies `i`
 *   leading `(?s)`/`(?m)`  -> removed, with `.` or `^` rewritten to match
 *   `(?P<name>` / `(?'name'` -> `(?<name>`
 *   `(?P=name)`            -> `\k<name>`
 *   `(?#comment)`          -> removed; a comment matches nothing
 *
 * Everything else is copied verbatim and handed to a real RegExp constructor.
 * An atomic group, a possessive quantifier or a verbose-mode `(?x)` pattern has
 * no ECMAScript form that matches the same text, so it is not guessed at: the
 * candidate is dropped and the construct is named in the ledger.
 */
export function repairPattern(pattern: string): PatternRepair {
  const repaired: string[] = [];
  const note = (what: string): void => {
    if (!repaired.includes(what)) repaired.push(what);
  };

  let body = pattern;
  let dotAll = false;
  let multiline = false;

  // A LEADING run of inline flag groups. Only a leading run is repaired: every
  // other dialect scopes a mid-pattern flag group to the rest of the pattern,
  // and honouring that scope is a rewrite we cannot prove. `(?i)` is the one
  // exception and it is handled in the scan below, because the compiled regex
  // is case insensitive whether the group is there or not.
  for (;;) {
    const head = /^\(\?([A-Za-z]+)\)/.exec(body);
    if (head === null) break;
    const letters = [...head[1]!];
    if (!letters.every((f) => REPAIRABLE_INLINE_FLAGS.has(f))) break;
    for (const f of letters) {
      if (f === 's') dotAll = true;
      if (f === 'm') multiline = true;
    }
    note(`inline flag group (?${head[1]!})`);
    body = body.slice(head[0].length);
  }

  const out: string[] = [];
  let inClass = false;
  let blocked: string | undefined;
  let i = 0;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === '\\') {
      // Copy the escape pair verbatim, including a lone trailing backslash,
      // which the constructor will reject on its own terms.
      out.push(body.slice(i, i + 2));
      i += 2;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === '.' && dotAll) {
      out.push('[\\s\\S]');
      note('dot-all `.` rewritten as [\\s\\S]');
      i += 1;
      continue;
    }
    if (ch === '^' && multiline) {
      out.push('(?:^|(?<=\\n))');
      note('multiline `^` rewritten as (?:^|(?<=\\n))');
      i += 1;
      continue;
    }
    if (ch === '$' && multiline) {
      blocked =
        'multiline `$` has no ECMAScript translation that provably matches the same text: PCRE, ' +
        'Python and JavaScript disagree about whether it matches before a trailing newline';
      break;
    }
    if (ch === '(' && body.startsWith('(?', i)) {
      if (body.startsWith('(?P<', i)) {
        out.push('(?<');
        note('Python named group (?P<name>...)');
        i += 4;
        continue;
      }
      if (body.startsWith('(?P=', i)) {
        const end = body.indexOf(')', i + 4);
        if (end < 0) {
          blocked = 'unterminated (?P=name) backreference';
          break;
        }
        out.push(`\\k<${body.slice(i + 4, end)}>`);
        note('Python named backreference (?P=name)');
        i = end + 1;
        continue;
      }
      if (body.startsWith("(?'", i)) {
        const end = body.indexOf("'", i + 3);
        if (end < 0) {
          blocked = "unterminated (?'name') group";
          break;
        }
        out.push(`(?<${body.slice(i + 3, end)}>`);
        note("Perl named group (?'name'...)");
        i = end + 1;
        continue;
      }
      if (body.startsWith('(?#', i)) {
        const end = body.indexOf(')', i + 3);
        if (end < 0) {
          blocked = 'unterminated (?#comment)';
          break;
        }
        note('inline comment (?#...)');
        i = end + 1;
        continue;
      }
      const flags = /^\(\?([A-Za-z]+)\)/.exec(body.slice(i));
      if (flags !== null && flags[1] === 'i') {
        note('inline flag group (?i)');
        i += flags[0].length;
        continue;
      }
      out.push(ch);
      i += 1;
      continue;
    }
    out.push(ch);
    i += 1;
  }

  if (blocked !== undefined) return { pattern: null, repaired, blockedBy: blocked };

  const candidate = out.join('');
  try {
    // A REAL RegExp constructor, at generation time, on the exact string the
    // runtime will compile. A pattern that cannot compile is now caught where
    // it is written, not where it is used.
    new RegExp(candidate, CHECK_PATTERN_FLAGS);
  } catch (error) {
    return { pattern: null, repaired, blockedBy: describeUncompilable(candidate, error) };
  }
  return { pattern: candidate, repaired };
}

/** A pattern that compiled, with the repairs that got it there. */
export type CompiledCheckPattern =
  | { ok: true; regex: RegExp; pattern: string; repaired: readonly string[] }
  | { ok: false; detail: string; repaired: readonly string[] };

/**
 * Repair, then compile with a real RegExp constructor. The single entry point
 * for every pattern-bearing check, so no path can admit a pattern that has not
 * been compiled.
 */
export function compileCheckPattern(pattern: string): CompiledCheckPattern {
  const repair = repairPattern(pattern);
  if (repair.pattern === null) {
    return {
      ok: false,
      detail: repair.blockedBy ?? 'pattern is not a valid ECMAScript regular expression',
      repaired: repair.repaired,
    };
  }
  return {
    ok: true,
    regex: new RegExp(repair.pattern, CHECK_PATTERN_FLAGS),
    pattern: repair.pattern,
    repaired: repair.repaired,
  };
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
        required: [
          'id',
          'promptTemplate',
          'params',
          'expectedTools',
          'check',
          'answerKey',
          'destructive',
          // v2: the model must NAME the reason the server is required. A task
          // that cannot name one is a task about the model.
          'serverRequiredBecause',
        ],
        properties: {
          id: { type: 'string' },
          promptTemplate: { type: 'string' },
          serverRequiredBecause: { type: 'string', enum: [...SERVER_REQUIREMENTS] },
          /** Error-path probes are the one honest use of a `tool_called`-only check. */
          errorPath: { type: 'boolean' },
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

/**
 * GENERATOR v2 system prompt.
 *
 * Every banned clause names a family MEASURED in the v1 sweep, not an
 * abstraction. Clause 1 kills coingecko's four date/year tasks; clause 2 kills
 * all 12 astro tasks and 10 svelte tasks (the answers were `client:only`,
 * `PUBLIC_`, `$derived.by`); clause 3 kills nine huggingface tasks (BERT's
 * vocab_size); clause 4 kills the task whose answer key was `anonymous` while
 * the server's own instructions said the tools are used anonymously; clause 5
 * kills the two context7 tasks whose answer was a naming convention.
 *
 * A prohibition list is enforced by the same model that violated it, so this
 * prompt only raises the prior. The NULL SCREEN is the enforcement.
 */
export const SYSTEM_PROMPT = [
  'You generate evaluation tasks for an MCP (Model Context Protocol) server.',
  '',
  'The ONLY thing these tasks measure is whether an agent can get a job done WITH THIS SERVER',
  'that it could not get done WITHOUT it. A task a competent model answers correctly from memory,',
  'with no tools at all, measures the model and is worthless. Assume the model reading your task',
  'is a frontier model with broad knowledge of public documentation, public APIs, famous entities',
  'and standard library names.',
  '',
  'BANNED TASK SHAPES. Do not emit any of these, ever:',
  '1. Historical constants and founding facts: genesis dates, launch years, block times, release dates.',
  '2. Well-known API surface names: directive names, rune names, decorator names, class names, config',
  '   keys, CLI verbs, import specifiers, documentation URL paths. If the answer is a name a working',
  '   developer could recall, it is banned.',
  '3. Attributes of famous entities: the contract address of a top-10 NFT collection, the vocab_size',
  '   of BERT, the row count of a standard benchmark dataset.',
  "4. Anything stated in the server's own instructions string, which the answering model is also given.",
  '5. Anything whose answer is a deterministic function of the prompt: an identifier scheme such as',
  '   /org/repo, a naming convention, a pluralisation of a word already in the prompt.',
  '',
  'REQUIRED TASK SHAPES. Every task must declare serverRequiredBecause, exactly one of:',
  'volatile - the answer changes on a timescale of days or less: a current price, a current count,',
  '  a latest version, a live rank, an open item count.',
  'long-tail - the answer is a field of a SPECIFIC low-popularity entity that appears in the',
  '  grounding evidence below, not one you recalled.',
  'server-minted - the answer is an artifact this server creates (a generated URL, a session handle,',
  '  a rendered id) and cannot exist before the call.',
  'verbatim-quote - the answer is a contiguous span of at least 12 words copied out of a specific',
  '  document this server returns.',
  'cross-reference - the answer requires joining two live lookups whose join key is not memorable,',
  '  and neither half alone is sufficient.',
  '',
  'GROUNDING. Build tasks out of what the tool surface and any grounding evidence below actually',
  'show. Do not invent entity ids, file paths, repository names or record keys: an id you guessed',
  'will 404, and a task that fails for that reason tells us nothing about the server. When you need',
  'a long-tail entity, take one from the tail of a grounded listing, never from your own memory.',
  '',
  'CHECKS. The check decides success by machine. Choose in this order:',
  '1. tool_result_matches - REQUIRED whenever the answer appears in a tool result. It is the only',
  '   check a no-tools model cannot pass by writing prose. The pattern must be SPECIFIC to the',
  '   correct arguments: a pattern that any result of that tool would contain is invalid, because a',
  '   caller passing nonsense arguments would also match it.',
  '2. tool_called - only as a secondary constraint, never as the whole check.',
  '3. regex or substring on final_text - only when the answer cannot be located in a tool result.',
  '   The literal must be at least 4 characters, must contain a literal run of at least 3',
  '   characters, and must not appear anywhere in the rendered prompt.',
  '4. judge - last resort, at most 1 per suite.',
  "A check that a model could satisfy while explicitly saying 'I cannot verify this' is a broken",
  'check. Prefer checks a hedge cannot satisfy.',
  '',
  'REGEX DIALECT. Every pattern, in a regex check and in a tool_result_matches check alike, is',
  "compiled by JavaScript's RegExp constructor with the i flag already applied. Matching is already",
  'case insensitive: never ask for it. Write ECMAScript syntax and nothing else. Do NOT use inline',
  'flag groups such as (?i), (?s), (?m) or (?x); atomic groups (?>...); possessive quantifiers such',
  'as .*+ or a++; inline comments (?#...); Python named groups (?P<name>...); conditionals; or',
  'recursion. Write [\\s\\S] where another dialect would write a dot under the s flag, and \\n where',
  'it would rely on multiline anchors. A pattern that does not compile is dropped, and that drop is',
  'a defect in this generator, never a finding about the server.',
  '',
  'ANSWER KEYS. The answerKey is the fact the agent must discover by CALLING tools. It must never',
  'appear, in whole or in part, in the rendered prompt, in the tool descriptions, or in the server',
  'instructions.',
  '',
  'UNCHANGED RULES. Every task must be solvable with the advertised tools alone; never invent a',
  'tool. Write the prompt as a template with {{placeholders}} and supply the bound params;',
  'placeholders carry inputs the agent is GIVEN, never the answer. On stateful surfaces, chain',
  'handles: if a tool consumes an id or handle, the task must also expect the tool that creates it,',
  'listed first in expectedTools. Set destructive:true when a correct solution requires a tool that',
  'writes, deletes, sends or transfers; when a tool carries no annotations, assume it is destructive.',
  'Vary difficulty: single-call lookups, multi-call chains, and at least one task that requires',
  'choosing between two similar tools.',
  '',
  'Generate 2x the requested count. A separate screening step runs every candidate past a model with',
  'no tools and deletes every candidate it answers correctly, so over-generate and expect roughly',
  'half to be deleted.',
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

/** v2: ask for `max(target * factor, MIN_OVER_GENERATION)` candidates. */
export function overGeneratedTarget(target: number, factor: number): number {
  return Math.max(Math.ceil(target * factor), MIN_OVER_GENERATION);
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
    'destructive (boolean), serverRequiredBecause (one of: ' + SERVER_REQUIREMENTS.join(', ') + '),',
    'and errorPath (boolean, true only when the task deliberately probes an error path).',
  );
  return parts.join('\n');
}

function buildRepairPrompt(offenders: readonly { task: RawTask; phrase: string }[]): string {
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
        // `leakedPhrase`, never `leakedToken`: this string is quoted back into a
        // prompt we may publish, and the redactor erases `token`-named fields.
        leakedPhrase: o.phrase,
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
  /**
   * Wire shape is an ARRAY of {name, value} (the structured-output schema cannot
   * express an open string map). The legacy record shape is still accepted.
   */
  params?: unknown;
  expectedTools?: unknown;
  check?: unknown;
  answerKey?: unknown;
  destructive?: unknown;
  serverRequiredBecause?: unknown;
  errorPath?: unknown;
}

/**
 * The ONE param binder.
 *
 * PROVEN v1 BUG: the pre-repair leak scan called a `normalizeParams` that did
 * `Object.entries(params)` and kept only string/number/boolean values, while
 * `params` on the wire is an array of {name, value} OBJECTS. Every value failed
 * the typeof guard, so the scan rendered the template with NO bindings, saw no
 * leak, and skipped the one regeneration attempt DESIGN 11 guarantees. The
 * post-validation check then dropped the same task with reason `answer-leak`,
 * with zero repair attempts. All 15 sweep runs show `leaksFoundAtGeneration: []`
 * and `regenerationAttempted: false` over 180 candidates: the exact signature.
 * Both call sites now use this function, so they can never disagree again.
 */
export function bindParams(params: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (name: unknown, value: unknown): void => {
    if (typeof name !== 'string' || name.length === 0) return;
    if (typeof value === 'string') out[name] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[name] = String(value);
    else if (typeof value === 'boolean') out[name] = String(value);
  };
  if (Array.isArray(params)) {
    for (const entry of params as readonly unknown[]) {
      if (entry && typeof entry === 'object') {
        const { name, value } = entry as { name?: unknown; value?: unknown };
        put(name, value);
      }
    }
    return out;
  }
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params as Record<string, unknown>)) put(k, v);
  }
  return out;
}

function textOf(message: Anthropic.Message): string {
  const chunks: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text' && typeof block.text === 'string') chunks.push(block.text);
  }
  return chunks.join('\n').trim();
}

export interface ParsedTaskPayload {
  tasks: RawTask[];
  /**
   * Array entries that were not objects and were discarded. v1 dropped them
   * BEFORE `generated` was taken, so a malformed entry vanished from both the
   * numerator and the denominator: an unrecorded loss.
   */
  entriesDiscarded: number;
}

/** Tolerant JSON extraction: bare JSON, fenced JSON, or JSON with prose around it. */
export function parseTaskPayload(text: string): ParsedTaskPayload {
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
    const tasks = list.filter((t): t is RawTask => !!t && typeof t === 'object') as RawTask[];
    return { tasks, entriesDiscarded: list.length - tasks.length };
  }
  throw new TaskSynthesisError('unparseable', 'judge response contained no task JSON');
}

async function askJudge(
  client: JudgeClient,
  opts: SynthesizeOptions,
  userPrompt: string,
): Promise<ParsedTaskPayload> {
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
  let message = await judgeMessage(client, params);
  if (message.stop_reason === 'refusal') {
    throw new TaskSynthesisError('refusal', 'judge model refused to generate the task suite');
  }
  // Adaptive thinking on a hard generation prompt can consume the entire token
  // ceiling before any text block exists (observed live: three consecutive
  // "judge returned no text" failures against real servers, stop_reason
  // max_tokens, all output spent on thinking). One retry with thinking off is
  // a delivery fallback, not a model swap: same model, same prompt, same
  // schema, so the pinned-generator discipline holds.
  if (textOf(message).length === 0 && message.stop_reason === 'max_tokens') {
    const { thinking: _dropped, ...rest } = params;
    message = await judgeMessage(client, rest as Anthropic.MessageCreateParamsNonStreaming);
    if (message.stop_reason === 'refusal') {
      throw new TaskSynthesisError('refusal', 'judge model refused to generate the task suite');
    }
  }
  const text = textOf(message);
  if (text.length === 0) {
    throw new TaskSynthesisError(
      'empty',
      `judge returned no text (stop_reason: ${String(message.stop_reason)})`
    );
  }
  return parseTaskPayload(text);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** One pattern rewritten out of a foreign regex dialect into ECMAScript. */
interface CheckPatternRepair {
  /** The pattern exactly as the generator wrote it. */
  from: string;
  /** The pattern the suite will carry and the runner will compile. */
  to: string;
  /** The constructs translated, named for the ledger. */
  constructs: readonly string[];
}

/** A check either survives the policy or names the rule that rejected it. */
type CheckVerdict =
  | { ok: true; check: TaskCheck; patternRepair?: CheckPatternRepair }
  | {
      ok: false;
      reason: DropReason;
      detail: string;
      /**
       * Set when the pattern compiled only after a dialect repair and a LATER
       * rule then rejected it. The ledger carries both forms, because the rule
       * judged the repaired one and the generator wrote the other.
       */
      repairedPattern?: string;
    };

interface CheckPolicyContext {
  surface: ReadonlySet<string>;
  /** The RENDERED prompt: a check the prompt already satisfies is not a check. */
  prompt: string;
  /** True when the task declares itself an error-path probe. */
  errorPath: boolean;
  /** Judge rubrics already admitted to this suite. */
  judgeCount: number;
}

/**
 * v2 check policy. Every branch here is a TIGHTENING of v1; nothing that v1
 * rejected is accepted now.
 *
 * The two structural rules (`where === 'final_text'`, `surface.has(tool)`) are
 * unchanged and stay validity-protecting. The new rules all answer one
 * question: can a model with no server satisfy this predicate by construction?
 *   - `[0-9]{3,}` was admitted on convex and is satisfied by any three digits.
 *   - `\[[a-zA-Z]+\]` was admitted on context7 and is satisfied by any bracketed
 *     word.
 *   - `/colinhacks/zod|/zod|zod` was admitted on context7 and its third branch
 *     is satisfied by echoing a token the prompt itself supplied.
 *   - two deepwiki tasks were `tool_called`-only, which the stubbed-empty and
 *     random-valid-args null models pass without answering anything.
 */
function validateCheck(raw: unknown, ctx: CheckPolicyContext): CheckVerdict {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'invalid-check', detail: 'no machine-checkable success predicate' };
  }
  const c = raw as Record<string, unknown>;
  switch (c.kind) {
    case 'substring': {
      if (c.where !== 'final_text' || typeof c.value !== 'string' || c.value.length === 0) {
        return { ok: false, reason: 'invalid-check', detail: 'substring check has no final_text value' };
      }
      if (c.value.trim().length < MIN_SUBSTRING_CHECK_LENGTH) {
        return {
          ok: false,
          reason: 'check-too-permissive',
          detail: `substring check ${JSON.stringify(c.value)} is under ${String(MIN_SUBSTRING_CHECK_LENGTH)} characters`,
        };
      }
      if (containsPhrase(ctx.prompt, c.value, 1)) {
        return {
          ok: false,
          reason: 'check-matches-prompt',
          detail: `the rendered prompt already contains the check literal ${JSON.stringify(c.value)}`,
        };
      }
      return { ok: true, check: { kind: 'substring', where: 'final_text', value: c.value } };
    }
    case 'regex': {
      if (c.where !== 'final_text' || typeof c.pattern !== 'string' || c.pattern.length === 0) {
        return { ok: false, reason: 'invalid-check', detail: 'regex check has no final_text pattern' };
      }
      const compiled = compileCheckPattern(c.pattern);
      if (!compiled.ok) {
        return {
          ok: false,
          reason: 'invalid-check',
          detail: `regex does not compile: ${compiled.detail}`,
        };
      }
      // Everything downstream measures the REPAIRED pattern, because that is
      // the string the runner will compile. Judging the shape of the original
      // and then evaluating the replacement would be two different checks.
      const pattern = compiled.pattern;
      const run = longestLiteralRun(pattern);
      if (run < MIN_REGEX_LITERAL_RUN) {
        return {
          ok: false,
          reason: 'check-too-permissive',
          detail: `regex ${JSON.stringify(pattern)} has a longest literal run of ${String(run)}, so it matches a shape rather than an answer`,
          ...(pattern === c.pattern ? {} : { repairedPattern: pattern }),
        };
      }
      // Alternation is covered for free: a compiled pattern matches the prompt
      // when ANY of its branches does.
      if (ctx.prompt.length > 0 && compiled.regex.test(ctx.prompt)) {
        return {
          ok: false,
          reason: 'check-matches-prompt',
          detail: `regex ${JSON.stringify(pattern)} is satisfied by the rendered prompt itself`,
          ...(pattern === c.pattern ? {} : { repairedPattern: pattern }),
        };
      }
      return {
        ok: true,
        check: { kind: 'regex', where: 'final_text', pattern },
        ...(pattern === c.pattern
          ? {}
          : { patternRepair: { from: c.pattern, to: pattern, constructs: compiled.repaired } }),
      };
    }
    case 'tool_called': {
      if (typeof c.tool !== 'string' || !ctx.surface.has(c.tool)) {
        return { ok: false, reason: 'invalid-check', detail: 'tool_called names a tool that is not on the surface' };
      }
      if (!ctx.errorPath) {
        return {
          ok: false,
          reason: 'check-too-permissive',
          detail:
            'tool_called is the whole check, which measures nothing about the answer and is passed by the ' +
            'stubbed-empty and random-valid-args null models. Allowed only on a declared error-path probe.',
        };
      }
      return { ok: true, check: { kind: 'tool_called', tool: c.tool } };
    }
    case 'tool_result_matches': {
      if (typeof c.tool !== 'string' || !ctx.surface.has(c.tool)) {
        return { ok: false, reason: 'invalid-check', detail: 'tool_result_matches names a tool that is not on the surface' };
      }
      if (typeof c.pattern !== 'string' || c.pattern.length === 0) {
        return { ok: false, reason: 'invalid-check', detail: 'tool_result_matches has no pattern' };
      }
      const compiled = compileCheckPattern(c.pattern);
      if (!compiled.ok) {
        return {
          ok: false,
          reason: 'invalid-check',
          detail: `regex does not compile: ${compiled.detail}`,
        };
      }
      const pattern = compiled.pattern;
      const run = longestLiteralRun(pattern);
      if (run < MIN_REGEX_LITERAL_RUN) {
        return {
          ok: false,
          reason: 'check-too-permissive',
          detail: `tool_result_matches pattern ${JSON.stringify(pattern)} has a longest literal run of ${String(run)}, so any result of that tool would satisfy it`,
          ...(pattern === c.pattern ? {} : { repairedPattern: pattern }),
        };
      }
      return {
        ok: true,
        check: { kind: 'tool_result_matches', tool: c.tool, pattern },
        ...(pattern === c.pattern
          ? {}
          : { patternRepair: { from: c.pattern, to: pattern, constructs: compiled.repaired } }),
      };
    }
    case 'judge': {
      if (typeof c.rubric !== 'string' || c.rubric.trim().length === 0) {
        return { ok: false, reason: 'invalid-check', detail: 'judge check has no rubric' };
      }
      if (ctx.judgeCount >= MAX_JUDGE_CHECKS_PER_SUITE) {
        return {
          ok: false,
          reason: 'check-too-permissive',
          detail: `judge rubrics are capped at ${String(MAX_JUDGE_CHECKS_PER_SUITE)} per suite; this suite already has one`,
        };
      }
      return { ok: true, check: { kind: 'judge', rubric: c.rubric } };
    }
    default:
      return { ok: false, reason: 'invalid-check', detail: 'no machine-checkable success predicate' };
  }
}

/**
 * The check, flattened into ledger evidence.
 *
 * Reads the RAW candidate, not the validated one, because most drops happen
 * before a validated check exists. Every field is optional and only present
 * when the candidate actually carried it, so nothing is invented (a `judge`
 * rubric is deliberately left out: it is prose, it is not what any of these
 * rules rejected, and it is the one check field that can run long).
 */
function checkEvidence(raw: unknown): {
  checkKind: string;
  checkPattern?: string;
  checkValue?: string;
  checkTool?: string;
} {
  const c = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    checkKind: typeof c['kind'] === 'string' ? c['kind'] : 'none',
    ...(typeof c['pattern'] === 'string' ? { checkPattern: c['pattern'] } : {}),
    ...(typeof c['value'] === 'string' ? { checkValue: c['value'] } : {}),
    ...(typeof c['tool'] === 'string' ? { checkTool: c['tool'] } : {}),
  };
}

/** The same flattening for a check that already passed validation. */
function checkEvidenceOf(check: TaskCheck): ReturnType<typeof checkEvidence> {
  return checkEvidence(check);
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
  /** Prose the answering model also reads: instructions + tool descriptions. */
  contextCorpus: readonly string[];
  /** Judge rubrics admitted so far, for the one-per-suite cap. */
  judgeCount: number;
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
  const excerpt = (text: string): string => text.slice(0, 200);
  if (ctx.seen.has(id)) {
    ctx.dropped.push({ id, reason: 'duplicate-id', detail: 'a task with this id was already admitted' });
    return null;
  }

  const template = typeof raw.promptTemplate === 'string' && raw.promptTemplate.length > 0
    ? raw.promptTemplate
    : typeof raw.prompt === 'string'
      ? raw.prompt
      : '';
  const params = bindParams(raw.params);
  const prompt = renderPrompt(template, params).trim();
  if (prompt.length === 0) {
    ctx.dropped.push({ id, reason: 'malformed', detail: 'empty rendered prompt' });
    return null;
  }

  const expectedListed = Array.isArray(raw.expectedTools)
    ? raw.expectedTools.filter((t): t is string => typeof t === 'string')
    : [];
  // A repeated tool name is sloppiness, not invalidity: normalize it here and
  // record the repair. Refusing a whole server row over a duplicated string
  // would be a false refusal, and a false refusal is worse than no row.
  const expectedRaw = [...new Set(expectedListed)];
  if (expectedRaw.length !== expectedListed.length) {
    ctx.repairs.push({
      id,
      kind: 'expected-tools-dedupe',
      detail: `removed ${String(expectedListed.length - expectedRaw.length)} duplicate expectedTools entries`,
    });
  }
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
      evidence: { expectedTools: expectedRaw, unknownTools: unknown, promptExcerpt: excerpt(prompt) },
    });
    return null;
  }

  // v2: the model must name the reason the SERVER is needed. This is a
  // declaration, not a proof (the null screen is the proof), but a candidate
  // that cannot even claim one is a task about the model.
  const requirement = raw.serverRequiredBecause;
  if (typeof requirement !== 'string' || !(SERVER_REQUIREMENTS as readonly string[]).includes(requirement)) {
    ctx.dropped.push({
      id,
      reason: 'no-server-requirement',
      detail: `serverRequiredBecause must be one of ${SERVER_REQUIREMENTS.join(', ')}; got ${JSON.stringify(requirement)}`,
      evidence: { promptExcerpt: excerpt(prompt) },
    });
    return null;
  }

  // The leak check runs BEFORE the check policy on purpose. A prompt that
  // states its own answer usually also carries a check literal the prompt
  // satisfies, and `answer-leak` is the root defect while `check-matches-prompt`
  // is only its symptom. The ledger must name the defect, not the symptom.
  //
  // The corpus is wider than v1's: bound param VALUES (scanned even when the
  // template never renders them) and the prose the answering model also reads,
  // which is the server `instructions` string DESIGN 17 injects plus every tool
  // description.
  const leak = scanAnswerLeak(
    { prompt, ...(raw.answerKey === undefined || raw.answerKey === null ? {} : { answerKey: raw.answerKey }) },
    { context: ctx.contextCorpus, params: Object.values(params) },
  );
  if (leak !== null) {
    ctx.dropped.push(
      leak.source === 'prompt'
        ? {
            id,
            reason: 'answer-leak',
            detail: `answer key phrase ${JSON.stringify(leak.phrase)} appears in the rendered prompt`,
            evidence: { phrase: leak.phrase, promptExcerpt: excerpt(prompt) },
          }
        : {
            id,
            reason: 'context-answer-leak',
            detail:
              leak.source === 'context'
                ? `answer key phrase ${JSON.stringify(leak.phrase)} appears in the server instructions or a tool description, which the answering model is also given`
                : `answer key phrase ${JSON.stringify(leak.phrase)} is a bound input parameter, so the task hands the agent its own answer`,
            evidence: { phrase: leak.phrase, promptExcerpt: excerpt(prompt) },
          },
    );
    return null;
  }

  const verdict = validateCheck(raw.check, {
    surface: ctx.surface,
    prompt,
    errorPath: raw.errorPath === true,
    judgeCount: ctx.judgeCount,
  });
  if (!verdict.ok) {
    ctx.dropped.push({
      id,
      reason: verdict.reason,
      detail: verdict.detail,
      // The predicate that did the rejecting, verbatim. Without it a reader
      // holding the published record cannot tell a broken check from a
      // correctly refused one.
      evidence: {
        ...checkEvidence(raw.check),
        ...(verdict.repairedPattern === undefined
          ? {}
          : { checkPatternRepaired: verdict.repairedPattern }),
        promptExcerpt: excerpt(prompt),
      },
    });
    return null;
  }
  const check = verdict.check;
  if (verdict.patternRepair !== undefined) {
    const { from, to, constructs } = verdict.patternRepair;
    ctx.repairs.push({
      id,
      kind: 'check-pattern-dialect',
      detail:
        `translated ${constructs.join(', ')} into ECMAScript: ${JSON.stringify(from)} became ` +
        `${JSON.stringify(to)}`,
    });
  }
  if (check.kind === 'judge') ctx.judgeCount += 1;

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
// Null screen (v2): the empirical half of null-hard generation
// ---------------------------------------------------------------------------

/**
 * Is this check even screenable by a tool-less probe?
 *
 * `tool_called` and `tool_result_matches` resolve against `ctx.calls`, which is
 * EMPTY for a model with no tools, so they are structurally unpassable and a
 * cold probe would only ever produce a false negative. They are kept, unscreened
 * and marked `screenable: false`, rather than silently counted as "survived".
 */
function screenableKind(check: TaskCheck, hasJudge: boolean): boolean {
  switch (check.kind) {
    case 'substring':
    case 'regex':
      return true;
    case 'judge':
      return hasJudge;
    default:
      return false;
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      const item = items[i];
      if (item === undefined) return;
      out[i] = await worker(item, i);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Ask a COLD, tool-less model every candidate and report which ones it got
 * right. This is the only step in the pipeline that measures null-passability
 * BEFORE the cheap and paid tiers are paid for.
 *
 * Deliberately stricter than the run-time no-tools null model in three ways:
 * it forbids hedging (four measured v1 null-passes were scored on text that
 * openly disclaimed the answer), it withholds the server instructions (a
 * measured leak channel), and it decides with the task's OWN predicate through
 * `evaluateCheck`, so the screen and the gate can never disagree about what
 * "passing" means.
 *
 * It is NOT a gate and it never touches one: screened-out candidates never
 * enter the suite, so they never enter the null_baseline denominator. The gate
 * still runs its three null models over 100 percent of the admitted suite. A
 * suite can pass this screen and still be killed by the gate, which is the
 * intended direction.
 */
export async function runNullScreen(
  tasks: readonly FitnessTask[],
  screen: NullScreenOptions,
): Promise<NullScreenResult> {
  const client = screen.client;
  if (client === undefined || tasks.length === 0) {
    return {
      enabled: false,
      model: null,
      screened: 0,
      dropped: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      records: tasks.map((task) => ({
        taskId: task.id,
        checkKind: task.check.kind,
        screenable: false,
        coldPassed: null,
      })),
    };
  }

  const hasJudge = typeof screen.judge === 'function';
  const records: NullScreenRecord[] = await mapWithConcurrency<FitnessTask, NullScreenRecord>(
    tasks,
    screen.concurrency ?? DEFAULT_SCREEN_CONCURRENCY,
    async (task): Promise<NullScreenRecord> => {
    const base = { taskId: task.id, checkKind: task.check.kind } as const;
    if (!screenableKind(task.check, hasJudge)) {
      return { ...base, screenable: false, coldPassed: null };
    }
    try {
      const message = await client.messages.create({
        model: screen.model,
        max_tokens: screen.maxTokens ?? DEFAULT_SCREEN_MAX_TOKENS,
        system: NULL_SCREEN_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: task.prompt }],
        output_config: { effort: screen.effort ?? 'low' },
      });
      const coldAnswer = textOf(message);
      const passed = await evaluateCheck(
        task.check,
        { finalText: coldAnswer, calls: [] },
        task,
        screen.judge,
      );
      const usage = message.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      return {
        ...base,
        screenable: true,
        coldPassed: passed,
        coldAnswerExcerpt: coldAnswer.slice(0, SCREEN_EXCERPT_CHARS),
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
      };
    } catch (error) {
      // A probe that failed is NOT evidence that the task is null-hard, and it
      // is not evidence that it is null-easy either. The candidate is kept and
      // the failure is recorded, never swallowed.
      return {
        ...base,
        screenable: true,
        coldPassed: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    },
  );

  return {
    enabled: true,
    model: screen.model,
    screened: records.filter((r) => r.screenable && r.error === undefined).length,
    dropped: records.filter((r) => r.coldPassed === true).length,
    errors: records.filter((r) => r.error !== undefined).length,
    inputTokens: records.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0),
    outputTokens: records.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0),
    records,
  };
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
  const overGenerationFactor = opts.overGenerationFactor ?? DEFAULT_OVER_GENERATION_FACTOR;
  // v2: ask for more than we need. The screen deletes a large fraction of the
  // candidates, and asking for exactly the target guarantees a refusal that the
  // generator, not the server, earned.
  const requested = overGeneratedTarget(target, overGenerationFactor);

  const first = await askJudge(client, opts, buildGenerationPrompt(opts, index, chains, requested));
  const raw = first.tasks;
  const emitted = raw.length;
  let entriesDiscarded = first.entriesDiscarded;

  // FREE gate, at generation time: the answer key may not be in the rendered
  // prompt. Offenders get one regeneration pass, then they are dropped.
  const leaksFound: AnswerLeak[] = [];
  const offenders: { task: RawTask; phrase: string }[] = [];
  for (const [i, task] of raw.entries()) {
    const rendered = renderPrompt(
      typeof task.promptTemplate === 'string' ? task.promptTemplate : (task.prompt ?? ''),
      bindParams(task.params),
    );
    const leak = scanAnswerLeak(
      { prompt: rendered, answerKey: task.answerKey },
      { params: Object.values(bindParams(task.params)) },
    );
    if (leak !== null) {
      const id = slugId(task.id, i);
      leaksFound.push({ taskId: id, phrase: leak.phrase, source: leak.source });
      offenders.push({ task, phrase: leak.phrase });
    }
  }

  let candidates = raw;
  let rewritten = 0;
  let regenerationAttempted = false;
  const repairs: TaskRepair[] = [];
  if (offenders.length > 0) {
    regenerationAttempted = true;
    let rewrites: RawTask[] = [];
    try {
      const repaired = await askJudge(client, opts, buildRepairPrompt(offenders));
      rewrites = repaired.tasks;
      entriesDiscarded += repaired.entriesDiscarded;
      // NOT added to `generated`: a rewrite REPLACES an offender. v1's
      // `generated += rewrites.length` inflated the admission-rate denominator
      // and would have manufactured `admission_rate_below_minimum` refusals the
      // moment the leak detector started firing.
      rewritten = rewrites.length;
    } catch {
      // A failed repair pass is not fatal: the offenders simply stay dropped.
      rewrites = [];
    }
    const byId = new Map<string, RawTask>();
    for (const [i, r] of rewrites.entries()) byId.set(slugId(r.id, i), r);
    // Positional pairing is the fallback for a rewrite that came back with a
    // blank id: v1 keyed such a rewrite as `task-<rewriteIndex>`, which never
    // matched the offender's `task-<originalIndex>`, so the offender silently
    // reverted to its leaking original and was dropped while
    // `regenerationAttempted` still reported true. Positional pairing is only
    // trusted when the counts line up, and the ledger records which way it went.
    const positional = rewrites.length === offenders.length;
    const offenderOrder = new Map(offenders.map((o, i) => [o.task, i]));
    candidates = raw.map((task, i) => {
      const offenderIndex = offenderOrder.get(task);
      if (offenderIndex === undefined) return task;
      const id = slugId(task.id, i);
      const byIdMatch = byId.get(id);
      const replacement = byIdMatch ?? (positional ? rewrites[offenderIndex] : undefined);
      if (replacement === undefined) return task;
      repairs.push({
        id,
        kind: 'answer-leak-rewrite',
        detail: 'replaced a prompt that stated its own answer key',
        matchedBy: byIdMatch === undefined ? 'position' : 'id',
      });
      return { ...replacement, id: task.id };
    });
  }

  const ctx: ValidationContext = {
    index,
    surface,
    chains,
    excludeDestructive,
    seen: new Set<string>(),
    dropped: [],
    repairs,
    // DESIGN 17 injects `instructions` into the answering model, and tool
    // descriptions ride along with every tool definition, so both are corpora
    // the answer key may not appear in.
    contextCorpus: [
      ...(opts.instructions && opts.instructions.trim().length > 0 ? [opts.instructions] : []),
      ...opts.tools.map((t) => t.description ?? '').filter((d) => d.length > 0),
    ],
    judgeCount: 0,
  };

  // `validateTask` runs the leak check on the FINAL rendered prompt itself, so
  // an offender that still leaks after its one regeneration is dropped there,
  // exactly once, and every candidate lands in exactly one bucket.
  const validated: FitnessTask[] = [];
  for (const [i, candidate] of candidates.entries()) {
    const task = validateTask(candidate, i, ctx);
    if (task !== null) validated.push(task);
  }

  // v2 NULL SCREEN. Runs after validation (so it only pays for candidates that
  // could have been admitted) and before the suite hash (so what it deleted was
  // never part of any suite).
  const screenOpts = opts.nullScreen;
  const nullScreen = await runNullScreen(validated, screenOpts ?? { model: '' });
  const dropOnCold = screenOpts?.dropOnCold !== false;
  const coldById = new Map(nullScreen.records.map((r) => [r.taskId, r]));
  const screened: FitnessTask[] = [];
  for (const task of validated) {
    const record = coldById.get(task.id);
    if (nullScreen.enabled && dropOnCold && record?.coldPassed === true) {
      ctx.dropped.push({
        id: task.id,
        reason: 'null_screen',
        detail:
          'a model with no tools at all answered this correctly, so it measures the model rather than the server',
        evidence: {
          // The predicate the cold answer was graded against, alongside the
          // cold answer itself. A screen drop is decided by our own check, so
          // the check has to be readable from the record that reports it.
          ...checkEvidenceOf(task.check),
          promptExcerpt: task.prompt.slice(0, 200),
          ...(record.coldAnswerExcerpt === undefined
            ? {}
            : { coldAnswerExcerpt: record.coldAnswerExcerpt.slice(0, 200) }),
        },
      });
      ctx.seen.delete(task.id);
      continue;
    }
    screened.push(task);
  }

  // Over-generation can leave more valid tasks than the operator asked to drive.
  // The surplus is NOT a drop (nothing is wrong with those tasks), so it is
  // counted separately and the accounting still reconciles.
  const tasks = screened.slice(0, target);
  const trimmed = screened.length - tasks.length;

  const generator: GeneratorConfig = {
    generatorVersion: GENERATOR_VERSION,
    synthesizerVersion: SYNTHESIZER_VERSION,
    generatorModel,
    serverSlug: opts.serverSlug,
    targetTaskCount: target,
    minTasks,
    excludeDestructive,
    toolSurfaceDigest: toolSurfaceDigest(opts.tools),
    instructionsDigest:
      opts.instructions && opts.instructions.length > 0 ? sha256Hex(opts.instructions) : null,
    effort: opts.effort ?? 'high',
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    overGenerationFactor,
    checkPolicyVersion: CHECK_POLICY_VERSION,
    leakCheckMode: LEAK_CHECK_MODE,
    nullScreen: {
      enabled: nullScreen.enabled,
      model: nullScreen.enabled ? (screenOpts?.model ?? null) : null,
      maxTokens: screenOpts?.maxTokens ?? DEFAULT_SCREEN_MAX_TOKENS,
      effort: screenOpts?.effort ?? 'low',
      dropOnCold,
    },
  };

  const suite: TaskSuite = {
    serverSlug: opts.serverSlug,
    // `suite-meta.json` is an OUTPUT and never an input here: folding the ledger
    // into the hash would make the hash circular.
    suiteHash: computeSuiteHash(tasks, generator, opts.seed),
    generatorModel,
    seed: opts.seed,
    tasks,
  };

  const candidateCount = candidates.length;
  const accounted = tasks.length + ctx.dropped.length + trimmed;

  return {
    suite,
    insufficient: tasks.length < minTasks,
    minTasks,
    generated: emitted,
    emitted,
    rewritten,
    candidates: candidateCount,
    entriesDiscarded,
    admitted: tasks.length,
    trimmed,
    // Published even when it fails: a wrong admission rate that nobody can see
    // is worse than one the record admits it cannot reconcile.
    reconciles: accounted === candidateCount,
    shortfall: candidateCount - accounted,
    dropped: ctx.dropped,
    repairs: ctx.repairs,
    handleChains: chains,
    regenerationAttempted,
    leaksFound,
    nullScreen,
    generator,
    surface: { toolCount: opts.tools.length, toolNames: opts.tools.map((t) => t.name) },
  };
}

// ---------------------------------------------------------------------------
// Extension batches (the pre-registered extension protocol)
// ---------------------------------------------------------------------------

/**
 * The derived seed for one extension batch.
 *
 * `seed + 1000 * index`, with `index` 1-BASED, because a 0-based index would
 * hand extension 1 the original suite's own seed and the generator would be
 * asked to produce the batch it already produced. The offset of 1000 keeps the
 * derived seeds of two runs one apart (seed 1 and seed 2) from colliding for any
 * plausible number of extensions.
 *
 * Deterministic on purpose: the batch a run bought is reproducible from the run
 * record alone, which is the whole point of pre-registering the protocol.
 */
export function extensionSeed(baseSeed: number, extensionIndex: number): number {
  if (!Number.isInteger(extensionIndex) || extensionIndex < 1) {
    throw new RangeError(`extensionSeed: extensionIndex must be an integer >= 1, got ${String(extensionIndex)}`);
  }
  return baseSeed + 1000 * extensionIndex;
}

export interface ExtensionBatchOptions extends Omit<SynthesizeOptions, 'seed' | 'targetTaskCount' | 'minTasks'> {
  /** The run's registered seed. The batch seed is derived from it, never reused. */
  baseSeed: number;
  /** 1-based index of this extension. */
  extensionIndex: number;
  /** `extensionSize` from the pre-registration. Both the target and the floor. */
  extensionSize: number;
}

/**
 * Generate ONE extension batch.
 *
 * Same generator version, same prompt, same check policy, same null screen, same
 * tool surface: the only registered thing that moves is the seed, which is
 * derived, and the size, which is `extensionSize` rather than the run's target.
 * That makes a batch comparable to the suite it extends, which is what pooling
 * counts across the two requires.
 *
 * `minTasks` is set to `extensionSize` so `insufficient` on the result means
 * exactly one thing: THIS BATCH CAME BACK SHORT. A short batch is not an error
 * and is never retried (a retry would be optional stopping by another name); the
 * caller uses whatever survived and records the shortfall.
 */
export async function synthesizeExtensionBatch(
  client: JudgeClient,
  opts: ExtensionBatchOptions,
): Promise<SynthesisResult> {
  const { baseSeed, extensionIndex, extensionSize, ...rest } = opts;
  if (!Number.isInteger(extensionSize) || extensionSize < 1) {
    throw new RangeError(`synthesizeExtensionBatch: extensionSize must be an integer >= 1, got ${String(extensionSize)}`);
  }
  return synthesizeTaskSuite(client, {
    ...rest,
    seed: extensionSeed(baseSeed, extensionIndex),
    targetTaskCount: extensionSize,
    minTasks: extensionSize,
  });
}
