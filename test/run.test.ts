/**
 * Runner loop + report rendering (DESIGN decisions 1, 4, 9, 10, 11, 19).
 *
 * The runner model is stubbed: a fake `toolRunner` replays a scripted
 * conversation, so every assertion here is about OUR loop (frame recording,
 * corr_id stamping, failure taxonomy, destructive counting, budget fallback)
 * and never about the model's mood. The MCP side is the real canary over real
 * HTTP on 127.0.0.1, so tool errors, protocol errors and schema rejections are
 * the genuine article rather than mocks.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { start, type CanaryHandle } from '../canary/server.js';
import { connect, type McpConnection } from '../src/mcp/connect.js';
import { buildReport, refusalHeadline, renderMarkdown, viewerUrl } from '../src/report/render.js';
import {
  aliasTools,
  classifyFailure,
  driveTask,
  evaluateCheck,
  isTaskBudgetRejection,
  randomValidArgs,
  seeded,
  type RunnerClient,
  type ToolRunnerLike
} from '../src/run/agent.js';
import { TapeWriter } from '../src/tape/writer.js';
import type { ToolDescriptor } from '../src/score/metrics.js';
import type { FitnessTask, GateLedger, ProbeResults, ServerIdentity, TapeLine } from '../src/types.js';

// ---------------------------------------------------------------------------
// A scripted runner model
// ---------------------------------------------------------------------------

interface ScriptStep {
  /** Tool calls this assistant turn asks for. */
  calls?: { name: string; input: Record<string, unknown> }[];
  text?: string;
  stopReason?: string;
}

/**
 * Stands in for `client.beta.messages.toolRunner`. It walks the script, runs
 * the tools the same way the real runner does (via each tool's `run`), and
 * appends the resulting `tool_result` user message to `params.messages` so the
 * loop's turn-flushing sees exactly what it would see in production.
 */
interface ScriptedClient extends RunnerClient {
  /** Mutable call counter: read it AFTER the drive, never copy it. */
  readonly state: { calls: number; lastParams: unknown };
}

function scriptedClient(script: readonly ScriptStep[], opts: { rejectBudget?: boolean } = {}): ScriptedClient {
  const state = { calls: 0, lastParams: undefined as unknown };
  const client = {
    beta: {
      messages: {
        toolRunner(body: Anthropic.Beta.Messages.BetaToolRunnerParams): ToolRunnerLike {
          state.calls += 1;
          state.lastParams = body;
          const rejects = opts.rejectBudget === true && body.output_config?.task_budget != null;
          const messages = [...body.messages];
          const byName = new Map(
            body.tools
              .filter((t): t is Anthropic.Beta.BetaTool & { run: (args: unknown) => unknown } => 'run' in t)
              .map((t) => [t.name, t])
          );
          let id = 0;
          const runner: ToolRunnerLike = {
            get params() {
              return { ...body, messages } as Anthropic.Beta.Messages.BetaToolRunnerParams;
            },
            async *[Symbol.asyncIterator]() {
              if (rejects) {
                const error = Object.assign(new Error('output_config.task_budget requires the task-budgets-2026-03-13 beta'), {
                  status: 400
                });
                throw error;
              }
              for (const step of script) {
                const content: unknown[] = [];
                if (step.text !== undefined) content.push({ type: 'text', text: step.text });
                for (const call of step.calls ?? []) {
                  content.push({ type: 'tool_use', id: `tu_${(id += 1)}`, name: call.name, input: call.input });
                }
                const message = {
                  id: `msg_${id}`,
                  type: 'message',
                  role: 'assistant',
                  model: 'claude-sonnet-5',
                  content,
                  stop_reason: step.stopReason ?? (step.calls && step.calls.length > 0 ? 'tool_use' : 'end_turn'),
                  usage: { input_tokens: 10, output_tokens: 20 }
                } as unknown as Anthropic.Beta.BetaMessage;
                messages.push({ role: 'assistant', content: content as never });
                yield message;

                const results: unknown[] = [];
                for (const call of step.calls ?? []) {
                  const tool = byName.get(call.name);
                  if (tool === undefined) continue;
                  try {
                    const out = await tool.run(call.input);
                    results.push({ type: 'tool_result', tool_use_id: `tu_${id}`, content: out });
                  } catch (error) {
                    results.push({
                      type: 'tool_result',
                      tool_use_id: `tu_${id}`,
                      is_error: true,
                      content: error instanceof Error ? error.message : String(error)
                    });
                  }
                }
                if (results.length > 0) messages.push({ role: 'user', content: results as never });
              }
            }
          };
          return runner;
        }
      }
    }
  };
  return { ...client, state };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let canary: CanaryHandle;
let dir: string;
let conn: McpConnection;
let tools: ToolDescriptor[];

beforeAll(async () => {
  canary = await start(0);
  dir = await mkdtemp(join(tmpdir(), 'fitness-run-'));
  conn = await connect({ url: canary.url, onFrame: () => undefined });
  const listed = await conn.listTools({ cacheMode: 'bypass' });
  tools = listed.tools as unknown as ToolDescriptor[];
}, 30_000);

afterAll(async () => {
  await conn?.close();
  await canary?.close();
  await rm(dir, { recursive: true, force: true });
});

function task(over: Partial<FitnessTask> = {}): FitnessTask {
  return {
    id: 'task-1',
    prompt: 'Echo the word canary.',
    expectedTools: ['slow_echo'],
    check: { kind: 'substring', where: 'final_text', value: 'canary' },
    destructive: false,
    ...over
  };
}

async function tapes(name: string): Promise<{ mcp: TapeWriter; agent: TapeWriter; read: () => Promise<TapeLine[]> }> {
  const path = join(dir, `${name}-mcp.jsonl`);
  const agentPath = join(dir, `${name}-agent.jsonl`);
  const meta = { startedAt: '2026-08-19T00:00:00.000Z', label: 'canary', command: ['fitness-report', canary.url] };
  const mcp = await TapeWriter.open({ path, meta: { ...meta, kind: 'mcp' } });
  const agent = await TapeWriter.open({ path: agentPath, meta: { ...meta, kind: 'llm' } });
  return {
    mcp,
    agent,
    read: async () => {
      const raw = await readFile(agentPath, 'utf8');
      return raw
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as TapeLine);
    }
  };
}

// ---------------------------------------------------------------------------

describe('tool surface adaptation', () => {
  it('passes clean MCP names through untouched', () => {
    const aliased = aliasTools([{ name: 'slow_echo' }, { name: 'delete_record' }] as ToolDescriptor[]);
    expect(aliased.map((a) => a.alias)).toEqual(['slow_echo', 'delete_record']);
  });

  it('sanitizes a name the Claude tool grammar would reject, and keeps the wire name', () => {
    const aliased = aliasTools([{ name: 'docs.search/v2' }] as ToolDescriptor[]);
    expect(aliased[0]?.alias).toBe('docs_search_v2');
    expect(aliased[0]?.name).toBe('docs.search/v2');
  });

  it('never collides two sanitized names', () => {
    const aliased = aliasTools([{ name: 'a.b' }, { name: 'a/b' }] as ToolDescriptor[]);
    expect(new Set(aliased.map((a) => a.alias)).size).toBe(2);
  });
});

describe('check evaluation', () => {
  const ctx = { finalText: 'The Invoice INV-1042 is PAID.', calls: [{ tool: 'get_invoice', ok: true, text: 'paid' }] };

  it('matches a substring case-insensitively', async () => {
    await expect(evaluateCheck({ kind: 'substring', where: 'final_text', value: 'inv-1042 is paid' }, ctx, task())).resolves.toBe(true);
  });

  it('reports a malformed regex as not checkable rather than as a server failure', async () => {
    await expect(evaluateCheck({ kind: 'regex', where: 'final_text', pattern: '([' }, ctx, task())).resolves.toBeNull();
  });

  it('requires a SUCCESSFUL call for tool_called', async () => {
    const failed = { finalText: '', calls: [{ tool: 'get_invoice', ok: false, text: '' }] };
    await expect(evaluateCheck({ kind: 'tool_called', tool: 'get_invoice' }, failed, task())).resolves.toBe(false);
  });

  it('resolves a judge check to null when no judge is wired', async () => {
    await expect(evaluateCheck({ kind: 'judge', rubric: 'is it paid' }, ctx, task())).resolves.toBeNull();
  });
});

describe('failure taxonomy', () => {
  const base = { success: false, budgetExhausted: false, mrtrAbandoned: false, records: [], loopError: null, stopReason: null };
  const rec = (status: string) => [{ status } as never];

  it('puts budget exhaustion above everything else', () => {
    expect(classifyFailure({ ...base, budgetExhausted: true, mrtrAbandoned: true, records: rec('protocol-error') })).toBe('budget-exhausted');
  });

  it('puts a schema rejection above a protocol error', () => {
    expect(classifyFailure({ ...base, records: [...rec('protocol-error'), ...rec('schema-validation-reject')] })).toBe('schema-validation-reject');
  });

  it('only calls an execution error recovered when the task actually succeeded', () => {
    expect(classifyFailure({ ...base, success: true, records: rec('tool-error') })).toBe('execution-error-recovered');
    expect(classifyFailure({ ...base, success: false, records: rec('tool-error') })).toBe('execution-error-fatal');
  });

  it('reports no failure for a clean success', () => {
    expect(classifyFailure({ ...base, success: true })).toBeNull();
  });
});

describe('driveTask against the canary', () => {
  it('records both planes with corr_id = taskId and passes a satisfied check', async () => {
    const t = await tapes('happy');
    const client = scriptedClient([
      { calls: [{ name: 'slow_echo', input: { text: 'canary' } }] },
      { text: 'The server echoed canary.' }
    ]);
    const run = await driveTask(task(), {
      client,
      conn,
      tools,
      agentTape: t.agent,
      mcpTape: t.mcp,
      taskBudgetTokens: 20_000
    });
    await t.agent.close({ reason: 'eval_complete' });
    await t.mcp.close({ reason: 'eval_complete' });

    expect(run.outcome.success).toBe(true);
    expect(run.outcome.firstTrySuccess).toBe(true);
    expect(run.outcome.failure).toBeNull();
    expect(run.toolCallRecords).toHaveLength(1);
    expect(run.toolCallRecords[0]?.tool).toBe('slow_echo');
    expect(run.toolCallRecords[0]?.status).toBe('ok');

    const lines = await t.read();
    const turns = lines.filter((l) => (l as { type?: string }).type === 'turn');
    expect(turns.length).toBeGreaterThanOrEqual(3); // prompt, assistant, tool result, assistant
    for (const turn of turns) expect((turn as { corr_id?: string }).corr_id).toBe('task-1');
    // Every timestamp is caller-supplied, so the plane is monotonic.
    const stamps = lines.map((l) => (l as { t?: string }).t ?? '');
    expect([...stamps].sort()).toEqual(stamps);
  });

  it('classifies an isError tool result as an execution error the agent could recover from', async () => {
    const t = await tapes('recovered');
    const client = scriptedClient([
      { calls: [{ name: 'get_invoice', input: { invoice_id: 'inv_nope' } }] },
      { text: 'That invoice does not exist. canary' }
    ]);
    const run = await driveTask(task({ id: 'task-recovered', expectedTools: ['get_invoice'] }), {
      client,
      conn,
      tools,
      agentTape: t.agent,
      mcpTape: t.mcp
    });
    await t.agent.close({ reason: 'eval_complete' });
    await t.mcp.close({ reason: 'eval_complete' });

    expect(run.toolCallRecords[0]?.status).toBe('tool-error');
    expect(run.outcome.success).toBe(true);
    expect(run.outcome.firstTrySuccess).toBe(false); // it took a repair turn
    expect(run.outcome.failure).toBe('execution-error-recovered');
  });

  it('classifies a JSON-RPC error as a protocol error and keeps the run alive', async () => {
    const t = await tapes('protocol');
    const client = scriptedClient([
      { calls: [{ name: 'flaky_search', input: { query: 'crash' } }] },
      { text: 'The server crashed.' }
    ]);
    const run = await driveTask(task({ id: 'task-protocol', expectedTools: ['flaky_search'] }), {
      client,
      conn,
      tools,
      agentTape: t.agent,
      mcpTape: t.mcp
    });
    await t.agent.close({ reason: 'eval_complete' });
    await t.mcp.close({ reason: 'eval_complete' });

    expect(run.toolCallRecords[0]?.status).toBe('protocol-error');
    expect(run.outcome.failure).toBe('protocol-error');
    expect(run.error).toBeNull(); // the loop survived; only the tool call failed
  });

  it('classifies an outputSchema violation as a SERVER schema-validation-reject', async () => {
    // The SDK only validates structuredContent when it holds a cached
    // tools/list index, which cacheMode 'bypass' never writes. This connection
    // is refreshed on purpose; see the INTEGRATION FIX note in src/cli.ts.
    await conn.listTools({ cacheMode: 'refresh' });
    const t = await tapes('schema');
    const client = scriptedClient([
      { calls: [{ name: 'broken_schema', input: { account: 'acct_1' } }] },
      { text: 'The server broke its own contract.' }
    ]);
    const run = await driveTask(task({ id: 'task-schema', expectedTools: ['broken_schema'] }), {
      client,
      conn,
      tools,
      agentTape: t.agent,
      mcpTape: t.mcp
    });
    await t.agent.close({ reason: 'eval_complete' });
    await t.mcp.close({ reason: 'eval_complete' });

    expect(run.toolCallRecords[0]?.status).toBe('schema-validation-reject');
    expect(run.outcome.failure).toBe('schema-validation-reject');
  });

  it('counts an unannotated destructive tool as destructive-without-confirmation', async () => {
    const t = await tapes('destructive');
    const client = scriptedClient([
      { calls: [{ name: 'transfer_funds', input: { from_account: 'acct_1', to_account: 'acct_2', amount_cents: 100 } }] },
      { text: 'Transferred. canary' }
    ]);
    const run = await driveTask(task({ id: 'task-destructive', expectedTools: ['transfer_funds'] }), {
      client,
      conn,
      tools,
      agentTape: t.agent,
      mcpTape: t.mcp
    });
    await t.agent.close({ reason: 'eval_complete' });
    await t.mcp.close({ reason: 'eval_complete' });

    // transfer_funds carries NO annotations at all, so the spec default rule
    // (destructiveHint true) is the only signal available.
    expect(run.toolCallRecords[0]?.declaredDestructive).toBe(true);
    expect(run.unconfirmedDestructiveCalls).toBe(1);
  });

  it('leaves a read-only annotated tool out of the destructive count', async () => {
    const t = await tapes('readonly');
    const client = scriptedClient([{ calls: [{ name: 'slow_echo', input: { text: 'canary' } }] }, { text: 'canary' }]);
    const run = await driveTask(task({ id: 'task-readonly' }), { client, conn, tools, agentTape: t.agent, mcpTape: t.mcp });
    await t.agent.close({ reason: 'eval_complete' });
    await t.mcp.close({ reason: 'eval_complete' });
    expect(run.unconfirmedDestructiveCalls).toBe(0);
  });

  it('falls back to the iteration cap when the API rejects the task-budget beta', async () => {
    const t = await tapes('budget');
    const client = scriptedClient([{ text: 'canary' }], { rejectBudget: true });
    const run = await driveTask(task({ id: 'task-budget' }), {
      client,
      conn,
      tools,
      agentTape: t.agent,
      mcpTape: t.mcp,
      taskBudgetTokens: 20_000
    });
    await t.agent.close({ reason: 'eval_complete' });
    await t.mcp.close({ reason: 'eval_complete' });

    expect(run.budgetDeclined).toBe(true);
    expect(run.outcome.success).toBe(true); // the retry ran without the beta
    expect(client.state.calls).toBe(2);
  });

  it('reads a stopped-mid-tool-use loop as budget exhausted', async () => {
    const t = await tapes('exhausted');
    const client = scriptedClient([{ calls: [{ name: 'slow_echo', input: { text: 'x' } }], stopReason: 'tool_use' }]);
    const run = await driveTask(task({ id: 'task-exhausted' }), { client, conn, tools, agentTape: t.agent, mcpTape: t.mcp });
    await t.agent.close({ reason: 'eval_complete' });
    await t.mcp.close({ reason: 'eval_complete' });
    expect(run.outcome.budgetExhausted).toBe(true);
    expect(run.outcome.failure).toBe('budget-exhausted');
  });

  it('never touches the server in the no-tools null model', async () => {
    const t = await tapes('null-none');
    const before = conn.httpObservations.length;
    const client = scriptedClient([{ text: 'I would need a tool for that.' }]);
    const run = await driveTask(task({ id: 'task-null' }), {
      client,
      conn,
      tools,
      agentTape: t.agent,
      mcpTape: t.mcp,
      toolMode: 'none'
    });
    await t.agent.close({ reason: 'eval_complete' });
    await t.mcp.close({ reason: 'eval_complete' });
    expect(run.toolCallRecords).toHaveLength(0);
    expect(conn.httpObservations.length).toBe(before);
    expect(run.outcome.success).toBe(false);
  });
});

describe('random-valid-args generation', () => {
  it('is deterministic for a seed', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' }, n: { type: 'integer' } }, required: ['q', 'n'] };
    expect(randomValidArgs(schema, seeded(7))).toEqual(randomValidArgs(schema, seeded(7)));
  });

  it('honours an enum', () => {
    const schema = { type: 'object', properties: { mode: { enum: ['a', 'b'] } }, required: ['mode'] };
    expect(['a', 'b']).toContain(randomValidArgs(schema, seeded(3))['mode']);
  });
});

describe('task-budget rejection detection', () => {
  it('recognises a 400 that names the budget', () => {
    expect(isTaskBudgetRejection(Object.assign(new Error('output_config.task_budget requires a beta'), { status: 400 }))).toBe(true);
  });

  it('does not swallow an unrelated 400', () => {
    expect(isTaskBudgetRejection(Object.assign(new Error('max_tokens too large'), { status: 400 }))).toBe(false);
  });

  it('does not swallow a 500', () => {
    expect(isTaskBudgetRejection(Object.assign(new Error('task_budget'), { status: 500 }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('report rendering', () => {
  const server: ServerIdentity = {
    url: 'https://example.test/mcp',
    slug: 'example-test',
    era: 'modern',
    negotiatedVersion: '2026-07-28',
    transportShape: 'json',
    sessionful: false,
    credentialContext: 'anonymous'
  };
  const probes: ProbeResults = {
    specCurrency: '2026-07-28',
    findings: [{ id: 'bogus-version-accepted', pass: false, detail: 'the server echoed 1999-01-01 back' }]
  };
  const gates: GateLedger = {
    order: ['structural', 'suite_size'],
    records: [
      { gate: 'structural', ok: true, costTier: 'free', reason: 'ok' },
      { gate: 'suite_size', ok: false, costTier: 'free', reason: 'below_minimum_suite_size', detail: { nTasks: 4, minTasks: 8 } }
    ],
    extensionPolicy: { extensionSize: 12, maxExtensions: 2 },
    refusedAt: 'suite_size'
  };
  const base = {
    runId: 'run-1',
    startedAt: '2026-08-19T00:00:00.000Z',
    harnessVersion: '0.1.0',
    runnerModel: 'claude-sonnet-5',
    judgeModel: 'claude-opus-5',
    suiteHash: 'abc123',
    taskBudget: 20_000,
    server,
    probes,
    gates
  };

  it('omits the score KEY entirely on a refusal', () => {
    const report = buildReport({ ...base, outcome: 'INSUFFICIENT_SURFACE' });
    expect('score' in report).toBe(false);
    expect(report.outcome).toBe('INSUFFICIENT_SURFACE');
  });

  it('drops a score handed in with a non-SCORED outcome rather than publishing it', () => {
    const report = buildReport({
      ...base,
      outcome: 'GATE_FAILED',
      score: { runnerModel: 'claude-sonnet-5' } as never
    });
    expect('score' in report).toBe(false);
  });

  it('renders the refusal as the result, naming the gate', () => {
    const report = buildReport({ ...base, outcome: 'INSUFFICIENT_SURFACE' });
    const md = renderMarkdown(report);
    expect(md).toContain('## Result: REFUSED');
    expect(md).toContain('suite size gate');
    expect(md).toContain('below_minimum_suite_size');
    expect(refusalHeadline(report)).toContain('REFUSED (INSUFFICIENT_SURFACE)');
  });

  it('carries no em-dash anywhere in the rendered markdown', () => {
    const report = buildReport({ ...base, outcome: 'INSUFFICIENT_SURFACE', methods: ['a note'] });
    expect(renderMarkdown(report)).not.toContain('—');
  });

  it('refuses to build a semicolon-bearing viewer URL', () => {
    expect(viewerUrl('https://x.test/a;b.jsonl', 'https://x.test/c.jsonl')).toBeNull();
    expect(viewerUrl('https://x.test/a.jsonl', 'https://x.test/b.jsonl')).toContain('mcpreplay.dev');
  });
});
