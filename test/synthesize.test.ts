/**
 * Task synthesis tests (DESIGN decision 17, plus 13 at suite level).
 *
 * No network and no API key: the Anthropic client is injected, so every test
 * drives a canned stub that returns fixed JSON. The stub also records the
 * request params, which is how we pin the judge model and the shape of the call.
 */

import { describe, expect, it } from 'vitest';

import type Anthropic from '@anthropic-ai/sdk';

import {
  DEFAULT_JUDGE_MODEL,
  MIN_VIABLE_TASKS,
  TaskSynthesisError,
  canonicalJson,
  computeSuiteHash,
  detectHandleChains,
  findAnswerLeak,
  isHandleParam,
  leakTokens,
  parseTaskPayload,
  renderPrompt,
  synthesizeTaskSuite,
  taskIsDestructive,
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

const HEALTHY_TASKS = [
  {
    id: 'docs-throttling',
    promptTemplate:
      'Use the documentation search to find how {{subject}} request throttling is implemented, and name the algorithm.',
    params: { subject: 'API' },
    expectedTools: ['search_docs'],
    check: { kind: 'substring', where: 'final_text', value: 'token bucket' },
    answerKey: 'token bucket',
    destructive: false,
  },
  {
    id: 'invoice-status',
    promptTemplate: 'Fetch invoice {{invoice}} and report its payment status.',
    params: { invoice: 'INV-1042' },
    expectedTools: ['get_invoice'],
    check: { kind: 'substring', where: 'final_text', value: 'PAID' },
    answerKey: 'PAID',
    destructive: false,
  },
  {
    id: 'user-department',
    promptTemplate: 'Which department is the user {{who}} assigned to?',
    params: { who: 'ada' },
    expectedTools: ['lookup_user'],
    check: { kind: 'substring', where: 'final_text', value: 'Platform Engineering' },
    answerKey: 'Platform Engineering',
    destructive: false,
  },
  {
    id: 'record-inventory',
    promptTemplate: 'List the records and report the status shared by the two oldest entries.',
    params: {},
    expectedTools: ['list_records'],
    check: { kind: 'substring', where: 'final_text', value: 'archived' },
    answerKey: 'archived',
    destructive: false,
  },
  {
    id: 'tool-choice',
    promptTemplate:
      'Find the documentation page describing what happens after too many {{noun}}, and give its slug.',
    params: { noun: 'requests' },
    expectedTools: ['search_docs'],
    check: { kind: 'regex', where: 'final_text', pattern: 'rate-limit-policy' },
    answerKey: 'rate-limit-policy',
    destructive: false,
  },
  {
    id: 'create-then-update',
    promptTemplate:
      'Create a record titled {{title}}, then rename it to {{newTitle}} and report the record id you were given.',
    params: { title: 'Q3 audit', newTitle: 'Q3 audit (final)' },
    expectedTools: ['create_record', 'update_record'],
    check: { kind: 'tool_called', tool: 'update_record' },
    answerKey: 'REC-3391',
    destructive: true,
  },
  {
    id: 'delete-flow',
    promptTemplate: 'Remove the scratch record named {{name}} and report the id you removed.',
    params: { name: 'scratch-1' },
    expectedTools: ['delete_record'],
    check: { kind: 'tool_called', tool: 'delete_record' },
    answerKey: 'REC-8842',
    destructive: true,
  },
  {
    id: 'transfer',
    promptTemplate:
      'Move {{amount}} from account {{from}} to account {{to}} and report the transaction id.',
    params: { amount: '250 USD', from: 'alpha', to: 'beta' },
    expectedTools: ['transfer_funds'],
    check: { kind: 'substring', where: 'final_text', value: 'TXN-5501' },
    answerKey: 'TXN-5501',
    // The model claims this is safe. The spec-default rule says otherwise.
    destructive: false,
  },
  {
    id: 'retry-guidance',
    promptTemplate: 'Summarize the retry guidance in the documentation for a new integrator.',
    params: {},
    expectedTools: ['search_docs'],
    check: { kind: 'judge', rubric: 'Mentions the documented retry strategy by name.' },
    answerKey: 'exponential backoff',
    destructive: false,
  },
];

/** Seeded offender: the prompt states the answer, so a no-tools model passes it. */
const LEAKY_TASK = {
  id: 'leaky-version',
  promptTemplate:
    'The documentation says the current release is {{version}}. Confirm the current release with the docs search.',
  params: { version: '4.2.1' },
  expectedTools: ['search_docs'],
  check: { kind: 'substring', where: 'final_text', value: '4.2.1' },
  answerKey: '4.2.1',
  destructive: false,
};

const LEAKY_FIXED = {
  ...LEAKY_TASK,
  promptTemplate: 'Look up the current release of the {{product}} documentation and report it.',
  params: { product: 'platform' },
};

const LEAKY_STILL_BROKEN = {
  ...LEAKY_TASK,
  promptTemplate: 'Confirm with the docs search that the current release is {{version}}.',
  params: { version: '4.2.1' },
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

  it('parses fenced and prose-wrapped JSON', () => {
    expect(parseTaskPayload('```json\n{"tasks":[{"id":"a"}]}\n```')).toHaveLength(1);
    expect(parseTaskPayload('Here you go:\n{"tasks":[{"id":"a"},{"id":"b"}]}\nDone.')).toHaveLength(2);
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

  it('checks the RENDERED prompt, not the template', async () => {
    // The template alone hides the answer behind {{version}}; only rendering exposes it.
    const s = stub([{ tasks: [LEAKY_TASK] }, { tasks: [LEAKY_STILL_BROKEN] }]);
    const result = await synthesizeTaskSuite(s.client, baseOptions());
    expect(result.leaksFound).toEqual([{ taskId: 'leaky-version', token: '4.2.1' }]);
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
    expect(result.dropped).toContainEqual({
      id: 'leaky-version',
      reason: 'answer-leak',
      detail: 'answer key token "4.2.1" appears in the rendered prompt',
    });
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
    synthesizerVersion: 1,
    generatorModel: 'claude-opus-5',
    serverSlug: 'canary',
    targetTaskCount: 12,
    minTasks: 8,
    excludeDestructive: false,
    toolSurfaceDigest: 'abc',
    instructionsDigest: null,
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
      instructionsDigest: null,
      toolSurfaceDigest: 'abc',
      excludeDestructive: false,
      minTasks: 8,
      targetTaskCount: 12,
      serverSlug: 'canary',
      generatorModel: 'claude-opus-5',
      synthesizerVersion: 1,
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
    expect(result.dropped).toContainEqual({
      id: 'ghost',
      reason: 'unknown-tool',
      detail: 'not on the advertised surface: no_such_tool',
    });
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
