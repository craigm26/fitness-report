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

import { construct } from './gates/construct.js';
import { plan, publishedVerdict } from './gates/gates.js';
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
import { computeTraceStats, type TraceRecord } from './score/stats.js';
import { redactReport, redactTape, scrubSecrets } from './tape/redact.js';
import { TapeWriter } from './tape/writer.js';
import {
  DEFAULT_JUDGE_MODEL,
  MIN_VIABLE_TASKS,
  findAnswerLeak,
  synthesizeTaskSuite,
  type JudgeClient,
  type SynthesisResult
} from './tasks/synthesize.js';
import type {
  FitnessReportJson,
  GateId,
  GateRecord,
  ProbeResults,
  RunOutcome,
  ServerIdentity,
  TapeLine,
  TaskSuite
} from './types.js';

const HARNESS_VERSION = '0.1.0';
const SOURCE = `fitness-report@${HARNESS_VERSION}`;
const DEFAULT_PUBLISH_BASE = 'https://fitnessreport.dev';

/**
 * Persisted BEFORE the first call (DESIGN decision 11), and honest about v0:
 * there is no extension loop in this pipeline, so `maxExtensions` is zero and
 * an unresolved gate resolves on its first evaluation. A non-zero policy here
 * would publish a procedure the run never performed.
 */
const EXTENSION_POLICY = { extensionSize: 0, maxExtensions: 0 } as const;

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

interface BufferedFrame {
  dir: 'in' | 'out';
  raw: unknown;
  t: string;
  corrId?: string;
}

/**
 * Holds wire frames until the tapes can be opened with the suite hash, then
 * writes straight through. Also keeps every frame in memory as a TraceRecord:
 * DESIGN decision 6 scores from PRE-redaction records, and re-reading the
 * redacted publish copy would corrupt legitimate arguments like `page_token`.
 */
class FrameRecorder {
  private buffered: BufferedFrame[] = [];
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
    if (this.writer === undefined) {
      this.buffered.push({ dir: tapeDir, raw, t, corrId });
      return;
    }
    void this.writer.writeMessage({ t, dir: tapeDir, raw, ...(corrId === undefined ? {} : { corr_id: corrId }) });
  };

  async attach(writer: TapeWriter): Promise<void> {
    this.writer = writer;
    for (const frame of this.buffered) {
      await writer.writeMessage({
        t: frame.t,
        dir: frame.dir,
        raw: frame.raw,
        ...(frame.corrId === undefined ? {} : { corr_id: frame.corrId })
      });
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

  build(extensionPolicy: { extensionSize: number; maxExtensions: number }) {
    return {
      order: [...this.order],
      records: [...this.records],
      extensionPolicy,
      refusedAt: this._refusedAt
    };
  }
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
  files: { reportJson: string; reportMd: string; mcpTape: string; agentTape: string; suite: string | null };
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

  const methods = defaultMethodsNotes();
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
  let suite: TaskSuite = {
    serverSlug: identity.slug,
    suiteHash: 'no-suite',
    generatorModel: opts.judge,
    seed: opts.seed,
    tasks: []
  };
  if (anthropic !== undefined) {
    log(`synthesizing tasks with ${opts.judge}`);
    try {
      synthesis = await synthesizeTaskSuite(anthropic, {
        serverSlug: identity.slug,
        tools: tools as never,
        instructions: identity.instructions ?? null,
        seed: opts.seed,
        generatorModel: opts.judge,
        ...(opts.maxTasks === undefined ? {} : { targetTaskCount: opts.maxTasks }),
        minTasks: MIN_VIABLE_TASKS
      });
      suite = synthesis.suite;
      log(`suite ${suite.suiteHash.slice(0, 12)}: ${suite.tasks.length} tasks admitted of ${synthesis.generated} generated`);
    } catch (error) {
      notes.push(`Task synthesis failed: ${describe(error)}`);
    }
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

  // -- FREE: structural, answer leak, suite size, plan and power -------------

  let outcome: RunOutcome = 'SCORED';
  const tasks = suite.tasks;

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
    const structuralReport = structural(
      // The generator's own index space does not survive validation, so cases
      // are indexed by ADMISSION order. The counts, which are what the gate
      // measures, are exact either way.
      (seed) => (seed < tasks.length ? tasks[seed] : null),
      (task) =>
        typeof task.id === 'string' &&
        task.id.length > 0 &&
        task.prompt.trim().length > 0 &&
        task.expectedTools.length > 0 &&
        task.expectedTools.every((t) => tools.some((tool) => tool.name === t)) &&
        findAnswerLeak(task) === null,
      { n: Math.max(synthesis.generated, tasks.length), minGenerated: MIN_VIABLE_TASKS }
    );
    ledger.add({
      gate: 'structural',
      ok: structuralReport.ok,
      costTier: 'free',
      reason: structuralReport.reason,
      detail: { ...structuralReport, explain: explainStructural(structuralReport) }
    });
    await gateEvent('structural', { ok: structuralReport.ok, reason: structuralReport.reason });
    if (!structuralReport.ok) {
      ledger.refuse('structural');
      outcome = structuralReport.reason === 'too_few_generated' ? 'INSUFFICIENT_SURFACE' : 'GATE_FAILED';
    }

    // `phrase`, not `token`: the publish-time redactor replaces any field
    // literally named `token`, and that would erase the leak evidence this
    // record exists to show.
    const leaks = tasks.map((task) => ({ id: task.id, phrase: findAnswerLeak(task) })).filter((l) => l.phrase !== null);
    ledger.add({
      gate: 'answer_leak',
      ok: leaks.length === 0,
      costTier: 'free',
      reason: leaks.length === 0 ? 'ok' : 'answer_in_prompt',
      detail: { leaks, regenerationAttempted: synthesis.regenerationAttempted, leaksFoundAtGeneration: synthesis.leaksFound }
    });
    if (leaks.length > 0) {
      ledger.refuse('answer_leak');
      outcome = 'GATE_FAILED';
    }

    const bigEnough = tasks.length >= MIN_VIABLE_TASKS && !synthesis.insufficient;
    ledger.add({
      gate: 'suite_size',
      ok: bigEnough,
      costTier: 'free',
      reason: bigEnough ? 'ok' : 'below_minimum_suite_size',
      detail: {
        nTasks: tasks.length,
        minTasks: MIN_VIABLE_TASKS,
        toolCount: tools.length,
        note:
          'With a median of 2.5 tools on the open roster, a suite below 8 tasks cannot separate a good server ' +
          'from a lucky one. This refuses rather than publishing a 2-task 100 percent.'
      }
    });
    if (!bigEnough) {
      ledger.refuse('suite_size');
      if (outcome === 'SCORED') outcome = 'INSUFFICIENT_SURFACE';
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
  const nulls: { label: string; k: number; n: number }[] = [];

  if (proceed() && tasks.length > 0 && anthropic !== undefined) {
    log('measuring null baselines');
    for (const [label, toolMode] of [
      ['no-tools', 'none'],
      ['stubbed-empty', 'stub']
    ] as const) {
      let k = 0;
      for (const task of tasks) {
        const run = await driveTask(task, {
          corrId: `${task.id}::null-${label}`,
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
          judge: judgeFor(anthropic, opts.judge),
          systemSuffix: `Null model pass: ${label}.`
        });
        if (run.outcome.success) k += 1;
      }
      nulls.push({ label, k, n: tasks.length });
      log(`  null ${label}: ${k}/${tasks.length}`);
    }
  }

  if (proceed() && tasks.length > 0) {
    const random = await driveRandomArgsBaseline({ conn, tasks, tools, seed: opts.seed, mcpTape, now });
    nulls.push({ label: 'random-valid-args', k: random.k, n: random.n });
    log(`  null random-valid-args: ${random.k}/${random.n}`);
  }

  // -- PAID: construct -------------------------------------------------------

  let constructRate: number | null = null;
  if (proceed() && tasks.length > 0 && anthropic !== undefined) {
    log(`construct gate: reference agent, ${opts.constructReps} rep(s) per task`);
    const report = await construct<{ id: string; index: number }, boolean>(
      async (c) => {
        const task = tasks[c.index];
        if (task === undefined) throw new Error(`no task at ${c.index}`);
        const run = await driveTask(task, {
          corrId: `${task.id}::construct`,
          client: anthropic,
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
          judge: judgeFor(anthropic, opts.judge),
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
      tasks.map((task, index) => ({ id: task.id, index })),
      () => true,
      { reps: opts.constructReps, minRate: 0.9, maxWorkers: 1 }
    );
    constructRate = report.rate;
    ledger.add({
      gate: 'construct',
      ok: report.ok,
      costTier: 'paid',
      // `ok` is derived from the RAW three-outcome verdict, so the row must
      // carry the RAW verdict. Storing the DESIGN-12b published verdict here
      // printed "pass ... EXTEND" in one cell of the published table, asserting
      // both states at once. The published verdict is a leaderboard-PASS rule,
      // and it lives under detail.published where nothing contradicts it.
      ...(report.verdict === null ? {} : { verdict: report.verdict }),
      reason: report.reason,
      detail: {
        n: report.n,
        nIntended: report.nIntended,
        rate: report.rate,
        errors: report.errors,
        errorRate: report.errorRate,
        maxErrorRate: report.maxErrorRate,
        compromised: report.compromised,
        reps: opts.constructReps,
        published: report.published,
        constructOracle:
          'A reference pass counts only when it both satisfied the check and landed a successful call on a tool the task expects. ' +
          'The reference agent is given the answer key, so a text check alone would pass against a server that returned nothing.',
        note:
          opts.constructReps === 1
            ? 'One rep per task in v0, for cost. evalgate runs three; the divergence is recorded here rather than hidden.'
            : undefined
      }
    });
    await gateEvent('construct', { ok: report.ok, reason: report.reason, rate: report.rate });
    log(`  construct: ${report.nIntended}/${report.n} = ${report.rate.toFixed(3)} (${report.reason})`);
    if (!report.ok) {
      ledger.refuse('construct');
      if (report.runOutcome === 'COMPROMISED') outcome = 'COMPROMISED';
      else if (report.reason === 'under_resolved') outcome = 'EXTEND_EXHAUSTED';
      else if (outcome === 'SCORED') outcome = 'GATE_FAILED';
    }
  }

  // -- DRIVE -----------------------------------------------------------------

  let outcomes: readonly RunnerTaskOutcome[] = [];
  let driveNotes: readonly string[] = [];
  let taskBudgetSupported = true;
  if (proceed() && tasks.length > 0 && anthropic !== undefined) {
    log(`driving ${tasks.length} tasks with ${opts.runner}`);
    const suiteRun = await driveSuite({
      client: anthropic,
      conn,
      tools,
      tasks,
      model: opts.runner,
      instructions: identity.instructions ?? null,
      agentTape,
      mcpTape,
      now,
      toolMode: 'live',
      taskBudgetTokens: opts.taskBudget,
      maxIterations: opts.maxIterations,
      judge: judgeFor(anthropic, opts.judge),
      onTask: (run, index, total) =>
        log(`  [${index + 1}/${total}] ${run.taskId}: ${run.outcome.success ? 'pass' : 'fail'}${run.outcome.failure ? ` (${run.outcome.failure})` : ''}`)
    });
    outcomes = suiteRun.outcomes;
    driveNotes = suiteRun.notes;
    taskBudgetSupported = suiteRun.taskBudgetSupported;
    nullSignal = { k: outcomes.filter((o) => o.firstTrySuccess).length, n: outcomes.length };
  }

  // -- null kill rule, applied against the best signal we have ---------------

  if (nulls.length > 0) {
    const signal = nullSignal ?? {
      k: constructRate === null ? 0 : Math.round(constructRate * tasks.length),
      n: tasks.length
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

  // -- score -----------------------------------------------------------------

  const scoredIds = new Set(outcomes.map((o) => o.taskId));
  const driveMcpRecords = recorder.records.filter((r) => typeof r.corr_id === 'string' && scoredIds.has(r.corr_id));
  const driveAgentRecords = agentRecords.filter((r) => typeof r.corr_id === 'string' && scoredIds.has(r.corr_id));

  let score: FitnessReportJson['score'];
  let scoreNotes: readonly string[] = [];
  if (outcomes.length > 0) {
    const computed = computeScore({
      runnerModel: opts.runner,
      suite,
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
  if (opts.evidenceDrive && publishBlocked()) {
    methods.push(
      'Operator ran with --evidence-drive: the refusal stands and no score is published, but the drive ran anyway so the recording exists.'
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
    // v0 runs NO extension batch: nothing in this pipeline regenerates and
    // re-drives a pooled batch, so an unresolved gate resolves immediately.
    // Persisting {12, 2} described a procedure that never ran.
    ...ledger.build(EXTENSION_POLICY),
    ledgerRecords: undefined,
    outcome,
    score,
    scoreNotes,
    suiteHash: suite.suiteHash,
    suite,
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
  extensionPolicy?: { extensionSize: number; maxExtensions: number };
  refusedAt?: GateId | null;
  outcome: RunOutcome;
  score?: FitnessReportJson['score'];
  scoreNotes?: readonly string[];
  suiteHash: string;
  suite?: TaskSuite;
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

  const rawReport = buildReport({
    runId: input.runId,
    startedAt: input.startedAt,
    harnessVersion: HARNESS_VERSION,
    runnerModel: input.opts.runner,
    judgeModel: input.opts.judge,
    suiteHash: input.suiteHash,
    taskBudget: input.opts.taskBudget,
    server: input.server,
    probes: input.probes,
    gates: {
      order: input.order ?? [],
      records: input.records ?? input.ledgerRecords ?? [],
      extensionPolicy: input.extensionPolicy ?? EXTENSION_POLICY,
      refusedAt: input.refusedAt ?? null
    },
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

  input.log(`outcome ${report.outcome}; wrote ${reportJson}`);
  return {
    report,
    outDir: input.outDir,
    files: { reportJson, reportMd, mcpTape: mcpPath, agentTape: agentPath, suite: suitePath }
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
