/**
 * End-to-end pipeline (DESIGN decision 11), with the MODEL stubbed and the
 * SERVER real.
 *
 * The canary is a real MCP server over real HTTP; the judge and the runner are
 * scripted, so the whole gate-ordered pipeline runs with no API key, no
 * network beyond loopback, and no nondeterminism. What this pins is the wiring
 * that no module test can reach: synthesis feeding the free gates, the free
 * gates gating the cheap ones, the cheap ones gating the paid one, the drive
 * feeding the scorer, and the scorer feeding a report whose `score` key is
 * present exactly when the gates allowed it.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { start, type CanaryHandle } from '../canary/server.js';
import { parseArgs, runPipeline, type ModelClient } from '../src/cli.js';
import type { TapeLine } from '../src/types.js';

let canary: CanaryHandle;
let dir: string;

beforeAll(async () => {
  canary = await start(0);
  dir = await mkdtemp(join(tmpdir(), 'fitness-pipeline-'));
}, 30_000);

afterAll(async () => {
  await canary?.close();
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A stubbed judge + runner
// ---------------------------------------------------------------------------

/** Ten tasks over the canary's real tool surface: enough to clear the floor. */
function suitePayload(count: number): string {
  const tasks = Array.from({ length: count }, (_, i) => ({
    id: `t${i + 1}`,
    promptTemplate: 'Fetch invoice {{id}} and report its status.',
    params: { id: `inv_100${i}` },
    expectedTools: ['get_invoice'],
    // A substantive predicate on purpose. `tool_called` alone is degenerate:
    // the stubbed-empty null model satisfies it by definition, and the null
    // gate correctly KILLs a suite built on it (verified while writing this).
    check: { kind: 'substring', where: 'final_text', value: 'status: open' },
    answerKey: `status-${i}`,
    destructive: false
  }));
  return JSON.stringify({ tasks });
}

function message(text: string): Anthropic.Message {
  return {
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 200 }
  } as unknown as Anthropic.Message;
}

interface StubOptions {
  taskCount: number;
  /** How the scripted runner behaves on each drive. */
  behaviour?: 'succeed' | 'fail';
}

function stubClient(opts: StubOptions): ModelClient {
  const client = {
    messages: {
      async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
        // The judge answers two different questions: synthesize a suite, and
        // grade an answer. Only synthesis is exercised here.
        const asked = JSON.stringify(params.messages);
        if (asked.includes('Rubric:')) return message('PASS');
        return message(suitePayload(opts.taskCount));
      }
    },
    beta: {
      messages: {
        toolRunner(body: Anthropic.Beta.Messages.BetaToolRunnerParams) {
          const messages = [...body.messages];
          const tools = body.tools.filter(
            (t): t is Anthropic.Beta.BetaTool & { run: (a: unknown) => unknown } => 'run' in t
          );
          const wantsTools = tools.length > 0 && opts.behaviour !== 'fail';
          let observed = '';
          return {
            get params() {
              return { ...body, messages } as Anthropic.Beta.Messages.BetaToolRunnerParams;
            },
            async *[Symbol.asyncIterator]() {
              const tool = tools.find((t) => t.name === 'get_invoice');
              if (wantsTools && tool !== undefined) {
                const content = [{ type: 'tool_use', id: 'tu_1', name: 'get_invoice', input: { invoice_id: 'inv_1001' } }];
                messages.push({ role: 'assistant', content: content as never });
                yield {
                  id: 'msg_1',
                  type: 'message',
                  role: 'assistant',
                  model: 'claude-sonnet-5',
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
              // The answer is derived from what the server actually returned, so
              // a null model that returns nothing cannot fabricate a pass.
              const status = /\\?"status\\?":\\?"([a-z]+)/.exec(observed)?.[1] ?? 'unknown';
              const text = [
                { type: 'text', text: wantsTools ? `Invoice inv_1001 status: ${status}` : 'I cannot answer that.' }
              ];
              messages.push({ role: 'assistant', content: text as never });
              yield {
                id: 'msg_2',
                type: 'message',
                role: 'assistant',
                model: 'claude-sonnet-5',
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
  return client;
}

/**
 * A runner that never touches the server: it just quotes back the answer key
 * the construct gate put in its system prompt. Against a `substring` check
 * whose value is the answer key, this is the tautology the construct gate has
 * to catch, and it is what a dead or garbage server produces once the reference
 * pass is handed the answer.
 */
function answerKeyQuotingClient(taskCount: number): ModelClient {
  const suite = JSON.stringify({
    tasks: Array.from({ length: taskCount }, (_, i) => ({
      id: `t${i + 1}`,
      promptTemplate: 'Fetch invoice {{id}} and report its status.',
      params: { id: `inv_100${i}` },
      expectedTools: ['get_invoice'],
      check: { kind: 'substring', where: 'final_text', value: 'status: open' },
      answerKey: 'status: open',
      destructive: false
    }))
  });
  return {
    messages: {
      async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
        if (JSON.stringify(params.messages).includes('Rubric:')) return message('PASS');
        return message(suite);
      }
    },
    beta: {
      messages: {
        toolRunner(body: Anthropic.Beta.Messages.BetaToolRunnerParams) {
          const messages = [...body.messages];
          const system = typeof body.system === 'string' ? body.system : '';
          const leaked = /Intended answer: (.*)$/m.exec(system)?.[1]?.trim();
          return {
            get params() {
              return { ...body, messages } as Anthropic.Beta.Messages.BetaToolRunnerParams;
            },
            async *[Symbol.asyncIterator]() {
              const content = [
                { type: 'text', text: leaked === undefined ? 'I cannot answer that.' : `Invoice ${leaked}` }
              ];
              messages.push({ role: 'assistant', content: content as never });
              yield {
                id: 'msg_1',
                type: 'message',
                role: 'assistant',
                model: 'claude-sonnet-5',
                content,
                stop_reason: 'end_turn',
                usage: { input_tokens: 40, output_tokens: 10 }
              } as unknown as Anthropic.Beta.BetaMessage;
            }
          };
        }
      }
    }
  };
}

async function readTape(path: string): Promise<TapeLine[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as TapeLine);
}

// ---------------------------------------------------------------------------

describe('argument parsing', () => {
  it('accepts the documented invocation', () => {
    const opts = parseArgs(['run', 'https://x.test/mcp', '--auth-token', 'T', '--pin', '2026-07-28', '--out', 'runs/x', '--runner', 'claude-sonnet-5', '--max-tasks', '5']);
    expect(opts).toMatchObject({
      url: 'https://x.test/mcp',
      authToken: 'T',
      pin: '2026-07-28',
      out: 'runs/x',
      runner: 'claude-sonnet-5',
      maxTasks: 5
    });
  });

  it('defaults the runner to the pinned model and the judge to opus', () => {
    const opts = parseArgs(['run', 'https://x.test/mcp']);
    expect(opts.runner).toBe('claude-sonnet-5');
    expect(opts.judge).toBe('claude-opus-5');
  });

  it('rejects a missing url rather than guessing one', () => {
    expect(() => parseArgs(['run'])).toThrow(/usage/);
    expect(() => parseArgs(['run', '--pin', 'x'])).toThrow(/usage/);
  });
});

describe('full pipeline against the canary', () => {
  it('scores a run whose gates all cleared, and records every plane', async () => {
    const out = join(dir, 'scored');
    const result = await runPipeline(
      { ...parseArgs(['run', canary.url]), out, constructReps: 1 },
      { anthropic: stubClient({ taskCount: 10 }), log: () => undefined }
    );

    expect(result.report.outcome).toBe('SCORED');
    expect('score' in result.report).toBe(true);
    const score = result.report.score;
    expect(score?.runnerModel).toBe('claude-sonnet-5');
    expect(score?.firstTrySuccess.n).toBe(10);
    expect(score?.eventualSuccess.k).toBe(10);
    // Tool attribution comes off the mcp plane, and ONLY from the scored drive:
    // the construct reference pass and the null baselines hit the same server
    // on the same connection under different corr_ids.
    const invoice = score?.tools.find((t) => t.tool === 'get_invoice');
    expect(invoice?.calls).toBe(10);

    // Gate order is the cost order, and the ledger names every gate that ran.
    expect(result.report.gates.refusedAt).toBeNull();
    expect(result.report.gates.order).toEqual([
      'protocol_hygiene',
      'structural',
      'answer_leak',
      'suite_size',
      'plan_power',
      'construct',
      'null_baseline'
    ]);

    // Both planes exist, carry the suite hash, and end cleanly with no exitCode.
    const mcp = await readTape(result.files.mcpTape);
    const agent = await readTape(result.files.agentTape);
    for (const plane of [mcp, agent]) {
      const meta = plane[0] as { type?: string; producer?: { configHash?: string } };
      expect(meta.type).toBe('meta');
      expect(meta.producer?.configHash).toBe(result.report.run.suiteHash);
      const end = plane[plane.length - 1] as { type?: string; reason?: string; exitCode?: unknown };
      expect(end.type).toBe('end');
      expect(end.reason).toBe('eval_complete');
      expect('exitCode' in end).toBe(false);
    }
    expect(agent.filter((l) => (l as { type?: string }).type === 'turn').length).toBeGreaterThan(10);
    expect(mcp.filter((l) => (l as { dir?: string }).dir === 'event').length).toBeGreaterThan(0);

    // The published trace_stats block must agree with the published FILE, line
    // for line: DESIGN decision 5 makes `mcp-tape stats <file>` the oracle it
    // answers to. Built from the wire frames alone it claimed zero harness
    // events for a tape full of them.
    const records = (
      result.report.trace_stats as {
        planes: { mcp: { session: { records: Record<string, number> } } };
      }
    ).planes.mcp.session.records;
    expect(records.total).toBe(mcp.length);
    expect(records.meta).toBe(1);
    expect(records.end).toBe(1);
    expect(records.event).toBe(mcp.filter((l) => (l as { dir?: string }).dir === 'event').length);
    expect(records.event).toBeGreaterThan(0);
    expect(records.message).toBe(
      mcp.filter((l) => (l as { dir?: string }).dir === 'in' || (l as { dir?: string }).dir === 'out').length
    );

    // The redacted publish copy exists beside the raw one, and scoring read the
    // raw one (DESIGN decision 6).
    const published = await readTape(join(out, 'publish', 'mcp.jsonl'));
    expect(published.length).toBe(mcp.length);

    // docs/format.md line 45: dir "in" is the client-to-server REQUEST. The
    // connection's frame hook uses the opposite (transport) convention, so the
    // recorder translates. If this inverts, mcp-tape's pairing and our port of
    // it both register zero tools/call requests, every per-tool metric reads
    // zero, and the tape still looks complete. Pin it.
    const toolCallFrames = mcp.filter(
      (l) => (l as { raw?: { method?: string } }).raw?.method === 'tools/call'
    );
    expect(toolCallFrames.length).toBeGreaterThan(0);
    for (const frame of toolCallFrames) expect((frame as { dir?: string }).dir).toBe('in');
    const responses = mcp.filter(
      (l) => (l as { dir?: string }).dir === 'out' && (l as { raw?: object }).raw !== undefined
    );
    expect(responses.length).toBeGreaterThan(0);
    // The scorer read the mcp plane, not the agent-plane fallback.
    expect(result.report.scoreNotes?.some((n) => n.includes('fell back to the agent plane'))).toBeFalsy();

    const md = await readFile(result.files.reportMd, 'utf8');
    expect(md).toContain('## Result: SCORED');
    expect(md).not.toContain('—');
  }, 120_000);

  it('refuses below the minimum suite size and publishes no score', async () => {
    const out = join(dir, 'small');
    const result = await runPipeline(
      { ...parseArgs(['run', canary.url, '--max-tasks', '3']), out },
      { anthropic: stubClient({ taskCount: 3 }), log: () => undefined }
    );

    expect(result.report.outcome).toBe('INSUFFICIENT_SURFACE');
    expect('score' in result.report).toBe(false);
    // The structural gate carries the same absolute floor and runs first, so it
    // is the gate that refuses. The suite-size record still states the count.
    expect(result.report.gates.refusedAt).toBe('structural');
    const structuralRecord = result.report.gates.records.find((r) => r.gate === 'structural');
    expect(structuralRecord?.reason).toBe('too_few_generated');
    const sizeRecord = result.report.gates.records.find((r) => r.gate === 'suite_size');
    expect(sizeRecord?.ok).toBe(false);
    expect(sizeRecord?.detail).toMatchObject({ nTasks: 3, minTasks: 8 });
    const md = await readFile(result.files.reportMd, 'utf8');
    expect(md).toContain('## Result: REFUSED');
    expect(md).toContain('structural gate');
  }, 120_000);

  it('runs the drive for evidence after a refusal without ever publishing a score', async () => {
    const out = join(dir, 'evidence');
    const result = await runPipeline(
      { ...parseArgs(['run', canary.url, '--max-tasks', '3', '--evidence-drive']), out },
      { anthropic: stubClient({ taskCount: 3 }), log: () => undefined }
    );

    expect(result.report.outcome).toBe('INSUFFICIENT_SURFACE');
    expect('score' in result.report).toBe(false);
    const agent = await readTape(result.files.agentTape);
    // The recording exists even though the number does not.
    expect(agent.filter((l) => (l as { type?: string }).type === 'turn').length).toBeGreaterThan(0);
    expect(result.report.methods?.some((m) => m.includes('evidence-drive'))).toBe(true);
  }, 120_000);

  it('refuses at the construct gate when the reference pass never reached the server', async () => {
    // The reference agent is handed the answer key, so a substring check over
    // final_text alone is satisfiable with zero tool calls. If the gate accepts
    // that, it is a tautology: the suite's ground truth was never validated and
    // a score gets published for a run whose server may have returned nothing.
    const out = join(dir, 'tautology');
    const result = await runPipeline(
      { ...parseArgs(['run', canary.url]), out, constructReps: 1 },
      { anthropic: answerKeyQuotingClient(10), log: () => undefined }
    );

    expect(result.report.gates.refusedAt).toBe('construct');
    expect(result.report.outcome).toBe('GATE_FAILED');
    expect('score' in result.report).toBe(false);
    const construct = result.report.gates.records.find((r) => r.gate === 'construct');
    expect(construct?.ok).toBe(false);
    expect(construct?.detail).toMatchObject({ rate: 0, n: 10 });
    // The ledger row must not assert two verdicts at once: `ok` is derived from
    // the raw verdict, so the row carries the raw verdict.
    expect(construct?.verdict?.outcome).toBe('FAIL');
    expect(construct?.ok).toBe(construct?.verdict?.outcome === 'PASS');
  }, 120_000);

  it('publishes no credential in report.json or report.md, only in neither tape', async () => {
    // report.json is the artifact site/README tells the operator to append to
    // site/data/runs.json. A gateway that echoes the presented token into its
    // error body puts it in the SDK's message, which lands in the gate detail
    // and in the honesty notes.
    const TOKEN = 'AAAABBBBCCCCDDDDEEEEFFFF1234'; // deliberately matches no pattern rule
    const gateway = createServer((req, res) => {
      const presented = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: `unauthorized: presented ${presented} for /mcp` }
        })
      );
    });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    const { port } = gateway.address() as AddressInfo;
    const out = join(dir, 'credential');
    try {
      const result = await runPipeline(
        { ...parseArgs(['run', `http://127.0.0.1:${port}/mcp`, '--auth-token', TOKEN]), out, timeoutMs: 5000 },
        { anthropic: stubClient({ taskCount: 10 }), log: () => undefined }
      );
      expect(result.report.outcome).toBe('INDETERMINATE');

      const json = await readFile(result.files.reportJson, 'utf8');
      const md = await readFile(result.files.reportMd, 'utf8');
      const tape = await readFile(join(out, 'publish', 'mcp.jsonl'), 'utf8');
      for (const artifact of [json, md, tape]) expect(artifact).not.toContain(TOKEN);
      // Not by dropping the evidence: the failure is still reported, with the
      // credential replaced in place.
      expect(json).toContain('presented [REDACTED] for /mcp');
      expect(JSON.stringify(result.report)).not.toContain(TOKEN);
    } finally {
      gateway.closeAllConnections?.();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  }, 120_000);

  it('reports a dead endpoint as INDETERMINATE with the handshake still recorded', async () => {
    const out = join(dir, 'dead');
    const result = await runPipeline(
      { ...parseArgs(['run', 'http://127.0.0.1:1/mcp']), out, timeoutMs: 2000 },
      { anthropic: stubClient({ taskCount: 10 }), log: () => undefined }
    );
    expect(result.report.outcome).toBe('INDETERMINATE');
    expect('score' in result.report).toBe(false);
    expect(result.report.gates.refusedAt).toBe('protocol_hygiene');
    const mcp = await readTape(result.files.mcpTape);
    expect((mcp[0] as { type?: string }).type).toBe('meta');
  }, 60_000);
});
