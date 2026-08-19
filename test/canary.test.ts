/**
 * Canary server tests (DESIGN decision 16).
 *
 * Every assertion here pins a DELIBERATE defect. If one of these fails because
 * the canary got "fixed", the fix is the bug: the harness scores itself against
 * this surface, and the audit suite uses it as the fixture bed for known-bad
 * inputs. Nothing here touches the network beyond 127.0.0.1 and nothing needs
 * an API key.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  ProtocolError,
  ProtocolErrorCode,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type JsonSchemaValidator,
  type jsonSchemaValidator,
  type JsonSchemaType,
  type Tool,
} from '@modelcontextprotocol/client';

import {
  BROKEN_SCHEMA_OUTPUT_SCHEMA,
  BROKEN_SCHEMA_VIOLATING_OUTPUT,
  CANARY_INSTRUCTIONS,
  CANARY_MCP_PATH,
  CANARY_TOOL_NAMES,
  FLAKY_SEARCH_CRASH_INPUT,
  FLAKY_SEARCH_FAIL_INPUT,
  KNOWN_INVOICE_IDS,
  SLOW_ECHO_DELAY_MS,
  start,
  type CanaryHandle,
} from '../canary/server.js';

/** A validator that accepts everything, so a client can observe the raw wire. */
const permissiveValidator: jsonSchemaValidator = {
  getValidator<T>(_schema: JsonSchemaType): JsonSchemaValidator<T> {
    return (input: unknown) => ({ valid: true, data: input as T, errorMessage: undefined });
  },
};

async function connect(url: string, validator?: jsonSchemaValidator): Promise<Client> {
  const client = new Client(
    { name: 'fitness-report-test', version: '0.0.0' },
    {
      versionNegotiation: { mode: 'auto' },
      ...(validator === undefined ? {} : { jsonSchemaValidator: validator }),
    },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

function firstText(result: CallToolResult): string {
  const block = result.content?.find(item => item.type === 'text');
  return block !== undefined && block.type === 'text' ? block.text : '';
}

function properties(tool: Tool): Record<string, Record<string, unknown>> {
  return (tool.inputSchema as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
}

/** One JSON-RPC message out of either wire shape the canary can answer with. */
function parseJsonRpcBody(contentType: string | null, body: string): Record<string, unknown> {
  if ((contentType ?? '').includes('text/event-stream')) {
    const dataLine = body.split('\n').find(line => line.startsWith('data:'));
    return JSON.parse((dataLine ?? '').slice('data:'.length).trim()) as Record<string, unknown>;
  }
  return JSON.parse(body) as Record<string, unknown>;
}

/**
 * POST a hand-built JSON-RPC envelope, bypassing the client SDK entirely. Used
 * where the claim under test is about the BYTES the canary emits, which a
 * client-mediated assertion could only ever infer.
 */
async function postRaw(url: string, message: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(message),
  });
  expect(res.status).toBe(200);
  return parseJsonRpcBody(res.headers.get('content-type'), await res.text());
}

describe('canary server', () => {
  let handle: CanaryHandle;
  let client: Client;
  let tools: readonly Tool[];
  let byName: Map<string, Tool>;

  beforeAll(async () => {
    // Ephemeral port: parallel test files must never collide on a fixed one.
    handle = await start(0);
    client = await connect(handle.url);
    tools = (await client.listTools()).tools;
    byName = new Map(tools.map(tool => [tool.name, tool]));
  });

  afterAll(async () => {
    await client.close();
    await handle.close();
  });

  describe('serving', () => {
    it('binds an ephemeral port on 127.0.0.1 and reports it', () => {
      expect(handle.port).toBeGreaterThan(0);
      expect(handle.origin).toBe(`http://127.0.0.1:${String(handle.port)}`);
      expect(handle.url).toBe(`${handle.origin}${CANARY_MCP_PATH}`);
    });

    it('starts a second instance on a different port', async () => {
      const second = await start(0);
      try {
        expect(second.port).not.toBe(handle.port);
        const res = await fetch(`${second.origin}/health`);
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toMatchObject({ ok: true });
      } finally {
        await second.close();
      }
    });

    it('closes even with a client connection still open', async () => {
      // A canary whose close() waits on idle keep-alive sockets would wedge
      // every run that ends without a tidy client shutdown.
      const spare = await start(0);
      const stray = await connect(spare.url);
      await expect(spare.close()).resolves.toBeUndefined();
      await expect(spare.close()).resolves.toBeUndefined(); // idempotent
      await stray.close().catch(() => undefined);
    }, 5000);

    it('exposes server instructions for task synthesis', () => {
      expect(client.getInstructions()).toBe(CANARY_INSTRUCTIONS);
    });

    it('serves both eras from one target', async () => {
      // DESIGN decision 2: dual-era is a hard requirement, and this is the
      // local target the harness proves it against.
      expect(client.getProtocolEra()).toBe('modern');
      expect(client.getDiscoverResult()?.supportedVersions).toContain('2026-07-28');

      const legacy = new Client({ name: 'fitness-report-test-legacy', version: '0.0.0' });
      await legacy.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
      try {
        expect(legacy.getProtocolEra()).toBe('legacy');
        const legacyTools = (await legacy.listTools()).tools;
        expect(legacyTools.map(tool => tool.name)).toEqual([...CANARY_TOOL_NAMES]);
        expect(legacyTools.find(tool => tool.name === 'transfer_funds')?.annotations).toBeUndefined();
      } finally {
        await legacy.close();
      }
    });
  });

  describe('tools/list shape', () => {
    it('serves exactly the seven canary tools, in order', () => {
      expect(tools.map(tool => tool.name)).toEqual([...CANARY_TOOL_NAMES]);
    });

    it('gives every tool a name, description and object inputSchema', () => {
      for (const tool of tools) {
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
        expect(tool.description).not.toBe('');
        expect(tool.inputSchema).toMatchObject({ type: 'object' });
      }
    });

    it('annotates delete_record as destructive (the control case)', () => {
      const tool = byName.get('delete_record');
      expect(tool?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    });

    it('ships transfer_funds with no annotations at all', () => {
      const tool = byName.get('transfer_funds');
      expect(tool).toBeDefined();
      expect(tool?.annotations).toBeUndefined();
      expect(Object.hasOwn(tool as object, 'annotations')).toBe(false);
    });

    it('treats the unannotated transfer_funds as destructive under the spec-default rule', () => {
      // DESIGN decision 10: destructive unless it declares readOnlyHint:true or
      // destructiveHint:false. Neither is declared, so it is destructive.
      const annotations = byName.get('transfer_funds')?.annotations;
      const optedOut = annotations?.readOnlyHint === true || annotations?.destructiveHint === false;
      expect(optedOut).toBe(false);
    });

    it('leaves lookup_user.user ambiguous: no type, and a description that says nothing', () => {
      const tool = byName.get('lookup_user');
      expect(tool).toBeDefined();
      const userParam = properties(tool as Tool)['user'];
      expect(userParam).toBeDefined();
      // No `type` keyword: an id, a display name and an object all validate.
      expect(userParam).not.toHaveProperty('type');
      const description = String(userParam?.['description'] ?? '').toLowerCase();
      expect(description).not.toContain('id');
      expect(description).not.toContain('name');
      expect(description).not.toContain('object');
    });

    it('advertises the strict outputSchema on broken_schema', () => {
      const tool = byName.get('broken_schema');
      expect(tool?.outputSchema).toEqual(BROKEN_SCHEMA_OUTPUT_SCHEMA);
    });

    it('declares no outputSchema on any other tool', () => {
      for (const tool of tools) {
        if (tool.name === 'broken_schema') continue;
        expect(tool.outputSchema).toBeUndefined();
      }
    });
  });

  describe('flaky_search: three distinct failure surfaces', () => {
    it('succeeds on an ordinary query', async () => {
      const result = await client.callTool({ name: 'flaky_search', arguments: { query: 'invoice' } });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(firstText(result))).toMatchObject({ query: 'invoice' });
    });

    it('returns isError:true with actionable text on the fail input', async () => {
      const result = await client.callTool({
        name: 'flaky_search',
        arguments: { query: FLAKY_SEARCH_FAIL_INPUT },
      });
      // The most common MCP failure class: isError riding a SUCCESSFUL response.
      expect(result.isError).toBe(true);
      const message = firstText(result);
      expect(message).toContain('Retry');
      expect(message.length).toBeGreaterThan(20);
    });

    it('raises a protocol-level JSON-RPC error on the crash input', async () => {
      const call = client.callTool({ name: 'flaky_search', arguments: { query: FLAKY_SEARCH_CRASH_INPUT } });
      await expect(call).rejects.toBeInstanceOf(ProtocolError);
      const error = await call.then(
        () => null,
        (thrown: unknown) => thrown as ProtocolError,
      );
      expect(error?.code).toBe(ProtocolErrorCode.InternalError);
      expect(error?.message).toContain('flaky_search');
    });

    it('keeps the three surfaces distinguishable in one session', async () => {
      const ok = await client.callTool({ name: 'flaky_search', arguments: { query: 'ledger' } });
      const soft = await client.callTool({ name: 'flaky_search', arguments: { query: FLAKY_SEARCH_FAIL_INPUT } });
      expect(ok.isError).toBeFalsy();
      expect(soft.isError).toBe(true);
      await expect(
        client.callTool({ name: 'flaky_search', arguments: { query: FLAKY_SEARCH_CRASH_INPUT } }),
      ).rejects.toBeInstanceOf(ProtocolError);
    });
  });

  describe('broken_schema: the violation is observable on the wire', () => {
    it('is rejected by a spec-conformant client (schema-validation-reject)', async () => {
      const call = client.callTool({ name: 'broken_schema', arguments: { account: 'acct_1' } });
      await expect(call).rejects.toBeInstanceOf(ProtocolError);
      const error = await call.then(
        () => null,
        (thrown: unknown) => thrown as ProtocolError,
      );
      expect(error?.message.toLowerCase()).toContain('output schema');
    });

    it('actually puts the violating structuredContent on the wire', async () => {
      // Same server, a client whose validator accepts anything: this is what
      // the server really sent, not what a strict client inferred.
      const observer = await connect(handle.url, permissiveValidator);
      try {
        const result = await observer.callTool({ name: 'broken_schema', arguments: { account: 'acct_1' } });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toEqual(BROKEN_SCHEMA_VIOLATING_OUTPUT);
      } finally {
        await observer.close();
      }
    });

    it('violates the advertised schema in three independent ways', () => {
      const advertised = BROKEN_SCHEMA_OUTPUT_SCHEMA;
      const sent = BROKEN_SCHEMA_VIOLATING_OUTPUT as Record<string, unknown>;
      expect(advertised.properties.balance_cents.type).toBe('integer');
      expect(typeof sent['balance_cents']).toBe('string');
      expect(advertised.properties.currency.type).toBe('string');
      expect(typeof sent['currency']).toBe('number');
      expect(advertised.additionalProperties).toBe(false);
      expect(Object.keys(sent)).toContain('unexpected_field');
    });
  });

  describe('get_invoice', () => {
    it('returns isError with actionable text on an unknown id', async () => {
      const result = await client.callTool({ name: 'get_invoice', arguments: { invoice_id: 'inv_9999' } });
      expect(result.isError).toBe(true);
      const message = firstText(result);
      for (const known of KNOWN_INVOICE_IDS) expect(message).toContain(known);
      expect(message).toContain('inv_9999');
    });

    it('succeeds on a known id', async () => {
      const result = await client.callTool({ name: 'get_invoice', arguments: { invoice_id: 'inv_1001' } });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(firstText(result))).toEqual({
        invoice_id: 'inv_1001',
        status: 'open',
        amount_due_cents: 12500,
        currency: 'USD',
      });
    });
  });

  describe('slow_echo', () => {
    it('takes at least the advertised delay', async () => {
      const startedAt = Date.now();
      const result = await client.callTool({ name: 'slow_echo', arguments: { text: 'ping' } });
      const elapsed = Date.now() - startedAt;
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toBe('ping');
      // Timer slack: assert the floor, never a ceiling.
      expect(elapsed).toBeGreaterThanOrEqual(SLOW_ECHO_DELAY_MS - 30);
    });
  });

  describe('lookup_user resolves every reading of its ambiguous parameter', () => {
    it('accepts an id string', async () => {
      const result = await client.callTool({ name: 'lookup_user', arguments: { user: 'usr_001' } });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(firstText(result))).toMatchObject({ id: 'usr_001' });
    });

    it('accepts a display name', async () => {
      const result = await client.callTool({ name: 'lookup_user', arguments: { user: 'Grace Hopper' } });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(firstText(result))).toMatchObject({ id: 'usr_002' });
    });

    it('accepts an object', async () => {
      const result = await client.callTool({ name: 'lookup_user', arguments: { user: { id: 'usr_001' } } });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(firstText(result))).toMatchObject({ id: 'usr_001' });
    });

    it('returns actionable text when nothing matches', async () => {
      const result = await client.callTool({ name: 'lookup_user', arguments: { user: 'nobody' } });
      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain('usr_001');
    });
  });

  describe('destructive tools', () => {
    it('delete_record reports the deletion deterministically', async () => {
      const result = await client.callTool({ name: 'delete_record', arguments: { record_id: 'rec_001' } });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(firstText(result))).toEqual({ deleted: true, record_id: 'rec_001' });
    });

    it('transfer_funds reports the transfer deterministically', async () => {
      const args = { from_account: 'acct_1', to_account: 'acct_2', amount_cents: 250 };
      const result = await client.callTool({ name: 'transfer_funds', arguments: args });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(firstText(result))).toMatchObject({
        transferred: true,
        reference: 'xfer_acct_1_acct_2_250',
      });
    });
  });

  describe('determinism', () => {
    it('returns byte-identical results for identical inputs', async () => {
      const once = await client.callTool({ name: 'flaky_search', arguments: { query: 'ledger' } });
      const twice = await client.callTool({ name: 'flaky_search', arguments: { query: 'ledger' } });
      expect(firstText(twice)).toBe(firstText(once));

      const a = await client.callTool({ name: 'delete_record', arguments: { record_id: 'rec_007' } });
      const b = await client.callTool({ name: 'delete_record', arguments: { record_id: 'rec_007' } });
      expect(firstText(b)).toBe(firstText(a));
    });
  });

  describe('raw wire', () => {
    it('emits a JSON-RPC error envelope for the crash input, with no result', async () => {
      const message = await postRaw(handle.url, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'flaky_search', arguments: { query: FLAKY_SEARCH_CRASH_INPUT } },
      });
      expect(message['result']).toBeUndefined();
      expect(message['error']).toMatchObject({ code: ProtocolErrorCode.InternalError });
    });

    it('emits an isError result envelope for the fail input, with no JSON-RPC error', async () => {
      const message = await postRaw(handle.url, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'flaky_search', arguments: { query: FLAKY_SEARCH_FAIL_INPUT } },
      });
      // The two failure classes are genuinely different envelopes, which is the
      // distinction the failure taxonomy is built on.
      expect(message['error']).toBeUndefined();
      expect(message['result']).toMatchObject({ isError: true });
    });

    it('emits the schema-violating structuredContent as a SUCCESSFUL result', async () => {
      const message = await postRaw(handle.url, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'broken_schema', arguments: { account: 'acct_1' } },
      });
      expect(message['error']).toBeUndefined();
      const result = message['result'] as { isError?: boolean; structuredContent?: unknown };
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual(BROKEN_SCHEMA_VIOLATING_OUTPUT);
    });

    it('omits the annotations key entirely from the transfer_funds listing', async () => {
      const message = await postRaw(handle.url, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
      const listed = (message['result'] as { tools: Record<string, unknown>[] }).tools;
      const transfer = listed.find(tool => tool['name'] === 'transfer_funds');
      expect(transfer).toBeDefined();
      // Not "annotations: undefined" or "annotations: {}" — the key is absent,
      // so the spec defaults are the only thing a scorer has to go on.
      expect(Object.keys(transfer as object)).not.toContain('annotations');
      expect(Object.keys(listed.find(tool => tool['name'] === 'delete_record') as object)).toContain('annotations');
    });
  });

  describe('unknown tool', () => {
    it('raises a JSON-RPC error naming the tools it does serve', async () => {
      const call = client.callTool({ name: 'no_such_tool', arguments: {} });
      await expect(call).rejects.toBeInstanceOf(ProtocolError);
      const error = await call.then(
        () => null,
        (thrown: unknown) => thrown as ProtocolError,
      );
      expect(error?.message).toContain('delete_record');
    });
  });
});
