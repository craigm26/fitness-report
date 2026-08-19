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
import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';

import { InMemoryTransport } from '@modelcontextprotocol/client';
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  inputRequired,
  type McpServerFactory
} from '@modelcontextprotocol/server';

import {
  MODERN_PROTOCOL_VERSION,
  connect,
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
import type { ProbeFinding, ProbeResults } from '../src/types.js';

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
