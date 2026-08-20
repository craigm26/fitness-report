/**
 * Task synthesis tests (DESIGN decision 17, plus 13 at suite level).
 *
 * No network and no API key: the Anthropic client is injected, so every test
 * drives a canned stub that returns fixed JSON. The stub also records the
 * request params, which is how we pin the judge model and the shape of the call.
 */

import { describe, expect, it } from 'vitest';

import type Anthropic from '@anthropic-ai/sdk';

import { evaluateCheck } from '../src/run/agent.js';
import { redactReport } from '../src/tape/redact.js';
import {
  CHECK_PATTERN_FLAGS,
  DEFAULT_JUDGE_MODEL,
  GENERATOR_VERSION,
  MIN_VIABLE_TASKS,
  SYNTHESIZER_VERSION,
  SYSTEM_PROMPT,
  TaskSynthesisError,
  bindParams,
  canonicalJson,
  compileCheckPattern,
  computeSuiteHash,
  detectHandleChains,
  findAnswerLeak,
  isHandleParam,
  leakTokens,
  longestLiteralRun,
  parseTaskPayload,
  renderPrompt,
  repairPattern,
  scanAnswerLeak,
  synthesizeTaskSuite,
  taskIsDestructive,
  unresolvedPlaceholders,
  type GeneratorConfig,
  type JudgeClient,
  type ToolSurfaceEntry,
} from '../src/tasks/synthesize.js';
import type { FitnessTask } from '../src/types.js';

// ---------------------------------------------------------------------------
// Canned judge client
// ---------------------------------------------------------------------------

interface Stub {
  client: JudgeClient;
  calls: Anthropic.MessageCreateParamsNonStreaming[];
}

function cannedMessage(text: string, stopReason: Anthropic.Message['stop_reason'] = 'end_turn'): Anthropic.Message {
  return {
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model: DEFAULT_JUDGE_MODEL,
    content: [{ type: 'text', text, citations: null }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message;
}

/** Returns payloads in order; the last one repeats if the code calls again. */
function stub(payloads: readonly unknown[], stopReason?: Anthropic.Message['stop_reason']): Stub {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let i = 0;
  return {
    calls,
    client: {
      messages: {
        create: async (params) => {
          calls.push(params);
          const payload = payloads[Math.min(i, payloads.length - 1)];
          i += 1;
          return cannedMessage(typeof payload === 'string' ? payload : JSON.stringify(payload), stopReason);
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture surface: canary-shaped (DESIGN 16) — read-only, unannotated
// destructive, correctly annotated destructive, and a create/consume pair.
// ---------------------------------------------------------------------------

const obj = (
  properties: Record<string, unknown>,
  required: readonly string[],
): Record<string, unknown> => ({ type: 'object', properties, required });

const TOOLS: readonly ToolSurfaceEntry[] = [
  {
    name: 'search_docs',
    description: 'Search the documentation index.',
    inputSchema: obj({ query: { type: 'string' } }, ['query']),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_invoice',
    description: 'Fetch one invoice by its number.',
    inputSchema: obj({ invoice_number: { type: 'string' } }, ['invoice_number']),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'lookup_user',
    description: 'Look up a user by name.',
    inputSchema: obj({ user: { type: 'string' } }, ['user']),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_records',
    description: 'List all records.',
    inputSchema: obj({}, []),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_record',
    description: 'Create a record. Returns the new record id.',
    inputSchema: obj({ title: { type: 'string' } }, ['title']),
    // deliberately unannotated: destructive under the spec-default rule
  },
  {
    name: 'update_record',
    description: 'Update an existing record.',
    inputSchema: obj({ record_id: { type: 'string' }, title: { type: 'string' } }, [
      'record_id',
      'title',
    ]),
  },
  {
    name: 'delete_record',
    description: 'Delete a record.',
    inputSchema: obj({ record_id: { type: 'string' } }, ['record_id']),
    annotations: { destructiveHint: true },
  },
  {
    name: 'transfer_funds',
    description: 'Move money between two accounts.',
    inputSchema: obj(
      { from: { type: 'string' }, to: { type: 'string' }, amount: { type: 'number' } },
      ['from', 'to', 'amount'],
    ),
    // UNANNOTATED destructive: the whole point of DESIGN decision 10
  },
];

const INSTRUCTIONS = 'Always call search_docs before answering a documentation question.';

// ---------------------------------------------------------------------------
// Canned model output
// ---------------------------------------------------------------------------

/**
 * GENERATOR v2 shape. `params` travels as the ARRAY of {name, value} pairs the
 * structured-output schema actually puts on the wire, not the legacy record map
 * every v1 fixture used: the record map is exactly why the suite never caught
 * the binder bug that blinded the generation-time leak scan across 15 runs and
 * 180 candidates. `serverRequiredBecause` is required, and no task uses
 * `tool_called` as its whole check.
 */
const pairs = (params: Record<string, string>): { name: string; value: string }[] =>
  Object.entries(params).map(([name, value]) => ({ name, value }));

const HEALTHY_TASKS = [
  {
    id: 'docs-throttling',
    promptTemplate:
      'Use the documentation search to find how {{subject}} request throttling is implemented, and name the algorithm.',
    params: pairs({ subject: 'API' }),
    expectedTools: ['search_docs'],
    check: { kind: 'substring', where: 'final_text', value: 'token bucket' },
    answerKey: 'token bucket',
    destructive: false,
    serverRequiredBecause: 'long-tail',
  },
  {
    id: 'invoice-status',
    promptTemplate: 'Fetch invoice {{invoice}} and report its payment status.',
    params: pairs({ invoice: 'INV-1042' }),
    expectedTools: ['get_invoice'],
    check: { kind: 'substring', where: 'final_text', value: 'PAID' },
    answerKey: 'PAID',
    destructive: false,
    serverRequiredBecause: 'volatile',
  },
  {
    id: 'user-department',
    promptTemplate: 'Which department is the user {{who}} assigned to?',
    params: pairs({ who: 'ada' }),
    expectedTools: ['lookup_user'],
    check: { kind: 'substring', where: 'final_text', value: 'Platform Engineering' },
    answerKey: 'Platform Engineering',
    destructive: false,
    serverRequiredBecause: 'long-tail',
  },
  {
    id: 'record-inventory',
    promptTemplate: 'List the records and report the status shared by the two oldest entries.',
    params: [],
    expectedTools: ['list_records'],
    check: { kind: 'substring', where: 'final_text', value: 'archived' },
    answerKey: 'archived',
    destructive: false,
    serverRequiredBecause: 'volatile',
  },
  {
    id: 'tool-choice',
    promptTemplate:
      'Find the documentation page describing what happens after too many {{noun}}, and give its slug.',
    params: pairs({ noun: 'requests' }),
    expectedTools: ['search_docs'],
    check: { kind: 'regex', where: 'final_text', pattern: 'rate-limit-policy' },
    answerKey: 'rate-limit-policy',
    destructive: false,
    serverRequiredBecause: 'long-tail',
  },
  {
    id: 'create-then-update',
    promptTemplate:
      'Create a record titled {{title}}, then rename it to {{newTitle}} and report the record id you were given.',
    params: pairs({ title: 'Q3 audit', newTitle: 'Q3 audit (final)' }),
    expectedTools: ['create_record', 'update_record'],
    // v2 prefers the one check a tool-less model cannot satisfy with prose.
    check: { kind: 'tool_result_matches', tool: 'update_record', pattern: 'REC-3391' },
    answerKey: 'REC-3391',
    destructive: true,
    serverRequiredBecause: 'server-minted',
  },
  {
    id: 'delete-flow',
    promptTemplate: 'Remove the scratch record named {{name}} and report the id you removed.',
    params: pairs({ name: 'scratch-1' }),
    expectedTools: ['delete_record'],
    check: { kind: 'tool_result_matches', tool: 'delete_record', pattern: 'REC-8842' },
    answerKey: 'REC-8842',
    destructive: true,
    serverRequiredBecause: 'server-minted',
  },
  {
    id: 'transfer',
    promptTemplate:
      'Move {{amount}} from account {{from}} to account {{to}} and report the transaction id.',
    params: pairs({ amount: '250 USD', from: 'alpha', to: 'beta' }),
    expectedTools: ['transfer_funds'],
    check: { kind: 'substring', where: 'final_text', value: 'TXN-5501' },
    answerKey: 'TXN-5501',
    // The model claims this is safe. The spec-default rule says otherwise.
    destructive: false,
    serverRequiredBecause: 'server-minted',
  },
  {
    id: 'retry-guidance',
    promptTemplate: 'Summarize the retry guidance in the documentation for a new integrator.',
    params: [],
    expectedTools: ['search_docs'],
    check: { kind: 'judge', rubric: 'Mentions the documented retry strategy by name.' },
    answerKey: 'exponential backoff',
    destructive: false,
    serverRequiredBecause: 'verbatim-quote',
  },
];

/**
 * Seeded offender: the prompt states the answer, so a no-tools model passes it.
 * The leak is carried by a BOUND PARAM on the wire shape, which is exactly the
 * case v1's binder could not see.
 */
const LEAKY_TASK = {
  id: 'leaky-version',
  promptTemplate:
    'The documentation says the current release is {{version}}. Confirm the current release with the docs search.',
  params: pairs({ version: '4.2.1' }),
  expectedTools: ['search_docs'],
  check: { kind: 'substring', where: 'final_text', value: 'release 4.2.1' },
  answerKey: '4.2.1',
  destructive: false,
  serverRequiredBecause: 'volatile',
};

const LEAKY_FIXED = {
  ...LEAKY_TASK,
  promptTemplate: 'Look up the current release of the {{product}} documentation and report it.',
  params: pairs({ product: 'platform' }),
};

const LEAKY_STILL_BROKEN = {
  ...LEAKY_TASK,
  promptTemplate: 'Confirm with the docs search that the current release is {{version}}.',
  params: pairs({ version: '4.2.1' }),
};

const FIRST_PAYLOAD = { tasks: [...HEALTHY_TASKS, LEAKY_TASK] };

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    serverSlug: 'canary',
    tools: TOOLS,
    instructions: INSTRUCTIONS,
    seed: 1337,
    ...overrides,
  } as Parameters<typeof synthesizeTaskSuite>[1];
}

function byId(tasks: readonly FitnessTask[]): Map<string, FitnessTask> {
  return new Map(tasks.map((t) => [t.id, t]));
}

// ---------------------------------------------------------------------------
// The judge call itself
// ---------------------------------------------------------------------------

describe('judge call', () => {
  it('pins claude-opus-5, ships the tool surface and the server instructions', async () => {
    const s = stub([{ tasks: HEALTHY_TASKS }]);
    const result = await synthesizeTaskSuite(s.client, baseOptions());

    expect(s.calls).toHaveLength(1);
    const call = s.calls[0]!;
    expect(call.model).toBe('claude-opus-5');
    expect(call.stream).toBeUndefined();
    expect(call.output_config?.effort).toBe('high');
    const prompt = String(call.messages[0]!.content);
    expect(prompt).toContain('transfer_funds');
    expect(prompt).toContain(INSTRUCTIONS);
    expect(prompt).toContain('Seed: 1337');
    expect(result.suite.generatorModel).toBe(DEFAULT_JUDGE_MODEL);
  });

  it('throws a typed error when the judge refuses', async () => {
    const s = stub([{ tasks: HEALTHY_TASKS }], 'refusal');
    await expect(synthesizeTaskSuite(s.client, baseOptions())).rejects.toBeInstanceOf(
      TaskSynthesisError,
    );
  });

  it('parses fenced and prose-wrapped JSON, and COUNTS what it discards', () => {
    expect(parseTaskPayload('```json\n{"tasks":[{"id":"a"}]}\n```').tasks).toHaveLength(1);
    expect(parseTaskPayload('Here you go:\n{"tasks":[{"id":"a"},{"id":"b"}]}\nDone.').tasks).toHaveLength(2);
    // A non-object entry used to vanish from the numerator AND the denominator.
    const mixed = parseTaskPayload('{"tasks":[{"id":"a"},"junk",null]}');
    expect(mixed.tasks).toHaveLength(1);
    expect(mixed.entriesDiscarded).toBe(2);
    expect(() => parseTaskPayload('no json at all')).toThrow(TaskSynthesisError);
  });
});

// ---------------------------------------------------------------------------
// Answer-leak gate (DESIGN 11, FREE tier; DESIGN 17 leak detector)
// ---------------------------------------------------------------------------

describe('answer-leak check', () => {
  it('catches an answer key stated in the rendered prompt', () => {
    expect(
      findAnswerLeak({
        prompt: 'The current release is 4.2.1. Confirm it.',
        answerKey: '4.2.1',
      }),
    ).toBe('4.2.1');
    expect(
      findAnswerLeak({ prompt: 'Report the current release.', answerKey: '4.2.1' }),
    ).toBeNull();
  });

  it('walks structured answer keys and ignores tokens too short to be evidence', () => {
    expect(leakTokens({ invoice: 'INV-1042', total: 90.5, ok: true })).toEqual(['INV-1042', '90.5']);
    expect(leakTokens({ n: 7 })).toEqual([]);
    expect(findAnswerLeak({ prompt: 'Total invoice INV-1042 please', answerKey: { id: 'INV-1042' } })).toBe(
      'INV-1042',
    );
  });

  it('is case- and whitespace-insensitive', () => {
    expect(
      findAnswerLeak({ prompt: 'answer:   Token   Bucket, obviously', answerKey: 'token bucket' }),
    ).toBe('token bucket');
  });

  it('checks the RENDERED prompt, not the template, and reads the WIRE shape of params', async () => {
    // The template alone hides the answer behind {{version}}; only rendering it
    // with the array-of-{name,value} params the API actually returns exposes it.
    // v1 read that array with Object.entries, bound nothing, and reported a
    // clean bill of health for 180 leaking-or-not candidates it never rendered.
    const s = stub([{ tasks: [LEAKY_TASK] }, { tasks: [LEAKY_STILL_BROKEN] }]);
    const result = await synthesizeTaskSuite(s.client, baseOptions());
    expect(result.leaksFound).toEqual([
      { taskId: 'leaky-version', phrase: '4.2.1', source: 'prompt' },
    ]);
    // The leak was SEEN at generation time, so the repair pass actually ran.
    expect(result.regenerationAttempted).toBe(true);
    expect(s.calls).toHaveLength(2);
  });

  it('regenerates a leaking task exactly once and admits the fix', async () => {
    const s = stub([FIRST_PAYLOAD, { tasks: [LEAKY_FIXED] }]);
    const result = await synthesizeTaskSuite(s.client, baseOptions());

    expect(result.regenerationAttempted).toBe(true);
    expect(s.calls).toHaveLength(2);
    expect(String(s.calls[1]!.messages[0]!.content)).toContain('leak');

    const task = byId(result.suite.tasks).get('leaky-version');
    expect(task).toBeDefined();
    expect(task!.prompt).toContain('Look up the current release');
    expect(task!.prompt).not.toContain('4.2.1');
    expect(result.dropped.some((d) => d.reason === 'answer-leak')).toBe(false);
    expect(result.admitted).toBe(HEALTHY_TASKS.length + 1);
  });

  it('drops an offender that still leaks after its one regeneration', async () => {
    const s = stub([FIRST_PAYLOAD, { tasks: [LEAKY_STILL_BROKEN] }]);
    const result = await synthesizeTaskSuite(s.client, baseOptions());

    expect(s.calls).toHaveLength(2);
    expect(byId(result.suite.tasks).has('leaky-version')).toBe(false);
    const drop = result.dropped.find((d) => d.id === 'leaky-version');
    expect(drop).toMatchObject({
      reason: 'answer-leak',
      detail: 'answer key phrase "4.2.1" appears in the rendered prompt',
    });
    // `phrase`, never `token`: a field named token is erased by the publish
    // -time redactor, which would delete the evidence for this very drop.
    expect(drop?.evidence?.phrase).toBe('4.2.1');
    expect(result.admitted).toBe(HEALTHY_TASKS.length);
    expect(result.insufficient).toBe(false);
  });

  it('does not call the judge a second time when nothing leaks', async () => {
    const s = stub([{ tasks: HEALTHY_TASKS }]);
    const result = await synthesizeTaskSuite(s.client, baseOptions());
    expect(s.calls).toHaveLength(1);
    expect(result.regenerationAttempted).toBe(false);
    expect(result.leaksFound).toEqual([]);
  });

  it('survives a judge failure during regeneration by dropping the offender', async () => {
    let n = 0;
    const client: JudgeClient = {
      messages: {
        create: async () => {
          n += 1;
          if (n === 1) return cannedMessage(JSON.stringify(FIRST_PAYLOAD));
          throw new Error('network hiccup');
        },
      },
    };
    const result = await synthesizeTaskSuite(client, baseOptions());
    expect(result.dropped.some((d) => d.id === 'leaky-version' && d.reason === 'answer-leak')).toBe(true);
    expect(result.admitted).toBe(HEALTHY_TASKS.length);
  });
});

// ---------------------------------------------------------------------------
// suiteHash
// ---------------------------------------------------------------------------

describe('suiteHash', () => {
  const CONFIG: GeneratorConfig = {
    generatorVersion: GENERATOR_VERSION,
    synthesizerVersion: SYNTHESIZER_VERSION,
    generatorModel: 'claude-opus-5',
    serverSlug: 'canary',
    targetTaskCount: 12,
    minTasks: 8,
    excludeDestructive: false,
    toolSurfaceDigest: 'abc',
    instructionsDigest: null,
    effort: 'high',
    maxTokens: 16000,
    overGenerationFactor: 2,
    checkPolicyVersion: 2,
    leakCheckMode: 'squashed+word-boundary/2',
    nullScreen: {
      enabled: false,
      model: null,
      maxTokens: 400,
      effort: 'low',
      dropOnCold: true,
    },
  };

  const TASK_A: FitnessTask = {
    id: 't1',
    prompt: 'do the thing',
    expectedTools: ['search_docs'],
    check: { kind: 'tool_called', tool: 'search_docs' },
    answerKey: 'token bucket',
    destructive: false,
  };

  const TASK_B: FitnessTask = {
    id: 't2',
    prompt: 'do the other thing',
    expectedTools: ['list_records'],
    check: { kind: 'substring', where: 'final_text', value: 'archived' },
    destructive: false,
  };

  it('canonical JSON is key-order invariant but array-order sensitive', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('is stable across key orders in both tasks and generator config', () => {
    const reorderedTask = {
      destructive: false,
      answerKey: 'token bucket',
      check: { tool: 'search_docs', kind: 'tool_called' },
      expectedTools: ['search_docs'],
      prompt: 'do the thing',
      id: 't1',
    } as unknown as FitnessTask;
    const reorderedConfig = {
      nullScreen: {
        dropOnCold: true,
        effort: 'low',
        maxTokens: 400,
        model: null,
        enabled: false,
      },
      leakCheckMode: 'squashed+word-boundary/2',
      checkPolicyVersion: 2,
      overGenerationFactor: 2,
      maxTokens: 16000,
      effort: 'high',
      instructionsDigest: null,
      toolSurfaceDigest: 'abc',
      excludeDestructive: false,
      minTasks: 8,
      targetTaskCount: 12,
      serverSlug: 'canary',
      generatorModel: 'claude-opus-5',
      synthesizerVersion: SYNTHESIZER_VERSION,
      generatorVersion: GENERATOR_VERSION,
    } as GeneratorConfig;

    expect(computeSuiteHash([TASK_A], CONFIG, 1337)).toBe(
      computeSuiteHash([reorderedTask], reorderedConfig, 1337),
    );
  });

  it('changes with the seed, with task order, and with the generator config', () => {
    const base = computeSuiteHash([TASK_A, TASK_B], CONFIG, 1337);
    expect(computeSuiteHash([TASK_A, TASK_B], CONFIG, 1338)).not.toBe(base);
    expect(computeSuiteHash([TASK_B, TASK_A], CONFIG, 1337)).not.toBe(base);
    expect(computeSuiteHash([TASK_A, TASK_B], { ...CONFIG, minTasks: 9 }, 1337)).not.toBe(base);
    expect(computeSuiteHash([TASK_A, TASK_B], { ...CONFIG, toolSurfaceDigest: 'zzz' }, 1337)).not.toBe(
      base,
    );
  });

  it('changes when the GENERATOR VERSION changes, so no run can pose as an older retry', () => {
    expect(GENERATOR_VERSION).toBe('fitness-report-generator/3');
    const current = computeSuiteHash([TASK_A, TASK_B], CONFIG, 1337);
    const older = computeSuiteHash(
      [TASK_A, TASK_B],
      { ...CONFIG, generatorVersion: 'fitness-report-generator/2', synthesizerVersion: 2 },
      1337,
    );
    expect(older).not.toBe(current);
    // The version string is in the PREIMAGE, not merely alongside it.
    expect(canonicalJson({ generator: CONFIG, seed: 1337, tasks: [TASK_A] })).toContain(
      'fitness-report-generator/3',
    );
  });

  it('changes with every v2 knob that changes what the generator would produce', () => {
    const base = computeSuiteHash([TASK_A], CONFIG, 1337);
    // v1 hashed none of these while all of them move the output, so two
    // materially different generators claimed the same hash.
    expect(computeSuiteHash([TASK_A], { ...CONFIG, effort: 'low' }, 1337)).not.toBe(base);
    expect(computeSuiteHash([TASK_A], { ...CONFIG, overGenerationFactor: 3 }, 1337)).not.toBe(base);
    expect(computeSuiteHash([TASK_A], { ...CONFIG, checkPolicyVersion: 3 }, 1337)).not.toBe(base);
    expect(computeSuiteHash([TASK_A], { ...CONFIG, leakCheckMode: 'whitespace/1' }, 1337)).not.toBe(base);
    expect(
      computeSuiteHash(
        [TASK_A],
        { ...CONFIG, nullScreen: { ...CONFIG.nullScreen, enabled: true, model: 'claude-sonnet-5' } },
        1337,
      ),
    ).not.toBe(base);
  });

  it('stamps the generator version onto every synthesized suite', async () => {
    const result = await synthesizeTaskSuite(stub([{ tasks: HEALTHY_TASKS }]).client, baseOptions());
    expect(result.generator.generatorVersion).toBe('fitness-report-generator/3');
    expect(result.generator.checkPolicyVersion).toBe(3);
    expect(result.suite.generatorModel).toBe(DEFAULT_JUDGE_MODEL);
  });

  it('is a sha256 hex digest and repeats across identical runs', async () => {
    const first = await synthesizeTaskSuite(stub([{ tasks: HEALTHY_TASKS }]).client, baseOptions());
    const second = await synthesizeTaskSuite(stub([{ tasks: HEALTHY_TASKS }]).client, baseOptions());
    expect(first.suite.suiteHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.suite.suiteHash).toBe(first.suite.suiteHash);

    const otherSeed = await synthesizeTaskSuite(
      stub([{ tasks: HEALTHY_TASKS }]).client,
      baseOptions({ seed: 7 }),
    );
    expect(otherSeed.suite.suiteHash).not.toBe(first.suite.suiteHash);
  });

  it('changes when the tool surface changes, even with identical tasks', async () => {
    const wide = await synthesizeTaskSuite(stub([{ tasks: HEALTHY_TASKS }]).client, baseOptions());
    const narrowed = await synthesizeTaskSuite(
      stub([{ tasks: HEALTHY_TASKS }]).client,
      baseOptions({
        tools: TOOLS.map((t) =>
          t.name === 'search_docs' ? { ...t, description: 'Search the docs (v2).' } : t,
        ),
      }),
    );
    expect(narrowed.suite.suiteHash).not.toBe(wide.suite.suiteHash);
  });
});

// ---------------------------------------------------------------------------
// Destructive marking (DESIGN 10)
// ---------------------------------------------------------------------------

describe('destructive marking', () => {
  it('follows the spec-default rule and ignores the model when it under-claims', async () => {
    const s = stub([{ tasks: HEALTHY_TASKS }]);
    const tasks = byId((await synthesizeTaskSuite(s.client, baseOptions())).suite.tasks);

    // readOnlyHint: true -> safe
    expect(tasks.get('docs-throttling')!.destructive).toBe(false);
    expect(tasks.get('invoice-status')!.destructive).toBe(false);
    expect(tasks.get('record-inventory')!.destructive).toBe(false);

    // destructiveHint: true -> destructive
    expect(tasks.get('delete-flow')!.destructive).toBe(true);

    // UNANNOTATED and the model said destructive:false. The rule wins.
    expect(tasks.get('transfer')!.destructive).toBe(true);
    expect(tasks.get('create-then-update')!.destructive).toBe(true);
  });

  it('never clears a flag the model set', () => {
    const index = new Map(TOOLS.map((t) => [t.name, t]));
    expect(taskIsDestructive(['search_docs'], index)).toBe(false);
    expect(taskIsDestructive(['search_docs', 'transfer_funds'], index)).toBe(true);
    // A tool that is not on the surface at all is destructive by default.
    expect(taskIsDestructive(['who_knows'], index)).toBe(true);
  });

  it('drops destructive tasks when the run excludes them', async () => {
    const s = stub([{ tasks: HEALTHY_TASKS }]);
    const result = await synthesizeTaskSuite(s.client, baseOptions({ excludeDestructive: true }));
    expect(result.suite.tasks.every((t) => !t.destructive)).toBe(true);
    expect(result.dropped.filter((d) => d.reason === 'destructive-excluded')).toHaveLength(3);
    // 6 of 9 survive, which is below the floor: DESIGN 13 fires.
    expect(result.insufficient).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Handle chaining (DESIGN 17, stateful surfaces)
// ---------------------------------------------------------------------------

describe('handle chaining', () => {
  it('recognizes handle-shaped params and rejects credential-shaped ones', () => {
    expect(isHandleParam('record_id')).toBe(true);
    expect(isHandleParam('recordId')).toBe(true);
    expect(isHandleParam('handle')).toBe(true);
    expect(isHandleParam('invoice_number')).toBe(false);
    expect(isHandleParam('api_key')).toBe(false);
    expect(isHandleParam('query')).toBe(false);
  });

  it('detects create-returns-handle edges', () => {
    const chains = detectHandleChains(TOOLS);
    expect(chains).toContainEqual({
      producer: 'create_record',
      consumer: 'update_record',
      param: 'record_id',
      required: true,
    });
    expect(chains.every((c) => c.producer !== c.consumer)).toBe(true);
    expect(detectHandleChains([TOOLS[0]!])).toEqual([]);
  });

  it('prepends the producer when a task consumes a handle without creating one', async () => {
    const s = stub([{ tasks: HEALTHY_TASKS }]);
    const result = await synthesizeTaskSuite(s.client, baseOptions());
    const deleteFlow = byId(result.suite.tasks).get('delete-flow')!;

    expect(deleteFlow.expectedTools).toEqual(['create_record', 'delete_record']);
    expect(result.repairs).toContainEqual({
      id: 'delete-flow',
      kind: 'handle-chain',
      detail: 'prepended create_record so delete_record has a record_id to consume',
    });
    // A task that already chains correctly is left alone.
    expect(byId(result.suite.tasks).get('create-then-update')!.expectedTools).toEqual([
      'create_record',
      'update_record',
    ]);
  });

  it('tells the judge about the chains it must respect', async () => {
    const s = stub([{ tasks: HEALTHY_TASKS }]);
    await synthesizeTaskSuite(s.client, baseOptions());
    expect(String(s.calls[0]!.messages[0]!.content)).toContain('create-returns-handle');
  });
});

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

describe('validation', () => {
  it('drops tasks that reference a tool the server never advertised', async () => {
    const s = stub([
      { tasks: [...HEALTHY_TASKS, { ...LEAKY_FIXED, id: 'ghost', expectedTools: ['no_such_tool'] }] },
    ]);
    const result = await synthesizeTaskSuite(s.client, baseOptions());
    expect(byId(result.suite.tasks).has('ghost')).toBe(false);
    const ghost = result.dropped.find((d) => d.id === 'ghost');
    expect(ghost).toMatchObject({
      reason: 'unknown-tool',
      detail: 'not on the advertised surface: no_such_tool',
    });
    // The ledger has to carry enough to argue with the drop: which names were
    // off-surface is the whole hypothesis behind the v1 admission collapse.
    expect(ghost?.evidence?.unknownTools).toEqual(['no_such_tool']);
  });

  it('drops tasks with no machine-checkable predicate, no tools, or a bad regex', async () => {
    const s = stub([
      {
        tasks: [
          { ...HEALTHY_TASKS[0], id: 'no-check', check: { kind: 'vibes' } },
          { ...HEALTHY_TASKS[0], id: 'no-tools', expectedTools: [] },
          {
            ...HEALTHY_TASKS[0],
            id: 'bad-regex',
            check: { kind: 'regex', where: 'final_text', pattern: '(' },
          },
          { ...HEALTHY_TASKS[0], id: 'empty-prompt', promptTemplate: '   ', params: {} },
          HEALTHY_TASKS[0],
          { ...HEALTHY_TASKS[0], id: 'docs-throttling' },
        ],
      },
    ]);
    const result = await synthesizeTaskSuite(s.client, baseOptions());
    const reasons = new Map(result.dropped.map((d) => [d.id, d.reason]));
    expect(reasons.get('no-check')).toBe('invalid-check');
    expect(reasons.get('no-tools')).toBe('no-expected-tools');
    expect(reasons.get('bad-regex')).toBe('invalid-check');
    expect(reasons.get('empty-prompt')).toBe('malformed');
    expect(reasons.get('docs-throttling')).toBe('duplicate-id');
    expect(result.suite.tasks).toHaveLength(1);
    expect(result.generated).toBe(6);
    expect(result.admitted).toBe(1);
  });

  it('renders parameters into the prompt and leaves unknown placeholders alone', () => {
    expect(renderPrompt('find {{a}} in {{b}}', { a: 'x', b: 'y' })).toBe('find x in y');
    expect(renderPrompt('find {{a}}', {})).toBe('find {{a}}');
  });
});

// ---------------------------------------------------------------------------
// DESIGN decision 13: minimum suite size
// ---------------------------------------------------------------------------

describe('minimum suite size', () => {
  const ONE_TOOL: readonly ToolSurfaceEntry[] = [TOOLS[0]!];

  const THIN_TASKS = [
    { ...HEALTHY_TASKS[0], id: 'thin-1' },
    { ...HEALTHY_TASKS[0], id: 'thin-2', answerKey: 'sliding window' },
    { ...HEALTHY_TASKS[4], id: 'thin-3' },
  ];

  it('flags a 1-tool surface as insufficient without throwing', async () => {
    const s = stub([{ tasks: THIN_TASKS }]);
    const result = await synthesizeTaskSuite(s.client, baseOptions({ tools: ONE_TOOL }));

    expect(result.insufficient).toBe(true);
    expect(result.minTasks).toBe(MIN_VIABLE_TASKS);
    expect(result.admitted).toBe(3);
    // The suite still comes back, hashed, so the refusal can cite a real suiteHash.
    expect(result.suite.tasks).toHaveLength(3);
    expect(result.suite.suiteHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.suite.serverSlug).toBe('canary');
  });

  it('does not flag a suite that clears the floor', async () => {
    const s = stub([{ tasks: HEALTHY_TASKS }]);
    const result = await synthesizeTaskSuite(s.client, baseOptions());
    expect(result.admitted).toBe(9);
    expect(result.insufficient).toBe(false);
  });

  it('counts against the caller-supplied floor when one is given', async () => {
    const s = stub([{ tasks: HEALTHY_TASKS }]);
    const result = await synthesizeTaskSuite(s.client, baseOptions({ minTasks: 20 }));
    expect(result.insufficient).toBe(true);
    expect(result.minTasks).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// GENERATOR v2: the null screen
// ---------------------------------------------------------------------------

/** A cold model that knows one answer and nothing else. */
function screenStub(knownAnswer: string): Stub {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    client: {
      messages: {
        create: async (params) => {
          calls.push(params);
          const asked = String(params.messages[0]?.content ?? '');
          // The cold model recalls the throttling algorithm from memory. It has
          // never heard of this canary's invoices, users or records.
          return cannedMessage(
            asked.includes('throttling') ? `It uses a ${knownAnswer}.` : 'UNKNOWN',
          );
        },
      },
    },
  };
}

describe('null screen (v2)', () => {
  const withScreen = (screen: Stub, overrides: Record<string, unknown> = {}) =>
    baseOptions({
      nullScreen: { client: screen.client, model: 'claude-sonnet-5' },
      ...overrides,
    });

  it('deletes a candidate the cold model answers correctly and records the verdict', async () => {
    const judge = stub([{ tasks: HEALTHY_TASKS }]);
    const screen = screenStub('token bucket');
    const result = await synthesizeTaskSuite(judge.client, withScreen(screen));

    // `docs-throttling` asks for a fact a frontier model already knows, which
    // is the exact family that passed 70 of 76 tasks in the v1 sweep.
    expect(byId(result.suite.tasks).has('docs-throttling')).toBe(false);
    expect(result.dropped).toContainEqual(
      expect.objectContaining({ id: 'docs-throttling', reason: 'null_screen' }),
    );
    expect(result.admitted).toBe(HEALTHY_TASKS.length - 1);

    // Every candidate has a verdict, kept or dropped.
    expect(result.nullScreen.enabled).toBe(true);
    expect(result.nullScreen.model).toBe('claude-sonnet-5');
    expect(result.nullScreen.dropped).toBe(1);
    expect(result.nullScreen.records).toHaveLength(HEALTHY_TASKS.length);
    const hot = result.nullScreen.records.find((r) => r.taskId === 'docs-throttling');
    expect(hot).toMatchObject({ screenable: true, coldPassed: true });
    expect(hot?.coldAnswerExcerpt).toContain('token bucket');
    const cold = result.nullScreen.records.find((r) => r.taskId === 'invoice-status');
    expect(cold).toMatchObject({ screenable: true, coldPassed: false });
  });

  it('screens with a tool-less system prompt and withholds the server instructions', async () => {
    const judge = stub([{ tasks: HEALTHY_TASKS }]);
    const screen = screenStub('token bucket');
    await synthesizeTaskSuite(judge.client, withScreen(screen));

    const probe = screen.calls[0]!;
    expect(probe.model).toBe('claude-sonnet-5');
    expect(String(probe.system)).toContain('You have no tools available');
    expect(String(probe.system)).toContain('UNKNOWN');
    // The instructions are a MEASURED leak channel (huggingface's said the
    // tools are used "anonymously" while a task's answer key was `anonymous`),
    // so the screen is deliberately blind to them and is therefore stricter
    // than the run-time null model, never weaker.
    expect(JSON.stringify(probe)).not.toContain(INSTRUCTIONS);
    expect(probe.thinking).toBeUndefined();
    expect(probe.max_tokens).toBe(400);
  });

  it('never screens a check an empty call list makes unpassable', async () => {
    const judge = stub([{ tasks: HEALTHY_TASKS }]);
    const screen = screenStub('token bucket');
    const result = await synthesizeTaskSuite(judge.client, withScreen(screen));

    // tool_result_matches cannot be satisfied without tool calls, so a cold
    // probe could only ever produce a false negative. Kept, marked, unscreened.
    const minted = result.nullScreen.records.find((r) => r.taskId === 'delete-flow');
    expect(minted).toMatchObject({ screenable: false, coldPassed: null });
    expect(byId(result.suite.tasks).has('delete-flow')).toBe(true);
    // One probe per screenable candidate, no more.
    const screenable = result.nullScreen.records.filter((r) => r.screenable).length;
    expect(screen.calls).toHaveLength(screenable);
  });

  it('keeps a candidate whose probe failed, and says so', async () => {
    const judge = stub([{ tasks: HEALTHY_TASKS }]);
    const screen: JudgeClient = {
      messages: {
        create: async () => {
          throw new Error('screen offline');
        },
      },
    };
    const result = await synthesizeTaskSuite(
      judge.client,
      baseOptions({ nullScreen: { client: screen, model: 'claude-sonnet-5' } }),
    );
    // A probe that failed is not evidence of anything. Never a silent delete.
    expect(result.admitted).toBe(HEALTHY_TASKS.length);
    expect(result.nullScreen.errors).toBeGreaterThan(0);
    expect(result.nullScreen.dropped).toBe(0);
    expect(result.nullScreen.records.some((r) => r.error === 'screen offline')).toBe(true);
  });

  it('is OFF when no screen client is injected, and the module stays offline', async () => {
    const judge = stub([{ tasks: HEALTHY_TASKS }]);
    const result = await synthesizeTaskSuite(judge.client, baseOptions());
    expect(result.nullScreen.enabled).toBe(false);
    expect(result.nullScreen.records.every((r) => r.coldPassed === null)).toBe(true);
    expect(result.admitted).toBe(HEALTHY_TASKS.length);
    expect(judge.calls).toHaveLength(1);
  });

  it('puts the screen policy in the suite hash, so a re-screen is a new suite', async () => {
    const unscreened = await synthesizeTaskSuite(
      stub([{ tasks: HEALTHY_TASKS }]).client,
      baseOptions(),
    );
    const screened = await synthesizeTaskSuite(
      stub([{ tasks: HEALTHY_TASKS }]).client,
      baseOptions({
        nullScreen: { client: screenStub('nothing at all').client, model: 'claude-sonnet-5' },
      }),
    );
    expect(screened.suite.tasks).toHaveLength(HEALTHY_TASKS.length);
    expect(screened.suite.suiteHash).not.toBe(unscreened.suite.suiteHash);
    expect(screened.generator.nullScreen).toMatchObject({
      enabled: true,
      model: 'claude-sonnet-5',
      dropOnCold: true,
    });
  });
});

// ---------------------------------------------------------------------------
// GENERATOR v2: check policy. Every rule below REJECTS; none admits.
// ---------------------------------------------------------------------------

describe('check policy (v2)', () => {
  const one = (overrides: Record<string, unknown>) => ({
    ...HEALTHY_TASKS[0],
    ...overrides,
  });

  const dropReasonFor = async (task: Record<string, unknown>): Promise<string | undefined> => {
    const s = stub([{ tasks: [task] }]);
    const result = await synthesizeTaskSuite(s.client, baseOptions());
    return result.dropped[0]?.reason;
  };

  it('measures the literal run a regex actually guarantees', () => {
    // Shapes a no-tools model satisfies by writing plausible prose.
    expect(longestLiteralRun('[0-9]{3,}')).toBeLessThan(3);
    expect(longestLiteralRun('\\d+')).toBeLessThan(3);
    expect(longestLiteralRun('.*')).toBeLessThan(3);
    expect(longestLiteralRun('\\[[a-zA-Z]+\\]')).toBeLessThan(3);
    // Real answers.
    expect(longestLiteralRun('rate-limit-policy')).toBe(17);
    expect(longestLiteralRun('\\b980\\b')).toBe(3);
    expect(longestLiteralRun('RFC 2616')).toBe(8);
  });

  it('rejects a regex that matches a shape rather than an answer', async () => {
    // Admitted on convex in v1: any three-digit number anywhere passes it.
    expect(
      await dropReasonFor(
        one({ id: 'bytes', check: { kind: 'regex', where: 'final_text', pattern: '[0-9]{3,}' } }),
      ),
    ).toBe('check-too-permissive');
    // Admitted on context7 in v1: any bracketed word passes it.
    expect(
      await dropReasonFor(
        one({ id: 'bracket', check: { kind: 'regex', where: 'final_text', pattern: '\\[[a-zA-Z]+\\]' } }),
      ),
    ).toBe('check-too-permissive');
  });

  it('rejects a check the prompt itself already satisfies', async () => {
    // Admitted on context7 in v1: the third alternative is a bare word the
    // prompt supplies, so the task is passable with no knowledge and no server.
    expect(
      await dropReasonFor(
        one({
          id: 'echo-zod',
          promptTemplate: 'Resolve the library id for {{lib}} with the docs search.',
          params: [{ name: 'lib', value: 'zod' }],
          answerKey: '/colinhacks/zod',
          check: { kind: 'regex', where: 'final_text', pattern: '/colinhacks/zod|/zod|zod' },
        }),
      ),
    ).toBe('check-matches-prompt');
    expect(
      await dropReasonFor(
        one({
          id: 'echo-substring',
          promptTemplate: 'Look up the {{topic}} page and summarize it.',
          params: [{ name: 'topic', value: 'rate limiting' }],
          answerKey: 'sliding window counter',
          check: { kind: 'substring', where: 'final_text', value: 'rate limiting' },
        }),
      ),
    ).toBe('check-matches-prompt');
  });

  it('rejects a one-word substring and a tool_called-only predicate', async () => {
    expect(
      await dropReasonFor(
        one({ id: 'tiny', check: { kind: 'substring', where: 'final_text', value: 'ok' } }),
      ),
    ).toBe('check-too-permissive');
    // Two deepwiki tasks were tool_called-only in v1: passed by the
    // stubbed-empty and random-valid-args null models without answering.
    expect(
      await dropReasonFor(one({ id: 'called-only', check: { kind: 'tool_called', tool: 'search_docs' } })),
    ).toBe('check-too-permissive');
  });

  it('allows tool_called only on a declared error-path probe', async () => {
    const s = stub([
      {
        tasks: [
          one({
            id: 'error-path',
            promptTemplate: 'Ask the docs search about {{topic}} and report what the server does.',
            params: [{ name: 'topic', value: 'a repository that does not exist' }],
            answerKey: 'not found',
            check: { kind: 'tool_called', tool: 'search_docs' },
            errorPath: true,
          }),
        ],
      },
    ]);
    const result = await synthesizeTaskSuite(s.client, baseOptions());
    expect(byId(result.suite.tasks).has('error-path')).toBe(true);
  });

  it('caps judge rubrics at one per suite', async () => {
    const s = stub([
      {
        tasks: [
          one({ id: 'judge-1', check: { kind: 'judge', rubric: 'Names the retry strategy.' } }),
          one({ id: 'judge-2', check: { kind: 'judge', rubric: 'Names the throttling algorithm.' } }),
        ],
      },
    ]);
    const result = await synthesizeTaskSuite(s.client, baseOptions());
    expect(byId(result.suite.tasks).has('judge-1')).toBe(true);
    expect(result.dropped).toContainEqual(
      expect.objectContaining({ id: 'judge-2', reason: 'check-too-permissive' }),
    );
  });

  it('requires the task to name why the server is needed at all', async () => {
    expect(await dropReasonFor(one({ id: 'unnamed', serverRequiredBecause: undefined }))).toBe(
      'no-server-requirement',
    );
    expect(await dropReasonFor(one({ id: 'bogus', serverRequiredBecause: 'because I said so' }))).toBe(
      'no-server-requirement',
    );
  });

  it('tells the generator what it is being screened on', () => {
    const s = stub([{ tasks: HEALTHY_TASKS }]);
    return synthesizeTaskSuite(s.client, baseOptions()).then(() => {
      const system = String(s.calls[0]!.system);
      expect(system).toContain('BANNED TASK SHAPES');
      expect(system).toContain('serverRequiredBecause');
      expect(system).toContain('tool_result_matches');
      expect(system).toContain('a model with');
      // Over-generation is asked for, because the screen deletes a large share.
      expect(String(s.calls[0]!.messages[0]!.content)).toContain('Generate exactly 24 tasks');
    });
  });
});

// ---------------------------------------------------------------------------
// GENERATOR v2: the answer-leak scan, widened and tightened
// ---------------------------------------------------------------------------

describe('answer-leak scan (v2)', () => {
  it('is punctuation-insensitive, which is how the exa task should have been caught', () => {
    // Measured v1 admission: prompt hands over the URL, answer key is "RFC 2616",
    // whitespace-only normalization says there is no leak, task ships.
    expect(
      findAnswerLeak({
        prompt: 'Read https://www.rfc-editor.org/rfc/rfc2616.txt and report the exact RFC number.',
        answerKey: 'RFC 2616',
      }),
    ).toBe('RFC 2616');
    expect(
      findAnswerLeak({ prompt: 'Report the coin id for staked ether.', answerKey: 'staked-ether' }),
    ).toBe('staked-ether');
  });

  it('does not fire on a short numeric key that merely appears inside another number', () => {
    // '307' and '1536' are real v1 answer keys. Squashed containment would drop
    // sound tasks; short keys therefore need a word boundary.
    expect(
      findAnswerLeak({ prompt: 'Look up status code handling for request 13073.', answerKey: '307' }),
    ).toBeNull();
    expect(
      findAnswerLeak({ prompt: 'Which status code does it return for a redirect?', answerKey: '307' }),
    ).toBeNull();
    expect(findAnswerLeak({ prompt: 'It returns 307 for that route.', answerKey: '307' })).toBe('307');
  });

  it('scans the server instructions and tool descriptions, with a longer floor for prose', () => {
    const corpus = {
      context: ['The Hugging Face tools are being used anonymously and rate limits apply.'],
    };
    const found = scanAnswerLeak(
      { prompt: 'Report the authentication status the server reports for this session.', answerKey: 'anonymous' },
      corpus,
    );
    expect(found).toEqual({ phrase: 'anonymous', source: 'context' });
    // Prose collides by accident, so a SHORT key found only in the context
    // corpus is not enough to drop a task. "rate" is in the instructions and is
    // under the prose floor; the prompt does not contain it at all.
    expect(
      scanAnswerLeak({ prompt: 'How many calls per hour does the server allow?', answerKey: 'rate' }, corpus),
    ).toBeNull();
  });

  it('scans bound param values even when the template never renders them', () => {
    expect(
      scanAnswerLeak(
        { prompt: 'Report the release the docs search returns.', answerKey: 'v4.2.1-beta' },
        { params: ['v4.2.1-beta'] },
      ),
    ).toEqual({ phrase: 'v4.2.1-beta', source: 'params' });
  });

  it('drops a candidate whose answer key lives in the server instructions', async () => {
    const s = stub([
      {
        tasks: [
          {
            ...HEALTHY_TASKS[0],
            id: 'instructions-leak',
            promptTemplate: 'Which tool does the server require before answering a docs question?',
            params: [],
            answerKey: 'search_docs before answering',
          },
        ],
      },
    ]);
    const result = await synthesizeTaskSuite(s.client, baseOptions());
    expect(result.dropped).toContainEqual(
      expect.objectContaining({ id: 'instructions-leak', reason: 'context-answer-leak' }),
    );
  });
});

// ---------------------------------------------------------------------------
// GENERATOR v2: admission accounting and the serialized ledger
// ---------------------------------------------------------------------------

describe('admission accounting (v2)', () => {
  it('binds params from the wire shape and the legacy record shape identically', () => {
    expect(bindParams([{ name: 'a', value: 'x' }, { name: 'n', value: 7 }])).toEqual({ a: 'x', n: '7' });
    expect(bindParams({ a: 'x', n: 7 })).toEqual({ a: 'x', n: '7' });
    expect(bindParams(undefined)).toEqual({});
    expect(bindParams([{ nope: 1 }])).toEqual({});
  });

  it('never counts a repair rewrite as a new candidate', async () => {
    const s = stub([{ tasks: [...HEALTHY_TASKS, LEAKY_TASK] }, { tasks: [LEAKY_FIXED] }]);
    const result = await synthesizeTaskSuite(s.client, baseOptions());

    // 10 raw candidates and 1 rewrite. v1 reported 11 generated against 10
    // admitted, an admission rate of 0.909 for a suite that lost nothing.
    expect(result.emitted).toBe(10);
    expect(result.rewritten).toBe(1);
    expect(result.candidates).toBe(10);
    expect(result.generated).toBe(result.emitted);
    expect(result.admitted).toBe(10);
    expect(result.admitted / result.candidates).toBe(1);
  });

  it('reconciles every candidate into exactly one bucket', async () => {
    const s = stub([
      {
        tasks: [
          ...HEALTHY_TASKS,
          { ...HEALTHY_TASKS[0], id: 'ghost', expectedTools: ['no_such_tool'] },
          { ...HEALTHY_TASKS[0], id: 'tiny', check: { kind: 'substring', where: 'final_text', value: 'ok' } },
        ],
      },
    ]);
    const result = await synthesizeTaskSuite(s.client, baseOptions());
    expect(result.candidates).toBe(result.admitted + result.dropped.length + result.trimmed);
    expect(result.reconciles).toBe(true);
    expect(result.shortfall).toBe(0);
  });

  it('serializes a drop ledger with the rule, the detail and the evidence', async () => {
    const s = stub([
      {
        tasks: [
          ...HEALTHY_TASKS,
          { ...HEALTHY_TASKS[0], id: 'ghost', expectedTools: ['no_such_tool'] },
        ],
      },
    ]);
    const result = await synthesizeTaskSuite(s.client, baseOptions());

    // The whole point: the ledger is a VALUE the pipeline can write to disk,
    // not a local variable that dies in the synthesizer's scope.
    const serialized = JSON.parse(
      JSON.stringify({
        generator: result.generator,
        surface: result.surface,
        yield: {
          emitted: result.emitted,
          rewritten: result.rewritten,
          candidates: result.candidates,
          entriesDiscarded: result.entriesDiscarded,
          admitted: result.admitted,
          trimmed: result.trimmed,
          reconciles: result.reconciles,
        },
        dropped: result.dropped.map((d) => ({ id: d.id, rule: d.reason, detail: d.detail, evidence: d.evidence })),
        nullScreen: result.nullScreen,
        repairs: result.repairs,
        leaks: result.leaksFound,
      }),
    ) as {
      generator: { generatorVersion: string };
      surface: { toolCount: number; toolNames: string[] };
      dropped: { id: string; rule: string; detail: string; evidence?: { unknownTools?: string[] } }[];
    };

    expect(serialized.generator.generatorVersion).toBe('fitness-report-generator/3');
    expect(serialized.surface.toolCount).toBe(TOOLS.length);
    expect(serialized.surface.toolNames).toContain('transfer_funds');
    const ghost = serialized.dropped.find((d) => d.id === 'ghost');
    expect(ghost?.rule).toBe('unknown-tool');
    expect(ghost?.evidence?.unknownTools).toEqual(['no_such_tool']);
    // No field anywhere in the ledger is named `token`: the publish-time
    // redactor erases those by name and would delete the evidence.
    expect(JSON.stringify(serialized)).not.toContain('"token"');
  });

  it('pairs a rewrite that came back with a blank id, and records how', async () => {
    // v1 keyed such a rewrite as `task-<rewriteIndex>`, never matched the
    // offender, silently reverted to the leaking original and dropped it while
    // still reporting regenerationAttempted: true.
    const s = stub([{ tasks: [...HEALTHY_TASKS, LEAKY_TASK] }, { tasks: [{ ...LEAKY_FIXED, id: '' }] }]);
    const result = await synthesizeTaskSuite(s.client, baseOptions());

    expect(byId(result.suite.tasks).has('leaky-version')).toBe(true);
    expect(result.repairs).toContainEqual({
      id: 'leaky-version',
      kind: 'answer-leak-rewrite',
      detail: 'replaced a prompt that stated its own answer key',
      matchedBy: 'position',
    });
    expect(result.dropped.some((d) => d.reason === 'answer-leak')).toBe(false);
  });

  it('counts payload entries the parser discarded', async () => {
    const s = stub(['{"tasks":[' + JSON.stringify(HEALTHY_TASKS[0]) + ',"junk"]}']);
    const result = await synthesizeTaskSuite(s.client, baseOptions());
    expect(result.entriesDiscarded).toBe(1);
    expect(result.emitted).toBe(1);
  });

  it('keeps the surplus out of the suite without calling it a drop', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...HEALTHY_TASKS[1],
      id: `inv-${String(i)}`,
      params: [{ name: 'invoice', value: `INV-10${String(i)}` }],
    }));
    const s = stub([{ tasks: many }]);
    const result = await synthesizeTaskSuite(s.client, baseOptions({ targetTaskCount: 9 }));
    expect(result.suite.tasks).toHaveLength(9);
    expect(result.trimmed).toBe(3);
    expect(result.dropped).toHaveLength(0);
    expect(result.reconciles).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GENERATOR v2: over-broad rules narrowed
// ---------------------------------------------------------------------------

describe('handle-param over-breadth (v2)', () => {
  it('does not classify pagination or correlation cursors as handles', () => {
    // aws-knowledge advertises `next_token`; huggingface advertises `repo_ids`.
    // DESIGN decision 6 records the same over-broad-name mistake in the redactor.
    expect(isHandleParam('next_token')).toBe(false);
    expect(isHandleParam('nextToken')).toBe(false);
    expect(isHandleParam('page_token')).toBe(false);
    expect(isHandleParam('cursor')).toBe(false);
    expect(isHandleParam('request_id')).toBe(false);
    expect(isHandleParam('idempotency_key')).toBe(false);
    // Still handles.
    expect(isHandleParam('record_id')).toBe(true);
    expect(isHandleParam('documentHandle')).toBe(true);
  });

  it('never fabricates a chain from a lone producer on the surface', () => {
    const paginated: readonly ToolSurfaceEntry[] = [
      {
        name: 'start_session',
        description: 'Start a session.',
        inputSchema: obj({ label: { type: 'string' } }, ['label']),
      },
      {
        name: 'list_regions',
        description: 'List regions, paginated.',
        inputSchema: obj({ next_token: { type: 'string' } }, []),
        annotations: { readOnlyHint: true },
      },
    ];
    // v1: one producer on the surface, so the cursor fabricated a chain and
    // `chainExpectedTools` then prepended a wrong producer or dropped the task.
    expect(detectHandleChains(paginated)).toEqual([]);
  });
});

describe('rendered-prompt properties the gate re-derives', () => {
  it('reports placeholders the params never bound', () => {
    expect(unresolvedPlaceholders('find {{a}} in {{b}}')).toEqual(['a', 'b']);
    expect(unresolvedPlaceholders(renderPrompt('find {{a}}', { a: 'x' }))).toEqual([]);
  });
});

describe('expectedTools normalization (v2)', () => {
  it('dedupes a repeated tool name instead of letting it refuse a run', async () => {
    const s = stub([
      {
        tasks: [
          {
            ...HEALTHY_TASKS[0],
            id: 'repeat',
            expectedTools: ['search_docs', 'search_docs'],
          },
        ],
      },
    ]);
    const result = await synthesizeTaskSuite(s.client, baseOptions());
    const task = byId(result.suite.tasks).get('repeat');
    expect(task?.expectedTools).toEqual(['search_docs']);
    expect(result.repairs).toContainEqual({
      id: 'repeat',
      kind: 'expected-tools-dedupe',
      detail: 'removed 1 duplicate expectedTools entries',
    });
  });
});

// ---------------------------------------------------------------------------
// GENERATOR v3: the check-pattern dialect
//
// 198 of 386 candidates across the sixteen published `fitness-report-generator/2`
// runs were dropped as `invalid-check` with the detail "regex does not compile",
// 196 of them on `tool_result_matches`. The published ledger recorded the rule
// and not the pattern, so these tests pin both halves of the fix: patterns that
// JavaScript refuses are repaired where an exact translation exists, and every
// drop now carries the check that caused it.
// ---------------------------------------------------------------------------

describe('check pattern dialect (v3)', () => {
  /**
   * Every `regex` and `tool_result_matches` pattern the published sweep
   * ADMITTED, sampled across the shapes that appear in it: lookahead
   * conjunctions, escaped metacharacters, bounded quantifiers, character
   * classes, alternation, anchors and JSON-key patterns.
   *
   * This corpus is the falsifier for "our own validation is rejecting patterns
   * that would in fact compile". Every one of these compiles, so every one of
   * them must come back byte-identical and unrepaired.
   */
  const PUBLISHED_PATTERNS: readonly string[] = [
    '_astro',
    'astro-dev-toolbar',
    'astro:(before|after)-(swap|preparation)',
    'prerender\\s*=\\s*false',
    '(is:inline[\\s\\S]*set:html|set:html[\\s\\S]*is:inline)',
    '\\b(2[5-9]|3[0-9]|4[0-9])\\b',
    '400\\s*(KB|KiB|kilobytes)',
    '51[,.]?200|51\\s*KB',
    '(?=[\\s\\S]*kaspa)(?=[\\s\\S]*sats)',
    "market_cap_rank['\"]?\\s*:\\s*137",
    '"trust_score_rank"\\s*:\\s*9[,\\s}]',
    'uniswap[\\s\\S]*"?high_7d"?\\s*:?\\s*[0-9]',
    'express\\.json\\(\\)',
    '\\[[a-zA-Z]+\\]',
    '\\$onUpdate',
    '\\$state\\.raw[\\s\\S]*\\$state\\.snapshot|\\$state\\.snapshot[\\s\\S]*\\$state\\.raw',
    'exa[\\s\\S]{0,300}?\\d+\\.\\d+\\.\\d+',
    'arXiv:\\d{4}\\.\\d{4,5}',
    '#H4sIA[A-Za-z0-9+/=_-]{16,}',
    'module github\\.com/wader/fq[\\s\\S]*go 1\\.',
    'tallyCount[\\s\\S]{0,90}not declared with',
    '(bun (add|install)[\\s\\S]*EXPO_PUBLIC_CONVEX_URL|EXPO_PUBLIC_CONVEX_URL[\\s\\S]*bun (add|install))',
    'hf://docs/[^\\s`"\']+',
    '^rate-limit-policy$',
    'a{2,3}?b',
    '(?<year>\\d{4})-\\d{2}',
    '(?<=v)\\d+\\.\\d+',
    '[]]',
    '[^]',
  ];

  it('returns a pattern JavaScript already accepts byte for byte', () => {
    // The safety property the whole repair rests on: every construct it
    // translates is one the ECMAScript parser REJECTS, so a pattern that
    // compiles cannot be changed by the repair existing.
    for (const pattern of PUBLISHED_PATTERNS) {
      const repair = repairPattern(pattern);
      expect(repair.pattern, pattern).toBe(pattern);
      expect(repair.repaired, pattern).toEqual([]);
      expect(repair.blockedBy, pattern).toBeUndefined();
    }
  });

  it('admits every pattern the published sweep admitted, so validation is not the over-strict half', async () => {
    for (const pattern of PUBLISHED_PATTERNS) {
      const compiled = compileCheckPattern(pattern);
      expect(compiled.ok, pattern).toBe(true);
    }
  });

  it('compiles with the same flags the runner compiles with', () => {
    // src/run/agent.ts safeRegex() uses `new RegExp(pattern, 'i')`. A pattern
    // that validated here and then failed there would be an indeterminate
    // task, scored as neither a pass nor a fail.
    expect(CHECK_PATTERN_FLAGS).toBe('i');
    const compiled = compileCheckPattern('rate-limit-policy');
    expect(compiled.ok).toBe(true);
    if (compiled.ok) expect(compiled.regex.flags).toBe('i');
  });

  it('strips an inline (?i) anywhere, because the runtime already applies i', () => {
    // (?i) is the single largest family of non-JavaScript regex syntax and the
    // one a model reaches for when it cannot predict the casing of prose. It
    // is also exactly removable here: `safeRegex` compiles with `i` whether
    // the group is present or not, so the compiled regex is identical.
    expect(repairPattern('(?i)rate-limit-policy')).toEqual({
      pattern: 'rate-limit-policy',
      repaired: ['inline flag group (?i)'],
    });
    expect(repairPattern('rate-limit(?i)-policy').pattern).toBe('rate-limit-policy');
    expect(repairPattern('(?i)[a-z]+-policy').pattern).toBe('[a-z]+-policy');
  });

  it('rewrites dot-all and multiline anchors instead of guessing at flags', () => {
    // (?s): a dot that also matches a newline IS [\s\S].
    expect(repairPattern('(?s)begin.*end').pattern).toBe('begin[\\s\\S]*end');
    // A dot inside a character class is already literal, and stays untouched.
    expect(repairPattern('(?s)v[.]\\d.').pattern).toBe('v[.]\\d[\\s\\S]');
    // (?is): both flags, one group.
    expect(repairPattern('(?is)Rate.Limit').pattern).toBe('Rate[\\s\\S]Limit');
    // (?m)^ matches at the start and after a newline in PCRE and in Python
    // alike, so the rewrite is exact.
    expect(repairPattern('(?m)^Total: [0-9]+').pattern).toBe('(?:^|(?<=\\n))Total: [0-9]+');
  });

  it('refuses to translate a multiline $, because the dialects disagree about it', () => {
    // PCRE and Python let `$` match before a trailing newline and JavaScript
    // does not. There is no rewrite that provably matches the same text, so
    // the candidate is dropped rather than quietly re-aimed.
    const repair = repairPattern('(?m)^rate-limit-policy$');
    expect(repair.pattern).toBeNull();
    expect(repair.blockedBy).toContain('multiline `$`');
  });

  it('translates the named-group and comment syntax of other dialects', () => {
    expect(repairPattern('(?P<ver>\\d+\\.\\d+\\.\\d+)').pattern).toBe('(?<ver>\\d+\\.\\d+\\.\\d+)');
    expect(repairPattern('(?P<w>[a-z]+)-(?P=w)').pattern).toBe('(?<w>[a-z]+)-\\k<w>');
    expect(repairPattern("(?'ver'\\d+\\.\\d+)").pattern).toBe('(?<ver>\\d+\\.\\d+)');
    // A comment matches nothing, so removing it cannot change a match.
    expect(repairPattern('(?#the release line)rate-limit-policy').pattern).toBe('rate-limit-policy');
  });

  it('drops, and names, a construct with no exact ECMAScript form', () => {
    // An atomic group and a possessive quantifier both forbid backtracking,
    // which JavaScript cannot express: the non-capturing or greedy form
    // matches strictly more text, so translating either would change what the
    // check accepts. Verbose mode changes what whitespace means.
    const atomic = repairPattern('(?>rate-limit-policy)+');
    expect(atomic.pattern).toBeNull();
    expect(atomic.blockedBy).toContain('atomic group');

    const possessive = repairPattern('rate-limit-policy[a-z]*+');
    expect(possessive.pattern).toBeNull();
    expect(possessive.blockedBy).toContain('possessive quantifier');

    const verbose = repairPattern('(?x) rate - limit # the policy page');
    expect(verbose.pattern).toBeNull();
    expect(verbose.blockedBy).toContain('inline flag group');

    const conditional = repairPattern('(?(1)rate-limit|policy)');
    expect(conditional.pattern).toBeNull();
    expect(conditional.blockedBy).toContain('conditional group');
  });

  it('keeps the meaning of a repaired pattern under the runner own evaluator', async () => {
    // The proof that a repair is not a re-aim: the repaired pattern, run
    // through the predicate evaluator the drive uses, accepts and rejects the
    // same text the generator meant it to.
    const compiled = compileCheckPattern('(?i)Rate-Limit-Policy');
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const task: FitnessTask = {
      id: 'repaired',
      prompt: 'find the page',
      expectedTools: ['search_docs'],
      check: { kind: 'regex', where: 'final_text', pattern: compiled.pattern },
      destructive: false,
    };
    expect(
      await evaluateCheck(task.check, { finalText: 'the rate-limit-policy page', calls: [] }, task),
    ).toBe(true);
    expect(
      await evaluateCheck(task.check, { finalText: 'the retry-policy page', calls: [] }, task),
    ).toBe(false);
  });

  it('tells the generator which dialect it is being compiled in', () => {
    // The prompt made tool_result_matches mandatory and never said what a
    // pattern would be compiled by. Both halves now live in the same section.
    expect(SYSTEM_PROMPT).toContain('REGEX DIALECT');
    expect(SYSTEM_PROMPT).toContain('ECMAScript');
    expect(SYSTEM_PROMPT).toContain('(?i)');
    expect(SYSTEM_PROMPT).toContain('i flag already applied');
  });

  it('admits a candidate the published generator dropped, and records the translation', async () => {
    const s = stub([
      {
        tasks: [
          {
            ...HEALTHY_TASKS[0],
            id: 'foreign-dialect',
            promptTemplate: 'Find the page describing what happens after too many {{noun}}.',
            params: [{ name: 'noun', value: 'requests' }],
            answerKey: 'rate-limit-policy',
            check: {
              kind: 'tool_result_matches',
              tool: 'search_docs',
              pattern: '(?i)rate-limit-policy',
            },
          },
        ],
      },
    ]);
    const result = await synthesizeTaskSuite(s.client, baseOptions());
    const task = byId(result.suite.tasks).get('foreign-dialect');
    // Admitted, where the published generator dropped it as invalid-check.
    expect(task).toBeDefined();
    expect(result.dropped).toEqual([]);
    // The SUITE carries the repaired pattern, because the suite is what the
    // runner compiles. Storing the original would move the failure downstream
    // to `evaluateCheck`, where it scores as neither a pass nor a fail.
    expect(task?.check).toEqual({
      kind: 'tool_result_matches',
      tool: 'search_docs',
      pattern: 'rate-limit-policy',
    });
    const repair = result.repairs.find((r) => r.kind === 'check-pattern-dialect');
    expect(repair?.id).toBe('foreign-dialect');
    expect(repair?.detail).toContain('inline flag group (?i)');
    expect(repair?.detail).toContain('"(?i)rate-limit-policy"');
    expect(repair?.detail).toContain('"rate-limit-policy"');
  });

  it('still drops an unsalvageable pattern, and says which construct did it', async () => {
    const s = stub([
      {
        tasks: [
          {
            ...HEALTHY_TASKS[0],
            id: 'atomic',
            check: {
              kind: 'tool_result_matches',
              tool: 'search_docs',
              pattern: '(?>rate-limit-policy)',
            },
          },
        ],
      },
    ]);
    const result = await synthesizeTaskSuite(s.client, baseOptions());
    const drop = result.dropped.find((d) => d.id === 'atomic');
    expect(drop?.reason).toBe('invalid-check');
    expect(drop?.detail).toContain('regex does not compile');
    expect(drop?.detail).toContain('atomic group');
    expect(byId(result.suite.tasks).has('atomic')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The drop ledger carries the check that did the rejecting
// ---------------------------------------------------------------------------

describe('drop ledger evidence (v3)', () => {
  const dropFor = async (task: Record<string, unknown>) => {
    const s = stub([{ tasks: [task] }]);
    const result = await synthesizeTaskSuite(s.client, baseOptions());
    return result.dropped[0];
  };

  it('records the pattern of a check that could not compile', async () => {
    // Without this the 198 published "regex does not compile" drops name no
    // pattern at all, so a reader cannot tell a broken generator from a
    // correctly refused candidate.
    const drop = await dropFor({
      ...HEALTHY_TASKS[0],
      id: 'uncompilable',
      check: { kind: 'tool_result_matches', tool: 'search_docs', pattern: '(?>rate-limit)' },
    });
    expect(drop?.evidence?.checkKind).toBe('tool_result_matches');
    expect(drop?.evidence?.checkPattern).toBe('(?>rate-limit)');
    expect(drop?.evidence?.checkTool).toBe('search_docs');
  });

  it('records the pattern of a check rejected as a shape rather than an answer', async () => {
    const drop = await dropFor({
      ...HEALTHY_TASKS[0],
      id: 'shape',
      check: { kind: 'regex', where: 'final_text', pattern: '[0-9]{3,}' },
    });
    expect(drop?.reason).toBe('check-too-permissive');
    expect(drop?.evidence?.checkPattern).toBe('[0-9]{3,}');
  });

  it('records both forms when a repaired pattern is then rejected', async () => {
    // The rule judged the ECMAScript form and the generator wrote the other
    // one. A ledger carrying only one of them cannot be argued with.
    const drop = await dropFor({
      ...HEALTHY_TASKS[0],
      id: 'repaired-then-rejected',
      check: { kind: 'regex', where: 'final_text', pattern: '(?i)[0-9]{3,}' },
    });
    expect(drop?.reason).toBe('check-too-permissive');
    expect(drop?.evidence?.checkPattern).toBe('(?i)[0-9]{3,}');
    expect(drop?.evidence?.checkPatternRepaired).toBe('[0-9]{3,}');
  });

  it('records the literal of a substring check and the tool of a tool_called check', async () => {
    const substring = await dropFor({
      ...HEALTHY_TASKS[0],
      id: 'tiny',
      check: { kind: 'substring', where: 'final_text', value: 'ok' },
    });
    expect(substring?.evidence?.checkKind).toBe('substring');
    expect(substring?.evidence?.checkValue).toBe('ok');

    const called = await dropFor({
      ...HEALTHY_TASKS[0],
      id: 'called-only',
      check: { kind: 'tool_called', tool: 'search_docs' },
    });
    expect(called?.evidence?.checkKind).toBe('tool_called');
    expect(called?.evidence?.checkTool).toBe('search_docs');
  });

  it('records the predicate the cold answer was graded against on a null screen drop', async () => {
    const screenClient: JudgeClient = {
      messages: {
        create: async () => cannedMessage('The answer is token bucket.'),
      },
    };
    const s = stub([{ tasks: [HEALTHY_TASKS[0]] }]);
    const result = await synthesizeTaskSuite(
      s.client,
      baseOptions({ nullScreen: { client: screenClient, model: 'claude-sonnet-5' } }),
    );
    const drop = result.dropped.find((d) => d.reason === 'null_screen');
    expect(drop?.evidence?.checkKind).toBe('substring');
    expect(drop?.evidence?.checkValue).toBe('token bucket');
    expect(drop?.evidence?.coldAnswerExcerpt).toContain('token bucket');
  });

  it('survives publish-time redaction, and is redacted by the same rules as everything else', async () => {
    // The evidence is additive INSIDE the same object the redactor already
    // walks: `redactReport` runs over suite-meta.json on the published copy.
    // A check literal is not a credential and must survive; a field the rules
    // name must not, whichever object it sits in.
    const drop = await dropFor({
      ...HEALTHY_TASKS[0],
      id: 'uncompilable',
      check: { kind: 'tool_result_matches', tool: 'search_docs', pattern: '(?>rate-limit)' },
    });
    const published = redactReport({ dropped: [drop], token: 'sk-live-not-a-real-key' });
    expect(published.dropped[0]?.evidence?.checkPattern).toBe('(?>rate-limit)');
    expect(published.dropped[0]?.evidence?.checkTool).toBe('search_docs');
    expect(published.token).not.toBe('sk-live-not-a-real-key');
  });
});
