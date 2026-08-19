/**
 * MCP client + probe tests (DESIGN decisions 2, 8, 14).
 *
 * No network: every server here is spun in-process. Three of the four suites
 * bind an ephemeral port on 127.0.0.1 (loopback only) because the probes that
 * matter - a bogus `protocolVersion`, a mismatched `Mcp-Name` - are raw HTTP
 * requests the SDK cannot express; the fourth runs over `InMemoryTransport` and
 * asserts that those probes degrade to `pass: null` "could not check" rather
 * than to a silent pass.
 *
 * The three live transport shapes from DESIGN decision 8 are all covered:
 * modern + plain `application/json`, modern + SSE-framed, and legacy +
 * session-ful (`mcp-session-id`) + plain JSON.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import type Anthropic from '@anthropic-ai/sdk';

import { InMemoryTransport } from '@modelcontextprotocol/client';
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  inputRequired,
  type McpServerFactory
} from '@modelcontextprotocol/server';

import {
  HTTP_ERROR_BODY_SNIPPET_MAX,
  HTTP_ERROR_EVENT,
  MODERN_PROTOCOL_VERSION,
  connect,
  httpLayerFailure,
  isModernRevision,
  parseSseData,
  slugFromUrl,
  stripCredentials,
  type FrameDirection,
  type McpConnection
} from '../src/mcp/connect.js';
import {
  BOGUS_PROTOCOL_VERSION,
  HEADER_MISMATCH_CODE,
  PROBE_MISMATCHED_NAME,
  PROBE_TOOL_NAME,
  probeBogusVersion,
  runProbes
} from '../src/mcp/probes.js';
import { classifyFailure, driveTask, type RunnerClient, type ToolRunnerLike } from '../src/run/agent.js';
import type { ToolDescriptor } from '../src/score/metrics.js';
import { REPLACEMENT, redactTape } from '../src/tape/redact.js';
import { TapeWriter } from '../src/tape/writer.js';
import type { FitnessTask, ProbeFinding, ProbeResults, TapeLine } from '../src/types.js';

// ---------------------------------------------------------------------------
// A two-tool canary server
// ---------------------------------------------------------------------------

const SERVER_INSTRUCTIONS = 'Two trivial tools. Call echo to mirror text; call add to sum two integers.';
const LOG_LEVEL_META_KEY = 'io.modelcontextprotocol/logLevel';

/**
 * Opaque server state for the MRTR round. Deliberately carries non-ASCII and
 * JSON punctuation so a re-encoding client would corrupt it visibly.
 */
const MRTR_REQUEST_STATE = 'state-é-{"n":1}|42';

function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'fitness-test-canary', version: '0.0.1' },
    { instructions: SERVER_INSTRUCTIONS }
  );
  server.registerTool(
    'echo',
    {
      description: 'Echo the given text back verbatim.',
      inputSchema: z.object({ text: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    ({ text }) => ({ content: [{ type: 'text' as const, text }] })
  );
  server.registerTool(
    'add',
    {
      description: 'Add two integers and return the sum.',
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    ({ a, b }) => ({ content: [{ type: 'text' as const, text: String(a + b) }] })
  );
  // Multi-round-trip surface: round one asks for confirmation and mints opaque
  // state; round two reports back exactly what the client echoed.
  server.registerTool(
    'confirm_transfer',
    {
      description: 'Asks for confirmation, then reports the echoed requestState and inputResponses.',
      inputSchema: z.object({ amount: z.number() })
    },
    ({ amount }, ctx) => {
      const state = ctx.mcpReq.requestState<string>();
      if (state === undefined) {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: `Transfer ${amount}?`,
              requestedSchema: {
                type: 'object',
                properties: { confirm: { type: 'boolean' } },
                required: ['confirm']
              }
            })
          },
          requestState: MRTR_REQUEST_STATE
        });
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ state, inputResponses: ctx.mcpReq.inputResponses ?? null })
          }
        ]
      };
    }
  );
  return server;
}

const serverFactory: McpServerFactory = () => buildServer();

// ---------------------------------------------------------------------------
// node:http <-> web fetch bridge (kept here so the module under test stays
// transport-agnostic; @modelcontextprotocol/node is not a dependency)
// ---------------------------------------------------------------------------

type WebHandler = (request: Request) => Promise<Response>;

async function toWebRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const one of value) headers.append(key, one);
    else headers.set(key, value);
  }
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD' && body.byteLength > 0;
  return new Request(new URL(req.url ?? '/', origin), {
    method,
    headers,
    ...(hasBody ? { body: new Uint8Array(body) } : {})
  });
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'content-length') return;
    res.setHeader(key, value);
  });
  res.writeHead(response.status);
  if (response.body === null) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

interface Harness {
  url: string;
  close: () => Promise<void>;
}

async function serve(handler: WebHandler): Promise<Harness> {
  const server: NodeHttpServer = createServer((req, res) => {
    void (async () => {
      try {
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const response = await handler(await toWebRequest(req, origin));
        await writeWebResponse(res, response);
      } catch (cause) {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(String(cause));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}

// ---------------------------------------------------------------------------
// Frame recorder with a deterministic injected clock
// ---------------------------------------------------------------------------

const T0 = '2026-08-19T12:00:00.000Z';
const TICK_MS = 1000;

interface RecordedFrame {
  dir: FrameDirection;
  raw: Record<string, unknown>;
  observedIso: string;
  corrId: string | undefined;
}

class Recorder {
  readonly frames: RecordedFrame[] = [];
  private tick = 0;

  now = (): Date => new Date(Date.parse(T0) + this.tick++ * TICK_MS);

  onFrame = (dir: FrameDirection, raw: unknown, observedIso: string, corrId?: string): void => {
    this.frames.push({ dir, raw: raw as Record<string, unknown>, observedIso, corrId });
  };

  outbound(method: string): RecordedFrame[] {
    return this.frames.filter((f) => f.dir === 'out' && f.raw['method'] === method);
  }

  /** Inbound responses paired to the ids of the outbound requests for `method`. */
  inboundFor(method: string): RecordedFrame[] {
    const ids = new Set(this.outbound(method).map((f) => String(f.raw['id'])));
    return this.frames.filter((f) => f.dir === 'in' && f.raw['id'] !== undefined && ids.has(String(f.raw['id'])));
  }
}

function findingById(results: ProbeResults, id: string): ProbeFinding {
  const finding = results.findings.find((f) => f.id === id);
  if (finding === undefined) throw new Error(`no probe finding with id ${id}`);
  return finding;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('connect helpers', () => {
  it('strips credentials and derives a slug', () => {
    expect(stripCredentials('https://user:pw@mcp.example.com/mcp?token=abc#x')).toBe('https://mcp.example.com/mcp');
    expect(slugFromUrl('https://mcp.deepwiki.com/mcp')).toBe('mcp-deepwiki-com');
  });

  it('classifies protocol revisions by era boundary', () => {
    expect(isModernRevision(MODERN_PROTOCOL_VERSION)).toBe(true);
    expect(isModernRevision('2027-01-01')).toBe(true);
    expect(isModernRevision('2025-11-25')).toBe(false);
    expect(isModernRevision(null)).toBe(false);
    expect(isModernRevision('not-a-date')).toBe(false);
  });

  it('extracts a JSON-RPC envelope out of an SSE-framed body', () => {
    const body = ': keepalive\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
    expect(parseSseData(body)).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(parseSseData(': keepalive\n\n')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 1: modern era, plain application/json responses
// ---------------------------------------------------------------------------

describe('modern era over plain JSON', () => {
  let harness: Harness;
  let recorder: Recorder;
  let conn: McpConnection;

  beforeAll(async () => {
    const handler = createMcpHandler(serverFactory, { legacy: 'stateless', responseMode: 'json' });
    harness = await serve((request) => handler.fetch(request));
    recorder = new Recorder();
    conn = await connect({
      url: harness.url,
      onFrame: recorder.onFrame,
      now: recorder.now,
      corrId: 'task-001',
      timeoutMs: 10_000
    });
  }, 30_000);

  afterAll(async () => {
    await conn?.close();
    await harness?.close();
  });

  it('yields a ServerIdentity with the negotiated modern era', () => {
    const identity = conn.identity;
    expect(identity.era).toBe('modern');
    expect(identity.negotiatedVersion).toBe(MODERN_PROTOCOL_VERSION);
    expect(identity.url).toBe(harness.url);
    expect(identity.slug).toBe(slugFromUrl(harness.url));
    expect(identity.transportShape).toBe('json');
    expect(identity.sessionful).toBe(false);
    expect(identity.credentialContext).toBe('anonymous');
    expect(identity.instructions).toBe(SERVER_INSTRUCTIONS);
    expect((identity.capabilities as Record<string, unknown>)['tools']).toBeDefined();
  });

  it('records the server/discover result used to pick the era', () => {
    const discover = conn.discoverResult;
    expect(discover).toBeDefined();
    expect(discover?.supportedVersions).toContain(MODERN_PROTOCOL_VERSION);
    expect(discover?.instructions).toBe(SERVER_INSTRUCTIONS);
  });

  it('surfaces the negotiation probe and its reply through onFrame', () => {
    const out = recorder.outbound('server/discover');
    expect(out.length).toBeGreaterThanOrEqual(1);
    const replies = recorder.inboundFor('server/discover');
    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(replies[0]?.raw['result']).toBeDefined();
  });

  it('stamps every frame with a caller-supplied observed timestamp and the correlation id', () => {
    expect(recorder.frames.length).toBeGreaterThan(0);
    let previous = -1;
    for (const frame of recorder.frames) {
      const delta = Date.parse(frame.observedIso) - Date.parse(T0);
      // Every timestamp came from the injected clock, never from Date.now().
      expect(Number.isInteger(delta)).toBe(true);
      expect(delta % TICK_MS).toBe(0);
      expect(delta).toBeGreaterThanOrEqual(0);
      // One clock reading per frame, in observation order.
      expect(delta).toBeGreaterThan(previous);
      previous = delta;
      expect(frame.corrId).toBe('task-001');
    }
  });

  it('sees both halves of every JSON-RPC exchange', async () => {
    const before = recorder.frames.length;
    const listed = await conn.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(['add', 'confirm_transfer', 'echo']);

    const outbound = recorder.outbound('tools/list');
    expect(outbound.length).toBe(1);
    expect(recorder.inboundFor('tools/list').length).toBe(1);
    expect(recorder.frames.length).toBeGreaterThan(before);
  });

  it('injects io.modelcontextprotocol/logLevel into _meta on modern requests', () => {
    const frame = recorder.outbound('tools/list')[0];
    const params = frame?.raw['params'] as Record<string, unknown> | undefined;
    const meta = params?.['_meta'] as Record<string, unknown> | undefined;
    expect(meta?.[LOG_LEVEL_META_KEY]).toBe('debug');
    // The SDK's own envelope keys survive alongside ours.
    expect(meta?.['io.modelcontextprotocol/protocolVersion']).toBe(MODERN_PROTOCOL_VERSION);
  });

  it('bypasses the response cache on every listTools by default', async () => {
    const before = recorder.outbound('tools/list').length;
    await conn.listTools();
    await conn.listTools();
    // cacheMode 'bypass' means neither read nor write: two calls, two round trips.
    expect(recorder.outbound('tools/list').length).toBe(before + 2);
  });

  it('calls a tool and returns a complete result', async () => {
    const outcome = await conn.callTool('echo', { text: 'hello canary' });
    expect(outcome.kind).toBe('result');
    if (outcome.kind !== 'result') throw new Error('unreachable');
    expect(JSON.stringify(outcome.result.content)).toContain('hello canary');
    expect(recorder.outbound('tools/call').length).toBeGreaterThanOrEqual(1);
  });

  it('completes a single-round drive through the request funnel', async () => {
    const before = conn.outboundIdsFor('tools/call').length;
    const outcome = await conn.driveToolCall('add', { a: 2, b: 3 }, () => undefined);
    expect(outcome.kind).toBe('result');
    const ids = conn.outboundIdsFor('tools/call');
    expect(ids.length).toBe(before + 1);
    expect(new Set(ids.map(String)).size).toBe(ids.length);
  });

  it('drives an input_required round manually: fresh id, byte-exact requestState echo', async () => {
    const beforeIds = conn.outboundIdsFor('tools/call').length;
    const beforeFrames = recorder.frames.length;
    const seen: Array<{ round: number; requestState: string | undefined }> = [];

    const outcome = await conn.driveToolCall('confirm_transfer', { amount: 42 }, (round) => {
      seen.push({ round: round.round, requestState: round.requestState });
      expect(Object.keys(round.inputRequests)).toEqual(['confirm']);
      return { confirm: { action: 'accept', content: { confirm: true } } };
    });

    expect(outcome.kind).toBe('result');
    if (outcome.kind !== 'result') throw new Error('unreachable');

    // Exactly one interactive round, surfaced to the caller (autoFulfill: false).
    expect(seen).toEqual([{ round: 1, requestState: MRTR_REQUEST_STATE }]);
    expect(outcome.rounds).toHaveLength(1);

    // Two legs, two DIFFERENT JSON-RPC ids.
    const ids = conn.outboundIdsFor('tools/call').slice(beforeIds);
    expect(ids).toHaveLength(2);
    expect(String(ids[0])).not.toBe(String(ids[1]));

    // The retry frame echoes requestState byte-exact and carries the answers.
    const retry = recorder.frames
      .slice(beforeFrames)
      .filter((f) => f.dir === 'out' && f.raw['method'] === 'tools/call')
      .at(-1);
    const retryParams = retry?.raw['params'] as Record<string, unknown> | undefined;
    expect(retryParams?.['requestState']).toBe(MRTR_REQUEST_STATE);
    expect(retryParams?.['inputResponses']).toEqual({ confirm: { action: 'accept', content: { confirm: true } } });

    // And the server saw exactly the state it minted.
    const payload = JSON.parse(
      (outcome.result.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}'
    ) as { state: string; inputResponses: Record<string, unknown> | null };
    expect(payload.state).toBe(MRTR_REQUEST_STATE);
    expect(payload.inputResponses).toMatchObject({ confirm: { action: 'accept' } });
  });

  it('abandons an MRTR call at the round cap and when the caller declines', async () => {
    const capped = await conn.driveToolCall('confirm_transfer', { amount: 1 }, () => ({}), { maxRounds: 0 });
    expect(capped.kind).toBe('mrtr-abandoned');
    if (capped.kind !== 'mrtr-abandoned') throw new Error('unreachable');
    expect(capped.reason).toBe('round-cap');
    expect(capped.rounds).toHaveLength(1);

    const declined = await conn.driveToolCall('confirm_transfer', { amount: 1 }, () => undefined);
    expect(declined.kind).toBe('mrtr-abandoned');
    if (declined.kind !== 'mrtr-abandoned') throw new Error('unreachable');
    expect(declined.reason).toBe('caller-declined');
  });

  it('hands an input_required answer back from callTool instead of auto-fulfilling it', async () => {
    const outcome = await conn.callTool('confirm_transfer', { amount: 7 });
    expect(outcome.kind).toBe('input_required');
    if (outcome.kind !== 'input_required') throw new Error('unreachable');
    expect(outcome.requestState).toBe(MRTR_REQUEST_STATE);
    expect(Object.keys(outcome.inputRequests)).toEqual(['confirm']);
  });

  it('changes the correlation id stamped on subsequent frames', async () => {
    conn.setCorrelationId('task-002');
    const before = recorder.frames.length;
    await conn.listTools();
    const fresh = recorder.frames.slice(before);
    expect(fresh.length).toBeGreaterThan(0);
    for (const frame of fresh) expect(frame.corrId).toBe('task-002');
    conn.setCorrelationId('task-001');
  });

  it('returns typed probe findings for a conformant modern server', async () => {
    const results = await runProbes(conn);
    expect(results.specCurrency).toBe(MODERN_PROTOCOL_VERSION);
    expect(results.findings.map((f) => f.id)).toEqual([
      'spec-currency',
      'bogus-version-accepted',
      'header-mismatch-accepted',
      'server-discover-present',
      'cache-hints',
      'deprecation-surface'
    ]);
    for (const finding of results.findings) {
      expect(typeof finding.id).toBe('string');
      expect(typeof finding.detail).toBe('string');
      expect(finding.pass === true || finding.pass === false || finding.pass === null).toBe(true);
    }

    expect(findingById(results, 'spec-currency').pass).toBe(true);
    expect(findingById(results, 'server-discover-present').pass).toBe(true);
    expect(findingById(results, 'deprecation-surface').pass).toBe(true);

    const bogus = findingById(results, 'bogus-version-accepted');
    expect(bogus.pass).toBe(true);
    expect(bogus.detail).not.toContain('ACCEPTED');

    const headers = findingById(results, 'header-mismatch-accepted');
    expect(headers.pass).toBe(true);
    expect(headers.evidence).toMatchObject({ status: 400, jsonRpcErrorCode: HEADER_MISMATCH_CODE });

    const cache = findingById(results, 'cache-hints');
    expect(cache.pass).toBe(true);
    expect(cache.evidence).toMatchObject({ cacheScope: expect.stringMatching(/^(public|private)$/) as unknown as string });
  });

  it('routes every raw probe request through onFrame', () => {
    const bogus = recorder.outbound('initialize').filter(
      (f) => (f.raw['params'] as Record<string, unknown> | undefined)?.['protocolVersion'] === BOGUS_PROTOCOL_VERSION
    );
    expect(bogus.length).toBe(1);
    expect(bogus[0]?.raw['id']).toBe('fitness-probe-bogus-version');

    const mismatch = recorder.outbound('tools/call').filter(
      (f) => (f.raw['params'] as Record<string, unknown> | undefined)?.['name'] === PROBE_TOOL_NAME
    );
    expect(mismatch.length).toBe(1);
    // The server's -32020 answer is a JSON-RPC envelope, so it lands as an
    // inbound frame too.
    const reply = recorder.frames.find(
      (f) => f.dir === 'in' && f.raw['id'] === 'fitness-probe-header-mismatch'
    );
    expect((reply?.raw['error'] as Record<string, unknown> | undefined)?.['code']).toBe(HEADER_MISMATCH_CODE);
    expect(PROBE_MISMATCHED_NAME).not.toBe(PROBE_TOOL_NAME);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: modern era, SSE-framed responses
// ---------------------------------------------------------------------------

describe('modern era over SSE', () => {
  let harness: Harness;
  let conn: McpConnection;

  beforeAll(async () => {
    const handler = createMcpHandler(serverFactory, { legacy: 'stateless', responseMode: 'sse', keepAliveMs: 0 });
    harness = await serve((request) => handler.fetch(request));
    conn = await connect({ url: harness.url, timeoutMs: 10_000 });
  }, 30_000);

  afterAll(async () => {
    await conn?.close();
    await harness?.close();
  });

  it('reports the SSE transport shape', async () => {
    await conn.listTools();
    expect(conn.identity.era).toBe('modern');
    expect(conn.identity.transportShape).toBe('sse');
    expect(conn.httpObservations.some((o) => (o.contentType ?? '').includes('text/event-stream'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: legacy era, session-ful, plain JSON
// ---------------------------------------------------------------------------

describe('legacy session-ful server', () => {
  let harness: Harness;
  let conn: McpConnection;
  let transport: WebStandardStreamableHTTPServerTransport;

  beforeAll(async () => {
    transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => 'fitness-test-session',
      enableJsonResponse: true
    });
    await buildServer().connect(transport);
    harness = await serve((request) => transport.handleRequest(request));
    conn = await connect({ url: harness.url, versionMode: 'legacy', authToken: 'test-token', timeoutMs: 10_000 });
  }, 30_000);

  afterAll(async () => {
    await conn?.close();
    await harness?.close();
  });

  it('negotiates the legacy era and detects the session', () => {
    const identity = conn.identity;
    expect(identity.era).toBe('legacy');
    expect(identity.negotiatedVersion).toBe('2025-11-25');
    expect(isModernRevision(identity.negotiatedVersion)).toBe(false);
    expect(identity.sessionful).toBe(true);
    expect(identity.transportShape).toBe('json');
    expect(identity.credentialContext).toBe('free-key');
    expect(identity.instructions).toBe(SERVER_INSTRUCTIONS);
    expect((identity.serverInfo as Record<string, unknown>)['name']).toBe('fitness-test-canary');
  });

  it('sends no logLevel _meta on the legacy era', () => {
    expect(conn.metaFor()).toBeUndefined();
  });

  it('renders the modern-only probes as could-not-check, never as passes', async () => {
    const results = await runProbes(conn);
    expect(results.specCurrency).toBe('2025-11-25');
    expect(findingById(results, 'spec-currency').pass).toBe(false);

    for (const id of ['header-mismatch-accepted', 'server-discover-present', 'cache-hints', 'deprecation-surface']) {
      const finding = findingById(results, id);
      expect(finding.pass).toBeNull();
      expect(finding.detail).toContain('could not check');
    }

    // The bogus-version probe runs on the legacy path, so it still has a verdict.
    const bogus = findingById(results, 'bogus-version-accepted');
    expect(bogus.pass).toBe(true);
    expect(bogus.evidence).toMatchObject({ offered: BOGUS_PROTOCOL_VERSION });
  });
});

// ---------------------------------------------------------------------------
// Suite 4: in-memory transport (no HTTP at all)
// ---------------------------------------------------------------------------

describe('in-memory transport', () => {
  let conn: McpConnection;
  let recorder: Recorder;

  beforeAll(async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(serverSide);
    recorder = new Recorder();
    conn = await connect({
      transport: clientSide,
      slug: 'inproc-canary',
      onFrame: recorder.onFrame,
      now: recorder.now,
      timeoutMs: 10_000
    });
  }, 30_000);

  afterAll(async () => {
    await conn?.close();
  });

  it('captures frames on a transport with no HTTP layer', async () => {
    await conn.listTools();
    expect(recorder.outbound('tools/list').length).toBe(1);
    expect(recorder.inboundFor('tools/list').length).toBe(1);
    expect(conn.identity.slug).toBe('inproc-canary');
    expect(conn.identity.url).toBe('inproc:inproc-canary');
    expect(conn.identity.transportShape).toBe('json');
    expect(conn.httpUrl).toBeNull();
  });

  it('degrades the raw-fetch probes to could-not-check', async () => {
    const results = await runProbes(conn);
    const bogus = findingById(results, 'bogus-version-accepted');
    expect(bogus.pass).toBeNull();
    expect(bogus.detail).toContain('no HTTP endpoint');
    await expect(conn.rawJsonRpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toThrow(/HTTP endpoint/);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: what an authenticating gateway does to the deterministic probes.
//
// Two failures live here, and they compound: a 401 carrying a JSON-RPC error
// body was scored as a hygiene PASS the target server never earned, and the raw
// probes posted to the credential-STRIPPED url, so a host that authenticates by
// query string never saw the key in the first place.
// ---------------------------------------------------------------------------

describe('raw probes against a query-authenticated host', () => {
  let harness: Harness;
  let conn: McpConnection;
  const posted: string[] = [];

  beforeAll(async () => {
    const handler = createMcpHandler(serverFactory, { legacy: 'stateless', responseMode: 'json' });
    harness = await serve((request) => handler.fetch(request));
    const gatedFetch: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      posted.push(url);
      const body = typeof init?.body === 'string' ? init.body : '';
      // The gateway: no key, no service. It answers in JSON-RPC, which is
      // exactly what made a 401 readable as "the server rejected our bogus
      // version".
      if (!url.includes('api_key=secret')) {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'missing api_key' } }),
          { status: 401, headers: { 'content-type': 'application/json' } }
        );
      }
      if (body.includes(BOGUS_PROTOCOL_VERSION)) {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'gateway rejected' } }),
          { status: 401, headers: { 'content-type': 'application/json' } }
        );
      }
      return await fetch(input, init);
    };
    conn = await connect({
      url: `${harness.url}?api_key=secret`,
      fetchImpl: gatedFetch,
      timeoutMs: 10_000
    });
  }, 30_000);

  afterAll(async () => {
    await conn?.close();
    await harness?.close();
  });

  it('sends raw probe requests to the wire url, credentials and all', async () => {
    posted.length = 0;
    await conn.rawJsonRpc({ jsonrpc: '2.0', id: 'raw-1', method: 'tools/list', params: {} });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('api_key=secret');
  });

  it('never lets the credential reach the identity or an observation', () => {
    expect(conn.identity.url).toBe(harness.url);
    expect(conn.identity.url).not.toContain('api_key');
    expect(conn.httpUrl).not.toContain('api_key');
    for (const observation of conn.httpObservations) expect(observation.url).not.toContain('api_key');
  });

  it('scores a 401 with a JSON-RPC error body as could-not-check, never a pass', async () => {
    const finding = await probeBogusVersion(conn);
    expect(finding.pass).toBeNull();
    expect(finding.detail).toContain('401');
    expect(finding.detail).toContain('could not check');
    // The body is still recorded: a probe that cannot conclude still shows why.
    expect(JSON.stringify(finding.evidence)).toContain('gateway rejected');
  });
});

// ---------------------------------------------------------------------------
// Suite 6: the aws-knowledge shape. A gateway that advertises tools, answers
// initialize and tools/list normally, and then kills every tools/call at the
// HTTP layer with a 400 and a prose body.
//
// Before `fitness.http_error` existed this produced a tape of requests with no
// responses and nothing at all explaining why: five advertised tools, sixteen
// dead calls, and a recording that could not name the cause. The event is the
// only line that can, so it is asserted here on the FILE, not just in memory.
// ---------------------------------------------------------------------------

/** Verbatim, from the live https://knowledge-mcp.global.api.aws/mcp gateway. */
const AWS_GATEWAY_BODY = 'Http operation is not supported for gateway protocol type MCP';

/**
 * The same 400, with a credential the gateway echoed back. Nothing about an
 * error body is trustworthy, so the snippet has to survive publish-time
 * redaction like every other recorded string.
 */
const LEAKY_GATEWAY_BODY = `${AWS_GATEWAY_BODY} (presented Bearer aws-secret-abc123XYZ)`;

/** Long enough that the 300-character cap has to do something visible. */
const LONG_GATEWAY_BODY = `${AWS_GATEWAY_BODY}: ${'x'.repeat(4000)}`;

interface EventRecord {
  kind: string;
  raw: Record<string, unknown>;
  observedIso: string;
  corrId: string | undefined;
}

/**
 * A scripted stand-in for `client.beta.messages.toolRunner`, deliberately
 * mirroring the real `BetaToolRunner`: a tool whose `run` throws becomes an
 * error `tool_result` and the loop CONTINUES. That is what makes the failure
 * classification interesting - the throw never reaches the loop's own catch.
 */
function scriptedClient(script: readonly { calls?: { name: string; input: Record<string, unknown> }[]; text?: string }[]): RunnerClient {
  return {
    beta: {
      messages: {
        toolRunner(body: Anthropic.Beta.Messages.BetaToolRunnerParams): ToolRunnerLike {
          const messages = [...body.messages];
          const byName = new Map(
            body.tools
              .filter((t): t is Anthropic.Beta.BetaTool & { run: (args: unknown) => unknown } => 'run' in t)
              .map((t) => [t.name, t])
          );
          let id = 0;
          return {
            get params() {
              return { ...body, messages } as Anthropic.Beta.Messages.BetaToolRunnerParams;
            },
            async *[Symbol.asyncIterator]() {
              for (const step of script) {
                const content: unknown[] = [];
                if (step.text !== undefined) content.push({ type: 'text', text: step.text });
                for (const call of step.calls ?? []) {
                  content.push({ type: 'tool_use', id: `tu_${(id += 1)}`, name: call.name, input: call.input });
                }
                messages.push({ role: 'assistant', content: content as never });
                yield {
                  id: `msg_${id}`,
                  type: 'message',
                  role: 'assistant',
                  model: 'claude-sonnet-5',
                  content,
                  stop_reason: (step.calls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn',
                  usage: { input_tokens: 10, output_tokens: 20 }
                } as unknown as Anthropic.Beta.BetaMessage;

                const results: unknown[] = [];
                for (const call of step.calls ?? []) {
                  const tool = byName.get(call.name);
                  if (tool === undefined) continue;
                  try {
                    results.push({ type: 'tool_result', tool_use_id: `tu_${id}`, content: await tool.run(call.input) });
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
        }
      }
    }
  };
}

describe('a gateway that 400s every tools/call below JSON-RPC', () => {
  let harness: Harness;
  let recorder: Recorder;
  let conn: McpConnection;
  let dir: string;
  let tape: TapeWriter;
  let tapePath: string;
  let tools: ToolDescriptor[];
  const events: EventRecord[] = [];
  /** Which body the gateway returns for the next tools/call. */
  let gatewayBody = AWS_GATEWAY_BODY;

  const eventsOfKind = (kind: string): EventRecord[] => events.filter((e) => e.kind === kind);

  const readTape = async (): Promise<TapeLine[]> => {
    await tape.sync();
    const raw = await readFile(tapePath, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as TapeLine);
  };

  beforeAll(async () => {
    const handler = createMcpHandler(serverFactory, { legacy: 'stateless', responseMode: 'json' });
    harness = await serve(async (request) => {
      // Peek at the body without consuming the one the real handler reads.
      const body = request.method === 'POST' ? await request.clone().text() : '';
      if (body.includes('tools/call')) {
        // No JSON-RPC anywhere: a bare HTTP status and a prose body, which is
        // exactly why the transport throws before an envelope can exist.
        return new Response(gatewayBody, { status: 400, headers: { 'content-type': 'text/plain' } });
      }
      return await handler.fetch(request);
    });

    dir = await mkdtemp(join(tmpdir(), 'fitness-http-error-'));
    tapePath = join(dir, 'mcp.jsonl');
    tape = await TapeWriter.open({
      path: tapePath,
      meta: {
        startedAt: T0,
        label: 'aws-shaped-gateway',
        command: ['fitness-report', 'http://127.0.0.1/mcp'],
        kind: 'mcp'
      }
    });

    recorder = new Recorder();
    conn = await connect({
      url: harness.url,
      onFrame: recorder.onFrame,
      // The two seams, wired exactly as src/cli.ts's FrameRecorder wires them:
      // frames flip transport direction into tape direction and go through
      // writeMessage; events keep their kind and go through writeEvent, which
      // refuses dir:"in"/"out" outright.
      onEvent: (kind, raw, observedIso, corrId) => {
        events.push({ kind, raw: raw as Record<string, unknown>, observedIso, corrId });
        void tape.writeEvent({
          t: observedIso,
          dir: 'event',
          kind,
          raw,
          ...(corrId === undefined ? {} : { corr_id: corrId })
        });
      },
      now: recorder.now,
      corrId: 'task-aws-1',
      timeoutMs: 10_000
    });
    conn.setCorrelationId('task-aws-1');
    const listed = await conn.listTools();
    tools = listed.tools as unknown as ToolDescriptor[];
  }, 30_000);

  afterAll(async () => {
    await conn?.close();
    await tape?.close({ reason: 'transport_error', t: recorder.now().toISOString() });
    await harness?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('still negotiates and lists tools: the surface looks healthy', () => {
    expect(conn.identity.era).toBe('modern');
    expect(tools.map((t) => t.name).sort()).toEqual(['add', 'confirm_transfer', 'echo']);
    expect(eventsOfKind(HTTP_ERROR_EVENT)).toHaveLength(0);
  });

  it('emits fitness.http_error when the tool call dies at the HTTP layer', async () => {
    gatewayBody = AWS_GATEWAY_BODY;
    const before = recorder.frames.length;
    await expect(conn.callTool('echo', { text: 'hello' })).rejects.toThrow();

    const emitted = eventsOfKind(HTTP_ERROR_EVENT);
    expect(emitted).toHaveLength(1);
    const event = emitted[0];
    expect(event?.raw).toMatchObject({
      method: 'tools/call',
      toolName: 'echo',
      status: 400,
      bodySnippet: AWS_GATEWAY_BODY
    });
    expect(String(event?.raw['message'])).toContain(AWS_GATEWAY_BODY);
    // The correlation id in force when the call was made, so the event groups
    // with that task's frames (format-extensions §5).
    expect(event?.corrId).toBe('task-aws-1');

    // Observed time, off the injected clock, never a wall clock.
    const delta = Date.parse(event?.observedIso ?? '') - Date.parse(T0);
    expect(Number.isInteger(delta)).toBe(true);
    expect(delta % TICK_MS).toBe(0);

    // And the symptom it exists to explain: an outbound request with no reply.
    const fresh = recorder.frames.slice(before);
    const requests = fresh.filter((f) => f.dir === 'out' && f.raw['method'] === 'tools/call');
    expect(requests).toHaveLength(1);
    expect(fresh.filter((f) => f.dir === 'in')).toHaveLength(0);
  });

  it('writes the event to the tape as dir:"event", never as a JSON-RPC line', async () => {
    const lines = await readTape();
    const httpErrors = lines.filter(
      (line) => (line as { kind?: unknown }).kind === HTTP_ERROR_EVENT
    ) as unknown as Array<Record<string, unknown>>;
    expect(httpErrors).toHaveLength(1);

    const line = httpErrors[0] as Record<string, unknown>;
    expect(line['dir']).toBe('event');
    expect(line['corr_id']).toBe('task-aws-1');
    expect(typeof line['t']).toBe('string');
    // format.md puts the payload of a dir-bearing line in `raw`, never `data`.
    expect(line['data']).toBeUndefined();
    expect((line['raw'] as Record<string, unknown>)['bodySnippet']).toBe(AWS_GATEWAY_BODY);

    // It must not be able to masquerade as protocol traffic: nothing with a
    // `kind` carries dir "in"/"out", and the writer refuses that outright.
    for (const written of lines) {
      const dir = (written as { dir?: unknown }).dir;
      if (dir === 'in' || dir === 'out') expect((written as { kind?: unknown }).kind).toBeUndefined();
    }
    await expect(
      tape.writeMessage({ t: T0, dir: 'event' as unknown as 'in', raw: {} })
    ).rejects.toThrow(/dir "in" or "out"/);
  });

  it('caps the body snippet at 300 characters and marks the elision', async () => {
    gatewayBody = LONG_GATEWAY_BODY;
    const before = eventsOfKind(HTTP_ERROR_EVENT).length;
    await expect(conn.callTool('add', { a: 1, b: 2 })).rejects.toThrow();

    const emitted = eventsOfKind(HTTP_ERROR_EVENT);
    expect(emitted).toHaveLength(before + 1);
    const snippet = String(emitted[emitted.length - 1]?.raw['bodySnippet']);
    expect(snippet.length).toBe(HTTP_ERROR_BODY_SNIPPET_MAX);
    expect(snippet.startsWith(AWS_GATEWAY_BODY)).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('puts the snippet through publish-time redaction like every other line', async () => {
    gatewayBody = LEAKY_GATEWAY_BODY;
    await expect(conn.callTool('echo', { text: 'again' })).rejects.toThrow();

    const lines = await readTape();
    const published = redactTape(lines);
    const errors = published.filter((line) => (line as { kind?: unknown }).kind === HTTP_ERROR_EVENT);
    const leaky = errors
      .map((line) => String(((line as unknown as Record<string, unknown>)['raw'] as Record<string, unknown>)['bodySnippet']))
      .filter((snippet) => snippet.includes(AWS_GATEWAY_BODY) && snippet.includes(REPLACEMENT));

    expect(leaky).toHaveLength(1);
    // The finding survives; the credential does not.
    expect(leaky[0]).not.toContain('aws-secret-abc123XYZ');
    // ...and redaction is a publish-time copy: the recorded line still has it.
    const recorded = lines.filter((line) => (line as { kind?: unknown }).kind === HTTP_ERROR_EVENT);
    expect(JSON.stringify(recorded)).toContain('aws-secret-abc123XYZ');
  });

  it('classifies the per-task failure as protocol-error', async () => {
    gatewayBody = AWS_GATEWAY_BODY;
    const task: FitnessTask = {
      id: 'task-aws-1',
      prompt: 'Echo the word canary.',
      expectedTools: ['echo'],
      check: { kind: 'substring', where: 'final_text', value: 'canary' },
      destructive: false
    };
    const run = await driveTask(task, {
      client: scriptedClient([
        { calls: [{ name: 'echo', input: { text: 'canary' } }] },
        { text: 'The server refused the call.' }
      ]),
      conn,
      tools,
      mcpTape: tape,
      now: recorder.now,
      taskBudgetTokens: null
    });

    expect(run.toolCallRecords.map((r) => r.status)).toEqual(['protocol-error']);
    expect(run.outcome.failure).toBe('protocol-error');
    expect(run.outcome.firstTrySuccess).toBe(false);
    // Pinned against the taxonomy directly, so a reordering of DESIGN decision
    // 9's precedence cannot silently refile a dead gateway as something else.
    expect(
      classifyFailure({
        success: false,
        budgetExhausted: false,
        mrtrAbandoned: false,
        records: run.toolCallRecords,
        loopError: run.error,
        stopReason: run.stopReason
      })
    ).toBe('protocol-error');

    // Both planes of evidence: the transport event from the connection, and the
    // task-scoped attribution from the runner, carrying the same status.
    const lines = await readTape();
    const protocolErrors = lines.filter(
      (line) => (line as { kind?: unknown }).kind === 'fitness.protocol_error'
    ) as unknown as Array<Record<string, unknown>>;
    expect(protocolErrors).toHaveLength(1);
    const raw = protocolErrors[0]?.['raw'] as Record<string, unknown>;
    expect(raw['tool']).toBe('echo');
    expect((raw['http'] as Record<string, unknown>)['status']).toBe(400);
    expect(protocolErrors[0]?.['corr_id']).toBe('task-aws-1');
  });
});

// ---------------------------------------------------------------------------
// The classifier itself: only failures with NO envelope behind them earn an
// event. Anything the tape already explains must stay out of it, or the
// recording grows a second, unfalsifiable account of the same failure.
// ---------------------------------------------------------------------------

describe('httpLayerFailure', () => {
  it('reports a thrown HTTP status with its body', () => {
    const error = Object.assign(new Error('Error POSTing to endpoint: nope'), {
      status: 400,
      data: { status: 400, text: 'nope' }
    });
    expect(httpLayerFailure(error)).toEqual({ status: 400, bodySnippet: 'nope', message: 'Error POSTing to endpoint: nope' });
  });

  it('recovers the body from the SDK message shape when no data is attached', () => {
    const error = new Error(`Error POSTing to endpoint: ${AWS_GATEWAY_BODY}`);
    expect(httpLayerFailure(error)).toBeNull();
    const withStatus = Object.assign(new Error(`Error POSTing to endpoint (HTTP 400): ${AWS_GATEWAY_BODY}`), {});
    expect(httpLayerFailure(withStatus)).toEqual({
      status: 400,
      bodySnippet: AWS_GATEWAY_BODY,
      message: `Error POSTing to endpoint (HTTP 400): ${AWS_GATEWAY_BODY}`
    });
  });

  it('counts a dead socket, with no status to show', () => {
    const error = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    expect(httpLayerFailure(error)).toEqual({ bodySnippet: '', message: 'fetch failed' });
  });

  it('does not invent an HTTP death from a status named inside a JSON-RPC error', () => {
    // Doc proxies (gitmcp, deepwiki, exa, coingecko) answer a failed upstream
    // fetch with an ordinary JSON-RPC error whose MESSAGE quotes the upstream
    // status. The envelope is already an inbound frame on the tape, and the
    // status was never observed by this client, so classifying it as an
    // HTTP-layer death publishes a fabricated `fitness.http_error` beside the
    // real one and copies its `http` block onto the task's protocol_error.
    const upstream = Object.assign(
      new Error('MCP error -32603: Upstream returned HTTP 502 while fetching the doc'),
      { code: -32603 }
    );
    expect(httpLayerFailure(upstream)).toBeNull();
    // Same trap through `data.status`: a JSON-RPC code means the tape has it.
    expect(httpLayerFailure(Object.assign(new Error('MCP error -32020: bad header'), { code: -32020, data: { status: 400, text: 'whatever' } }))).toBeNull();
    // And a bare message that merely mentions a status is not a transport death.
    expect(httpLayerFailure(new Error('the gateway said HTTP 503 earlier'))).toBeNull();
  });

  it('ignores failures the tape already explains', () => {
    // A JSON-RPC error response: the inbound frame is on the tape.
    expect(httpLayerFailure(Object.assign(new Error('MCP error -32602: bad params'), { code: -32602 }))).toBeNull();
    // An outputSchema rejection: a schema-validation-reject finding, raised
    // from a well-formed result.
    expect(httpLayerFailure(new Error('structuredContent does not match the tool outputSchema'))).toBeNull();
    // A client-side deadline is not something the server said.
    expect(httpLayerFailure(Object.assign(new Error('Request timed out'), { data: { timeout: 5000 } }))).toBeNull();
    expect(httpLayerFailure(undefined)).toBeNull();
  });
});
