#!/usr/bin/env node
/**
 * `fitness-report run <url>` (DESIGN decision 11: the gate-ordered pipeline).
 *
 *   FREE   protocol probes, task synthesis, structural, answer leak, suite size,
 *          plan and power
 *   CHEAP  null model baselines (no tools, stubbed empty, random valid args)
 *   PAID   construct (reference agent with full information)
 *   DRIVE  the scored run
 *
 * Everything before the drive is there to earn the right to publish a number.
 * When a gate refuses, the report JSON has NO `score` field and the markdown
 * renders the refusal AS the result.
 *
 * RECORDING. Both planes are opened only once the suite hash exists, because
 * DESIGN decision 5 puts `suiteHash` in `producer.configHash` on the meta line.
 * Frames observed before that (the handshake, every probe) are buffered with
 * their real observed timestamps and flushed in order the moment the tapes
 * open, so nothing is lost and nothing is re-clocked.
 *
 * CORRELATION. The scored drive stamps `corr_id = taskId` exactly. The null
 * baselines and the construct reference pass stamp `<taskId>::<phase>`, so
 * their real wire traffic stays in the recording (a tape that hid it would be a
 * lie) while the scorer reads only the frames the scored drive produced.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';

import { DEFAULT_MAX_ERROR_RATE, construct, type ConstructReason } from './gates/construct.js';
import { plan, publishedVerdict, verdict, type PublishedVerdict } from './gates/gates.js';
import { explainNulls, nullBaselineGate } from './gates/nulls.js';
import { explainStructural, structural } from './gates/structural.js';
import { connect, McpConnectError, stripCredentials, type McpConnection } from './mcp/connect.js';
import { runProbes } from './mcp/probes.js';
import { buildReport, defaultMethodsNotes, renderMarkdown, viewerUrl } from './report/render.js';
import {
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_RUNNER_MODEL,
  MIN_TASK_BUDGET_TOKENS,
  driveRandomArgsBaseline,
  driveSuite,
  driveTask,
  type JudgeCheck,
  type RunnerClient
} from './run/agent.js';
import { computeScore, type RunnerTaskOutcome, type ToolDescriptor } from './score/metrics.js';
import {
  computeTraceStats,
  estimateCostUsd,
  resolvePrice,
  type TraceRecord
} from './score/stats.js';
import { redactReport, redactTape, scrubSecrets } from './tape/redact.js';
import { TapeWriter } from './tape/writer.js';
import {
  DEFAULT_JUDGE_MODEL,
  MIN_VIABLE_TASKS,
  computePooledSuiteHash,
  extensionSeed,
  findAnswerLeak,
  synthesizeExtensionBatch,
  synthesizeTaskSuite,
  taskContentKey,
  unresolvedPlaceholders,
  type JudgeClient,
  type LeakScanCorpus,
  type SynthesisResult
} from './tasks/synthesize.js';
import type {
  ExtensionEvidence,
  ExtensionPolicy,
  ExtensionViolation,
  FitnessReportJson,
  FitnessTask,
  GateId,
  GateOutcome,
  GateRecord,
  JudgePhase,
  JudgeUsageBlock,
  PooledCounts,
  ProbeResults,
  RunOutcome,
  ServerIdentity,
  TapeEventLine,
  TapeLine,
  TapeMessageLine,
  TaskSuite,
  Verdict
} from './types.js';

const HARNESS_VERSION = '0.1.0';
const SOURCE = `fitness-report@${HARNESS_VERSION}`;
const DEFAULT_PUBLISH_BASE = 'https://fitnessreport.dev';

/**
 * THE PRE-REGISTRATION. Persisted into the run record BEFORE the first model
 * call (DESIGN decision 11) and never read from a flag: an extension policy the
 * operator could turn up after seeing a verdict is optional stopping wearing a
 * constant's clothes.
 *
 * evalgate doctrine, quoted verbatim in src/gates/gates.ts: "EXTEND is not a
 * loophole. The extension size and the maximum number of extensions are fixed in
 * the pre-registration alongside n; after the last extension an unresolved gate
 * resolves to FAIL." METHODS: "No optional stopping. A run completes its
 * registered size or is void."
 *
 * What this pipeline now performs, in full:
 *   - construct returns EXTEND (under_resolved) and an extension remains
 *     -> synthesize `extensionSize` NEW tasks with the same generator and a
 *        DERIVED seed, put them through the same free gates and the same null
 *        baselines, run construct on the NEW tasks at the SAME reps, POOL k and
 *        n, and re-apply the rule to the pooled counts.
 *   - after `maxExtensions`, an unresolved gate resolves to FAIL.
 * A regenerated task suite outside this protocol is a NEW run, never a retry.
 *
 * Frozen, and no flag, option or environment variable reaches it: a policy any
 * code path could raise after seeing a verdict is optional stopping wearing a
 * constant's name.
 */
export const EXTENSION_POLICY: ExtensionPolicy = Object.freeze({ extensionSize: 6, maxExtensions: 2 });

/** The construct gate's registered threshold and alpha (DESIGN decision 11). */
const CONSTRUCT_MIN_RATE = 0.9;
const CONSTRUCT_ALPHA = 0.05;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export interface CliOptions {
  url: string;
  authToken?: string;
  pin?: string;
  out?: string;
  runner: string;
  judge: string;
  maxTasks?: number;
  seed: number;
  taskBudget: number;
  maxIterations: number;
  constructReps: number;
  /** Run the drive even after a refusal, purely to record evidence. */
  evidenceDrive: boolean;
  skipProbes: boolean;
  publishBase: string;
  timeoutMs?: number;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const args = [...argv];
  if (args[0] === 'run') args.shift();
  const url = args.shift();
  if (url === undefined || url.startsWith('--')) {
    throw new Error('usage: fitness-report run <url> [--auth-token T] [--pin 2026-07-28] [--out DIR] [--runner MODEL] [--max-tasks N]');
  }

  const opts: CliOptions = {
    url,
    runner: DEFAULT_RUNNER_MODEL,
    judge: DEFAULT_JUDGE_MODEL,
    seed: 1,
    taskBudget: MIN_TASK_BUDGET_TOKENS,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    constructReps: 1,
    evidenceDrive: false,
    skipProbes: false,
    publishBase: DEFAULT_PUBLISH_BASE
  };

  while (args.length > 0) {
    const flag = args.shift() as string;
    const value = (): string => {
      const v = args.shift();
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--auth-token': opts.authToken = value(); break;
      case '--pin': opts.pin = value(); break;
      case '--out': opts.out = value(); break;
      case '--runner': opts.runner = value(); break;
      case '--judge': opts.judge = value(); break;
      case '--cheap': opts.runner = 'claude-haiku-4-5'; break;
      case '--max-tasks': opts.maxTasks = Number.parseInt(value(), 10); break;
      case '--seed': opts.seed = Number.parseInt(value(), 10); break;
      case '--task-budget': opts.taskBudget = Number.parseInt(value(), 10); break;
      case '--max-iterations': opts.maxIterations = Number.parseInt(value(), 10); break;
      case '--construct-reps': opts.constructReps = Number.parseInt(value(), 10); break;
      case '--evidence-drive': opts.evidenceDrive = true; break;
      case '--skip-probes': opts.skipProbes = true; break;
      case '--publish-base': opts.publishBase = value(); break;
      case '--timeout-ms': opts.timeoutMs = Number.parseInt(value(), 10); break;
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Frame buffering
// ---------------------------------------------------------------------------

/**
 * One line waiting for the tapes to open. The union keeps message and event
 * lines in ONE queue so the flush preserves the order they were observed in;
 * two queues would file every pre-suite event after every pre-suite frame.
 */
type BufferedLine =
  | { type: 'message'; line: TapeMessageLine }
  | { type: 'event'; line: TapeEventLine };

/**
 * Holds wire frames until the tapes can be opened with the suite hash, then
 * writes straight through. Also keeps every frame in memory as a TraceRecord:
 * DESIGN decision 6 scores from PRE-redaction records, and re-reading the
 * redacted publish copy would corrupt legitimate arguments like `page_token`.
 */
class FrameRecorder {
  private buffered: BufferedLine[] = [];
  private writer: TapeWriter | undefined;
  readonly records: TraceRecord[] = [];

  /**
   * INTEGRATION FIX: the two sides of this seam name directions differently,
   * and getting it wrong is silent.
   *
   *   src/mcp/connect.ts `FrameHook` uses TRANSPORT direction:
   *     'out' = we sent it (the request), 'in' = we received it (the response).
   *   docs/format.md line 45 uses TAPE direction:
   *     'in'  = client to server (the REQUEST), 'out' = server to client.
   *
   * They are exact opposites. Written through unchanged, every tools/call
   * request lands as `dir:"out"`, and both mcp-tape's `buildMcpPairs` and our
   * own port of it only register requests on `dir:"in"`. The tape still looks
   * complete, `mcp-tape stats` still parses it, and every per-tool metric reads
   * zero while the scorer quietly falls back to the agent plane. Verified on a
   * full canary run before this line existed: `tools: []` from the oracle and a
   * "no tools/call frames on the mcp plane" note in the score.
   *
   * connect.ts keeps its transport semantics (they are documented, internally
   * consistent, and asserted by test/mcp.test.ts). The translation belongs
   * here, at the one place where a frame becomes a tape line.
   */
  private static toTapeDir(transportDir: 'in' | 'out'): 'in' | 'out' {
    return transportDir === 'out' ? 'in' : 'out';
  }

  capture = (dir: 'in' | 'out', raw: unknown, t: string, corrId?: string): void => {
    const tapeDir = FrameRecorder.toTapeDir(dir);
    this.records.push({ t, dir: tapeDir, raw, source: 'fitness-report', ...(corrId === undefined ? {} : { corr_id: corrId }) });
    const line: TapeMessageLine = { t, dir: tapeDir, raw, ...(corrId === undefined ? {} : { corr_id: corrId }) };
    if (this.writer === undefined) {
      this.buffered.push({ type: 'message', line });
      return;
    }
    void this.writer.writeMessage(line);
  };

  /**
   * Harness-native events from the connection (`fitness.http_error`), which is
   * the only account the tape has of a request that died below JSON-RPC.
   *
   * NOT pushed into `records`: that array is the scorer's pairing input, where
   * a `dir:'event'` line would either be ignored or, worse, counted. It reaches
   * `mcpTapeRecords` the same way every other written line does, through the
   * writer's own onFrame tap.
   */
  captureEvent = (kind: string, raw: unknown, t: string, corrId?: string): void => {
    const line: TapeEventLine = { t, dir: 'event', kind, raw, ...(corrId === undefined ? {} : { corr_id: corrId }) };
    if (this.writer === undefined) {
      this.buffered.push({ type: 'event', line });
      return;
    }
    void this.writer.writeEvent(line);
  };

  async attach(writer: TapeWriter): Promise<void> {
    this.writer = writer;
    for (const buffered of this.buffered) {
      if (buffered.type === 'event') await writer.writeEvent(buffered.line);
      else await writer.writeMessage(buffered.line);
    }
    this.buffered = [];
  }
}

/** Mirrors agent-plane turns into memory for the scorer. */
function tappedWriter(records: TraceRecord[]): (line: TapeLine) => void {
  return (line: TapeLine): void => {
    records.push(line as TraceRecord);
  };
}

// ---------------------------------------------------------------------------
// Gate ledger builder
// ---------------------------------------------------------------------------

class Ledger {
  private readonly order: GateId[] = [];
  private readonly records: GateRecord[] = [];
  private _refusedAt: GateId | null = null;

  add(record: GateRecord): void {
    this.order.push(record.gate);
    this.records.push(record);
  }

  refuse(gate: GateId): void {
    if (this._refusedAt === null) this._refusedAt = gate;
  }

  get refusedAt(): GateId | null {
    return this._refusedAt;
  }

  build(extensionPolicy: ExtensionPolicy, extensions: readonly ExtensionEvidence[] = []) {
    return {
      order: [...this.order],
      records: [...this.records],
      extensionPolicy,
      refusedAt: this._refusedAt,
      // Absent rather than empty when nothing was consumed: an empty array reads
      // as "the protocol ran and bought nothing", which is a different claim.
      ...(extensions.length === 0 ? {} : { extensions: [...extensions] })
    };
  }
}

// ---------------------------------------------------------------------------
// Pooled construct math (the extension protocol's arithmetic)
// ---------------------------------------------------------------------------

/** One construct pass: the original suite, or one extension batch. */
export interface ConstructPart {
  n: number;
  nIntended: number;
  errors: number;
}

/**
 * The construct report re-derived over POOLED counts.
 *
 * The three-outcome rule is applied to the pooled k and n, never to a batch on
 * its own and never to an average of rates: pooling is what buys the resolution
 * the extension was purchased for, and re-deciding per batch would be running
 * the test twice. The reason ladder is the same one src/gates/construct.ts
 * uses, in the same order, so a pooled verdict and a single-pass verdict cannot
 * disagree about what a set of counts means.
 *
 * DIVERGENCE 12a travels with the pooling: oracle errors are summed too, and the
 * COMPROMISED check runs on `errors / (n + errors)` over the whole pool.
 */
export interface PooledConstruct {
  k: number;
  n: number;
  errors: number;
  rate: number;
  errorRate: number;
  maxErrorRate: number;
  compromised: boolean;
  verdict: Verdict | null;
  published: PublishedVerdict | null;
  ok: boolean;
  reason: ConstructReason;
  /** Per-pass counts, in the order the passes ran. */
  parts: readonly ConstructPart[];
}

export function poolConstruct(
  parts: readonly ConstructPart[],
  opts: { minRate?: number; alpha?: number; maxErrorRate?: number } = {}
): PooledConstruct {
  const minRate = opts.minRate ?? CONSTRUCT_MIN_RATE;
  const alpha = opts.alpha ?? CONSTRUCT_ALPHA;
  const maxErrorRate = opts.maxErrorRate ?? DEFAULT_MAX_ERROR_RATE;

  let k = 0;
  let n = 0;
  let errors = 0;
  for (const part of parts) {
    k += part.nIntended;
    n += part.n;
    errors += part.errors;
  }

  const attempted = n + errors;
  const errorRate = attempted === 0 ? 0 : errors / attempted;
  const compromised = errorRate > maxErrorRate;
  const v = n > 0 ? verdict(k, n, minRate, alpha) : null;
  const published = n > 0 ? publishedVerdict(k, n, minRate, { alpha }) : null;

  let reason: ConstructReason;
  if (compromised) reason = 'compromised';
  else if (n === 0) reason = 'no_cases';
  else if (v!.outcome === 'PASS') reason = 'ok';
  else if (v!.outcome === 'EXTEND') reason = 'under_resolved';
  else reason = 'below_min_rate';

  return {
    k,
    n,
    errors,
    rate: n === 0 ? 0 : k / n,
    errorRate,
    maxErrorRate,
    compromised,
    verdict: v,
    published,
    ok: reason === 'ok',
    reason,
    parts: [...parts]
  };
}

/**
 * The extension doctrine, as one pure decision.
 *
 * evalgate, quoted in src/gates/gates.ts: "EXTEND is not a loophole. The
 * extension size and the maximum number of extensions are fixed in the
 * pre-registration alongside n; after the last extension an unresolved gate
 * resolves to FAIL."
 *
 * It lives here, exported and side-effect free, because a doctrine expressed as
 * a condition inside a loop is a doctrine nobody can test. Every branch below is
 * a rule from the pre-registration and none of them reads a threshold, a ratio,
 * an alpha or a floor.
 */
export interface ConstructResolution {
  /** Buy another pre-registered extension batch? */
  extend: boolean;
  /** The typed reason string the ledger row carries, rendered verbatim. */
  reason: string;
  /** True once an unresolved gate has resolved to FAIL for want of extensions. */
  resolvedToFail: boolean;
  /** The run outcome a refusal here carries. null = do not rename the outcome. */
  outcome: RunOutcome | null;
}

export function resolveConstruct(input: {
  pooled: Pick<PooledConstruct, 'ok' | 'reason' | 'compromised'>;
  policy: ExtensionPolicy;
  extensionsConsumed: number;
  /** True when an earlier gate already refused, so nothing more may be bought. */
  blocked: boolean;
}): ConstructResolution {
  const { pooled, policy, extensionsConsumed, blocked } = input;

  if (pooled.compromised) {
    return { extend: false, reason: 'compromised', resolvedToFail: false, outcome: 'COMPROMISED' };
  }
  if (pooled.ok) {
    return { extend: false, reason: 'ok', resolvedToFail: false, outcome: null };
  }
  if (pooled.reason !== 'under_resolved') {
    return { extend: false, reason: pooled.reason, resolvedToFail: false, outcome: 'GATE_FAILED' };
  }

  const remaining = policy.maxExtensions - extensionsConsumed;
  if (policy.extensionSize > 0 && remaining > 0 && !blocked) {
    return { extend: true, reason: 'under_resolved', resolvedToFail: false, outcome: null };
  }
  if (blocked && policy.extensionSize > 0 && remaining > 0) {
    // The run cannot publish anyway, so buying resolution for it would spend the
    // paid tier on a number nobody may read. The unspent extensions are recorded
    // rather than quietly consumed.
    return {
      extend: false,
      reason: 'under_resolved_not_extended',
      resolvedToFail: false,
      outcome: null
    };
  }
  if (policy.maxExtensions === 0 || policy.extensionSize === 0) {
    // The pathological pre-registration: there was never an extension to
    // exhaust, so the gate resolved on its first evaluation. This is the ONLY
    // surviving use of EXTEND_EXHAUSTED.
    return { extend: false, reason: 'under_resolved', resolvedToFail: false, outcome: 'EXTEND_EXHAUSTED' };
  }
  // After the last extension, an unresolved gate resolves to FAIL.
  return {
    extend: false,
    reason: 'unresolved_after_max_extensions',
    resolvedToFail: true,
    outcome: 'GATE_FAILED'
  };
}

// ---------------------------------------------------------------------------
// The FREE-tier screen (the registered suite AND every extension batch)
// ---------------------------------------------------------------------------

/** What screening one extension batch decided. */
export interface BatchScreen {
  /** Tasks cleared for pooling. EMPTY when the batch refused. */
  admitted: readonly FitnessTask[];
  /** Non-empty means this run is REFUSED, at the gate each entry names. */
  violations: readonly ExtensionViolation[];
  /** Removals that are NOT refusals. */
  dropped: { admission: number; duplicate: number };
  /** The pooled ids behind those counts, so a drop can be argued with. */
  droppedIds: { admission: readonly string[]; duplicate: readonly string[] };
  /** Tasks that cleared every rule, whether or not the batch was voided. */
  clean: number;
  refused: boolean;
}

export interface FreeGateScreen {
  /** The structural gate's `holds` predicate over the registered suite. */
  admissible(task: FitnessTask): boolean;
  /** The same rules over one bought batch, with their consequences named. */
  screenBatch(input: {
    index: number;
    tasks: readonly FitnessTask[];
    pooled: readonly FitnessTask[];
  }): BatchScreen;
}

/**
 * The free gates, defined ONCE and applied to both kinds of task.
 *
 * SYMMETRY, which is the whole point of this function. The structural gate runs
 * `admissible` over the registered suite, and any task that fails it makes
 * `nHolding !== nGenerated`, which is `property_violated`, which REFUSES the
 * run. The answer-leak gate refuses on any leak in the registered suite. An
 * extension batch used to be filtered by the same predicate with the opposite
 * consequence: a task that leaked its answer key, or that shipped an unbound
 * `{{placeholder}}` to an agent, was counted into a `dropped` tally and deleted
 * without a word, in a batch the run had just spent its paid tier to buy. So the
 * same generator defect refused one run and silently shrank another, and the
 * batch bought precisely to settle a verdict was the one place it could hide.
 *
 * THE RULE, published in METHODS and pinned by test/extension.test.ts:
 *   - answer leak in a batch task            -> REFUSE (extension_answer_leak)
 *   - structural property violated in a task -> REFUSE (extension_structural)
 *   - ordinary admission (unknown tool, no expected tools, missing id) -> DROP
 *   - restates a task already in the pool                              -> DROP
 *   - deleted by the generation-time null screen                       -> DROP
 * The two refusing rules are the ones re-derived from the RENDERED content, and
 * they are the ones that say something about the GENERATOR rather than about
 * this batch's luck. The three dropping rules say a candidate did not fit the
 * surface, or was already counted, and dropping those loses nothing.
 *
 * A refused batch is voided WHOLE. Keeping its clean tasks would be selecting
 * the pool on a defect the same generator produced, which is the sampling bias
 * the extension protocol exists to avoid.
 */
export function freeGateScreen(input: {
  tools: readonly { name: string }[];
  leakCorpus: LeakScanCorpus;
}): FreeGateScreen {
  const known = new Set(input.tools.map((t) => t.name));

  /** Catalog membership. A failure here is an ordinary admission DROP. */
  const admissionValid = (task: FitnessTask): boolean =>
    typeof task.id === 'string' &&
    task.id.length > 0 &&
    task.expectedTools.length > 0 &&
    task.expectedTools.every((t) => known.has(t));

  /**
   * The property, re-derived from the RENDERED content (structural.ts's own
   * docstring: a predicate that re-checks what the generator already guaranteed
   * verifies nothing, because the two agree by construction). An unbound
   * `{{placeholder}}` shipped to an agent is a broken task, and so is an empty
   * prompt. Duplicate tool NAMES are deliberately not here: admission
   * normalizes those, and one repeated string is not worth a refusal.
   */
  const propertyHolds = (task: FitnessTask): boolean =>
    task.prompt.trim().length > 0 && unresolvedPlaceholders(task.prompt).length === 0;

  const leakOf = (task: FitnessTask): string | null => findAnswerLeak(task, input.leakCorpus);

  const admissible = (task: FitnessTask): boolean =>
    admissionValid(task) && propertyHolds(task) && leakOf(task) === null;

  const screenBatch = (batch: {
    index: number;
    tasks: readonly FitnessTask[];
    pooled: readonly FitnessTask[];
  }): BatchScreen => {
    // The `e<index>-` prefix is deterministic and collision-free. A generator
    // asked twice for six tasks will happily mint `t1` twice, and two tasks
    // sharing an id share a corr_id: the tape then merges two different tasks
    // into one decision row and every per-task metric reads the wrong
    // denominator. The batch's own suiteHash covers the UNPREFIXED ids and is
    // recorded beside these, so the lineage stays checkable.
    const ids = new Set(batch.pooled.map((t) => t.id));
    // ... and precisely BECAUSE the prefix makes ids unique, id is useless as a
    // duplicate test. The pool is deduped on CONTENT.
    const keys = new Set(batch.pooled.map((t) => taskContentKey(t)));

    const admitted: FitnessTask[] = [];
    const violations: ExtensionViolation[] = [];
    const admissionIds: string[] = [];
    const duplicateIds: string[] = [];

    for (const task of batch.tasks) {
      const pooledTask: FitnessTask = { ...task, id: `e${String(batch.index)}-${task.id}` };

      const leak = leakOf(pooledTask);
      if (leak !== null) {
        violations.push({
          gate: 'extension_answer_leak',
          reason: 'answer_in_extension_batch',
          extensionIndex: batch.index,
          taskId: pooledTask.id,
          detail:
            `The answer key phrase ${JSON.stringify(leak)} is readable by the answering model, in this task's ` +
            'prompt or in the context it is given. The registered suite refuses on exactly this finding, so a ' +
            'batch bought to resolve a gate does too.'
        });
        continue;
      }
      if (!propertyHolds(pooledTask)) {
        const unbound = unresolvedPlaceholders(pooledTask.prompt);
        violations.push({
          gate: 'extension_structural',
          reason: 'extension_property_violated',
          extensionIndex: batch.index,
          taskId: pooledTask.id,
          detail:
            unbound.length > 0
              ? `The rendered prompt still carries unbound placeholder(s) ${unbound.join(', ')}, so this task was ` +
                'never fully generated. The structural gate refuses on exactly this finding in the registered suite.'
              : 'The rendered prompt is empty, so there is no task here. The structural gate refuses on exactly ' +
                'this finding in the registered suite.'
        });
        continue;
      }
      if (!admissionValid(pooledTask) || ids.has(pooledTask.id)) {
        admissionIds.push(pooledTask.id);
        continue;
      }
      const key = taskContentKey(pooledTask);
      if (keys.has(key)) {
        duplicateIds.push(pooledTask.id);
        continue;
      }
      ids.add(pooledTask.id);
      keys.add(key);
      admitted.push(pooledTask);
    }

    const refused = violations.length > 0;
    return {
      admitted: refused ? [] : admitted,
      violations,
      dropped: { admission: admissionIds.length, duplicate: duplicateIds.length },
      droppedIds: { admission: admissionIds, duplicate: duplicateIds },
      clean: admitted.length,
      refused
    };
  };

  return { admissible, screenBatch };
}

// ---------------------------------------------------------------------------
// Judge spend meter
// ---------------------------------------------------------------------------

interface MeteredCall {
  phase: JudgePhase;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** False when the response carried no `usage` block at all. */
  counted: boolean;
}

/**
 * Every judge-tier exchange, metered at the injectable-client seam.
 *
 * WHY THIS EXISTS. Task synthesis, its retries, every extension batch, the null
 * screen probes and every rubric check touch NEITHER tape: synthesis runs before
 * the suite hash exists (and the tapes cannot open until it does), and the screen
 * and the rubric checks are model calls with no wire traffic at all. So
 * `trace_stats` prices exactly zero of it, and the published cost of a run was
 * the runner's cost with the judge's cost silently missing. DESIGN decision 15
 * says a metric is a finite number or absent, never a wrong one, and a flat
 * per-run guess is a wrong one.
 *
 * WHAT IS NOT METERED HERE. `beta.messages.toolRunner`: those turns are written
 * to the agent plane WITH their usage attached and are priced by `trace_stats`.
 * Counting them again would double the run.
 *
 * The wrapper is structural, so a stub with a two-line `messages.create` keeps
 * working; `stream` is exposed only when the underlying client has it, because
 * `askJudge` picks its path on `typeof client.messages.stream === 'function'`.
 * A response with no `usage` is counted as a CALL and left out of the token
 * totals, with a note. It is never estimated.
 */
export class JudgeMeter {
  private readonly calls: MeteredCall[] = [];
  private failed = 0;

  constructor(
    private readonly inner: JudgeClient,
    private readonly judgeModel: string
  ) {}

  /** A view of the client whose calls are attributed to `phase`. */
  as(phase: JudgePhase): JudgeClient {
    const inner = this.inner;
    const record = (params: Anthropic.MessageCreateParamsNonStreaming, message: Anthropic.Message): void =>
      this.record(phase, params, message);
    const onThrow = (): void => {
      this.failed += 1;
    };

    const messages: JudgeClient['messages'] = {
      async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
        let message: Anthropic.Message;
        try {
          message = await inner.messages.create(params);
        } catch (error) {
          onThrow();
          throw error;
        }
        record(params, message);
        return message;
      }
    };
    const stream = inner.messages.stream;
    if (typeof stream === 'function') {
      messages.stream = (params: Anthropic.MessageCreateParamsNonStreaming) => {
        const handle = stream.call(inner.messages, params);
        return {
          async finalMessage(): Promise<Anthropic.Message> {
            let message: Anthropic.Message;
            try {
              message = await handle.finalMessage();
            } catch (error) {
              onThrow();
              throw error;
            }
            record(params, message);
            return message;
          }
        };
      };
    }
    return { messages };
  }

  private record(
    phase: JudgePhase,
    params: Anthropic.MessageCreateParamsNonStreaming,
    message: Anthropic.Message
  ): void {
    const usage = (message as { usage?: unknown }).usage as
      | {
          input_tokens?: unknown;
          output_tokens?: unknown;
          cache_read_input_tokens?: unknown;
          cache_creation_input_tokens?: unknown;
        }
      | undefined;
    const counted = usage !== undefined && usage !== null && typeof usage === 'object';
    // The RESPONSE names the model that was actually billed, including the dated
    // variant (`<id>-20260514`) the price table already resolves. `params.model`
    // is the fallback, which is what a stub without a model field leaves us.
    const model =
      typeof message.model === 'string' && message.model.length > 0 ? message.model : String(params.model);
    this.calls.push({
      phase,
      model,
      inputTokens: finite(usage?.input_tokens),
      outputTokens: finite(usage?.output_tokens),
      cacheReadTokens: finite(usage?.cache_read_input_tokens),
      cacheCreationTokens: finite(usage?.cache_creation_input_tokens),
      counted
    });
  }

  /** null when this run made no judge call at all: absent, never a zero. */
  summary(): JudgeUsageBlock | null {
    if (this.calls.length === 0 && this.failed === 0) return null;

    const byModelMap = new Map<string, MeteredCall[]>();
    for (const call of this.calls) {
      const list = byModelMap.get(call.model) ?? [];
      list.push(call);
      byModelMap.set(call.model, list);
    }

    const unpriced: string[] = [];
    let total: number | null = null;
    const byModel = [...byModelMap.entries()].map(([model, calls]) => {
      const inputTokens = sum(calls, (c) => c.inputTokens);
      const outputTokens = sum(calls, (c) => c.outputTokens);
      const cacheReadTokens = sum(calls, (c) => c.cacheReadTokens);
      const cacheCreationTokens = sum(calls, (c) => c.cacheCreationTokens);
      const price = resolvePrice(model);
      const estCostUsd = estimateCostUsd(
        {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_input_tokens: cacheReadTokens,
          cache_creation_input_tokens: cacheCreationTokens
        },
        price
      );
      if (price === null) unpriced.push(model);
      if (estCostUsd !== null) total = (total ?? 0) + estCostUsd;
      return {
        model,
        calls: calls.length,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        estCostUsd
      };
    });

    const phases: JudgePhase[] = ['synthesis', 'extension_synthesis', 'null_screen', 'rubric'];
    const byPhase = phases
      .map((phase) => {
        const calls = this.calls.filter((c) => c.phase === phase);
        return {
          phase,
          calls: calls.length,
          inputTokens: sum(calls, (c) => c.inputTokens),
          outputTokens: sum(calls, (c) => c.outputTokens)
        };
      })
      .filter((row) => row.calls > 0);

    const uncountedCalls = this.calls.filter((c) => !c.counted).length;
    const partial = unpriced.length > 0 || uncountedCalls > 0 || this.failed > 0;
    const notes: string[] = [
      'Judge spend is measured from the API usage blocks of the synthesis calls (including retries and every ' +
        'extension batch), the null screen probes and the rubric checks. None of those reach a tape, so this ' +
        'figure is ADDITIVE to the trace_stats cost rather than part of it.'
    ];
    if (unpriced.length > 0) {
      notes.push(
        `No price row for ${[...new Set(unpriced)].join(', ')}: those tokens are counted and their cost is not, ` +
          'so the dollar figure is a lower bound (pricing fails closed).'
      );
    }
    if (uncountedCalls > 0) {
      notes.push(
        `${String(uncountedCalls)} judge response(s) carried no usage block. They are counted as calls and their ` +
          'tokens are left out rather than estimated.'
      );
    }
    if (this.failed > 0) {
      notes.push(
        `${String(this.failed)} judge call(s) threw before returning usage. Whatever they spent is unknowable and ` +
          'is not in this total.'
      );
    }

    return {
      model: this.judgeModel,
      calls: this.calls.length,
      inputTokens: sum(this.calls, (c) => c.inputTokens),
      outputTokens: sum(this.calls, (c) => c.outputTokens),
      cacheReadTokens: sum(this.calls, (c) => c.cacheReadTokens),
      cacheCreationTokens: sum(this.calls, (c) => c.cacheCreationTokens),
      estCostUsd: total,
      partial,
      uncountedCalls,
      failedCalls: this.failed,
      byModel,
      byPhase,
      notes
    };
  }
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function sum<T>(items: readonly T[], of: (item: T) => number): number {
  let total = 0;
  for (const item of items) total += of(item);
  return total;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * Everything the pipeline needs from the Anthropic SDK: the judge surface for
 * synthesis and grading, and the tool-runner surface for the drive. A real
 * `new Anthropic()` satisfies both, and so does a test stub, which is why no
 * test in this repo needs a key or a network.
 */
export type ModelClient = JudgeClient & RunnerClient;

export interface PipelineResult {
  report: FitnessReportJson;
  outDir: string;
  files: {
    reportJson: string;
    reportMd: string;
    mcpTape: string;
    agentTape: string;
    suite: string | null;
    /** `suite-meta.json`, the serialized synthesis ledger. */
    suiteMeta: string | null;
  };
}

export async function runPipeline(opts: CliOptions, deps: {
  anthropic?: ModelClient;
  now?: () => Date;
  log?: (message: string) => void;
} = {}): Promise<PipelineResult> {
  const now = deps.now ?? ((): Date => new Date());
  const log = deps.log ?? ((m: string): void => console.error(m));
  const startedAt = now().toISOString();
  const runId = `${slugOf(opts.url)}-${startedAt.replace(/[:.]/g, '-')}`;
  const outDir = resolve(opts.out ?? join('runs', runId));
  await mkdir(outDir, { recursive: true });

  // The published pre-registration copy is DERIVED from the frozen policy the
  // run persists into its own record, so the sentence a reader sees and the
  // constant the loop obeys cannot drift apart.
  const methods = defaultMethodsNotes(EXTENSION_POLICY);
  const notes: string[] = [];
  const ledger = new Ledger();
  const recorder = new FrameRecorder();
  const agentRecords: TraceRecord[] = [];
  /**
   * Every LINE written to the mcp plane, mirrored in memory: meta, wire frames,
   * `fitness.*` events, end. `recorder.records` holds only the JSON-RPC frames
   * the connection hook saw, which is the right input for SCORING and the wrong
   * one for `trace_stats` (it reported `event: 0` for a tape carrying 93 event
   * lines, contradicting the published file and `mcp-tape stats`).
   */
  const mcpTapeRecords: TraceRecord[] = [];

  const anthropic = deps.anthropic ?? (hasApiKey() ? new Anthropic() : undefined);
  if (anthropic === undefined) {
    notes.push('No ANTHROPIC_API_KEY in the environment. Only the zero-token phases ran.');
  }

  /**
   * Every judge-tier call goes through here, tagged with the phase that made it.
   * The runner loop does NOT: its turns carry their own usage onto the agent
   * plane and are priced by trace_stats, and metering them here would double
   * every token the run spent.
   */
  const meter = anthropic === undefined ? undefined : new JudgeMeter(anthropic, opts.judge);
  /** A phase-tagged view of the judge client. Undefined when no client exists. */
  const judged = (phase: JudgePhase): JudgeClient | undefined => meter?.as(phase);
  const rubricJudge = meter === undefined ? undefined : judgeFor(meter.as('rubric'), opts.judge);

  // -- connect ---------------------------------------------------------------

  log(`connecting to ${stripCredentials(opts.url)}`);
  let conn: McpConnection;
  try {
    conn = await connect({
      url: opts.url,
      ...(opts.authToken === undefined ? {} : { authToken: opts.authToken }),
      ...(opts.pin === undefined ? {} : { pin: opts.pin }),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      onFrame: recorder.capture,
      onEvent: recorder.captureEvent,
      now
    });
  } catch (error) {
    // A handshake that never completed is a run we cannot score and must still
    // report. The buffered frames are the evidence.
    const detail = error instanceof McpConnectError ? JSON.stringify(error.detail) : describe(error);
    return await finish({
      outDir,
      runId,
      startedAt,
      opts,
      server: {
        url: stripCredentials(opts.url),
        slug: slugOf(opts.url),
        era: 'legacy',
        negotiatedVersion: null,
        transportShape: 'json',
        sessionful: false,
        credentialContext: opts.authToken === undefined ? 'anonymous' : 'free-key'
      },
      probes: { specCurrency: null, findings: [] },
      ledgerRecords: [
        {
          gate: 'protocol_hygiene',
          ok: false,
          costTier: 'free',
          reason: 'transport_error',
          detail: { message: describe(error), connectDetail: detail }
        }
      ],
      order: ['protocol_hygiene'],
      refusedAt: 'protocol_hygiene',
      outcome: 'INDETERMINATE',
      suiteHash: 'no-suite',
      recorder,
      agentRecords,
      mcpTapeRecords,
      notes: [...notes, `Could not connect: ${describe(error)}`],
      methods,
      log,
      now,
      endReason: 'transport_error'
    });
  }

  const identity: ServerIdentity = { ...conn.identity, discover: conn.discoverResult };
  log(`connected: era ${identity.era}, negotiated ${identity.negotiatedVersion ?? 'nothing'}`);

  // -- FREE: probes ----------------------------------------------------------

  let probes: ProbeResults = { specCurrency: identity.negotiatedVersion, findings: [] };
  if (!opts.skipProbes) {
    probes = await runProbes(conn);
    const failed = probes.findings.filter((f) => f.pass === false);
    ledger.add({
      gate: 'protocol_hygiene',
      ok: failed.length === 0,
      costTier: 'free',
      reason: failed.length === 0 ? 'ok' : 'hygiene_findings_present',
      detail: {
        note:
          'Protocol hygiene is a reported column, not a refusal. A hygiene failure is a fact about the server, ' +
          'not evidence that this eval is invalid.',
        failed: failed.map((f) => f.id)
      }
    });
  }

  // -- FREE: tool surface and synthesis --------------------------------------

  // INTEGRATION FIX: 'refresh', not 'bypass'. DESIGN decision 8 requires
  // cacheMode discipline, and 'bypass' skips cache WRITES too, which leaves the
  // SDK with no cached tools/list index to validate `structuredContent`
  // against. Verified against the canary's `broken_schema` tool: under 'bypass'
  // a result that violates its own outputSchema comes back clean, so the
  // `schema-validation-reject` class of decision 9 becomes unreachable and a
  // real SERVER finding disappears. 'refresh' gives fresh bytes AND the index.
  // The probes still do their own 'bypass' listing, which is what drift needs.
  const listed = await conn.listTools({ cacheMode: 'refresh' });
  const tools = listed.tools as unknown as ToolDescriptor[];
  log(`tool surface: ${tools.length} tools`);

  let synthesis: SynthesisResult | undefined;
  let synthesisFailure: { kind: string; message: string } | null = null;
  let suite: TaskSuite = {
    serverSlug: identity.slug,
    suiteHash: 'no-suite',
    generatorModel: opts.judge,
    seed: opts.seed,
    tasks: []
  };
  let synthesisEndedAt = startedAt;
  if (anthropic !== undefined) {
    log(`synthesizing tasks with ${opts.judge}`);
    try {
      synthesis = await synthesizeTaskSuite(judged('synthesis')!, {
        serverSlug: identity.slug,
        tools: tools as never,
        instructions: identity.instructions ?? null,
        seed: opts.seed,
        generatorModel: opts.judge,
        ...(opts.maxTasks === undefined ? {} : { targetTaskCount: opts.maxTasks }),
        minTasks: MIN_VIABLE_TASKS,
        // GENERATOR v2 null screen. The screen runs on the RUNNER model, never
        // the judge: the null_baseline gate measures the noise floor with the
        // runner, so screening with anything else lets through exactly the
        // candidates that gate will then kill, after the cheap and paid tiers
        // have already been paid for.
        nullScreen: {
          client: judged('null_screen')!,
          model: opts.runner,
          judge: rubricJudge!
        }
      });
      suite = synthesis.suite;
      log(
        `suite ${suite.suiteHash.slice(0, 12)}: ${suite.tasks.length} admitted of ${synthesis.candidates} candidates ` +
          `(${synthesis.nullScreen.dropped} deleted by the null screen)`
      );
    } catch (error) {
      synthesisFailure = {
        kind: error instanceof Error ? error.name : 'error',
        message: describe(error)
      };
      notes.push(`Task synthesis failed: ${describe(error)}`);
    }
    synthesisEndedAt = now().toISOString();
  }

  // -- open the tapes (the suite hash is the configHash) ---------------------

  const command = ['fitness-report', stripCredentials(opts.url)];
  const mcpTape = await TapeWriter.open({
    path: join(outDir, 'mcp.jsonl'),
    meta: {
      startedAt,
      label: identity.slug,
      command,
      mcpTapVersion: HARNESS_VERSION,
      kind: 'mcp',
      source: SOURCE,
      producer: { name: 'fitness-report', version: HARNESS_VERSION, configHash: suite.suiteHash }
    },
    onFrame: tappedWriter(mcpTapeRecords)
  });
  await recorder.attach(mcpTape);

  const agentTape = await TapeWriter.open({
    path: join(outDir, 'agent.jsonl'),
    meta: {
      startedAt,
      label: identity.slug,
      command,
      mcpTapVersion: HARNESS_VERSION,
      kind: 'llm',
      source: SOURCE,
      producer: { name: 'fitness-report', version: HARNESS_VERSION, configHash: suite.suiteHash }
    },
    onFrame: tappedWriter(agentRecords)
  });

  const gateEvent = async (gate: string, data: unknown): Promise<void> => {
    // `raw` carries the payload of a dir-bearing line (docs/format.md).
    await mcpTape.writeEvent({ t: now().toISOString(), dir: 'event', kind: 'fitness.gate', raw: { gate, ...(data as object) } });
  };

  // -- synthesis evidence ----------------------------------------------------
  //
  // The judge call touches neither plane, so in v1 a refusal that said "12
  // candidates became 5" had no recorded evidence anywhere: SynthesisResult died
  // in this function's local scope and finish() wrote only suite.json. DESIGN
  // decision 20 requires every finding to link to the recorded session that
  // justifies it, so the ledger is serialized to suite-meta.json AND mirrored
  // onto the mcp plane. `dir:'event'` with the payload in `raw` (DESIGN 5 plus
  // the CONTRACT CHANGE note in src/types.ts): never `data`, never 'in'/'out'.
  // No corr_id: this is a suite-level event, not a task-level one.
  const suiteMeta = buildSuiteMeta({
    runId,
    serverSlug: identity.slug,
    suiteHash: suite.suiteHash,
    synthesis,
    failure: synthesisFailure,
    tools
  });
  await mcpTape.writeEvent({
    t: synthesisEndedAt,
    dir: 'event',
    kind: 'fitness.synthesis',
    raw: compactSynthesis(suiteMeta)
  });
  if (synthesis !== undefined) {
    for (const record of synthesis.nullScreen.records) {
      await mcpTape.writeEvent({
        t: synthesisEndedAt,
        dir: 'event',
        kind: 'fitness.null_screen',
        corr_id: `${record.taskId}::screen`,
        raw: record
      });
    }
  }

  // -- FREE: structural, answer leak, suite size, plan and power -------------

  let outcome: RunOutcome = 'SCORED';
  const tasks = suite.tasks;

  /**
   * Everything the ANSWERING model reads besides the prompt. DESIGN decision 17
   * injects `instructions` into the runner system prompt and every tool
   * definition carries its description, so both are places an answer key can
   * leak from without ever touching a prompt.
   */
  const leakCorpus = {
    context: [
      ...(typeof identity.instructions === 'string' && identity.instructions.trim().length > 0
        ? [identity.instructions]
        : []),
      ...tools.map((t) => (typeof t.description === 'string' ? t.description : '')).filter((d) => d.length > 0)
    ]
  };

  /**
   * The FREE-tier rules, in ONE place.
   *
   * The structural gate measures `admissible` over the original suite and every
   * extension batch goes through `screenBatch`, which is built from the same
   * three predicates. Two copies of this rule would let a batch into the pool on
   * terms the original suite never had to meet, and the pooled denominator would
   * then be measuring two different things. `screenBatch` also decides which
   * findings REFUSE and which merely drop; see `freeGateScreen`.
   */
  const freeGates = freeGateScreen({ tools, leakCorpus });
  const admissible = freeGates.admissible;

  if (synthesis === undefined) {
    ledger.add({
      gate: 'structural',
      ok: false,
      costTier: 'free',
      reason: 'no_cases_generated',
      detail: { note: 'No task suite was produced, so nothing downstream can be measured.' }
    });
    ledger.refuse('structural');
    outcome = 'INDETERMINATE';
  } else {
    /**
     * Hoisted ABOVE the structural gate on purpose (v2 fix).
     *
     * `Ledger.refuse` keeps the FIRST gate that refuses, and structural fails
     * with `too_few_generated` whenever the admitted suite is under 8, which is
     * true of every suite the null screen emptied. The screen's own finding
     * therefore never reached a published row: a server whose entire candidate
     * set was answerable with no server at all published as `refusedAt:
     * structural`, reason `too_few_generated`, outcome INSUFFICIENT_SURFACE.
     * That is a statement about the server's SURFACE and it is the wrong one.
     *
     * So the screen's verdict is computed first, and when it explains the
     * shortfall the structural refusal is deferred to `suite_size`, the gate
     * that carries the screen ledger and the attribution string. Structural
     * still records `ok: false` with its own counts; only the attribution
     * moves. A structural failure the screen does NOT explain
     * (`property_violated`: admitted tasks that do not hold) still refuses
     * there, because that is an independent defect.
     */
    const screenDropped = synthesis.nullScreen.dropped;
    const screenScreened = synthesis.nullScreen.screened;
    const bigEnough = tasks.length >= MIN_VIABLE_TASKS && !synthesis.insufficient;
    const nullAnswerable = !bigEnough && screenDropped > 0 && tasks.length + screenDropped >= MIN_VIABLE_TASKS;

    const structuralReport = structural(
      // The generator's own index space does not survive validation, so cases
      // are indexed by ADMISSION order. The counts, which are what the gate
      // measures, are exact either way.
      (seed) => (seed < tasks.length ? tasks[seed] : null),
      admissible,
      // The denominator is the number of candidates that were actually
      // VALIDATED. v1 passed `max(generated, tasks.length)` while `generated`
      // double-counted the repair pass, which understated the admission rate
      // and would have refused runs the generator did not earn. The 0.25 floor
      // and the absolute minimum of 8 are untouched.
      { n: Math.max(synthesis.candidates, tasks.length), minGenerated: MIN_VIABLE_TASKS }
    );
    ledger.add({
      gate: 'structural',
      ok: structuralReport.ok,
      costTier: 'free',
      reason: structuralReport.reason,
      detail: {
        ...structuralReport,
        explain: explainStructural(structuralReport),
        synthesis: compactSynthesis(suiteMeta),
        // The screen counts live in the structural record too, not only nested
        // under `synthesis`, because this is the record whose nRequested and
        // nGenerated a reader will otherwise subtract into a wrong "dropped".
        nullScreenDropped: screenDropped,
        nullScreenScreened: screenScreened,
        note:
          'nRequested is the candidate count the generator actually put through validation. Generator ' +
          `${synthesis.generator.generatorVersion}: v1 and v2 admission rates are not comparable and must never share a table.`
      }
    });
    await gateEvent('structural', { ok: structuralReport.ok, reason: structuralReport.reason });
    if (!structuralReport.ok) {
      // `property_violated` is the generator shipping tasks that do not hold,
      // which the screen cannot explain and which refuses here. Every other
      // structural failure is a COUNT, and a count the screen emptied is
      // attributed to the screen (see the hoist comment above).
      const countFailure = structuralReport.reason !== 'property_violated';
      if (nullAnswerable && countFailure) {
        notes.push(
          `Structural counts are below their floors because the null screen deleted ${screenDropped} of ` +
            `${screenScreened} screened candidates. The refusal is recorded against the suite size gate, ` +
            'which carries that ledger, rather than against structural.'
        );
      } else {
        ledger.refuse('structural');
        outcome = structuralReport.reason === 'too_few_generated' ? 'INSUFFICIENT_SURFACE' : 'GATE_FAILED';
      }
    }

    // `phrase`, not `token`: the publish-time redactor replaces any field
    // literally named `token`, and that would erase the leak evidence this
    // record exists to show.
    const leaks = tasks
      .map((task) => ({ id: task.id, phrase: findAnswerLeak(task, leakCorpus) }))
      .filter((l) => l.phrase !== null);
    ledger.add({
      gate: 'answer_leak',
      ok: leaks.length === 0,
      costTier: 'free',
      reason: leaks.length === 0 ? 'ok' : 'answer_in_prompt',
      detail: {
        leaks,
        regenerationAttempted: synthesis.regenerationAttempted,
        leaksFoundAtGeneration: synthesis.leaksFound,
        // The corpus is wider than v1's. The answering model is given the
        // server `instructions` string (DESIGN 17) and every tool description,
        // so a key that appears there leaks through a channel the v1 scan never
        // read: huggingface's instructions say the tools are used "anonymously"
        // and a task's answer key was `anonymous`. Widening the scan makes this
        // FREE gate strictly stricter and costs zero tokens.
        corpus: ['rendered prompt', 'bound params', 'server instructions', 'tool descriptions'],
        contextLeakDropsAtGeneration: synthesis.dropped.filter((d) => d.reason === 'context-answer-leak').length
      }
    });
    if (leaks.length > 0) {
      ledger.refuse('answer_leak');
      outcome = 'GATE_FAILED';
    }

    // Two different findings hide behind one refusal. "The surface was too small
    // to generate from" is a statement about the SERVER. "Everything we could
    // generate was answerable with no server at all" is a statement about the
    // server's VALUE ADD, and it is arguably the most interesting thing this
    // harness can find. The threshold does not move (both still refuse below 8);
    // only the typed reason distinguishes them, with the screen ledger as its
    // evidence. `bigEnough`, `screenDropped` and `nullAnswerable` are computed
    // above the structural gate so this gate can own the attribution.
    ledger.add({
      gate: 'suite_size',
      ok: bigEnough,
      costTier: 'free',
      reason: bigEnough ? 'ok' : nullAnswerable ? 'all_candidates_null_answerable' : 'below_minimum_suite_size',
      detail: {
        nTasks: tasks.length,
        minTasks: MIN_VIABLE_TASKS,
        toolCount: tools.length,
        nullScreenDropped: screenDropped,
        nullScreenScreened: synthesis.nullScreen.screened,
        note:
          'With a median of 2.5 tools on the open roster, a suite below 8 tasks cannot separate a good server ' +
          'from a lucky one. This refuses rather than publishing a 2-task 100 percent.',
        ...(nullAnswerable
          ? {
              attribution:
                'Enough candidates were generated. They were deleted because a model with no server answered them ' +
                'correctly, so this refusal is about what the server adds, not about how small its surface is. ' +
                'The per-candidate screen verdicts are in suite-meta.json.'
            }
          : {})
      }
    });
    if (!bigEnough) {
      ledger.refuse('suite_size');
      // DEGENERATE, not INSUFFICIENT_SURFACE: a suite the screen emptied is one
      // a null model already answered, which is what DEGENERATE names. Calling
      // it INSUFFICIENT_SURFACE publishes "this server has too few tools" over a
      // server whose tools were never needed.
      if (outcome === 'SCORED') outcome = nullAnswerable ? 'DEGENERATE' : 'INSUFFICIENT_SURFACE';
    }

    const design = plan(0.9, 0.8);
    ledger.add({
      gate: 'plan_power',
      ok: true,
      costTier: 'free',
      reason: tasks.length >= design.n ? 'ok' : 'underpowered_recorded',
      detail: {
        requiredN: design.n,
        actualN: tasks.length,
        threshold: design.threshold,
        detectableRate: design.detectableRate,
        power: design.power,
        note:
          'This does not refuse. It is why a raw PASS below the planned n downgrades to EXTEND under the ' +
          'published-verdict rule.'
      }
    });
  }

  // -- CHEAP: null baselines -------------------------------------------------

  const proceed = (): boolean => ledger.refusedAt === null || opts.evidenceDrive;
  const publishBlocked = (): boolean => ledger.refusedAt !== null;

  let nullSignal: { k: number; n: number } | null = null;
  /**
   * Null counts accumulate ACROSS batches, keyed by null model. An extension
   * task is measured by the same three null models before it can be counted
   * anywhere, so the run-time null gate still sees 100 percent of the suite it
   * is deciding about. A pooled construct numerator over a partially measured
   * noise floor would be comparing a 24-task success rate against a 12-task
   * baseline, which is not a comparison.
   */
  const nullTotals = new Map<string, { k: number; n: number }>();
  const addNull = (label: string, k: number, n: number): void => {
    const current = nullTotals.get(label) ?? { k: 0, n: 0 };
    nullTotals.set(label, { k: current.k + k, n: current.n + n });
  };

  const measureNulls = async (batch: readonly FitnessTask[], seed: number, label: string): Promise<void> => {
    if (batch.length === 0) return;
    const suffix = label.length === 0 ? '' : ` (${label})`;
    if (anthropic !== undefined) {
      for (const [nullModel, toolMode] of [
        ['no-tools', 'none'],
        ['stubbed-empty', 'stub']
      ] as const) {
        let k = 0;
        for (const task of batch) {
          const run = await driveTask(task, {
            corrId: `${task.id}::null-${nullModel}`,
            client: anthropic,
            conn,
            tools,
            model: opts.runner,
            instructions: identity.instructions ?? null,
            agentTape,
            mcpTape,
            now,
            toolMode,
            taskBudgetTokens: opts.taskBudget,
            maxIterations: 2,
            ...(rubricJudge === undefined ? {} : { judge: rubricJudge }),
            systemSuffix: `Null model pass: ${nullModel}.`
          });
          if (run.outcome.success) k += 1;
        }
        addNull(nullModel, k, batch.length);
        log(`  null ${nullModel}${suffix}: ${k}/${batch.length}`);
      }
    }
    // Zero tokens and no model in the loop, so it runs even with no client.
    const random = await driveRandomArgsBaseline({ conn, tasks: batch, tools, seed, mcpTape, now });
    addNull('random-valid-args', random.k, random.n);
    log(`  null random-valid-args${suffix}: ${random.k}/${random.n}`);
  };

  if (proceed() && tasks.length > 0) {
    log('measuring null baselines');
    await measureNulls(tasks, opts.seed, '');
  }

  // -- PAID: construct, and the pre-registered extension protocol -------------

  let constructRate: number | null = null;
  /**
   * The suite the DRIVE and the SCORE run over: the original tasks plus every
   * task a consumed extension pooled. A run that bought resolution with six more
   * tasks and then scored only the original twelve would be reporting a number
   * for a suite it did not run.
   */
  let pooledTasks: readonly FitnessTask[] = tasks;
  const extensions: ExtensionEvidence[] = [];
  const batchSuiteHashes: (string | null)[] = [];
  /**
   * One full synthesis ledger per consumed batch, serialized into
   * suite-meta.json beside the lineage. A bought task must be exactly as
   * auditable as a registered one, and aggregate counts are not an audit.
   */
  const batchLedgers: { index: number; meta: SuiteMetaJson }[] = [];

  /** One construct pass over one batch of tasks, at the registered reps. */
  const runConstruct = async (batch: readonly FitnessTask[]) =>
    construct<{ id: string; index: number }, boolean>(
      async (c) => {
        const task = batch[c.index];
        if (task === undefined) throw new Error(`no task at ${c.index}`);
        const run = await driveTask(task, {
          corrId: `${task.id}::construct`,
          client: anthropic!,
          conn,
          tools,
          model: opts.runner,
          instructions: identity.instructions ?? null,
          agentTape,
          mcpTape,
          now,
          toolMode: 'live',
          taskBudgetTokens: opts.taskBudget,
          maxIterations: opts.maxIterations,
          ...(rubricJudge === undefined ? {} : { judge: rubricJudge }),
          revealAnswerKey: true,
          systemSuffix: 'Construct gate reference pass: full information.'
        });
        if (run.error !== null) throw new Error(run.error);
        // The reference pass is handed the answer key, so a `substring` or
        // `regex` check over `final_text` alone is a tautology: the model can
        // satisfy it by quoting the system prompt, with zero tool calls,
        // against a dead or garbage server. A construct PASS must additionally
        // prove the answer was REACHED THROUGH THE SERVER, so the pass has to
        // have landed a successful call on a tool the task expects.
        const expected = new Set(task.expectedTools);
        const reachedThroughServer = run.toolCallRecords.some(
          (record) => record.status === 'ok' && (expected.size === 0 || expected.has(record.tool))
        );
        return run.outcome.success && reachedThroughServer;
      },
      batch.map((task, index) => ({ id: task.id, index })),
      () => true,
      { reps: opts.constructReps, minRate: CONSTRUCT_MIN_RATE, alpha: CONSTRUCT_ALPHA, maxWorkers: 1 }
    );

  if (proceed() && tasks.length > 0 && anthropic !== undefined) {
    log(`construct gate: reference agent, ${opts.constructReps} rep(s) per task`);
    const first = await runConstruct(tasks);
    const parts: ConstructPart[] = [{ n: first.n, nIntended: first.nIntended, errors: first.errors }];
    let pooled = poolConstruct(parts);
    log(`  construct: ${pooled.k}/${pooled.n} = ${pooled.rate.toFixed(3)} (${pooled.reason})`);

    let resolution = resolveConstruct({
      pooled,
      policy: EXTENSION_POLICY,
      extensionsConsumed: extensions.length,
      blocked: ledger.refusedAt !== null
    });

    // THE EXTENSION LOOP. Bounded by the pre-registration and by nothing else:
    // no timer, no budget check, no operator decision. Every iteration consumes
    // exactly one registered extension whatever it produces.
    while (resolution.extend) {
      const index = extensions.length + 1;
      const seed = extensionSeed(opts.seed, index);
      const pooledBefore: PooledCounts = { k: pooled.k, n: pooled.n };
      const verdictBefore: GateOutcome | null = pooled.verdict?.outcome ?? null;
      log(
        `  construct is under-resolved at ${pooled.k}/${pooled.n}: running pre-registered extension ` +
          `${index} of ${EXTENSION_POLICY.maxExtensions} (${EXTENSION_POLICY.extensionSize} tasks, derived seed ${seed})`
      );

      let batch: SynthesisResult | undefined;
      let failure: string | undefined;
      try {
        // Same generator version, same prompt, same tool surface, same options.
        // The seed is DERIVED (seed + 1000 * index) so the batch is new and is
        // still reproducible from the run record alone.
        batch = await synthesizeExtensionBatch(judged('extension_synthesis')!, {
          serverSlug: identity.slug,
          tools: tools as never,
          instructions: identity.instructions ?? null,
          generatorModel: opts.judge,
          baseSeed: opts.seed,
          extensionIndex: index,
          extensionSize: EXTENSION_POLICY.extensionSize,
          nullScreen: {
            client: judged('null_screen')!,
            model: opts.runner,
            ...(rubricJudge === undefined ? {} : { judge: rubricJudge })
          }
        });
      } catch (error) {
        // A batch that could not be generated is a batch of size zero. It still
        // CONSUMES the extension: retrying it until one comes back is optional
        // stopping with extra steps.
        failure = describe(error);
      }

      const emitted = batch?.suite.tasks ?? [];
      // The SAME free gates the registered suite passed, with the SAME
      // consequences: a leak or a property violation inside a bought batch
      // refuses this run, exactly as it would have in the registered suite.
      // Ordinary admission drops, null screen deletions and tasks restating one
      // already in the pool are dropped and counted.
      const screen = freeGates.screenBatch({ index, tasks: emitted, pooled: pooledTasks });

      if (screen.admitted.length > 0) {
        // Extension tasks are measured by the SAME three null models before
        // they can be counted anywhere, so the run-time null gate still sees
        // the whole suite it is deciding about.
        await measureNulls(screen.admitted, seed, `extension ${index}`);
        const batchReport = await runConstruct(screen.admitted);
        parts.push({ n: batchReport.n, nIntended: batchReport.nIntended, errors: batchReport.errors });
        pooledTasks = [...pooledTasks, ...screen.admitted];
      }
      // POOLED, never per batch: pooling is what buys the resolution the
      // extension was purchased for, and deciding per batch would run the test
      // once per batch.
      pooled = poolConstruct(parts);

      const evidence: ExtensionEvidence = {
        index,
        gate: 'construct',
        seed,
        batchSuiteHash: batch?.suite.suiteHash ?? null,
        taskIds: screen.admitted.map((t) => t.id),
        generated: emitted.length,
        admitted: screen.admitted.length,
        dropped: {
          nullScreen: batch?.nullScreen.dropped ?? 0,
          // Always 0 now: a leaking batch task refuses the run instead of
          // dropping, and its offenders are in `violations`.
          answerLeak: 0,
          admission: screen.dropped.admission,
          duplicate: screen.dropped.duplicate
        },
        short: screen.admitted.length < EXTENSION_POLICY.extensionSize,
        pooledBefore,
        pooledAfter: { k: pooled.k, n: pooled.n },
        verdictBefore,
        verdictAfter: pooled.verdict?.outcome ?? null,
        ...(failure === undefined ? {} : { failure }),
        ...(screen.violations.length === 0 ? {} : { violations: screen.violations })
      };
      extensions.push(evidence);
      batchSuiteHashes.push(evidence.batchSuiteHash);
      // FINDING 5: the batch's own synthesis ledger, kept whole. It used to be
      // reduced to `nullScreen.dropped` and thrown away, so the tasks a run
      // bought with its paid tier were the least auditable tasks in the run.
      batchLedgers.push({
        index,
        meta: buildSuiteMeta({
          runId,
          serverSlug: identity.slug,
          suiteHash: batch?.suite.suiteHash ?? 'no-batch',
          synthesis: batch,
          failure: failure === undefined ? null : { kind: 'extension_synthesis_failed', message: failure },
          tools
        })
      });
      await mcpTape.writeEvent({
        t: now().toISOString(),
        dir: 'event',
        kind: 'fitness.extension',
        raw: evidence
      });
      log(
        `  extension ${index}: ${screen.admitted.length} of ${emitted.length} task(s) pooled; construct now ` +
          `${pooled.k}/${pooled.n} = ${pooled.rate.toFixed(3)} (${pooled.reason})`
      );

      // THE SYMMETRY. A free gate that refuses in the registered suite refuses
      // here, with the batch and the task named. One ledger row per violated
      // gate, under its own id: both this repo's renderer and the leaderboard
      // resolve `refusedAt` by finding the FIRST record with that gate id, so a
      // second row under `answer_leak` would have published the earlier passing
      // row's reason ("ok") as the reason this run was refused.
      for (const gate of ['extension_answer_leak', 'extension_structural'] as const) {
        const found = screen.violations.filter((v) => v.gate === gate);
        const first = found[0];
        if (first === undefined) continue;
        ledger.add({
          gate,
          ok: false,
          costTier: 'free',
          reason: first.reason,
          detail: {
            extensionIndex: index,
            seed,
            batchSuiteHash: evidence.batchSuiteHash,
            tasks: found,
            generated: emitted.length,
            cleanTasksInBatch: screen.clean,
            note:
              'This finding refuses the run exactly as it would in the registered suite. The batch is voided ' +
              'whole rather than mined for its clean tasks: keeping them would select the pool on a defect the ' +
              'same generator produced. The extension is still consumed, because it was bought. Ordinary ' +
              'admission drops, null screen deletions and duplicates of pooled tasks remain drops and are ' +
              'counted in the extension record.'
          }
        });
        ledger.refuse(gate);
        await gateEvent(gate, {
          ok: false,
          reason: first.reason,
          extensionIndex: index,
          taskIds: found.map((v) => v.taskId)
        });
        log(`  extension ${index} REFUSED at ${gate}: ${found.map((v) => v.taskId).join(', ')}`);
      }
      if (screen.refused && outcome === 'SCORED') outcome = 'GATE_FAILED';

      resolution = resolveConstruct({
        pooled,
        policy: EXTENSION_POLICY,
        extensionsConsumed: extensions.length,
        blocked: ledger.refusedAt !== null
      });
    }

    constructRate = pooled.rate;
    ledger.add({
      gate: 'construct',
      ok: pooled.ok,
      costTier: 'paid',
      // `ok` is derived from the RAW three-outcome verdict, so the row must
      // carry the RAW verdict. Storing the DESIGN-12b published verdict here
      // printed "pass ... EXTEND" in one cell of the published table, asserting
      // both states at once. The published verdict is a leaderboard-PASS rule,
      // and it lives under detail.published where nothing contradicts it.
      ...(pooled.verdict === null ? {} : { verdict: pooled.verdict }),
      reason: resolution.reason,
      detail: {
        n: pooled.n,
        nIntended: pooled.k,
        rate: pooled.rate,
        errors: pooled.errors,
        errorRate: pooled.errorRate,
        maxErrorRate: pooled.maxErrorRate,
        compromised: pooled.compromised,
        reps: opts.constructReps,
        published: pooled.published,
        // Top level as well as inside `pooled`: the leaderboard's fallback path
        // reads `detail.extensionsConsumed` when a record reaches it without the
        // per-batch entries, and an extension that was spent must never be
        // invisible just because one reader took the other branch.
        extensionsConsumed: extensions.length,
        pooled: {
          k: pooled.k,
          n: pooled.n,
          parts: pooled.parts,
          extensionsConsumed: extensions.length,
          extensionsRemaining: Math.max(0, EXTENSION_POLICY.maxExtensions - extensions.length),
          policy: EXTENSION_POLICY
        },
        extensions,
        // The doctrine, stated in the row it applies to.
        resolvedToFail: resolution.resolvedToFail,
        extensionProtocol:
          `Extension policy fixed before the first model call: ${EXTENSION_POLICY.extensionSize} tasks per extension, ` +
          `at most ${EXTENSION_POLICY.maxExtensions}. An EXTEND verdict buys one batch of new tasks from the same ` +
          'generator at a derived seed, past the same free gates and the same null baselines, run at the same reps; ' +
          'k and n are pooled across the original suite and every batch and the rule is re-applied to the pooled ' +
          'counts. After the last extension an unresolved gate resolves to FAIL. A suite regenerated outside this ' +
          'protocol is a NEW run, never a retry.',
        constructOracle:
          'A reference pass counts only when it both satisfied the check and landed a successful call on a tool the task expects. ' +
          'The reference agent is given the answer key, so a text check alone would pass against a server that returned nothing.',
        note:
          opts.constructReps === 1
            ? 'One rep per task in v0, for cost. evalgate runs three; the divergence is recorded here rather than hidden.'
            : undefined
      }
    });
    await gateEvent('construct', {
      ok: pooled.ok,
      reason: resolution.reason,
      rate: pooled.rate,
      k: pooled.k,
      n: pooled.n,
      extensionsConsumed: extensions.length
    });
    log(`  construct (pooled): ${pooled.k}/${pooled.n} = ${pooled.rate.toFixed(3)} (${resolution.reason})`);
    if (!pooled.ok) {
      ledger.refuse('construct');
      // COMPROMISED outranks whatever an earlier gate named: it says the
      // measurement did not complete, which is a fact about the run rather than
      // a verdict on the server. Everything else only names the outcome when
      // nothing else already has.
      if (resolution.outcome !== null && (resolution.outcome === 'COMPROMISED' || outcome === 'SCORED')) {
        outcome = resolution.outcome;
      }
    }
  }

  // -- DRIVE -----------------------------------------------------------------

  let outcomes: readonly RunnerTaskOutcome[] = [];
  let driveNotes: readonly string[] = [];
  let taskBudgetSupported = true;
  if (proceed() && pooledTasks.length > 0 && anthropic !== undefined) {
    log(
      `driving ${pooledTasks.length} tasks with ${opts.runner}` +
        (extensions.length === 0 ? '' : ` (${tasks.length} original plus ${pooledTasks.length - tasks.length} from ${extensions.length} extension batch(es))`)
    );
    const suiteRun = await driveSuite({
      client: anthropic,
      conn,
      tools,
      // The FULL pooled suite. Extension tasks carry their own corr ids and are
      // driven, recorded and scored exactly like original tasks: a task good
      // enough to resolve the construct gate is good enough to be in the number.
      tasks: pooledTasks,
      model: opts.runner,
      instructions: identity.instructions ?? null,
      agentTape,
      mcpTape,
      now,
      toolMode: 'live',
      taskBudgetTokens: opts.taskBudget,
      maxIterations: opts.maxIterations,
      ...(rubricJudge === undefined ? {} : { judge: rubricJudge }),
      onTask: (run, index, total) =>
        log(`  [${index + 1}/${total}] ${run.taskId}: ${run.outcome.success ? 'pass' : 'fail'}${run.outcome.failure ? ` (${run.outcome.failure})` : ''}`)
    });
    outcomes = suiteRun.outcomes;
    driveNotes = suiteRun.notes;
    taskBudgetSupported = suiteRun.taskBudgetSupported;
    nullSignal = { k: outcomes.filter((o) => o.firstTrySuccess).length, n: outcomes.length };
  }

  // -- null kill rule, applied against the best signal we have ---------------

  const nulls = [...nullTotals.entries()].map(([label, counts]) => ({ label, k: counts.k, n: counts.n }));
  if (nulls.length > 0) {
    const signal = nullSignal ?? {
      // The pooled suite, because that is what the nulls were measured over.
      k: constructRate === null ? 0 : Math.round(constructRate * pooledTasks.length),
      n: pooledTasks.length
    };
    const report = nullBaselineGate({ signal, nulls });
    ledger.add({
      gate: 'null_baseline',
      ok: report.ok,
      costTier: 'cheap',
      reason: report.reason,
      detail: {
        ...report,
        signalSource: nullSignal === null ? 'construct reference rate (the drive did not run)' : 'first-try success on the scored drive',
        // The MEASUREMENT is cheap-tier and ran before the paid gate. The
        // DECISION needs a signal to compare the noise floor against, and the
        // first signal any run produces comes from a paid pass, so the row is
        // recorded here, after it. The ledger order is the order gates were
        // decided, not the order they were priced.
        measuredBeforePaidTier: true,
        decidedAfter: nullSignal === null ? 'construct' : 'drive',
        explain: explainNulls(report)
      }
    });
    await gateEvent('null_baseline', { ok: report.ok, reason: report.reason, tNull: report.tNull, tAblate: report.tAblate });
    if (report.halts) {
      ledger.refuse('null_baseline');
      // Only the gate that actually stopped the run names the outcome. A later
      // gate reading INDETERMINATE off a signal an EARLIER refusal already
      // invalidated would publish "REFUSED (INDETERMINATE), stopped at the
      // construct gate": two different stories in one report.
      if (ledger.refusedAt === 'null_baseline') {
        outcome = report.outcome === 'KILL' ? 'DEGENERATE' : 'INDETERMINATE';
      }
    }
  }

  // -- the published suite: original plus every pooled extension -------------
  //
  // The hash covers the POOLED set, so a reader who re-derives it over the
  // published suite.json gets the same string. It cannot be
  // `computeSuiteHash(pooledTasks, generator, seed)`: the pooled set came from
  // several generator configs (one per derived seed) and stamping one config
  // over all of them would claim a provenance this run does not have. The
  // lineage (original hash, per-batch hashes, the pooled task list) is the
  // preimage, and it is written to suite-meta.json so anyone can recompute it.
  //
  // The TAPE meta line keeps the pre-extension hash in `producer.configHash`:
  // it is written when the tapes open, which is necessarily before the paid
  // tier has decided anything, and rewriting history to match a later decision
  // is exactly what a recording must never do. The lineage records both.

  const lineage =
    extensions.length === 0
      ? undefined
      : {
          policy: EXTENSION_POLICY,
          originalSuiteHash: suite.suiteHash,
          pooledSuiteHash: computePooledSuiteHash({
            originalSuiteHash: suite.suiteHash,
            batchSuiteHashes,
            tasks: pooledTasks
          }),
          /** What `producer.configHash` says on both tapes. Pre-extension by design. */
          tapeConfigHash: suite.suiteHash,
          originalTaskIds: tasks.map((t) => t.id),
          batches: extensions.map((e) => ({
            index: e.index,
            seed: e.seed,
            batchSuiteHash: e.batchSuiteHash,
            taskIds: e.taskIds,
            generated: e.generated,
            admitted: e.admitted,
            dropped: e.dropped,
            short: e.short,
            pooledBefore: e.pooledBefore,
            pooledAfter: e.pooledAfter,
            ...(e.failure === undefined ? {} : { failure: e.failure }),
            ...(e.violations === undefined ? {} : { violations: e.violations }),
            // The batch's OWN synthesis ledger, whole: every drop with its rule
            // and its evidence, every repair, every null screen verdict. The
            // report carries the counts; this carries the reasons, so a task the
            // run BOUGHT is exactly as auditable as one it registered.
            synthesis: batchLedgers.find((b) => b.index === e.index)?.meta ?? null
          })),
          note:
            'Extension task ids carry a deterministic e<index>- prefix so no two tasks in the pool share a ' +
            'correlation id. The per-batch suiteHash covers the unprefixed ids exactly as the generator emitted them, ' +
            'and `synthesis` on each batch is that batch own drop ledger. Pooling is deduped on task CONTENT ' +
            '(rendered prompt, expected tools, check), never on id, because the prefix makes every id unique and ' +
            'would hide a task the batch restated from the pool.'
        };

  const publishedSuite: TaskSuite =
    lineage === undefined ? suite : { ...suite, suiteHash: lineage.pooledSuiteHash, tasks: pooledTasks };
  const publishedSuiteMeta: SuiteMetaJson =
    lineage === undefined ? suiteMeta : { ...suiteMeta, extension: lineage };

  // -- score -----------------------------------------------------------------

  const scoredIds = new Set(outcomes.map((o) => o.taskId));
  const driveMcpRecords = recorder.records.filter((r) => typeof r.corr_id === 'string' && scoredIds.has(r.corr_id));
  const driveAgentRecords = agentRecords.filter((r) => typeof r.corr_id === 'string' && scoredIds.has(r.corr_id));

  let score: FitnessReportJson['score'];
  let scoreNotes: readonly string[] = [];
  if (outcomes.length > 0) {
    const computed = computeScore({
      runnerModel: opts.runner,
      suite: publishedSuite,
      outcomes,
      mcpRecords: driveMcpRecords,
      agentRecords: driveAgentRecords,
      toolCatalog: tools
    });
    scoreNotes = computed.notes;
    if (ledger.refusedAt === null) {
      score = computed.score;
      const published = publishedVerdict(
        computed.score.firstTrySuccess.k,
        computed.score.firstTrySuccess.n,
        0.9
      );
      if (published.downgraded) {
        methods.push(
          `First-try success would read as a PASS on the point estimate alone, but the Wilson lower bound is ` +
            `${published.wilsonLow.toFixed(3)} and the design needed n = ${published.requiredN}. The published verdict is EXTEND.`
        );
      }
    } else {
      notes.push(
        'The drive ran for evidence only. A gate had already refused, so no score is published from it.'
      );
    }
  }

  if (ledger.refusedAt === null && outcomes.length === 0) {
    outcome = 'INDETERMINATE';
    notes.push('No tasks were driven, so there is nothing to score.');
  } else if (ledger.refusedAt === null) {
    outcome = 'SCORED';
  }

  if (!taskBudgetSupported) methods.push(...driveNotes);
  // GENERATOR v2 disclosure. The screen is the one place in this design where a
  // reader could reasonably suspect the score of having been engineered, so the
  // bias, its direction and the number that reveals it are stated outright.
  if (synthesis !== undefined) {
    methods.push(
      `Task suite generated by ${synthesis.generator.generatorVersion} (judge ${synthesis.generator.generatorModel}). ` +
        'v1 and v2 suites are different measurements and are never merged in one leaderboard column.'
    );
    if (synthesis.nullScreen.enabled) {
      methods.push(
        'Task candidates are screened at generation time with a single no-tools probe on the runner model. Candidates the cold model answers correctly are deleted before any gate runs, with the reason recorded. The run-time null baseline therefore measures the noise floor of a null-screened suite, not of an arbitrary suite, and is biased downward by construction.',
        'The screen simulates one of the three null models the gate uses, weakly and with a single sample. It never removes a task from the gate denominator and never changes a gate threshold; the null_baseline rule, its 0.5 ratio and its 95th percentile are unchanged from v1.',
        'The share of generated candidates the screen deleted is published per server.',
        `Null screen on this server: ${synthesis.nullScreen.dropped} of ${synthesis.nullScreen.screened} screened candidates were answerable with no server at all.`,
        `Screen spend is not on either tape. The screen made ${synthesis.nullScreen.screened} runner-model calls ` +
          `(${synthesis.nullScreen.inputTokens} input and ${synthesis.nullScreen.outputTokens} output tokens) before the ` +
          'suite existed, so trace_stats cannot see them. They are measured in run.judgeUsage, under the null_screen ' +
          'phase, and the per-candidate counts stay in the synthesis ledger.'
      );
    }
    if (!synthesis.reconciles) {
      methods.push(
        `Synthesis accounting did not reconcile: ${synthesis.candidates} candidates against ` +
          `${synthesis.admitted} admitted plus ${synthesis.dropped.length} dropped plus ${synthesis.trimmed} trimmed ` +
          `(shortfall ${synthesis.shortfall}). The admission rate above is therefore approximate, and suite-meta.json records the gap rather than hiding it.`
      );
    }
  }
  if (opts.evidenceDrive && publishBlocked()) {
    methods.push(
      'Operator ran with --evidence-drive: the refusal stands and no score is published, but the drive ran anyway so the recording exists.'
    );
  }
  if (extensions.length > 0 && lineage !== undefined) {
    const pooledTaskCount = pooledTasks.length - tasks.length;
    methods.push(
      `The construct gate was under-resolved on the registered suite, so ${extensions.length} of the ` +
        `${EXTENSION_POLICY.maxExtensions} pre-registered extension(s) were consumed: ${pooledTaskCount} new task(s) ` +
        'from the same generator at derived seeds, past the same free gates and the same three null baselines, run ' +
        'at the same reps. The verdict is the three-outcome rule applied to the POOLED counts, and the score below ' +
        'covers the pooled suite. The per-batch hashes are in suite-meta.json.',
      `The published suite hash ${lineage.pooledSuiteHash.slice(0, 12)} covers the pooled set. The tapes carry the ` +
        `pre-extension hash ${lineage.tapeConfigHash.slice(0, 12)} in producer.configHash, because a recording is ` +
        'written as it happens and is never rewritten to match a later decision.'
    );
  }

  const judgeUsage = meter?.summary() ?? undefined;
  if (judgeUsage !== undefined) {
    methods.push(
      `Judge spend for this run is measured, not estimated: ${judgeUsage.calls} judge-tier call(s), ` +
        `${judgeUsage.inputTokens} input and ${judgeUsage.outputTokens} output tokens, ` +
        `${judgeUsage.estCostUsd === null ? 'no priced total (no price row matched)' : `$${judgeUsage.estCostUsd.toFixed(4)}`}` +
        '. None of it reaches a tape, so a total for the run is the trace_stats cost PLUS run.judgeUsage.estCostUsd.'
    );
  }

  await conn.close();

  return await finish({
    outDir,
    runId,
    startedAt,
    opts,
    server: identity,
    probes,
    // The pre-registration, persisted with every extension it actually bought.
    ...ledger.build(EXTENSION_POLICY, extensions),
    ledgerRecords: undefined,
    outcome,
    score,
    scoreNotes,
    ...(judgeUsage === undefined ? {} : { judgeUsage }),
    suiteHash: publishedSuite.suiteHash,
    suite: publishedSuite,
    suiteMeta: publishedSuiteMeta,
    recorder,
    agentRecords,
    mcpTapeRecords,
    notes,
    methods,
    log,
    now,
    endReason: 'eval_complete',
    tapes: { mcpTape, agentTape }
  });
}

// ---------------------------------------------------------------------------
// Finishing: close tapes, redact publish copies, render
// ---------------------------------------------------------------------------

interface FinishInput {
  outDir: string;
  runId: string;
  startedAt: string;
  opts: CliOptions;
  server: ServerIdentity;
  probes: ProbeResults;
  order?: readonly GateId[];
  records?: readonly GateRecord[];
  ledgerRecords?: readonly GateRecord[];
  extensionPolicy?: ExtensionPolicy;
  extensions?: readonly ExtensionEvidence[];
  refusedAt?: GateId | null;
  outcome: RunOutcome;
  score?: FitnessReportJson['score'];
  scoreNotes?: readonly string[];
  /** Measured judge spend. Absent when the run made no judge call. */
  judgeUsage?: JudgeUsageBlock;
  suiteHash: string;
  suite?: TaskSuite;
  /** The synthesis ledger. Written even when synthesis threw. */
  suiteMeta?: SuiteMetaJson;
  recorder: FrameRecorder;
  agentRecords: TraceRecord[];
  /** Mirror of every LINE on the mcp plane, for `trace_stats`. */
  mcpTapeRecords: TraceRecord[];
  notes: readonly string[];
  methods: readonly string[];
  log: (m: string) => void;
  now: () => Date;
  endReason: string;
  tapes?: { mcpTape: TapeWriter; agentTape: TapeWriter };
}

async function finish(input: FinishInput): Promise<PipelineResult> {
  const mcpPath = join(input.outDir, 'mcp.jsonl');
  const agentPath = join(input.outDir, 'agent.jsonl');

  if (input.tapes === undefined) {
    // The connect path failed before the tapes opened: write them now so the
    // buffered handshake frames are not lost.
    const command = ['fitness-report', stripCredentials(input.opts.url)];
    const meta = {
      startedAt: input.startedAt,
      label: input.server.slug,
      command,
      mcpTapVersion: HARNESS_VERSION,
      source: SOURCE,
      producer: { name: 'fitness-report', version: HARNESS_VERSION, configHash: input.suiteHash }
    };
    const mcpTape = await TapeWriter.open({
      path: mcpPath,
      meta: { ...meta, kind: 'mcp' },
      onFrame: tappedWriter(input.mcpTapeRecords)
    });
    await input.recorder.attach(mcpTape);
    const agentTape = await TapeWriter.open({
      path: agentPath,
      meta: { ...meta, kind: 'llm' },
      onFrame: tappedWriter(input.agentRecords)
    });
    await mcpTape.close({ reason: input.endReason, t: input.now().toISOString() });
    await agentTape.close({ reason: input.endReason, t: input.now().toISOString() });
  } else {
    await input.tapes.mcpTape.close({ reason: input.endReason, t: input.now().toISOString() });
    await input.tapes.agentTape.close({ reason: input.endReason, t: input.now().toISOString() });
  }

  // Everything we KNOW is a credential, removed by exact match wherever it
  // appears. Pattern rules cannot catch a token a gateway echoes back as
  // "presented <tok>" with no marker word in front of it, and the pre-strip URL
  // carries any `?api_key=` the host authenticates with.
  const secrets = [
    input.opts.authToken,
    input.opts.url === stripCredentials(input.opts.url) ? undefined : input.opts.url
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);

  // Redacted publish copies (DESIGN decision 6: the writer never redacts; only
  // the published copy does, and scoring already happened in memory).
  await mkdir(join(input.outDir, 'publish'), { recursive: true });
  for (const plane of ['mcp', 'agent'] as const) {
    const raw = await readFile(join(input.outDir, `${plane}.jsonl`), 'utf8');
    const lines = raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as TapeLine);
    const redacted = scrubSecrets(redactTape(lines), secrets);
    await writeFile(
      join(input.outDir, 'publish', `${plane}.jsonl`),
      redacted.map((l) => JSON.stringify(l)).join('\n') + '\n',
      'utf8'
    );
  }

  const mcpUrl = `${input.opts.publishBase.replace(/\/$/, '')}/traces/${input.runId}/mcp.jsonl`;
  const agentUrl = `${input.opts.publishBase.replace(/\/$/, '')}/traces/${input.runId}/agent.jsonl`;
  const viewer = viewerUrl(mcpUrl, agentUrl);

  // Stats are computed over what the FILES contain, because DESIGN decision 5
  // makes `npx mcp-tape stats <file> --json` the oracle this block must agree
  // with. Scoring keeps reading the wire-frame-only subset.
  const traceStats = computeTraceStats({
    mcp: input.mcpTapeRecords.length > 0 ? input.mcpTapeRecords : input.recorder.records,
    agent: input.agentRecords
  });

  // The generator identity, lifted out of the synthesis ledger to the top of
  // the record. It is already inside the suite hash, but a hash cannot be
  // grouped on and the leaderboard must refuse to rank a v1 denominator against
  // a v2 one.
  const generatorConfig = input.suiteMeta?.generator as
    | { generatorVersion?: string; nullScreen?: { enabled?: boolean } }
    | null
    | undefined;

  const rawReport = buildReport({
    runId: input.runId,
    startedAt: input.startedAt,
    harnessVersion: HARNESS_VERSION,
    runnerModel: input.opts.runner,
    judgeModel: input.opts.judge,
    suiteHash: input.suiteHash,
    taskBudget: input.opts.taskBudget,
    generatorVersion: generatorConfig?.generatorVersion ?? null,
    nullScreenEnabled: generatorConfig?.nullScreen?.enabled === true,
    server: input.server,
    probes: input.probes,
    gates: {
      order: input.order ?? [],
      records: input.records ?? input.ledgerRecords ?? [],
      extensionPolicy: input.extensionPolicy ?? EXTENSION_POLICY,
      refusedAt: input.refusedAt ?? null,
      ...(input.extensions === undefined || input.extensions.length === 0
        ? {}
        : { extensions: input.extensions })
    },
    ...(input.judgeUsage === undefined ? {} : { judgeUsage: input.judgeUsage }),
    outcome: input.outcome,
    ...(input.score === undefined ? {} : { score: input.score }),
    scoreNotes: [...(input.scoreNotes ?? []), ...input.notes],
    methods: input.methods,
    traceLinks: viewer === null ? null : { mcp: mcpUrl, agent: agentUrl, viewer },
    traceStats
  });

  // THE REPORT IS PUBLISHED TOO. Redacting only the tapes left the credential
  // in the one artifact site/README tells the operator to append to
  // site/data/runs.json: a connect error, a probe body snippet or a gate detail
  // string carries it verbatim into report.json and report.md.
  const report = redactReport(rawReport, secrets);

  const reportJson = join(input.outDir, 'report.json');
  const reportMd = join(input.outDir, 'report.md');
  await writeFile(reportJson, JSON.stringify(report, null, 2) + '\n', 'utf8');
  await writeFile(reportMd, renderMarkdown(report) + '\n', 'utf8');

  let suitePath: string | null = null;
  if (input.suite !== undefined) {
    suitePath = join(input.outDir, 'suite.json');
    await writeFile(suitePath, JSON.stringify(input.suite, null, 2) + '\n', 'utf8');
  }

  // The synthesis ledger is written whenever synthesis was ATTEMPTED, including
  // the run where it threw: "12 candidates became 5" with no record of which
  // rule fired is a refusal nobody can defend. It carries our own generated
  // text, so it is redacted for publication exactly like the report is.
  let suiteMetaPath: string | null = null;
  if (input.suiteMeta !== undefined) {
    suiteMetaPath = join(input.outDir, 'suite-meta.json');
    const redacted = redactReport(input.suiteMeta, secrets);
    await writeFile(suiteMetaPath, JSON.stringify(redacted, null, 2) + '\n', 'utf8');
  }

  input.log(`outcome ${report.outcome}; wrote ${reportJson}`);
  return {
    report,
    outDir: input.outDir,
    files: {
      reportJson,
      reportMd,
      mcpTape: mcpPath,
      agentTape: agentPath,
      suite: suitePath,
      suiteMeta: suiteMetaPath
    }
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function hasApiKey(): boolean {
  return typeof process.env['ANTHROPIC_API_KEY'] === 'string' && process.env['ANTHROPIC_API_KEY'].length > 0;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function slugOf(url: string): string {
  try {
    return new URL(url).host.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  } catch {
    return 'server';
  }
}

// ---------------------------------------------------------------------------
// Synthesis ledger (schema `fitness-report.suite-meta/1`)
// ---------------------------------------------------------------------------

/**
 * The serialized drop ledger.
 *
 * Written for EVERY run, including one where synthesis threw: a refusal whose
 * cause is not recorded is exactly the bare-lint-count failure DESIGN's opening
 * paragraph forbids. Note what is NOT here: this file is an OUTPUT and never an
 * input to `suiteHash`, or the hash would be circular.
 *
 * Field naming is load-bearing. The leaked answer string is `phrase`, never
 * `token`: src/tape/default-redact.json carries a descend-anywhere `$..token`
 * rule and the published copy would erase exactly the evidence this file
 * exists to carry. Same reason nothing here is called secret, password,
 * api_key, apiKey, access_key, bearer or authorization.
 *
 * Dropped candidates' prompts may contain their own answer keys by definition.
 * That is fine to publish: it is our generated text, not a credential.
 */
export interface SuiteMetaJson {
  schema: 'fitness-report.suite-meta/1';
  runId: string;
  serverSlug: string;
  suiteHash: string;
  generator: unknown;
  surface: { toolCount: number; toolNames: readonly string[] };
  yield: {
    emitted: number;
    rewritten: number;
    candidates: number;
    entriesDiscarded: number;
    admitted: number;
    trimmed: number;
    admissionRate: number | null;
    reconciles: boolean;
    shortfall: number;
    minTasks: number;
    insufficient: boolean;
  };
  nullScreen: unknown;
  dropped: readonly unknown[];
  dropsByRule: Record<string, number>;
  repairs: readonly unknown[];
  handleChains: readonly unknown[];
  leaks: { atGeneration: readonly unknown[]; regenerationAttempted: boolean };
  failure: { kind: string; message: string } | null;
  /**
   * Extension lineage. Present only when the pre-registered protocol actually
   * consumed one: the original suite hash, the per-batch hashes at their derived
   * seeds, and the pooled hash the report publishes. This is the preimage a
   * reader recomputes `run.suiteHash` from, so it can never be omitted from a
   * run that extended.
   */
  extension?: unknown;
}

export function buildSuiteMeta(input: {
  runId: string;
  serverSlug: string;
  suiteHash: string;
  synthesis: SynthesisResult | undefined;
  failure: { kind: string; message: string } | null;
  tools: readonly ToolDescriptor[];
}): SuiteMetaJson {
  const s = input.synthesis;
  const dropsByRule: Record<string, number> = {};
  for (const drop of s?.dropped ?? []) dropsByRule[drop.reason] = (dropsByRule[drop.reason] ?? 0) + 1;
  return {
    schema: 'fitness-report.suite-meta/1',
    runId: input.runId,
    serverSlug: input.serverSlug,
    suiteHash: input.suiteHash,
    generator: s?.generator ?? null,
    surface: s?.surface ?? { toolCount: input.tools.length, toolNames: input.tools.map((t) => t.name) },
    yield: {
      emitted: s?.emitted ?? 0,
      rewritten: s?.rewritten ?? 0,
      candidates: s?.candidates ?? 0,
      entriesDiscarded: s?.entriesDiscarded ?? 0,
      admitted: s?.admitted ?? 0,
      trimmed: s?.trimmed ?? 0,
      admissionRate: s === undefined || s.candidates === 0 ? null : s.admitted / s.candidates,
      reconciles: s?.reconciles ?? false,
      shortfall: s?.shortfall ?? 0,
      minTasks: s?.minTasks ?? MIN_VIABLE_TASKS,
      insufficient: s?.insufficient ?? true
    },
    nullScreen: s?.nullScreen ?? { enabled: false, model: null, screened: 0, dropped: 0, errors: 0, records: [] },
    dropped: (s?.dropped ?? []).map((d) => ({ id: d.id, rule: d.reason, detail: d.detail, evidence: d.evidence })),
    dropsByRule,
    repairs: s?.repairs ?? [],
    handleChains: s?.handleChains ?? [],
    leaks: { atGeneration: s?.leaksFound ?? [], regenerationAttempted: s?.regenerationAttempted ?? false },
    failure: input.failure
  };
}

/** The tape mirror: one line, counts and rules, no per-candidate prose. */
export function compactSynthesis(meta: SuiteMetaJson): unknown {
  const screen = meta.nullScreen as {
    enabled?: boolean;
    model?: string | null;
    screened?: number;
    dropped?: number;
    errors?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  const generator = meta.generator as { generatorVersion?: string; generatorModel?: string } | null;
  return {
    suiteHash: meta.suiteHash,
    generatorVersion: generator?.generatorVersion ?? null,
    generatorModel: generator?.generatorModel ?? null,
    yield: meta.yield,
    dropsByRule: meta.dropsByRule,
    nullScreen: {
      enabled: screen.enabled ?? false,
      model: screen.model ?? null,
      screened: screen.screened ?? 0,
      dropped: screen.dropped ?? 0,
      errors: screen.errors ?? 0,
      // The screen calls the RUNNER model once per validated candidate and
      // those calls land on neither tape, so `trace_stats` cannot see them.
      // Published here or they are spend nobody can account for.
      inputTokens: screen.inputTokens ?? 0,
      outputTokens: screen.outputTokens ?? 0
    },
    repairs: meta.repairs.length,
    leaksAtGeneration: meta.leaks.atGeneration.length,
    regenerationAttempted: meta.leaks.regenerationAttempted,
    failure: meta.failure,
    detail: 'full ledger in suite-meta.json'
  };
}

/** A `judge` check, answered by the judge model with one word. */
export function judgeFor(client: JudgeClient, model: string): JudgeCheck {
  return async (rubric, finalText) => {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 1000,
        output_config: { effort: 'low' },
        system:
          'You are grading one answer against one rubric. Reply with exactly PASS or FAIL and nothing else.',
        messages: [{ role: 'user', content: `Rubric: ${rubric}\n\nAnswer:\n${finalText}` }]
      });
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .toUpperCase();
      if (text.includes('PASS')) return true;
      if (text.includes('FAIL')) return false;
      return null;
    } catch {
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(argv: readonly string[]): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(describe(error));
    return 2;
  }
  try {
    const result = await runPipeline(opts);
    console.log(result.files.reportJson);
    return result.report.outcome === 'SCORED' ? 0 : 1;
  } catch (error) {
    console.error(`fitness-report failed: ${describe(error)}`);
    return 3;
  }
}

const entry = process.argv[1];
const invokedDirectly = entry !== undefined && (basename(entry) === 'cli.ts' || basename(entry) === 'cli.js');

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 3;
    }
  );
}
