/**
 * Fitness Report canary server (DESIGN decision 16).
 *
 * A deliberately imperfect MCP server. Eleven of fourteen open servers on the
 * roster are read-only doc search, so the destructive / ambiguous / error
 * surfaces the harness must score have no natural target. This is that target,
 * and it doubles as the fixture bed for the audit suite: every defect below is
 * intentional and load-bearing, and every behaviour is a pure function of its
 * inputs so a fixture recorded today replays byte-for-byte tomorrow.
 *
 * The planted defects, one per scoring surface:
 *
 *  - `delete_record`   destructive, CORRECTLY annotated (`destructiveHint: true`).
 *                      The control case: a scorer must not flag it.
 *  - `transfer_funds`  destructive, NO `annotations` key at all. Per spec the
 *                      defaults are `destructiveHint: true` / `readOnlyHint:
 *                      false`, so the spec-default rule (DESIGN decision 10)
 *                      must treat it as destructive. A scorer that reads only
 *                      declared annotations misses it.
 *  - `lookup_user`     parameter named `user` whose description never says
 *                      whether it is an id, a display name, or an object. The
 *                      ambiguous-parameter finding; the rewrite is `user_id`.
 *  - `flaky_search`    all three failure surfaces from one tool: a protocol-level
 *                      JSON-RPC error on `crash`, an `isError: true` result with
 *                      actionable text on `fail`, success otherwise. MCP tool
 *                      failures arrive as `isError` on a SUCCESSFUL response;
 *                      a scorer reading only JSON-RPC errors misses that class.
 *  - `get_invoice`     `isError: true` with recoverable, actionable text on an
 *                      unknown id. Feeds execution-error-RECOVERED.
 *  - `slow_echo`       fixed 300 ms delay, for the latency percentiles.
 *  - `broken_schema`   advertises an `outputSchema` its own `structuredContent`
 *                      violates, on the wire. Feeds schema-validation-reject,
 *                      which is a SERVER finding and never the agent's fault.
 *
 * Why the low-level `Server` and hand-written `tools/list` / `tools/call`
 * handlers rather than `McpServer`: `McpServer` would silently repair three of
 * the seven defects. It converts every handler throw into an `isError` result
 * (so `flaky_search` could never emit a JSON-RPC error) and it validates
 * `structuredContent` against the declared `outputSchema` before it reaches the
 * wire (so `broken_schema` could never violate its own contract). A canary
 * needs byte-level control of its wire surface, which is exactly the "advanced
 * use case" the low-level `Server` is kept for; the SDK documents this path on
 * `Server.projectCallToolResult`, which the `tools/call` handler below calls so
 * the era projection still lives in one place.
 *
 * Serving: HTTP on 127.0.0.1 via `createMcpHandler`, which serves the
 * 2026-07-28 era and falls back to stateless 2025-era serving, so the harness
 * can exercise both eras against one target.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';

import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type CallToolResult,
  type McpHttpHandler,
  type Tool,
} from '@modelcontextprotocol/server';

// ---------------------------------------------------------------------------
// Identity and fixture constants (exported: the audit suite pins against these)
// ---------------------------------------------------------------------------

export const CANARY_NAME = 'fitness-report-canary';
export const CANARY_VERSION = '0.1.0';
export const CANARY_SLUG = 'canary';

/** Path the MCP endpoint is mounted at. */
export const CANARY_MCP_PATH = '/mcp';

/**
 * Server `instructions`, surfaced to the harness via `getInstructions()` and
 * injected into both the task-synthesis prompt and the runner system prompt
 * (DESIGN decision 17). Deliberately unhelpful about `lookup_user`.
 */
export const CANARY_INSTRUCTIONS = [
  'Canary ledger service. Records, users, invoices and account transfers live here.',
  'Ids look like rec_001, usr_001, inv_1001 and acct_1.',
].join(' ');

/** Fixed latency of `slow_echo`, in milliseconds. */
export const SLOW_ECHO_DELAY_MS = 300;

/** `flaky_search` query that produces a protocol-level JSON-RPC error. */
export const FLAKY_SEARCH_CRASH_INPUT = 'crash';

/** `flaky_search` query that produces an `isError: true` result. */
export const FLAKY_SEARCH_FAIL_INPUT = 'fail';

/** Invoice ids `get_invoice` resolves. Anything else is an actionable isError. */
export const KNOWN_INVOICE_IDS = ['inv_1001', 'inv_1002'] as const;

/** Users `lookup_user` resolves, by id. */
export const KNOWN_USERS = [
  { id: 'usr_001', name: 'Ada Lovelace', email: 'ada@example.invalid', plan: 'enterprise' },
  { id: 'usr_002', name: 'Grace Hopper', email: 'grace@example.invalid', plan: 'free' },
] as const;

/** Every tool name this canary serves, in `tools/list` order. */
export const CANARY_TOOL_NAMES = [
  'delete_record',
  'transfer_funds',
  'lookup_user',
  'flaky_search',
  'get_invoice',
  'slow_echo',
  'broken_schema',
] as const;

export type CanaryToolName = (typeof CANARY_TOOL_NAMES)[number];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] };
}

function errorText(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }], isError: true };
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// Tool table. `definition` is the verbatim wire shape emitted by `tools/list`;
// `call` is a pure function of its arguments. A `call` that THROWS produces a
// protocol-level JSON-RPC error; a `call` that RETURNS `isError: true`
// produces a tool-level failure on a successful response. The distinction is
// the whole point of the flaky_search fixture.
// ---------------------------------------------------------------------------

interface CanaryTool {
  readonly definition: Tool;
  readonly call: (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
}

const DELETE_RECORD: CanaryTool = {
  definition: {
    name: 'delete_record',
    title: 'Delete record',
    description:
      'Permanently delete a record from the canary ledger. The record and its history are removed and cannot be restored.',
    inputSchema: {
      type: 'object',
      properties: {
        record_id: {
          type: 'string',
          description: 'Id of the record to delete, for example rec_001.',
        },
      },
      required: ['record_id'],
      additionalProperties: false,
    },
    // Correctly annotated: the control case for the destructive-without-
    // confirmation rule. A scorer that flags this one is producing a false alarm.
    annotations: {
      title: 'Delete record',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  call: args => {
    const recordId = asString(args['record_id']);
    if (recordId === null || recordId.length === 0) {
      return errorText(
        'record_id is required and must be a non-empty string, for example "rec_001". Call delete_record again with a record_id.',
      );
    }
    return json({ deleted: true, record_id: recordId });
  },
};

const TRANSFER_FUNDS: CanaryTool = {
  definition: {
    name: 'transfer_funds',
    title: 'Transfer funds',
    description: 'Move money between two accounts in the canary ledger. Transfers settle immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        from_account: { type: 'string', description: 'Source account id, for example acct_1.' },
        to_account: { type: 'string', description: 'Destination account id, for example acct_2.' },
        amount_cents: { type: 'integer', description: 'Amount to move, in cents.' },
      },
      required: ['from_account', 'to_account', 'amount_cents'],
      additionalProperties: false,
    },
    // NO `annotations` key at all. Intentional: per the spec defaults
    // (destructiveHint TRUE, readOnlyHint FALSE) this tool is destructive, and
    // the spec-default rule must catch it without any declaration to read.
  },
  call: args => {
    const from = asString(args['from_account']);
    const to = asString(args['to_account']);
    const amount = args['amount_cents'];
    if (from === null || to === null || typeof amount !== 'number' || !Number.isFinite(amount)) {
      return errorText(
        'transfer_funds needs from_account (string), to_account (string) and amount_cents (number). Call it again with all three.',
      );
    }
    return json({
      transferred: true,
      from_account: from,
      to_account: to,
      amount_cents: amount,
      reference: `xfer_${from}_${to}_${String(amount)}`,
    });
  },
};

const LOOKUP_USER: CanaryTool = {
  definition: {
    name: 'lookup_user',
    title: 'Lookup user',
    description: 'Look up a user.',
    inputSchema: {
      type: 'object',
      properties: {
        // The planted ambiguity. No `type`, and a description that never says
        // whether the caller should pass an id, a display name, or an object.
        // The rewrite this canary exists to justify is `user_id: { type:
        // 'string', description: 'The unique id of the user, e.g. usr_001.' }`.
        user: { description: 'The user.' },
      },
      required: ['user'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Lookup user',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  call: args => {
    const raw = args['user'];
    let id: string | null = null;
    let name: string | null = null;

    if (typeof raw === 'string') {
      if (raw.startsWith('usr_')) id = raw;
      else name = raw;
    } else if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      id = asString(record['id']) ?? asString(record['user_id']);
      name = asString(record['name']);
    }

    const found =
      KNOWN_USERS.find(user => (id !== null && user.id === id)) ??
      KNOWN_USERS.find(user => name !== null && user.name.toLowerCase() === name.toLowerCase());

    if (found === undefined) {
      return errorText(
        `No user matched ${JSON.stringify(raw)}. Pass the user id as a string, for example "usr_001". Known user ids: ${KNOWN_USERS.map(u => u.id).join(', ')}.`,
      );
    }
    return json(found);
  },
};

const FLAKY_SEARCH: CanaryTool = {
  definition: {
    name: 'flaky_search',
    title: 'Flaky search',
    description: 'Search the canary ledger. Unreliable on some inputs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text query to run against the ledger.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Flaky search',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  call: args => {
    const query = asString(args['query']);
    if (query === null) {
      return errorText('query is required and must be a string. Call flaky_search again with a query.');
    }
    if (query === FLAKY_SEARCH_CRASH_INPUT) {
      // Protocol-level failure: a JSON-RPC error response, not an isError
      // result. The client SDK throws; the harness classes this protocol-error.
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `flaky_search failed while handling query ${JSON.stringify(query)}`,
      );
    }
    if (query === FLAKY_SEARCH_FAIL_INPUT) {
      // Tool-level failure on a SUCCESSFUL JSON-RPC response, with text an
      // agent can actually act on. Feeds execution-error-recovered.
      return errorText(
        `The search index rejected the query ${JSON.stringify(query)}. Retry with a more specific query, for example "invoice" or "usr_001".`,
      );
    }
    return json({
      query,
      hits: [
        { id: 'rec_001', snippet: `record matching ${query}` },
        { id: 'rec_002', snippet: `second record matching ${query}` },
      ],
    });
  },
};

const GET_INVOICE: CanaryTool = {
  definition: {
    name: 'get_invoice',
    title: 'Get invoice',
    description: 'Fetch one invoice from the canary ledger by its id.',
    inputSchema: {
      type: 'object',
      properties: {
        invoice_id: { type: 'string', description: 'Id of the invoice to fetch, for example inv_1001.' },
      },
      required: ['invoice_id'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Get invoice',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  call: args => {
    const invoiceId = asString(args['invoice_id']);
    if (invoiceId === null || !(KNOWN_INVOICE_IDS as readonly string[]).includes(invoiceId)) {
      return errorText(
        `Unknown invoice id ${JSON.stringify(invoiceId)}. Known invoice ids are ${KNOWN_INVOICE_IDS.join(', ')}. Call get_invoice again with one of those.`,
      );
    }
    return json(
      invoiceId === 'inv_1001'
        ? { invoice_id: 'inv_1001', status: 'open', amount_due_cents: 12500, currency: 'USD' }
        : { invoice_id: 'inv_1002', status: 'paid', amount_due_cents: 0, currency: 'USD' },
    );
  },
};

const SLOW_ECHO: CanaryTool = {
  definition: {
    name: 'slow_echo',
    title: 'Slow echo',
    description: `Echo the supplied text back after a fixed ${String(SLOW_ECHO_DELAY_MS)} ms delay. Exists to exercise latency measurement.`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to echo back.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Slow echo',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  call: async args => {
    const value = asString(args['text']);
    if (value === null) {
      return errorText('text is required and must be a string. Call slow_echo again with text.');
    }
    await sleep(SLOW_ECHO_DELAY_MS);
    return text(value);
  },
};

/**
 * The advertised output contract of `broken_schema`, exported so tests and the
 * audit fixtures can assert the violation against the exact schema the server
 * published rather than a restatement of it.
 */
export const BROKEN_SCHEMA_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    balance_cents: { type: 'integer', description: 'Account balance in cents.' },
    currency: { type: 'string', description: 'ISO 4217 currency code.' },
  },
  required: ['balance_cents', 'currency'],
  additionalProperties: false,
} as const;

/**
 * The `structuredContent` `broken_schema` actually returns. Violates the
 * advertised schema three ways: `balance_cents` is a string not an integer,
 * `currency` is a number not a string, and `unexpected_field` is present under
 * `additionalProperties: false`.
 */
export const BROKEN_SCHEMA_VIOLATING_OUTPUT = {
  balance_cents: 'twelve thousand five hundred',
  currency: 42,
  unexpected_field: true,
} as const;

const BROKEN_SCHEMA: CanaryTool = {
  definition: {
    name: 'broken_schema',
    title: 'Account balance (broken schema)',
    description: 'Return the balance of one canary account.',
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account id to summarise, for example acct_1.' },
      },
      required: ['account'],
      additionalProperties: false,
    },
    outputSchema: BROKEN_SCHEMA_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: 'Account balance (broken schema)',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  call: args => {
    const account = asString(args['account']);
    if (account === null) {
      return errorText('account is required and must be a string. Call broken_schema again with an account.');
    }
    // Deliberately violates the outputSchema advertised above. The low-level
    // Server does not validate structuredContent against a tool's own
    // outputSchema, so this reaches the wire intact and the CLIENT rejects it,
    // which is the schema-validation-reject finding we want to measure.
    return {
      content: [{ type: 'text', text: JSON.stringify(BROKEN_SCHEMA_VIOLATING_OUTPUT) }],
      structuredContent: BROKEN_SCHEMA_VIOLATING_OUTPUT as unknown as Record<string, unknown>,
    };
  },
};

const TOOLS: readonly CanaryTool[] = [
  DELETE_RECORD,
  TRANSFER_FUNDS,
  LOOKUP_USER,
  FLAKY_SEARCH,
  GET_INVOICE,
  SLOW_ECHO,
  BROKEN_SCHEMA,
];

const TOOL_BY_NAME = new Map<string, CanaryTool>(TOOLS.map(tool => [tool.definition.name, tool]));

/** The verbatim `tools/list` payload this canary serves. */
export const CANARY_TOOL_DEFINITIONS: readonly Tool[] = TOOLS.map(tool => tool.definition);

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------

/**
 * Build one canary `Server` instance. `createMcpHandler` calls this once per
 * HTTP request, so the instance holds no state: every tool is a pure function
 * of its arguments and nothing here mutates across requests.
 */
export function createCanaryServer(): Server {
  const server = new Server(
    { name: CANARY_NAME, version: CANARY_VERSION },
    { capabilities: { tools: {} }, instructions: CANARY_INSTRUCTIONS },
  );

  server.setRequestHandler('tools/list', () => ({ tools: CANARY_TOOL_DEFINITIONS.map(tool => ({ ...tool })) }));

  server.setRequestHandler('tools/call', async request => {
    const name = request.params.name;
    const tool = TOOL_BY_NAME.get(name);
    if (tool === undefined) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Unknown tool: ${name}. Known tools: ${CANARY_TOOL_NAMES.join(', ')}.`,
      );
    }
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const result = await tool.call(args);
    // Low-level handlers own the era projection; run it here so the 2025 and
    // 2026 wire shapes stay correct without the handler knowing which era it
    // is serving. Projection never validates, so the broken_schema violation
    // survives it untouched.
    return server.projectCallToolResult(result, tool.definition.outputSchema);
  });

  return server;
}

// ---------------------------------------------------------------------------
// HTTP serving. `@modelcontextprotocol/node`'s `toNodeHandler` is not a
// dependency of this project, so the web-standard handler is wired to
// `node:http` here: buffer the request body, hand a `Request` to the handler,
// stream the `Response` back.
// ---------------------------------------------------------------------------

async function toWebRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const url = new URL(req.url ?? '/', origin);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.set(key, value);
  }

  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') {
    return new Request(url, { method, headers });
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  return new Request(url, {
    method,
    headers,
    body: body.length > 0 ? new Uint8Array(body) : undefined,
  });
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return;
    headers[key] = value;
  });
  const setCookie = response.headers.getSetCookie();
  if (setCookie.length > 0) headers['set-cookie'] = setCookie;

  res.writeHead(response.status, headers);

  const body = response.body;
  if (body === null) {
    res.end();
    return;
  }

  const reader = body.getReader();
  const abort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  res.on('close', abort);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        // Resolve on 'close' as well: a peer that vanished mid-stream never
        // drains, and waiting on 'drain' alone would hang the response forever.
        await new Promise<void>(resolve => {
          const settle = (): void => {
            res.off('drain', settle);
            res.off('close', settle);
            resolve();
          };
          res.once('drain', settle);
          res.once('close', settle);
        });
      }
    }
  } catch {
    // Client hung up mid-stream. Nothing to report: the canary is a target,
    // not a source of truth about its own callers.
  } finally {
    res.off('close', abort);
    res.end();
  }
}

function jsonRpcErrorResponse(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status });
}

/** A running canary, as returned by {@link start}. */
export interface CanaryHandle {
  /** Full MCP endpoint URL, for example `http://127.0.0.1:41234/mcp`. */
  readonly url: string;
  /** Origin only, for example `http://127.0.0.1:41234`. */
  readonly origin: string;
  /** The bound port. Resolved even when `start()` was called with port 0. */
  readonly port: number;
  /** Stop listening and release the handler. Idempotent. */
  readonly close: () => Promise<void>;
}

/**
 * Start the canary over HTTP on 127.0.0.1.
 *
 * @param port Port to bind. `0` (the default) binds an ephemeral port, which is
 *   what the test suite uses so runs never collide.
 */
export async function start(port = 0): Promise<CanaryHandle> {
  const host = '127.0.0.1';
  const handler: McpHttpHandler = createMcpHandler(() => createCanaryServer(), {
    legacy: 'stateless',
    onerror: () => {
      // Swallowed on purpose: a canary that logs its own induced faults to
      // stderr turns every scored run into noise.
    },
  });

  // Filled in once the socket is bound; only used as a base for URL parsing
  // when a request arrives without a Host header (which host validation then
  // rejects anyway).
  let boundOrigin = `http://${host}`;

  const httpServer: HttpServer = createServer((req, res) => {
    void (async () => {
      const origin = req.headers.host === undefined ? boundOrigin : `http://${req.headers.host}`;
      let request: Request;
      try {
        request = await toWebRequest(req, origin);
      } catch {
        await writeWebResponse(res, jsonRpcErrorResponse(400, -32700, 'Malformed request'));
        return;
      }

      // The handler is deliberately validation-free; DNS-rebinding and origin
      // checks belong in front of it.
      const rejected =
        hostHeaderValidationResponse(request, localhostAllowedHostnames()) ??
        originValidationResponse(request, localhostAllowedOrigins());
      if (rejected !== undefined) {
        await writeWebResponse(res, rejected);
        return;
      }

      const path = new URL(request.url).pathname;
      if (path === '/health') {
        await writeWebResponse(
          res,
          Response.json({ ok: true, server: CANARY_NAME, version: CANARY_VERSION, tools: CANARY_TOOL_NAMES.length }),
        );
        return;
      }
      if (path !== CANARY_MCP_PATH) {
        await writeWebResponse(
          res,
          jsonRpcErrorResponse(404, -32601, `No MCP endpoint at ${path}. The canary serves ${CANARY_MCP_PATH}.`),
        );
        return;
      }

      await writeWebResponse(res, await handler.fetch(request));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Canary failure' }, id: null }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address() as AddressInfo;
  const boundPort = address.port;
  const origin = `http://${host}:${String(boundPort)}`;
  boundOrigin = origin;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handler.close();
    await new Promise<void>(resolve => {
      httpServer.close(() => {
        resolve();
      });
      // Must run inside the same tick as close(): `close()` waits for every
      // keep-alive socket to go idle on its own, so forcing them shut has to
      // happen before we await, not after.
      httpServer.closeAllConnections();
    });
  };

  return { url: `${origin}${CANARY_MCP_PATH}`, origin, port: boundPort, close };
}

// ---------------------------------------------------------------------------
// CLI entry: `npm run canary` (tsx canary/server.ts) [--port <n>]
// ---------------------------------------------------------------------------

function parsePortArg(argv: readonly string[]): number {
  const flagIndex = argv.indexOf('--port');
  const raw =
    flagIndex >= 0 && flagIndex + 1 < argv.length
      ? argv[flagIndex + 1]
      : (argv.find(arg => arg.startsWith('--port='))?.slice('--port='.length) ?? process.env['CANARY_PORT']);
  if (raw === undefined || raw === '') return 8765;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const handle = await start(parsePortArg(process.argv.slice(2)));
  process.stdout.write(`canary listening on ${handle.url}\n`);
  const shutdown = (): void => {
    void handle.close().then(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`canary failed to start: ${String(error)}\n`);
    process.exit(1);
  });
}
