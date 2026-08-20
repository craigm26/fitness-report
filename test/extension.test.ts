/**
 * The pre-registered extension protocol, and the measured judge spend.
 *
 * evalgate doctrine, quoted in src/gates/gates.ts and in DESIGN decision 11:
 * "EXTEND is not a loophole. The extension size and the maximum number of
 * extensions are fixed in the pre-registration alongside n; after the last
 * extension an unresolved gate resolves to FAIL." METHODS: "No optional
 * stopping. A run completes its registered size or is void."
 *
 * These tests run the WHOLE pipeline against the real canary with the model
 * scripted, because the parts of this protocol that can go wrong are wiring:
 * whether the derived seed reaches the generator, whether a batch is put through
 * the same free gates the original suite passed, whether the extension tasks are
 * measured by the same null models before they are counted, whether k and n are
 * pooled rather than re-decided per batch, and whether the drive and the score
 * cover the suite the run actually bought.
 *
 * Every expectation about the gate arithmetic is derived from `verdict()`
 * itself, never from arithmetic written in a test, so a test can never assert a
 * threshold the gate does not implement.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { start, type CanaryHandle } from '../canary/server.js';
import {
  EXTENSION_POLICY,
  JudgeMeter,
  freeGateScreen,
  parseArgs,
  poolConstruct,
  resolveConstruct,
  runPipeline,
  type ModelClient
} from '../src/cli.js';
import { verdict } from '../src/gates/gates.js';
import { structural } from '../src/gates/structural.js';
import { defaultMethodsNotes, extensionCopy } from '../src/report/render.js';
import { estimateCostUsd, resolvePrice } from '../src/score/stats.js';
import { computePooledSuiteHash, extensionSeed, taskContentKey } from '../src/tasks/synthesize.js';
import type {
  ExtensionEvidence,
  ExtensionPolicy,
  FitnessTask,
  GateLedger,
  TapeLine
} from '../src/types.js';

let canary: CanaryHandle;
let dir: string;

beforeAll(async () => {
  canary = await start(0);
  dir = await mkdtemp(join(tmpdir(), 'fitness-extension-'));
}, 30_000);

afterAll(async () => {
  await canary?.close();
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The scripted model
// ---------------------------------------------------------------------------

const JUDGE_MODEL = 'claude-opus-5';
const RUNNER_MODEL = 'claude-sonnet-5';
const JUDGE_USAGE = { input_tokens: 900, output_tokens: 1300 };
const SCREEN_USAGE = { input_tokens: 40, output_tokens: 6 };

interface Script {
  /** Tasks to emit, keyed by the SEED the generation prompt carries. */
  suites: Readonly<Record<string, readonly (string | TaskSpec)[]>>;
  /** Task ids the runner answers wrongly, in the reference pass and the drive. */
  failing?: ReadonlySet<string>;
  /** Strip the usage block off every judge response. */
  withoutUsage?: boolean;
}

function judgeMessage(text: string, model: string, usage: object | undefined): Anthropic.Message {
  return {
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    ...(usage === undefined ? {} : { usage })
  } as unknown as Anthropic.Message;
}

interface TaskSpec {
  id: string;
  /**
   * Appended to the prompt TEMPLATE, before rendering. `{{unbound}}` here
   * survives into the rendered prompt, which is exactly what the structural
   * property forbids and what the generator itself deliberately does not check
   * (see the docstring on `unresolvedPlaceholders`).
   */
  templateSuffix?: string;
}

/** `t1` and `{ id: 't1' }` mean the same thing, so old call sites stay put. */
function specOf(entry: string | TaskSpec): TaskSpec {
  return typeof entry === 'string' ? { id: entry } : entry;
}

/**
 * A suite payload over the canary's real `get_invoice`.
 *
 * The task id is IN the prompt, which is how the scripted runner knows which
 * task it is being asked to do, and the answer key is a nonsense token that
 * cannot collide with the prompt, the tool descriptions or the server
 * instructions (all three are answer-leak corpora).
 */
function payload(entries: readonly (string | TaskSpec)[]): string {
  return JSON.stringify({
    tasks: entries.map(specOf).map((spec) => ({
      id: spec.id,
      promptTemplate:
        'Task {{tid}}: fetch invoice inv_1001 and report its status.' + (spec.templateSuffix ?? ''),
      params: [{ name: 'tid', value: spec.id }],
      expectedTools: ['get_invoice'],
      check: { kind: 'substring', where: 'final_text', value: 'status: open' },
      answerKey: `zzq-${spec.id}`,
      destructive: false,
      serverRequiredBecause: 'volatile'
    }))
  });
}

function scriptedClient(script: Script): ModelClient {
  const usage = (u: object): object | undefined => (script.withoutUsage === true ? undefined : u);
  return {
    messages: {
      async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
        const system = typeof params.system === 'string' ? params.system : '';
        const asked = JSON.stringify(params.messages);
        // The generation-time null screen: a cold model that knows nothing about
        // this canary's invoices, so every candidate survives it.
        if (system.includes('You have no tools available')) {
          return judgeMessage('UNKNOWN', RUNNER_MODEL, usage(SCREEN_USAGE));
        }
        if (asked.includes('Rubric:')) return judgeMessage('PASS', JUDGE_MODEL, usage(JUDGE_USAGE));
        // Keyed on the SEED the prompt carries: this is what proves the derived
        // seed (seed + 1000 * index) actually reached the generator, rather than
        // the batch being the original suite regenerated.
        const seed = /Seed: (\d+)/.exec(asked)?.[1] ?? '';
        const ids = script.suites[seed];
        if (ids === undefined) throw new Error(`no scripted suite for seed ${seed}`);
        return judgeMessage(payload(ids), JUDGE_MODEL, usage(JUDGE_USAGE));
      }
    },
    beta: {
      messages: {
        toolRunner(body: Anthropic.Beta.Messages.BetaToolRunnerParams) {
          const messages = [...body.messages];
          const prompt = String(body.messages[0]?.content ?? '');
          const taskId = /^Task ([a-z0-9-]+):/.exec(prompt)?.[1] ?? '';
          const tools = body.tools.filter(
            (t): t is Anthropic.Beta.BetaTool & { run: (a: unknown) => unknown } => 'run' in t
          );
          return {
            get params() {
              return { ...body, messages } as Anthropic.Beta.Messages.BetaToolRunnerParams;
            },
            async *[Symbol.asyncIterator]() {
              const tool = tools.find((t) => t.name === 'get_invoice');
              let observed = '';
              if (tool !== undefined) {
                const content = [
                  { type: 'tool_use', id: 'tu_1', name: 'get_invoice', input: { invoice_id: 'inv_1001' } }
                ];
                messages.push({ role: 'assistant', content: content as never });
                yield {
                  id: 'msg_1',
                  type: 'message',
                  role: 'assistant',
                  model: RUNNER_MODEL,
                  content,
                  stop_reason: 'tool_use',
                  usage: { input_tokens: 50, output_tokens: 30 }
                } as unknown as Anthropic.Beta.BetaMessage;
                let result: unknown;
                try {
                  result = await tool.run({ invoice_id: 'inv_1001' });
                } catch (error) {
                  result = error instanceof Error ? error.message : String(error);
                }
                observed = JSON.stringify(result);
                messages.push({
                  role: 'user',
                  content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: result }] as never
                });
              }
              // The answer is derived from what the SERVER returned, so a null
              // model that gets nothing back cannot fabricate a pass.
              const status = /\\?"status\\?":\\?"([a-z]+)/.exec(observed)?.[1] ?? 'unknown';
              const failed = tool === undefined || script.failing?.has(taskId) === true;
              const text = [
                {
                  type: 'text',
                  text: failed ? 'I could not determine the status.' : `Invoice inv_1001 status: ${status}`
                }
              ];
              messages.push({ role: 'assistant', content: text as never });
              yield {
                id: 'msg_2',
                type: 'message',
                role: 'assistant',
                model: RUNNER_MODEL,
                content: text,
                stop_reason: 'end_turn',
                usage: { input_tokens: 60, output_tokens: 25 }
              } as unknown as Anthropic.Beta.BetaMessage;
            }
          };
        }
      }
    }
  };
}

const ORIGINAL_IDS = Array.from({ length: 12 }, (_, i) => `t${i + 1}`);
const BATCH1_IDS = Array.from({ length: 6 }, (_, i) => `x${i + 1}`);
const BATCH2_IDS = Array.from({ length: 6 }, (_, i) => `y${i + 1}`);

async function readTape(path: string): Promise<TapeLine[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as TapeLine);
}

// ---------------------------------------------------------------------------
// The arithmetic, taken from the gate itself
// ---------------------------------------------------------------------------

describe('pooled verdict math', () => {
  it('pools k and n and re-applies the SAME three outcome rule', () => {
    const pooled = poolConstruct([
      { n: 12, nIntended: 10, errors: 0 },
      { n: 6, nIntended: 6, errors: 0 }
    ]);
    expect(pooled).toMatchObject({ k: 16, n: 18, errors: 0 });
    // Not "16/18 rounded"; the actual object the gate would have produced.
    expect(pooled.verdict).toEqual(verdict(16, 18, 0.9));
  });

  it('does not treat 16 of 18 as a pass, because the rule does not', () => {
    // 0.888... is BELOW the 0.90 threshold, and the exact binomial cannot rule
    // out clearing it, so this is EXTEND and buys another extension rather than
    // publishing. Written from the real function on purpose: an eyeballed
    // "16/18 is basically 0.9" is exactly the reasoning the gate exists to stop.
    expect(verdict(16, 18, 0.9).outcome).toBe('EXTEND');
    expect(poolConstruct([{ n: 18, nIntended: 16, errors: 0 }]).reason).toBe('under_resolved');
  });

  it('resolves the pooled counts a full two-extension run produces', () => {
    const pooled = poolConstruct([
      { n: 12, nIntended: 10, errors: 0 },
      { n: 6, nIntended: 6, errors: 0 },
      { n: 6, nIntended: 6, errors: 0 }
    ]);
    expect(pooled).toMatchObject({ k: 22, n: 24 });
    expect(pooled.verdict).toEqual(verdict(22, 24, 0.9));
    expect(pooled.verdict?.outcome).toBe('PASS');
    expect(pooled.ok).toBe(true);
    // The DESIGN 12b publication rule is computed on the pooled counts too, and
    // it still downgrades: n = 24 is nowhere near the planned n. `ok` is the RAW
    // verdict, so the gate passes and the leaderboard claim stays honest.
    expect(pooled.published?.rawOutcome).toBe('PASS');
    expect(pooled.published?.outcome).toBe('EXTEND');
    expect(pooled.published?.downgraded).toBe(true);
  });

  it('pools oracle errors too, so divergence 12a survives the extension', () => {
    const pooled = poolConstruct([
      { n: 12, nIntended: 12, errors: 0 },
      { n: 4, nIntended: 4, errors: 3 }
    ]);
    expect(pooled.errors).toBe(3);
    expect(pooled.errorRate).toBeCloseTo(3 / 19, 12);
    expect(pooled.compromised).toBe(true);
    expect(pooled.reason).toBe('compromised');
    expect(pooled.ok).toBe(false);
  });

  it('reports no_cases rather than a rate when nothing completed', () => {
    const pooled = poolConstruct([{ n: 0, nIntended: 0, errors: 0 }]);
    expect(pooled.reason).toBe('no_cases');
    expect(pooled.verdict).toBeNull();
    expect(pooled.rate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The doctrine, as a decision
// ---------------------------------------------------------------------------

describe('extension doctrine', () => {
  const under = { ok: false, reason: 'under_resolved' as const, compromised: false };

  it('registers one policy, frozen, reachable by no flag', () => {
    expect(EXTENSION_POLICY).toEqual({ extensionSize: 6, maxExtensions: 2 });
    // A policy any code path could raise after seeing a verdict is optional
    // stopping wearing a constant's name.
    expect(Object.isFrozen(EXTENSION_POLICY)).toBe(true);
    const flags = [
      '--extension-size',
      '--max-extensions',
      '--extend',
      '--extensions'
    ];
    for (const flag of flags) {
      expect(() => parseArgs(['run', 'https://x.test/mcp', flag, '6'])).toThrow(/unknown flag/);
    }
  });

  it('extends while extensions remain', () => {
    const r = resolveConstruct({
      pooled: under,
      policy: { extensionSize: 6, maxExtensions: 2 },
      extensionsConsumed: 0,
      blocked: false
    });
    expect(r).toMatchObject({ extend: true, reason: 'under_resolved', resolvedToFail: false, outcome: null });
  });

  it('resolves an unresolved gate to FAIL after the last extension', () => {
    const r = resolveConstruct({
      pooled: under,
      policy: { extensionSize: 6, maxExtensions: 2 },
      extensionsConsumed: 2,
      blocked: false
    });
    expect(r.extend).toBe(false);
    expect(r.resolvedToFail).toBe(true);
    expect(r.reason).toBe('unresolved_after_max_extensions');
    // FAIL, not "we ran out of extensions and therefore cannot say".
    expect(r.outcome).toBe('GATE_FAILED');
    expect(r.outcome).not.toBe('EXTEND_EXHAUSTED');
  });

  it('never extends under a zero-extension pre-registration', () => {
    for (const policy of [
      { extensionSize: 0, maxExtensions: 0 },
      { extensionSize: 6, maxExtensions: 0 },
      { extensionSize: 0, maxExtensions: 2 }
    ]) {
      const r = resolveConstruct({ pooled: under, policy, extensionsConsumed: 0, blocked: false });
      expect(r.extend).toBe(false);
      // The ONLY surviving use of EXTEND_EXHAUSTED: there was never an
      // extension to exhaust, so the gate resolved on its first evaluation.
      expect(r.outcome).toBe('EXTEND_EXHAUSTED');
      expect(r.resolvedToFail).toBe(false);
    }
  });

  it('buys nothing for a run that a gate has already refused', () => {
    const r = resolveConstruct({
      pooled: under,
      policy: { extensionSize: 6, maxExtensions: 2 },
      extensionsConsumed: 0,
      blocked: true
    });
    expect(r.extend).toBe(false);
    expect(r.reason).toBe('under_resolved_not_extended');
    expect(r.outcome).toBeNull();
  });

  it('passes and fails without touching the extension budget', () => {
    const policy = { extensionSize: 6, maxExtensions: 2 };
    expect(
      resolveConstruct({
        pooled: { ok: true, reason: 'ok', compromised: false },
        policy,
        extensionsConsumed: 0,
        blocked: false
      })
    ).toMatchObject({ extend: false, reason: 'ok', outcome: null });
    expect(
      resolveConstruct({
        pooled: { ok: false, reason: 'below_min_rate', compromised: false },
        policy,
        extensionsConsumed: 0,
        blocked: false
      })
    ).toMatchObject({ extend: false, reason: 'below_min_rate', outcome: 'GATE_FAILED' });
  });

  it('derives every batch seed from the registered seed, 1-based', () => {
    expect(extensionSeed(1, 1)).toBe(1001);
    expect(extensionSeed(1, 2)).toBe(2001);
    expect(extensionSeed(7, 1)).toBe(1007);
    // A 0-based index would hand extension 1 the original suite's own seed.
    expect(() => extensionSeed(1, 0)).toThrow(/>= 1/);
  });
});

// ---------------------------------------------------------------------------
// The loop, end to end
// ---------------------------------------------------------------------------

describe('the extension loop against the canary', () => {
  it('extends twice, pools to a PASS, and scores the FULL pooled suite', async () => {
    const out = join(dir, 'extend-pass');
    const result = await runPipeline(
      { ...parseArgs(['run', canary.url]), out, constructReps: 1 },
      {
        anthropic: scriptedClient({
          suites: { '1': ORIGINAL_IDS, '1001': BATCH1_IDS, '2001': BATCH2_IDS },
          // 10 of 12 on the registered suite: EXTEND, which is what buys the
          // first batch.
          failing: new Set(['t11', 't12'])
        }),
        log: () => undefined
      }
    );

    expect(result.report.outcome).toBe('SCORED');
    expect(result.report.gates.extensionPolicy).toEqual({ extensionSize: 6, maxExtensions: 2 });

    const extensions = result.report.gates.extensions as readonly ExtensionEvidence[];
    expect(extensions).toHaveLength(2);

    // Extension 1: derived seed, its own batch hash, six new task ids, and the
    // pooled counts on both sides of it.
    expect(extensions[0]).toMatchObject({
      index: 1,
      gate: 'construct',
      seed: 1001,
      generated: 6,
      admitted: 6,
      short: false,
      pooledBefore: { k: 10, n: 12 },
      pooledAfter: { k: 16, n: 18 },
      verdictBefore: 'EXTEND',
      verdictAfter: 'EXTEND'
    });
    expect(extensions[0]?.taskIds).toEqual(BATCH1_IDS.map((id) => `e1-${id}`));
    expect(typeof extensions[0]?.batchSuiteHash).toBe('string');

    // Extension 2 is what resolves it, and the resolution is the POOLED verdict.
    expect(extensions[1]).toMatchObject({
      index: 2,
      seed: 2001,
      pooledBefore: { k: 16, n: 18 },
      pooledAfter: { k: 22, n: 24 },
      verdictAfter: 'PASS'
    });
    expect(extensions[0]?.batchSuiteHash).not.toBe(extensions[1]?.batchSuiteHash);

    const construct = result.report.gates.records.find((r) => r.gate === 'construct');
    expect(construct?.ok).toBe(true);
    expect(construct?.reason).toBe('ok');
    expect(construct?.verdict).toEqual(verdict(22, 24, 0.9));
    expect(construct?.detail).toMatchObject({
      n: 24,
      nIntended: 22,
      pooled: { k: 22, n: 24, extensionsConsumed: 2, extensionsRemaining: 0 }
    });

    // The DRIVE and the SCORE cover the pooled suite, not the registered one.
    const score = result.report.score;
    expect(score?.firstTrySuccess.n).toBe(24);
    expect(score?.firstTrySuccess.k).toBe(22);
    expect(score?.tasks).toHaveLength(24);
    expect(score?.tasks.map((t) => t.taskId)).toContain('e2-y6');

    // Extension tasks are recorded under their OWN corr ids, exactly like
    // original tasks: same wire frames, same event lines, no special casing.
    const mcp = await readTape(result.files.mcpTape);
    const extensionFrames = mcp.filter((l) => (l as { corr_id?: string }).corr_id === 'e1-x1');
    expect(extensionFrames.length).toBeGreaterThan(0);
    const toolCalls = mcp.filter(
      (l) =>
        (l as { raw?: { method?: string } }).raw?.method === 'tools/call' &&
        (l as { corr_id?: string }).corr_id === 'e2-y1'
    );
    expect(toolCalls.length).toBeGreaterThan(0);
    // One `fitness.extension` event per consumed extension, payload in `raw`.
    const events = mcp.filter((l) => (l as { kind?: string }).kind === 'fitness.extension');
    expect(events).toHaveLength(2);
    expect((events[0] as { dir?: string }).dir).toBe('event');
    expect((events[0] as { raw?: { index?: number } }).raw?.index).toBe(1);
    expect((events[0] as { data?: unknown }).data).toBeUndefined();

    // The extension tasks were measured by the same three null models BEFORE
    // they could be counted, so the null gate saw the whole pooled suite.
    const nullRecord = result.report.gates.records.find((r) => r.gate === 'null_baseline');
    const nullDetail = nullRecord?.detail as { rates: readonly { label: string; k: number; n: number }[] };
    expect(nullDetail.rates.map((r) => r.label)).toEqual([
      'no-tools',
      'stubbed-empty',
      'random-valid-args'
    ]);
    // Every null model saw all 24 pooled tasks, not the 12 the run registered.
    for (const row of nullDetail.rates) expect(row.n).toBe(24);
    expect(nullRecord?.ok).toBe(true);

    const md = await readFile(result.files.reportMd, 'utf8');
    expect(md).toContain('6 new tasks per extension, at most 2');
    expect(md).toContain('resolves to FAIL');
    expect(md).not.toContain('no extension batches are run in v0');
    expect(md).not.toContain('—');
  }, 240_000);

  it('records the lineage of the pooled suite in suite-meta.json', async () => {
    const out = join(dir, 'lineage');
    const result = await runPipeline(
      { ...parseArgs(['run', canary.url]), out, constructReps: 1 },
      {
        anthropic: scriptedClient({
          suites: { '1': ORIGINAL_IDS, '1001': BATCH1_IDS, '2001': BATCH2_IDS },
          failing: new Set(['t11', 't12'])
        }),
        log: () => undefined
      }
    );

    const meta = JSON.parse(await readFile(result.files.suiteMeta!, 'utf8')) as {
      suiteHash: string;
      extension: {
        policy: { extensionSize: number; maxExtensions: number };
        originalSuiteHash: string;
        pooledSuiteHash: string;
        tapeConfigHash: string;
        originalTaskIds: string[];
        batches: { index: number; seed: number; batchSuiteHash: string; taskIds: string[] }[];
      };
    };

    const lineage = meta.extension;
    expect(lineage.policy).toEqual({ extensionSize: 6, maxExtensions: 2 });
    expect(lineage.batches.map((b) => b.seed)).toEqual([1001, 2001]);
    expect(lineage.originalTaskIds).toEqual(ORIGINAL_IDS);
    expect(lineage.originalSuiteHash).not.toBe(lineage.pooledSuiteHash);

    // The published hash covers the POOLED set, and the lineage is its preimage:
    // a reader holding suite.json and this file can recompute it.
    expect(result.report.run.suiteHash).toBe(lineage.pooledSuiteHash);
    const suite = JSON.parse(await readFile(result.files.suite!, 'utf8')) as {
      suiteHash: string;
      tasks: { id: string }[];
    };
    expect(suite.tasks).toHaveLength(24);
    expect(suite.suiteHash).toBe(lineage.pooledSuiteHash);
    expect(
      computePooledSuiteHash({
        originalSuiteHash: lineage.originalSuiteHash,
        batchSuiteHashes: lineage.batches.map((b) => b.batchSuiteHash),
        tasks: suite.tasks as never
      })
    ).toBe(lineage.pooledSuiteHash);

    // The TAPES keep the pre-extension hash: a recording is written as it
    // happens and is never rewritten to match a later decision. The lineage says
    // so out loud rather than leaving a reader to find the mismatch.
    const mcp = await readTape(result.files.mcpTape);
    const producer = (mcp[0] as { producer?: { configHash?: string } }).producer;
    expect(producer?.configHash).toBe(lineage.tapeConfigHash);
    expect(lineage.tapeConfigHash).toBe(lineage.originalSuiteHash);
    const md = await readFile(result.files.reportMd, 'utf8');
    expect(md).toContain('producer.configHash');
  }, 240_000);

  it('consumes the extension even when the batch comes back short', async () => {
    const out = join(dir, 'short-batch');
    const result = await runPipeline(
      { ...parseArgs(['run', canary.url]), out, constructReps: 1 },
      {
        anthropic: scriptedClient({
          // The generator returns TWO tasks where six were registered. The batch
          // is used at whatever size survived; it is never re-asked, because
          // asking again until a full batch arrives is optional stopping.
          suites: { '1': ORIGINAL_IDS, '1001': BATCH1_IDS.slice(0, 2), '2001': BATCH2_IDS },
          failing: new Set(['t11', 't12'])
        }),
        log: () => undefined
      }
    );

    const extensions = result.report.gates.extensions as readonly ExtensionEvidence[];
    expect(extensions).toHaveLength(2);
    expect(extensions[0]).toMatchObject({
      index: 1,
      generated: 2,
      admitted: 2,
      short: true,
      pooledBefore: { k: 10, n: 12 },
      pooledAfter: { k: 12, n: 14 }
    });
    // The short batch STILL counts against the budget, and its two tasks are in
    // the pool: n went to 14, not back to 12 and not up to 18.
    expect(extensions[1]?.index).toBe(2);
    expect(extensions[1]?.pooledBefore).toEqual({ k: 12, n: 14 });

    const construct = result.report.gates.records.find((r) => r.gate === 'construct');
    expect(construct?.detail).toMatchObject({ n: 20, nIntended: 18 });
    expect(construct?.verdict).toEqual(verdict(18, 20, 0.9));
    expect(result.report.score?.firstTrySuccess.n).toBe(20);

    const md = await readFile(result.files.reportMd, 'utf8');
    expect(md).toContain('(short)');
  }, 240_000);

  it('resolves to FAIL, not EXTEND_EXHAUSTED, after the last extension', async () => {
    const out = join(dir, 'extend-fail');
    const result = await runPipeline(
      { ...parseArgs(['run', canary.url]), out, constructReps: 1 },
      {
        anthropic: scriptedClient({
          suites: { '1': ORIGINAL_IDS, '1001': BATCH1_IDS, '2001': BATCH2_IDS },
          // Every batch lands one short of resolving, so both extensions are
          // consumed and the gate is still under-resolved at the end.
          failing: new Set(['t11', 't12', 'x6', 'y6'])
        }),
        log: () => undefined
      }
    );

    const extensions = result.report.gates.extensions as readonly ExtensionEvidence[];
    expect(extensions).toHaveLength(2);
    expect(extensions[1]?.pooledAfter).toEqual({ k: 20, n: 24 });
    expect(verdict(20, 24, 0.9).outcome).toBe('EXTEND');

    // THE HEADLINE. The data never resolved, the pre-registration is spent, so
    // the gate FAILS. It does not extend again, and it does not report a
    // third state that quietly means "no answer".
    expect(result.report.gates.refusedAt).toBe('construct');
    expect(result.report.outcome).toBe('GATE_FAILED');
    expect(result.report.outcome).not.toBe('EXTEND_EXHAUSTED');
    expect('score' in result.report).toBe(false);

    const construct = result.report.gates.records.find((r) => r.gate === 'construct');
    expect(construct?.ok).toBe(false);
    expect(construct?.reason).toBe('unresolved_after_max_extensions');
    expect(construct?.detail).toMatchObject({
      resolvedToFail: true,
      pooled: { extensionsConsumed: 2, extensionsRemaining: 0 }
    });
    // The row still carries the RAW pooled verdict, which is what `ok` came
    // from. The FAIL is the protocol resolving it, not the binomial claiming it.
    expect(construct?.verdict?.outcome).toBe('EXTEND');

    const md = await readFile(result.files.reportMd, 'utf8');
    expect(md).toContain('## Result: REFUSED');
    expect(md).toContain('unresolved_after_max_extensions');
  }, 240_000);

  it('runs no extension at all when the gate resolves on the registered suite', async () => {
    const out = join(dir, 'no-extension');
    const result = await runPipeline(
      { ...parseArgs(['run', canary.url]), out, constructReps: 1 },
      { anthropic: scriptedClient({ suites: { '1': ORIGINAL_IDS } }), log: () => undefined }
    );

    expect(result.report.outcome).toBe('SCORED');
    // Absent, not an empty array: an empty array reads as "the protocol ran and
    // bought nothing", which is a different claim from "it never fired".
    expect('extensions' in result.report.gates).toBe(false);
    expect(result.report.score?.firstTrySuccess.n).toBe(12);
    const construct = result.report.gates.records.find((r) => r.gate === 'construct');
    expect(construct?.detail).toMatchObject({ n: 12, pooled: { extensionsConsumed: 2 - 2 } });
    const md = await readFile(result.files.reportMd, 'utf8');
    expect(md).toContain('No extension was consumed on this run.');
  }, 240_000);
});

// ---------------------------------------------------------------------------
// Measured judge spend
// ---------------------------------------------------------------------------

describe('judge usage', () => {
  it('aggregates every judge exchange per model and per phase', async () => {
    const out = join(dir, 'judge-usage');
    const result = await runPipeline(
      { ...parseArgs(['run', canary.url]), out, constructReps: 1 },
      { anthropic: scriptedClient({ suites: { '1': ORIGINAL_IDS } }), log: () => undefined }
    );

    const usage = result.report.run.judgeUsage;
    expect(usage).toBeDefined();
    // One synthesis call plus one cold screen probe per validated candidate.
    expect(usage?.byPhase.find((p) => p.phase === 'synthesis')?.calls).toBe(1);
    expect(usage?.byPhase.find((p) => p.phase === 'null_screen')?.calls).toBe(12);
    expect(usage?.calls).toBe(13);
    expect(usage?.inputTokens).toBe(JUDGE_USAGE.input_tokens + 12 * SCREEN_USAGE.input_tokens);
    expect(usage?.outputTokens).toBe(JUDGE_USAGE.output_tokens + 12 * SCREEN_USAGE.output_tokens);
    expect(usage?.uncountedCalls).toBe(0);
    expect(usage?.failedCalls).toBe(0);
    expect(usage?.model).toBe(JUDGE_MODEL);

    // The screen runs on the RUNNER model, so it must never be priced as the
    // judge. Two rows, two price rows, and the total is their sum.
    const judgeRow = usage?.byModel.find((m) => m.model === JUDGE_MODEL);
    const screenRow = usage?.byModel.find((m) => m.model === RUNNER_MODEL);
    expect(judgeRow?.calls).toBe(1);
    expect(screenRow?.calls).toBe(12);
    const expectedJudge = estimateCostUsd(
      { input_tokens: JUDGE_USAGE.input_tokens, output_tokens: JUDGE_USAGE.output_tokens },
      resolvePrice(JUDGE_MODEL)
    );
    const expectedScreen = estimateCostUsd(
      { input_tokens: 12 * SCREEN_USAGE.input_tokens, output_tokens: 12 * SCREEN_USAGE.output_tokens },
      resolvePrice(RUNNER_MODEL)
    );
    expect(judgeRow?.estCostUsd).toBeCloseTo(expectedJudge!, 12);
    expect(screenRow?.estCostUsd).toBeCloseTo(expectedScreen!, 12);
    expect(usage?.estCostUsd).toBeCloseTo(expectedJudge! + expectedScreen!, 12);
    expect(usage?.partial).toBe(false);

    const md = await readFile(result.files.reportMd, 'utf8');
    expect(md).toContain('Judge spend:');
    expect(result.report.methods?.some((m) => m.includes('trace cost'))).toBe(true);
  }, 240_000);

  it('counts every extension batch and its screen probes', async () => {
    const out = join(dir, 'judge-usage-extended');
    const result = await runPipeline(
      { ...parseArgs(['run', canary.url]), out, constructReps: 1 },
      {
        anthropic: scriptedClient({
          suites: { '1': ORIGINAL_IDS, '1001': BATCH1_IDS, '2001': BATCH2_IDS },
          failing: new Set(['t11', 't12'])
        }),
        log: () => undefined
      }
    );

    const usage = result.report.run.judgeUsage;
    expect(usage?.byPhase.find((p) => p.phase === 'extension_synthesis')?.calls).toBe(2);
    // 12 for the registered suite plus 6 for each batch.
    expect(usage?.byPhase.find((p) => p.phase === 'null_screen')?.calls).toBe(24);
    expect(usage?.calls).toBe(1 + 2 + 24);
  }, 240_000);

  it('counts a response with no usage block as uncounted, never as zero cost', async () => {
    const meter = new JudgeMeter(
      {
        messages: {
          async create(): Promise<Anthropic.Message> {
            return judgeMessage('ok', JUDGE_MODEL, undefined);
          }
        }
      },
      JUDGE_MODEL
    );
    await meter.as('synthesis').messages.create({ model: JUDGE_MODEL, max_tokens: 10, messages: [] });
    const usage = meter.summary();
    expect(usage?.calls).toBe(1);
    expect(usage?.uncountedCalls).toBe(1);
    expect(usage?.inputTokens).toBe(0);
    // No usage means no priceable tokens, so there is no dollar figure at all.
    expect(usage?.estCostUsd).toBeNull();
    expect(usage?.partial).toBe(true);
    expect(usage?.notes.some((n) => n.includes('no usage block'))).toBe(true);
  });

  it('prices nothing it cannot price, and says the total is a floor', async () => {
    const meter = new JudgeMeter(
      {
        messages: {
          async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
            return judgeMessage('ok', String(params.model), { input_tokens: 1000, output_tokens: 1000 });
          }
        }
      },
      JUDGE_MODEL
    );
    const client = meter.as('rubric');
    await client.messages.create({ model: JUDGE_MODEL, max_tokens: 10, messages: [] });
    await client.messages.create({ model: 'claude-from-the-future-9', max_tokens: 10, messages: [] });
    const usage = meter.summary();
    expect(usage?.calls).toBe(2);
    expect(usage?.byModel.find((m) => m.model === 'claude-from-the-future-9')?.estCostUsd).toBeNull();
    expect(usage?.partial).toBe(true);
    expect(usage?.notes.some((n) => n.includes('lower bound'))).toBe(true);
    // The priced half is still reported: a run that drops what it CAN measure is
    // no more honest than one that guesses what it cannot.
    expect(usage?.estCostUsd).toBeCloseTo(
      estimateCostUsd({ input_tokens: 1000, output_tokens: 1000 }, resolvePrice(JUDGE_MODEL))!,
      12
    );
  });

  it('counts a call that threw, and never invents its tokens', async () => {
    const meter = new JudgeMeter(
      {
        messages: {
          async create(): Promise<Anthropic.Message> {
            throw new Error('judge unreachable');
          }
        }
      },
      JUDGE_MODEL
    );
    await expect(
      meter.as('synthesis').messages.create({ model: JUDGE_MODEL, max_tokens: 10, messages: [] })
    ).rejects.toThrow(/unreachable/);
    const usage = meter.summary();
    expect(usage?.calls).toBe(0);
    expect(usage?.failedCalls).toBe(1);
    expect(usage?.estCostUsd).toBeNull();
    expect(usage?.notes.some((n) => n.includes('threw'))).toBe(true);
  });

  it('meters the streaming path when the client offers one, and leaves stubs alone', async () => {
    let streamed = 0;
    const meter = new JudgeMeter(
      {
        messages: {
          async create(): Promise<Anthropic.Message> {
            throw new Error('create must not be used when stream exists');
          },
          stream() {
            streamed += 1;
            return {
              async finalMessage(): Promise<Anthropic.Message> {
                return judgeMessage('ok', JUDGE_MODEL, { input_tokens: 10, output_tokens: 20 });
              }
            };
          }
        }
      },
      JUDGE_MODEL
    );
    const client = meter.as('synthesis');
    expect(typeof client.messages.stream).toBe('function');
    await client.messages.stream!({ model: JUDGE_MODEL, max_tokens: 10, messages: [] }).finalMessage();
    expect(streamed).toBe(1);
    expect(meter.summary()?.inputTokens).toBe(10);

    // A stub with no stream must not grow one, or askJudge would take a path the
    // stub cannot serve.
    const plain = new JudgeMeter(
      { messages: { async create(): Promise<Anthropic.Message> { return judgeMessage('ok', JUDGE_MODEL, undefined); } } },
      JUDGE_MODEL
    );
    expect(plain.as('synthesis').messages.stream).toBeUndefined();
  });

  it('is absent, not zero, when no judge call was made', () => {
    const meter = new JudgeMeter(
      { messages: { async create(): Promise<Anthropic.Message> { return judgeMessage('x', JUDGE_MODEL, undefined); } } },
      JUDGE_MODEL
    );
    expect(meter.summary()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FINDING 1: the free gates are SYMMETRIC across the registered suite and a
// bought batch. FINDING 2: the pool is deduped on content, never on id.
// ---------------------------------------------------------------------------

/**
 * The batch screen, as a decision.
 *
 * These run against the pure function rather than the pipeline because two of
 * the three refusing inputs cannot be produced end to end: `synthesizeTaskSuite`
 * drops a leaking candidate itself, over the same corpus the pipeline rescans
 * (rendered prompt, bound params, server instructions, tool descriptions), so no
 * scripted generator can hand the loop a leak through the real path. The rule
 * still has to hold, and the pipeline is wired to this exact function, so it is
 * pinned here and the reachable half (an unbound placeholder, which the
 * generator deliberately does NOT check) is pinned end to end below.
 */
describe('extension batch free gates', () => {
  const SURFACE = [{ name: 'get_invoice' }, { name: 'lookup_user' }];
  const CORPUS = { context: ['This canary exposes invoice tools for testing.'] };
  const screener = freeGateScreen({ tools: SURFACE, leakCorpus: CORPUS });

  function task(over: Partial<FitnessTask> & { id: string }): FitnessTask {
    return {
      id: over.id,
      prompt: over.prompt ?? 'Fetch invoice inv_1001 and report its status.',
      expectedTools: over.expectedTools ?? ['get_invoice'],
      check: over.check ?? { kind: 'substring', where: 'final_text', value: 'status: open' },
      destructive: over.destructive ?? false,
      ...(over.answerKey === undefined ? {} : { answerKey: over.answerKey })
    };
  }

  const clean = task({ id: 'c1', prompt: 'Fetch invoice inv_1002 and report its status.', answerKey: 'zzq-c1' });

  /**
   * The registered-suite half of the symmetry, taken from the gate itself: the
   * structural gate runs `admissible` as its `holds` predicate, and one task
   * that does not hold is `property_violated`, which refuses the run.
   */
  function registeredSuiteWould(offender: FitnessTask): string {
    const report = structural(
      (seed) => (seed === 0 ? offender : null),
      screener.admissible,
      { n: 1, minGenerated: 1, minAdmissionRate: 0 }
    );
    return report.ok ? 'ok' : report.reason;
  }

  it('REFUSES on an answer key inside a batch, exactly as the registered suite does', () => {
    const leaking = task({
      id: 'l1',
      prompt: 'Fetch invoice inv_1001. Its status is overdue, confirm that.',
      answerKey: 'overdue'
    });

    // The registered suite refuses this task. That is the behaviour a batch has
    // to match, and the assertion comes from `structural` rather than from a
    // sentence written in this test.
    expect(screener.admissible(leaking)).toBe(false);
    expect(registeredSuiteWould(leaking)).toBe('property_violated');

    const screen = screener.screenBatch({ index: 1, tasks: [leaking, clean], pooled: [] });
    expect(screen.refused).toBe(true);
    expect(screen.violations).toHaveLength(1);
    expect(screen.violations[0]).toMatchObject({
      gate: 'extension_answer_leak',
      reason: 'answer_in_extension_batch',
      extensionIndex: 1,
      taskId: 'e1-l1'
    });
    expect(screen.violations[0]?.detail).toContain('overdue');

    // Voided WHOLE. The one clean task in the batch is not pooled: keeping it
    // would select the pool on a defect the same generator produced.
    expect(screen.admitted).toEqual([]);
    expect(screen.clean).toBe(1);
    // And it is not a drop. The old behaviour counted it and said nothing.
    expect(screen.dropped).toEqual({ admission: 0, duplicate: 0 });
  });

  it('REFUSES on a structural property violated inside a batch', () => {
    const unbound = task({ id: 'p1', prompt: 'Fetch invoice {{invoice_id}} and report its status.' });
    expect(screener.admissible(unbound)).toBe(false);
    expect(registeredSuiteWould(unbound)).toBe('property_violated');

    const screen = screener.screenBatch({ index: 2, tasks: [unbound, clean], pooled: [] });
    expect(screen.refused).toBe(true);
    expect(screen.violations[0]).toMatchObject({
      gate: 'extension_structural',
      reason: 'extension_property_violated',
      extensionIndex: 2,
      taskId: 'e2-p1'
    });
    expect(screen.violations[0]?.detail).toContain('invoice_id');
    expect(screen.admitted).toEqual([]);

    // An empty rendered prompt is the same finding: there is no task there.
    const empty = screener.screenBatch({ index: 3, tasks: [task({ id: 'p2', prompt: '   ' })], pooled: [] });
    expect(empty.violations[0]?.gate).toBe('extension_structural');
  });

  it('DROPS an ordinary admission failure, and says so rather than refusing', () => {
    const unknownTool = task({ id: 'u1', expectedTools: ['delete_everything'] });
    const noTools = task({ id: 'u2', expectedTools: [] });

    // The published asymmetry, deliberate and documented in METHODS: the same
    // task refuses the registered suite (it is measured by the structural gate)
    // and only drops out of a batch, because "this candidate does not fit the
    // surface" says nothing about the generator that the batch was bought to
    // test. Everything the batch DOES say about the generator refuses.
    expect(screener.admissible(unknownTool)).toBe(false);
    expect(registeredSuiteWould(unknownTool)).toBe('property_violated');

    const screen = screener.screenBatch({ index: 1, tasks: [unknownTool, noTools, clean], pooled: [] });
    expect(screen.refused).toBe(false);
    expect(screen.violations).toEqual([]);
    expect(screen.dropped.admission).toBe(2);
    expect(screen.droppedIds.admission).toEqual(['e1-u1', 'e1-u2']);
    expect(screen.admitted.map((t) => t.id)).toEqual(['e1-c1']);

    const methods = defaultMethodsNotes(EXTENSION_POLICY).join(' ');
    expect(methods).toContain('refuses the run');
    expect(methods).toContain('ordinary admission');
  });

  it('drops a batch task that restates one already in the pool', () => {
    const pooled = [task({ id: 't3' })];
    // Same task, different id, different spacing and casing. The id prefix makes
    // the collision invisible; the content key does not.
    const restated = task({ id: 'r1', prompt: '  FETCH   invoice inv_1001\nand report its Status.  ' });

    const screen = screener.screenBatch({ index: 1, tasks: [restated, clean], pooled });
    expect(screen.refused).toBe(false);
    expect(screen.dropped.duplicate).toBe(1);
    expect(screen.droppedIds.duplicate).toEqual(['e1-r1']);
    expect(screen.admitted.map((t) => t.id)).toEqual(['e1-c1']);
    // A duplicate is a DROP, never a refusal: a restated task is a correlated
    // trial, not evidence that the generator is broken.
    expect(screen.violations).toEqual([]);
  });

  it('dedupes inside one batch too, not only against the pool', () => {
    const a = task({ id: 'a1' });
    const b = task({ id: 'b1' });
    const screen = screener.screenBatch({ index: 1, tasks: [a, b], pooled: [] });
    expect(screen.admitted.map((t) => t.id)).toEqual(['e1-a1']);
    expect(screen.dropped.duplicate).toBe(1);
  });

  it('keys task identity on content, never on id', () => {
    const base = task({ id: 'k1' });
    // Id is not in the key: that is the whole point.
    expect(taskContentKey(base)).toBe(taskContentKey(task({ id: 'k2' })));
    // Whitespace, case and expected-tool ORDER do not make a new task.
    expect(taskContentKey(task({ id: 'k3', prompt: ' fetch INVOICE  inv_1001\tand report its status. ' })))
      .toBe(taskContentKey(base));
    expect(taskContentKey(task({ id: 'k4', expectedTools: ['lookup_user', 'get_invoice'] })))
      .toBe(taskContentKey(task({ id: 'k5', expectedTools: ['get_invoice', 'lookup_user'] })));
    // A different question, a different success predicate, or a different tool
    // set are all different trials.
    expect(taskContentKey(task({ id: 'k6', prompt: 'Fetch invoice inv_2002.' }))).not.toBe(taskContentKey(base));
    expect(
      taskContentKey(task({ id: 'k7', check: { kind: 'substring', where: 'final_text', value: 'status: paid' } }))
    ).not.toBe(taskContentKey(base));
    expect(taskContentKey(task({ id: 'k8', expectedTools: ['lookup_user'] }))).not.toBe(taskContentKey(base));
  });
});

// ---------------------------------------------------------------------------
// The same rules, end to end through the pipeline
// ---------------------------------------------------------------------------

describe('a batch that fails a free gate against the canary', () => {
  it('REFUSES the run when a bought batch violates the structural property', async () => {
    const out = join(dir, 'batch-property-violation');
    const result = await runPipeline(
      { ...parseArgs(['run', canary.url]), out, constructReps: 1 },
      {
        anthropic: scriptedClient({
          suites: {
            '1': ORIGINAL_IDS,
            // One task in the batch ships an unbound placeholder to the agent.
            // The generator does not check for this on purpose (a predicate that
            // re-checks what the generator guaranteed verifies nothing), so it
            // reaches the pipeline exactly as a real generator defect would.
            '1001': [{ id: 'x1', templateSuffix: ' Reference {{ticket_id}}.' }, 'x2', 'x3', 'x4', 'x5', 'x6'],
            '2001': BATCH2_IDS
          },
          failing: new Set(['t11', 't12'])
        }),
        log: () => undefined
      }
    );

    // THE HEADLINE. In the registered suite this defect refuses at `structural`.
    // In a batch bought to resolve the construct gate it used to be deleted in
    // silence. It refuses now, and the refusal names the batch and the task.
    expect(result.report.gates.refusedAt).toBe('extension_structural');
    expect(result.report.outcome).toBe('GATE_FAILED');
    expect('score' in result.report).toBe(false);

    const record = result.report.gates.records.find((r) => r.gate === 'extension_structural');
    expect(record?.ok).toBe(false);
    expect(record?.costTier).toBe('free');
    expect(record?.reason).toBe('extension_property_violated');
    expect(record?.detail).toMatchObject({ extensionIndex: 1, seed: 1001, generated: 6, cleanTasksInBatch: 5 });

    const extensions = result.report.gates.extensions as readonly ExtensionEvidence[];
    // The extension was bought, so it is consumed and recorded. Nothing else is
    // bought after a refusal.
    expect(extensions).toHaveLength(1);
    expect(extensions[0]).toMatchObject({
      index: 1,
      generated: 6,
      admitted: 0,
      // The batch is voided WHOLE: the five clean tasks are not pooled either.
      taskIds: [],
      pooledBefore: { k: 10, n: 12 },
      pooledAfter: { k: 10, n: 12 },
      verdictBefore: 'EXTEND',
      verdictAfter: 'EXTEND'
    });
    expect(extensions[0]?.violations).toHaveLength(1);
    expect(extensions[0]?.violations?.[0]).toMatchObject({
      gate: 'extension_structural',
      reason: 'extension_property_violated',
      extensionIndex: 1,
      taskId: 'e1-x1'
    });
    // No task from a refused batch reaches the recording or the pool.
    const mcp = await readTape(result.files.mcpTape);
    expect(mcp.some((l) => String((l as { corr_id?: string }).corr_id ?? '').startsWith('e1-'))).toBe(false);
    const gateEvents = mcp.filter(
      (l) => (l as { raw?: { gate?: string } }).raw?.gate === 'extension_structural'
    );
    expect(gateEvents).toHaveLength(1);
    expect((gateEvents[0] as { raw?: { taskIds?: string[] } }).raw?.taskIds).toEqual(['e1-x1']);

    const md = await readFile(result.files.reportMd, 'utf8');
    expect(md).toContain('## Result: REFUSED');
    expect(md).toContain('extension_property_violated');
    expect(md).toContain('REFUSED at extension_structural: e1-x1');
    expect(md).not.toContain('—');
  }, 240_000);

  it('drops a batch task that restates a pooled task, and still consumes the extension', async () => {
    const out = join(dir, 'batch-duplicate');
    const result = await runPipeline(
      { ...parseArgs(['run', canary.url]), out, constructReps: 1 },
      {
        anthropic: scriptedClient({
          // The batch restates two tasks the pool already holds. Their ids are
          // `t3` and `t5`, which the protocol prefixes to `e1-t3` and `e1-t5`,
          // so nothing collides on id and the pooled n would have grown by two
          // trials perfectly correlated with two already counted.
          suites: { '1': ORIGINAL_IDS, '1001': ['t3', 't5', 'x1', 'x2', 'x3', 'x4'], '2001': BATCH2_IDS },
          failing: new Set(['t11', 't12'])
        }),
        log: () => undefined
      }
    );

    const extensions = result.report.gates.extensions as readonly ExtensionEvidence[];
    expect(extensions[0]).toMatchObject({
      index: 1,
      generated: 6,
      admitted: 4,
      short: true,
      dropped: { duplicate: 2, admission: 0, answerLeak: 0 },
      pooledBefore: { k: 10, n: 12 },
      // 12 + 4, NOT 12 + 6. That difference is the whole finding.
      pooledAfter: { k: 14, n: 16 }
    });
    expect(extensions[0]?.taskIds).toEqual(['e1-x1', 'e1-x2', 'e1-x3', 'e1-x4']);
    // A duplicate is a drop, not a refusal.
    expect(extensions[0]?.violations).toBeUndefined();
    expect(result.report.gates.refusedAt).toBeNull();

    // The extension is CONSUMED either way: two of its six tasks were unusable,
    // and re-asking until six usable ones arrive is optional stopping.
    expect(extensions).toHaveLength(2);
    expect(extensions[1]?.pooledBefore).toEqual({ k: 14, n: 16 });
    expect(extensions[1]?.pooledAfter).toEqual({ k: 20, n: 22 });

    const construct = result.report.gates.records.find((r) => r.gate === 'construct');
    expect(construct?.verdict).toEqual(verdict(20, 22, 0.9));
    expect(result.report.outcome).toBe('SCORED');
    expect(result.report.score?.firstTrySuccess.n).toBe(22);
    expect(result.report.score?.tasks.map((t) => t.taskId)).not.toContain('e1-t3');

    // The published suite carries no two tasks with the same content, which is
    // the property the dedupe exists to hold.
    const suite = JSON.parse(await readFile(result.files.suite!, 'utf8')) as { tasks: FitnessTask[] };
    expect(suite.tasks).toHaveLength(22);
    expect(new Set(suite.tasks.map((t) => taskContentKey(t))).size).toBe(22);

    const md = await readFile(result.files.reportMd, 'utf8');
    expect(md).toContain('already in the pool, dropped as duplicates');
  }, 240_000);

  it('explains a batch that could not be generated instead of publishing a bare short row', async () => {
    const out = join(dir, 'batch-generation-failure');
    const result = await runPipeline(
      { ...parseArgs(['run', canary.url]), out, constructReps: 1 },
      {
        anthropic: scriptedClient({
          // No entry for seed 1001: the generator throws for the first batch.
          suites: { '1': ORIGINAL_IDS, '2001': BATCH2_IDS },
          failing: new Set(['t11', 't12'])
        }),
        log: () => undefined
      }
    );

    const extensions = result.report.gates.extensions as readonly ExtensionEvidence[];
    expect(extensions).toHaveLength(2);
    expect(extensions[0]).toMatchObject({ index: 1, generated: 0, admitted: 0, short: true });
    expect(extensions[0]?.failure).toContain('no scripted suite for seed 1001');
    // A batch that could not be generated is a batch of size zero. It still
    // consumes the extension, so the second one is the last.
    expect(extensions[1]).toMatchObject({ index: 2, admitted: 6, pooledAfter: { k: 16, n: 18 } });

    // THE FINDING: the markdown used to publish this as an unexplained
    // "0 of 0 (short)" row with no reason anywhere on the page.
    const md = await readFile(result.files.reportMd, 'utf8');
    expect(md).toContain('batch not generated: no scripted suite for seed 1001');
    expect(md).not.toContain('—');
  }, 240_000);

  it('persists each bought batch own synthesis ledger into suite-meta.json', async () => {
    const out = join(dir, 'batch-provenance');
    const result = await runPipeline(
      { ...parseArgs(['run', canary.url]), out, constructReps: 1 },
      {
        anthropic: scriptedClient({
          suites: { '1': ORIGINAL_IDS, '1001': BATCH1_IDS, '2001': BATCH2_IDS },
          failing: new Set(['t11', 't12'])
        }),
        log: () => undefined
      }
    );

    const meta = JSON.parse(await readFile(result.files.suiteMeta!, 'utf8')) as {
      extension: {
        batches: {
          index: number;
          seed: number;
          batchSuiteHash: string;
          synthesis: {
            schema: string;
            suiteHash: string;
            generator: { generatorVersion: string; targetTaskCount: number; minTasks: number };
            yield: { candidates: number; admitted: number };
            nullScreen: { screened: number; dropped: number; records: { taskId: string }[] };
            dropped: unknown[];
            failure: unknown;
          } | null;
        }[];
      };
    };

    const registered = JSON.parse(await readFile(result.files.suiteMeta!, 'utf8')) as {
      generator: { generatorVersion: string };
    };

    for (const batch of meta.extension.batches) {
      const ledger = batch.synthesis;
      // A task the run BOUGHT has to be as auditable as one it registered. The
      // aggregate counts in the report say six arrived; this says which six, from
      // which generator config, and what the screen did to each of them.
      expect(ledger).not.toBeNull();
      expect(ledger?.schema).toBe('fitness-report.suite-meta/1');
      expect(ledger?.suiteHash).toBe(batch.batchSuiteHash);
      // Same generator as the registered suite, sized to the pre-registration.
      // Only the seed moves, and the seed is recorded beside this on the batch.
      expect(ledger?.generator.generatorVersion).toBe(registered.generator.generatorVersion);
      expect(ledger?.generator.targetTaskCount).toBe(EXTENSION_POLICY.extensionSize);
      expect(ledger?.generator.minTasks).toBe(EXTENSION_POLICY.extensionSize);
      expect(batch.seed).toBe(extensionSeed(1, batch.index));
      expect(ledger?.yield).toMatchObject({ candidates: 6, admitted: 6 });
      expect(ledger?.nullScreen.screened).toBe(6);
      expect(ledger?.nullScreen.records).toHaveLength(6);
      expect(ledger?.failure).toBeNull();
    }
    expect(meta.extension.batches[0]?.synthesis?.suiteHash).not.toBe(
      meta.extension.batches[1]?.synthesis?.suiteHash
    );
  }, 240_000);

  it('records a ledger for a batch that never generated, with the failure named', async () => {
    const out = join(dir, 'batch-provenance-failure');
    const result = await runPipeline(
      { ...parseArgs(['run', canary.url]), out, constructReps: 1 },
      {
        anthropic: scriptedClient({
          suites: { '1': ORIGINAL_IDS, '2001': BATCH2_IDS },
          failing: new Set(['t11', 't12'])
        }),
        log: () => undefined
      }
    );

    const meta = JSON.parse(await readFile(result.files.suiteMeta!, 'utf8')) as {
      extension: { batches: { index: number; synthesis: { failure: { kind: string; message: string } | null } | null }[] };
    };
    const first = meta.extension.batches.find((b) => b.index === 1);
    expect(first?.synthesis?.failure).toMatchObject({ kind: 'extension_synthesis_failed' });
    expect(first?.synthesis?.failure?.message).toContain('no scripted suite for seed 1001');
  }, 240_000);
});

// ---------------------------------------------------------------------------
// FINDING 3: the published pre-registration is DERIVED, never restated
// ---------------------------------------------------------------------------

describe('pre-registration copy', () => {
  function ledgerFor(policy: ExtensionPolicy): GateLedger {
    return { order: [], records: [], extensionPolicy: policy, refusedAt: null };
  }

  it('derives the registered numbers from the policy the run persisted', () => {
    const notes = defaultMethodsNotes({ extensionSize: 9, maxExtensions: 4 }).join('\n');
    expect(notes).toContain('9 new tasks per extension, at most 4');
    // The old copy hardcoded this sentence, so a policy change would have
    // published a pre-registration the run did not obey.
    expect(notes).not.toContain('6 new tasks per extension');
    expect(notes).not.toContain('at most 2');

    const frozen = defaultMethodsNotes(EXTENSION_POLICY).join('\n');
    expect(frozen).toContain(
      `${EXTENSION_POLICY.extensionSize} new tasks per extension, at most ${EXTENSION_POLICY.maxExtensions}`
    );
  });

  it('says there is no extension protocol when the pre-registration has none', () => {
    const notes = defaultMethodsNotes({ extensionSize: 0, maxExtensions: 0 }).join('\n');
    expect(notes).toContain('no extension batches at all');
    expect(notes).not.toMatch(/\d+ new tasks per extension/);
    // The gates section agrees with the methods section.
    expect(extensionCopy(ledgerFor({ extensionSize: 0, maxExtensions: 0 })).join('\n')).toContain(
      'no extension batches'
    );
  });

  it('states the batch symmetry rule the pipeline implements', () => {
    const notes = defaultMethodsNotes(EXTENSION_POLICY).join('\n');
    expect(notes).toContain('refuses the run');
    expect(notes).toContain('evidence about the generator, not a task to quietly discard');
    expect(notes).toContain('null screen');
    expect(notes).toContain('restates one already in the pool');
    expect(notes).not.toContain('—');
  });

  it('renders a generation failure and a refusal in the extension table', () => {
    const evidence: ExtensionEvidence = {
      index: 1,
      gate: 'construct',
      seed: 1001,
      batchSuiteHash: null,
      taskIds: [],
      generated: 0,
      admitted: 0,
      dropped: { nullScreen: 0, answerLeak: 0, admission: 0, duplicate: 0 },
      short: true,
      pooledBefore: { k: 10, n: 12 },
      pooledAfter: { k: 10, n: 12 },
      verdictBefore: 'EXTEND',
      verdictAfter: 'EXTEND',
      failure: 'judge returned no text (stop_reason: max_tokens)'
    };
    const lines = extensionCopy({
      order: [],
      records: [],
      extensionPolicy: EXTENSION_POLICY,
      refusedAt: null,
      extensions: [evidence]
    });
    const table = lines.join('\n');
    // The row still says (short); it no longer says ONLY that.
    expect(table).toContain('0 of 0 (short)');
    expect(table).toContain('batch not generated: judge returned no text (stop_reason: max_tokens)');
    // Still a well formed markdown table: the note is a COLUMN, not a stray
    // line, and a reason carrying a pipe cannot split the row.
    const rows = lines.filter((l) => l.startsWith('|'));
    expect(rows).toHaveLength(3);
    const widths = new Set(rows.map((r) => r.split('|').length));
    expect(widths.size).toBe(1);

    const refused = extensionCopy({
      order: [],
      records: [],
      extensionPolicy: EXTENSION_POLICY,
      refusedAt: 'extension_answer_leak',
      extensions: [
        {
          ...evidence,
          failure: undefined,
          generated: 6,
          dropped: { nullScreen: 1, answerLeak: 0, admission: 2, duplicate: 1 },
          violations: [
            {
              gate: 'extension_answer_leak',
              reason: 'answer_in_extension_batch',
              extensionIndex: 1,
              taskId: 'e1-x3',
              detail: 'the answer key is in the prompt'
            }
          ]
        }
      ]
    }).join('\n');
    expect(refused).toContain('REFUSED at extension_answer_leak: e1-x3, answer_in_extension_batch');
    expect(refused).toContain('1 task(s) already in the pool, dropped as duplicates');
    expect(refused).toContain('2 dropped at admission');
    expect(refused).toContain('1 deleted by the null screen');
  });
});
