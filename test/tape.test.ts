/**
 * Tape module tests: golden two-plane run, writer invariants (DESIGN decisions
 * 4/5/6), publish-time redaction, and the mcp-tape conformance oracle.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { TapeWriter } from '../src/tape/writer.js';
import { redactReport, redactTape, scrubSecrets } from '../src/tape/redact.js';
import { computeTraceStats, type TraceRecord } from '../src/score/stats.js';
import type { TapeLine, TapeMessageLine, TapeTurnLine } from '../src/types.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const HARNESS_VERSION = '0.1.0';
const SUITE_HASH = 'sha256:9f2b1c0d';
const SERVER_URL = 'https://canary.test/mcp';
const T0 = '2026-08-19T12:00:00.000Z';

/** A Google API key shape, present in the LOCAL default-redact.json only. */
const GOOGLE_KEY = 'AIzaSyD-1234567890abcdefghijklmnopqrstu';

function iso(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

const tmpDirs: string[] = [];

async function tmpRunDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fitness-tape-'));
  tmpDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function readLines(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Golden two-plane run. Both planes describe the SAME three tool calls: the mcp
// plane as JSON-RPC wire frames, the agent plane as turn records. They are
// deliberately never merged into one file (DESIGN decision 4).
// ---------------------------------------------------------------------------

interface Golden {
  dir: string;
  mcpPath: string;
  agentPath: string;
  mcpLines: TapeLine[];
  agentLines: TapeLine[];
}

async function writeGoldenRun(): Promise<Golden> {
  const dir = await tmpRunDir();
  const mcpPath = join(dir, 'run-1', 'mcp.jsonl');
  const agentPath = join(dir, 'run-1', 'agent.jsonl');

  const mcpFrames: TapeLine[] = [];
  const agentFrames: TapeLine[] = [];

  const mcp = await TapeWriter.open({
    path: mcpPath,
    meta: {
      startedAt: T0,
      label: 'canary',
      command: ['fitness-report', SERVER_URL],
      mcpTapVersion: HARNESS_VERSION,
      kind: 'mcp',
      source: `fitness-report@${HARNESS_VERSION}`,
      producer: { name: 'fitness-report', version: HARNESS_VERSION, configHash: SUITE_HASH },
    },
    onFrame: (l) => mcpFrames.push(l),
  });

  await mcp.writeEvent({
    t: iso(10),
    dir: 'event',
    kind: 'fitness.task_start',
    raw: { taskId: 't1' },
    corr_id: 't1',
  });

  const call = (id: number, name: string, args: unknown, at: number, corr: string) =>
    mcp.writeMessage({
      t: iso(at),
      dir: 'in',
      raw: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
      corr_id: corr,
    });
  const reply = (id: number, result: unknown, at: number, corr: string) =>
    mcp.writeMessage({
      t: iso(at),
      dir: 'out',
      raw: { jsonrpc: '2.0', id, result },
      corr_id: corr,
    });

  await call(1, 'lookup_user', { user: 'amy', api_key: 'sk-live-abcdefghijklmnopqrstuvwx' }, 100, 't1');
  await reply(
    1,
    {
      content: [
        { type: 'text', text: `found amy; console key ${GOOGLE_KEY} and https://svc:s3cr3t@canary.test/mcp` },
      ],
      structuredContent: { user_id: 'u-7', password: 'hunter2' },
    },
    600,
    't1',
  );

  await call(2, 'get_invoice', { invoice_id: 'i-1', page_token: 'ptok-42' }, 700, 't1');
  await reply(
    2,
    { isError: true, content: [{ type: 'text', text: 'invoice i-1 not found; try list_invoices' }] },
    1100,
    't1',
  );

  await mcp.writeEvent({
    t: iso(1200),
    dir: 'event',
    kind: 'fitness.verdict',
    raw: { taskId: 't1', firstTrySuccess: false, success: true },
    corr_id: 't1',
  });

  await call(3, 'delete_record', { record_id: 'r-9' }, 1300, 't2');
  await reply(3, { content: [{ type: 'text', text: 'deleted' }] }, 1500, 't2');

  await mcp.close({ t: iso(2000), reason: 'eval_complete' });

  // --- agent plane -------------------------------------------------------
  const agent = await TapeWriter.open({
    path: agentPath,
    meta: {
      startedAt: T0,
      label: 'canary',
      command: ['fitness-report', SERVER_URL],
      mcpTapVersion: HARNESS_VERSION,
      kind: 'llm',
      source: `fitness-report@${HARNESS_VERSION}`,
      producer: { name: 'fitness-report', version: HARNESS_VERSION, configHash: SUITE_HASH },
    },
    onFrame: (l) => agentFrames.push(l),
  });

  const assistantCall = (at: number, id: string, name: string, input: unknown, corr: string) =>
    agent.writeTurn({
      t: iso(at),
      type: 'turn',
      role: 'assistant',
      blocks: [
        { type: 'thinking', thinking: 'pick a tool', signature: 'sig-opaque-do-not-touch' },
        { type: 'tool_use', id, name, input },
      ],
      model: 'claude-sonnet-5',
      usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 0 },
      corr_id: corr,
    });
  const toolResult = (at: number, id: string, text: string, isError: boolean, corr: string) =>
    agent.writeTurn({
      t: iso(at),
      type: 'turn',
      role: 'user',
      blocks: [
        { type: 'tool_result', tool_use_id: id, is_error: isError, content: [{ type: 'text', text }] },
      ],
      corr_id: corr,
    });

  await assistantCall(90, 'tu_1', 'lookup_user', { user: 'amy' }, 't1');
  await toolResult(650, 'tu_1', 'found amy', false, 't1');
  await assistantCall(690, 'tu_2', 'get_invoice', { invoice_id: 'i-1' }, 't1');
  await toolResult(1150, 'tu_2', 'invoice i-1 not found', true, 't1');
  await assistantCall(1290, 'tu_3', 'delete_record', { record_id: 'r-9' }, 't2');
  await toolResult(1550, 'tu_3', 'deleted', false, 't2');

  // Reconstructed from a request body: MUST be echoed:true or consumers
  // double-count tu_1 (docs/format.md turn records).
  await agent.writeTurn({
    t: iso(1600),
    type: 'turn',
    role: 'assistant',
    blocks: [{ type: 'tool_use', id: 'tu_1', name: 'lookup_user', input: { user: 'amy' } }],
    model: 'claude-sonnet-5',
    echoed: true,
    corr_id: 't1',
  });

  await agent.writeTurn({
    t: iso(1900),
    type: 'turn',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'record r-9 deleted' }],
    model: 'claude-sonnet-5',
    usage: { input_tokens: 2400, output_tokens: 42 },
    corr_id: 't2',
  });

  await agent.close({ t: iso(2000), reason: 'eval_complete' });

  return { dir, mcpPath, agentPath, mcpLines: mcpFrames, agentLines: agentFrames };
}

describe('TapeWriter — golden two-plane run', () => {
  it('writes exact line shapes on both planes', async () => {
    const g = await writeGoldenRun();
    const mcp = await readLines(g.mcpPath);
    const agent = await readLines(g.agentPath);

    // meta first, exactly per DESIGN decision 5.
    expect(mcp[0]).toEqual({
      v: 1,
      type: 'meta',
      startedAt: T0,
      label: 'canary',
      command: ['fitness-report', SERVER_URL],
      mcpTapVersion: HARNESS_VERSION,
      kind: 'mcp',
      source: 'fitness-report@0.1.0',
      producer: { name: 'fitness-report', version: '0.1.0', configHash: SUITE_HASH },
    });
    expect(Object.keys(mcp[0]!).slice(0, 5)).toEqual([
      'v',
      'type',
      'startedAt',
      'label',
      'command',
    ]);
    expect(agent[0]).toMatchObject({ v: 1, type: 'meta', kind: 'llm' });

    // end last: reason, derived durationMs, and NO exitCode (we wrap no child).
    const end = mcp[mcp.length - 1]!;
    expect(end).toEqual({
      t: iso(2000),
      type: 'end',
      reason: 'eval_complete',
      durationMs: 2000,
    });
    expect('exitCode' in end).toBe(false);
    expect('exitCode' in agent[agent.length - 1]!).toBe(false);

    // Wire frames: dir in/out only, corr_id on every non-meta/non-end line.
    const wire = mcp.filter((l) => l.dir === 'in' || l.dir === 'out');
    expect(wire).toHaveLength(6);
    for (const line of wire) {
      expect(typeof line.t).toBe('string');
      expect(line.corr_id).toBeTruthy();
      expect(Object.keys(line)).toEqual(['t', 'dir', 'raw', 'corr_id']);
    }

    // Harness events are dir:"event" with a fitness.* kind, never in/out, and
    // their payload rides in `raw`: docs/format.md marks `raw` required on
    // every line carrying a `dir`, and format-extensions §2 defines it as the
    // producer-defined payload. Writing `data` left a v1 consumer rendering our
    // own gate decisions as empty lines.
    const events = mcp.filter((l) => l.dir === 'event');
    expect(events.map((e) => e.kind)).toEqual(['fitness.task_start', 'fitness.verdict']);
    for (const event of events) {
      expect(event.raw).toBeDefined();
      expect('data' in event).toBe(false);
      expect(Object.keys(event)).toEqual(['t', 'dir', 'kind', 'raw', 'corr_id']);
    }
    expect(events[0]!.raw).toEqual({ taskId: 't1' });

    // Turn plane carries turn records only (plus meta/end).
    const turns = agent.filter((l) => l.type === 'turn');
    expect(turns).toHaveLength(8);
    expect(turns.filter((t) => t.echoed === true)).toHaveLength(1);
    expect(turns[0]).toMatchObject({ type: 'turn', role: 'assistant', model: 'claude-sonnet-5' });
    expect(Object.keys(turns[0]!)).toEqual([
      't',
      'type',
      'role',
      'blocks',
      'model',
      'usage',
      'corr_id',
    ]);
  });

  it('preserves caller timestamps verbatim and never stamps wall-clock time', async () => {
    const g = await writeGoldenRun();
    const mcp = await readLines(g.mcpPath);
    const expected = [T0, iso(10), iso(100), iso(600), iso(700), iso(1100), iso(1200), iso(1300), iso(1500), iso(2000)];
    expect(mcp.map((l) => l.t ?? l.startedAt)).toEqual(expected);

    // Nothing in the tape may carry a timestamp from "now".
    const nowYear = new Date().toISOString().slice(0, 4);
    const fixtureYear = T0.slice(0, 4);
    if (nowYear !== fixtureYear) {
      for (const line of mcp) {
        expect(String(line.t ?? line.startedAt).slice(0, 4)).toBe(fixtureYear);
      }
    }
  });

  it('derives durationMs from caller timestamps and defaults end.t to the last observed line', async () => {
    const dir = await tmpRunDir();
    const path = join(dir, 'mcp.jsonl');
    const w = await TapeWriter.open({
      path,
      meta: { startedAt: T0, label: 'x', command: ['fitness-report', SERVER_URL], kind: 'mcp' },
    });
    await w.writeMessage({ t: iso(4321), dir: 'in', raw: { jsonrpc: '2.0', id: 1, method: 'ping' } });
    await w.close({ reason: 'transport_error' });
    const lines = await readLines(path);
    expect(lines[lines.length - 1]).toEqual({
      t: iso(4321),
      type: 'end',
      reason: 'transport_error',
      durationMs: 4321,
    });
  });

  it('serializes concurrent writes in call order and never rotates', async () => {
    const dir = await tmpRunDir();
    const path = join(dir, 'mcp.jsonl');
    const w = await TapeWriter.open({
      path,
      meta: { startedAt: T0, label: 'x', command: ['fitness-report', SERVER_URL], kind: 'mcp' },
    });
    // A 256KB payload would have tripped the ported rotation logic; rotation is
    // removed, so the base file keeps its meta line and no .1 part appears.
    const big = 'x'.repeat(256 * 1024);
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      pending.push(
        w.writeMessage({
          t: iso(i),
          dir: 'in',
          raw: { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'n', arguments: { big } } },
          corr_id: `t${i}`,
        }),
      );
    }
    await Promise.all(pending);
    await w.close({ t: iso(999), reason: 'eval_complete' });

    const lines = await readLines(path);
    expect(lines).toHaveLength(22);
    expect(lines.slice(1, 21).map((l) => (l.raw as { id: number }).id)).toEqual(
      Array.from({ length: 20 }, (_, i) => i),
    );
    expect((await readdir(dir)).sort()).toEqual(['mcp.jsonl']);
  });

  it('rejects lines that would corrupt downstream pairing', async () => {
    const dir = await tmpRunDir();
    const w = await TapeWriter.open({
      path: join(dir, 'mcp.jsonl'),
      meta: { startedAt: T0, label: 'x', command: ['fitness-report'], kind: 'mcp' },
    });
    // Event lines using dir:"in"/"out" get fed into request/response pairing.
    await expect(
      w.writeEvent({ t: iso(1), dir: 'in' as unknown as 'event', kind: 'fitness.gate' }),
    ).rejects.toThrow(/never use dir/);
    // Missing caller timestamp is a bug, not something to paper over with now().
    await expect(
      w.writeMessage({ t: '' as string, dir: 'in', raw: {} } as TapeMessageLine),
    ).rejects.toThrow(/caller-supplied ISO timestamp/);
    await w.close({ t: iso(2), reason: 'eval_complete' });
    // close() is idempotent so error paths can close in a finally.
    await w.close({ t: iso(3), reason: 'eval_complete' });
    const lines = await readLines(join(dir, 'mcp.jsonl'));
    expect(lines.filter((l) => l.type === 'end')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Redaction (publish-time only)
// ---------------------------------------------------------------------------

describe('redactTape', () => {
  it('nukes secret values but leaves numeric token counts intact', async () => {
    const g = await writeGoldenRun();
    const before = (await readLines(g.mcpPath)) as unknown as TapeLine[];
    const beforeJson = JSON.stringify(before);
    const after = redactTape(before);

    // Purity: scoring keeps reading the pre-redaction records.
    expect(JSON.stringify(before)).toBe(beforeJson);

    const flat = JSON.stringify(after);
    expect(flat).not.toContain('sk-live-abcdefghijklmnopqrstuvwx');
    expect(flat).not.toContain('hunter2');
    expect(flat).not.toContain(GOOGLE_KEY);
    expect(flat).not.toContain('s3cr3t');

    const req = after.find(
      (l) => (l as TapeMessageLine).dir === 'in' &&
        ((l as TapeMessageLine).raw as { id?: number }).id === 1,
    ) as TapeMessageLine;
    const args = (req.raw as { params: { arguments: Record<string, unknown> } }).params.arguments;
    expect(args.api_key).toBe('[REDACTED]');
    expect(args.user).toBe('amy'); // a non-secret argument survives untouched

    const res = after.find(
      (l) => (l as TapeMessageLine).dir === 'out' &&
        ((l as TapeMessageLine).raw as { id?: number }).id === 1,
    ) as TapeMessageLine;
    const result = (res.raw as {
      result: { content: { text: string }[]; structuredContent: Record<string, unknown> };
    }).result;
    expect(result.structuredContent.password).toBe('[REDACTED]');
    expect(result.structuredContent.user_id).toBe('u-7');
    expect(result.content[0]!.text).toContain('[REDACTED]'); // AIza… value rule
    expect(result.content[0]!.text).toContain('https://svc:[REDACTED]@canary.test/mcp');

    // Structure survives: meta first, end last, ends still carry no exitCode.
    // The meta line must survive intact: the leaderboard row and the replay
    // link are built from `command` and `producer`.
    expect(after[0]).toMatchObject({
      v: 1,
      type: 'meta',
      kind: 'mcp',
      command: ['fitness-report', SERVER_URL],
      producer: { name: 'fitness-report', version: HARNESS_VERSION, configHash: SUITE_HASH },
    });
    expect(after[after.length - 1]).toMatchObject({ type: 'end', reason: 'eval_complete' });
    expect(after).toHaveLength(before.length);
  });

  it('keeps usage counts and opaque replay blobs, and documents the page_token casualty', async () => {
    const g = await writeGoldenRun();
    const agent = (await readLines(g.agentPath)) as unknown as TapeLine[];
    const after = redactTape(agent);

    const turn = after.find((l) => (l as TapeTurnLine).type === 'turn') as TapeTurnLine;
    // /token/i matches `input_tokens`, but a COUNT is not a secret: killing it
    // would silently zero the cost model (DESIGN decision 15).
    expect(turn.usage).toEqual({ input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 0 });
    // Anthropic 400s on replayed thinking blocks whose signature bytes changed.
    const thinking = (turn.blocks as { type: string; signature?: string }[]).find(
      (b) => b.type === 'thinking',
    );
    expect(thinking?.signature).toBe('sig-opaque-do-not-touch');

    // THIS is why redaction is publish-time only: a legitimate pagination
    // argument is destroyed by the key-name pass. Scoring must never read this.
    const mcp = (await readLines(g.mcpPath)) as unknown as TapeLine[];
    const redactedCall = redactTape(mcp).find(
      (l) => (l as TapeMessageLine).dir === 'in' &&
        ((l as TapeMessageLine).raw as { id?: number }).id === 2,
    ) as TapeMessageLine;
    const args = (redactedCall.raw as { params: { arguments: Record<string, unknown> } }).params
      .arguments;
    expect(args.page_token).toBe('[REDACTED]');
    const preRedaction = (mcp.find(
      (l) => (l as TapeMessageLine).dir === 'in' &&
        ((l as TapeMessageLine).raw as { id?: number }).id === 2,
    ) as TapeMessageLine).raw as { params: { arguments: Record<string, unknown> } };
    expect(preRedaction.params.arguments.page_token).toBe('ptok-42');
  });
});

// ---------------------------------------------------------------------------
// The published REPORT gets redacted too. Redacting only the tapes leaves the
// credential in the one file site/README tells the operator to append to
// site/data/runs.json.
// ---------------------------------------------------------------------------

describe('redactReport', () => {
  const TOKEN = 'AAAABBBBCCCCDDDDEEEEFFFF1234'; // matches no pattern rule on purpose

  const report = () => ({
    schema: 'fitness-report/1',
    server: { url: 'https://canary.test/mcp', instructions: `call with key ${TOKEN}` },
    gates: {
      records: [
        {
          gate: 'protocol_hygiene',
          reason: 'transport_error',
          detail: { message: `MCP connect failed: unauthorized: presented ${TOKEN} for /mcp` },
        },
      ],
    },
    probes: {
      findings: [
        { id: 'bogus-version-accepted', evidence: { bodySnippet: `{"error":"bad key ${TOKEN}"}` } },
        { id: 'x', evidence: { headers: { authorization: `Bearer ${TOKEN}` } } },
      ],
    },
    score: { meanTokensPerCompletedTask: 1772, tasks: [{ inputTokens: 900, outputTokens: 60 }] },
    trace_stats: {
      models: { summary: { cacheReadTokens: { total: 12 }, thinkingTokens: { total: 7 } } },
    },
  });

  it('removes a known secret that no pattern rule can see', () => {
    const flat = JSON.stringify(redactReport(report(), [TOKEN]));
    expect(flat).not.toContain(TOKEN);
    expect(flat).toContain('[REDACTED]');
  });

  it('keeps the measurements a blunt key-name pass would destroy', () => {
    const safe = redactReport(report(), [TOKEN]) as ReturnType<typeof report>;
    // These are OBJECTS whose key matches /token/i. The tape pass replaces them
    // wholesale; the report pass matches whole key names instead.
    expect(safe.trace_stats.models.summary.cacheReadTokens).toEqual({ total: 12 });
    expect(safe.trace_stats.models.summary.thinkingTokens).toEqual({ total: 7 });
    expect(safe.score.meanTokensPerCompletedTask).toBe(1772);
    expect(safe.score.tasks[0]!.inputTokens).toBe(900);
    // A field actually named `authorization` still goes.
    expect(
      (safe.probes.findings[1]!.evidence as { headers: { authorization: string } }).headers.authorization,
    ).toBe('[REDACTED]');
  });

  it('is pure and leaves short strings alone', () => {
    const before = report();
    const json = JSON.stringify(before);
    redactReport(before, [TOKEN]);
    expect(JSON.stringify(before)).toBe(json);
    // A "secret" too short to be a credential must not turn the report into
    // confetti.
    expect(scrubSecrets({ a: 'abc' }, ['abc'])).toEqual({ a: 'abc' });
  });
});

// ---------------------------------------------------------------------------
// CONFORMANCE ORACLE: our tapes must be readable by the mcp-tape CLI, and its
// counts must agree with ours. mcp-tape is a devDependency, bin-only on npm
// (no exports, no types) — it is NEVER imported at runtime, only shelled out to.
// ---------------------------------------------------------------------------

interface OracleStats {
  schema: string;
  session: {
    kind: string;
    label: string;
    durationMs: number;
    endReason: string;
    exitCode: number | null;
    records: { total: number; meta: number; message: number; event: number; turn: number; end: number };
    producer: string;
  };
  tools: { name: string; calls: number; errors: number }[];
}

async function mcpTapeStats(file: string): Promise<OracleStats> {
  // --no-install keeps the oracle offline: it resolves the local devDependency
  // binary or fails, and a failure means "skip", never "download from the net".
  const { stdout } = await execFileAsync('npx', ['--no-install', 'mcp-tape', 'stats', file, '--json'], {
    cwd: REPO_ROOT,
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout) as OracleStats;
}

describe('mcp-tape conformance oracle', () => {
  it('parses both planes and agrees with our own call counts', async () => {
    const g = await writeGoldenRun();

    // A single mixed file is what we must NOT ship (DESIGN decision 4). Built
    // outside the try so only the npx calls can trigger the skip path.
    const mixed = join(g.dir, 'mixed.jsonl');
    await writeFile(
      mixed,
      [...(await readLines(g.mcpPath)), ...(await readLines(g.agentPath))]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n',
      'utf8',
    );

    let mcpStats: OracleStats;
    let agentStats: OracleStats;
    let mixedStats: OracleStats;
    try {
      mcpStats = await mcpTapeStats(g.mcpPath);
      agentStats = await mcpTapeStats(g.agentPath);
      mixedStats = await mcpTapeStats(mixed);
    } catch (err) {
      console.warn(
        `[skip] mcp-tape conformance oracle unavailable (npx or the mcp-tape binary is missing): ${
          (err as Error).message
        }`,
      );
      return;
    }

    expect(mcpStats.schema).toBe('mcp-tape.stats/1');
    expect(mcpStats.session).toMatchObject({
      kind: 'mcp',
      label: 'canary',
      durationMs: 2000,
      endReason: 'eval_complete',
      exitCode: null,
      producer: 'fitness-report@0.1.0',
    });
    expect(mcpStats.session.records).toMatchObject({
      meta: 1,
      message: 6,
      event: 2,
      turn: 0,
      end: 1,
      total: 10,
    });

    // Our own count: 3 tools/call requests, 1 isError response.
    const mcpCalls = mcpStats.tools.reduce((a, t) => a + t.calls, 0);
    expect(mcpCalls).toBe(3);
    expect(mcpStats.tools.map((t) => t.name).sort()).toEqual([
      'delete_record',
      'get_invoice',
      'lookup_user',
    ]);
    expect(mcpStats.tools.reduce((a, t) => a + t.errors, 0)).toBe(1);

    // The agent plane describes the SAME three calls; the echoed turn must not
    // add a fourth.
    expect(agentStats.session.kind).toBe('llm');
    expect(agentStats.tools.reduce((a, t) => a + t.calls, 0)).toBe(3);
    expect(agentStats.tools.reduce((a, t) => a + t.errors, 0)).toBe(1);

    // And the empirical justification for two files: merged, every call is
    // counted twice.
    expect(mixedStats.tools.reduce((a, t) => a + t.calls, 0)).toBe(6);

    // Our own trace_stats block must agree with the oracle LINE FOR LINE, not
    // just on call counts. Building it from the wire frames alone published
    // `event: 0` for a tape carrying 93 event lines, contradicting the very
    // file the report links to.
    const ourMcp = computeTraceStats({
      mcp: (await readLines(g.mcpPath)) as unknown as TraceRecord[],
      agent: [],
    });
    expect(ourMcp.planes.mcp.session.records).toMatchObject(mcpStats.session.records);
    const ourAgent = computeTraceStats({
      mcp: [],
      agent: (await readLines(g.agentPath)) as unknown as TraceRecord[],
    });
    expect(ourAgent.planes.agent.session.records).toMatchObject(agentStats.session.records);
  }, 120_000);
});
