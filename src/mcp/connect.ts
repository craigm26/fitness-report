/**
 * MCP transport wrapper for Fitness Report (DESIGN decisions 2, 8, 14).
 *
 * Owns everything the rest of the harness needs from `@modelcontextprotocol/client@2`:
 *
 *   - version negotiation (`mode: 'auto'` by default, `--pin` exposed as `pin`)
 *     plus the recorded era / negotiated version / `server/discover` result;
 *   - a FRAME HOOK: every JSON-RPC request and response is surfaced to a
 *     caller-supplied `onFrame(dir, raw, observedIso, corrId)` with an OBSERVED
 *     timestamp (see "Frame capture" below for how, since the SDK has no hook);
 *   - `listTools()` with cacheMode discipline (`'bypass'` by default so drift
 *     probes never read a cached tool surface);
 *   - `inputRequired.autoFulfill: false` plus a manual MRTR drive surface where
 *     the caller answers each round, every round rides a fresh JSON-RPC id, and
 *     the opaque `requestState` is echoed byte-exact;
 *   - `io.modelcontextprotocol/logLevel` injected into `_meta` on the modern era
 *     (without it we capture zero server logs);
 *   - graceful handling of the three live transport shapes: SSE-framed vs plain
 *     `application/json` responses, and session-ful vs stateless servers.
 *
 * ## Frame capture: how, and why this way
 *
 * The v2 SDK exposes NO per-frame hook on `Client` or `Protocol`. The two
 * candidate seams are the `Middleware`/`withLogging` fetch chain (HTTP metadata
 * only: status, duration, headers - no JSON-RPC bodies, and nothing at all on a
 * non-HTTP transport) and the `Transport` interface itself. We instrument the
 * transport:
 *
 *   {@link FrameCapturingTransport} wraps ANY `Transport` and is what we hand to
 *   `Client.connect()`. Outbound frames are emitted inside `send()` immediately
 *   before delegating; inbound frames are emitted from the INNER transport's
 *   `onmessage` before the message is forwarded to whatever the SDK installed as
 *   the wrapper's `onmessage`. That placement matters: during version
 *   negotiation the SDK temporarily replaces `transport.onmessage` with its own
 *   probe-window handler and deliberately does not forward inbound messages to
 *   pre-set observers. Because we sit on the inner transport we still see the
 *   `server/discover` probe and its reply, which is the exchange that decides
 *   the era.
 *
 * HTTP-level facts the JSON-RPC layer cannot show (response `content-type`,
 * `mcp-session-id`, status) are captured by a `fetch` wrapper passed to
 * `StreamableHTTPClientTransport`, and drive `transportShape` / `sessionful`.
 *
 * Raw `fetch` probes (deliberately malformed requests the SDK cannot express)
 * go through {@link McpConnection.rawJsonRpc}, which surfaces the outbound
 * envelope through the same `onFrame`, and the inbound envelope too whenever the
 * response body actually carries one. A non-JSON-RPC response body is NOT
 * synthesised into a `dir:'in'` frame (DESIGN decision 5 reserves those
 * directions for real JSON-RPC); it comes back to the caller for
 * `ProbeFinding.evidence` instead.
 */

import {
  Client,
  LOG_LEVEL_META_KEY,
  StreamableHTTPClientTransport,
  isInputRequiredResult,
  type CacheMode,
  type CallToolResult,
  type ClientCapabilities,
  type DiscoverResult,
  type JSONRPCMessage,
  type ListToolsResult,
  type LoggingLevel,
  type MessageExtraInfo,
  type Tool,
  type Transport,
  type TransportSendOptions,
  type VersionNegotiationMode
} from '@modelcontextprotocol/client';

import type { CredentialContext, ProtocolEra, ServerIdentity } from '../types.js';

// ---------------------------------------------------------------------------
// Frame hook
// ---------------------------------------------------------------------------

/** JSON-RPC frame direction. `'event'`/`'command'` lines are the tape writer's business, never ours. */
export type FrameDirection = 'in' | 'out';

/**
 * Called for EVERY JSON-RPC frame the connection sends or receives.
 *
 * @param dir         `'out'` = client to server, `'in'` = server to client.
 * @param raw         The verbatim JSON-RPC envelope (deep-cloned, so later SDK
 *                    mutation cannot rewrite history).
 * @param observedIso Observed ISO timestamp, taken at the moment the frame
 *                    crossed the seam - never "wall clock at log time".
 * @param corrId      The current correlation id (taskId), when one is set.
 */
export type FrameHook = (dir: FrameDirection, raw: unknown, observedIso: string, corrId?: string) => void;

/** One observed HTTP exchange underneath the JSON-RPC layer. */
export interface HttpObservation {
  url: string;
  status: number;
  contentType: string | null;
  sessionId: string | null;
  observedIso: string;
}

/** The harness's own identity on the wire. */
export interface ClientInfo {
  name: string;
  version: string;
}

export const DEFAULT_CLIENT_INFO: ClientInfo = { name: 'fitness-report', version: '0.1.0' };

/** The modern revision `--pin` targets, and the boundary for `isModernRevision`. */
export const MODERN_PROTOCOL_VERSION = '2026-07-28';

/**
 * What the harness advertises it can answer. A 2026-07-28 server refuses to
 * embed an `elicitation/create` input request unless the requesting client
 * declared the capability, so without this the whole MRTR surface is invisible
 * and a server that asks for confirmation would look like one that never asks.
 * `roots` and `sampling` are deliberately absent (deprecated by SEP-2577).
 */
export const DEFAULT_CLIENT_CAPABILITIES: ClientCapabilities = { elicitation: {} };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ConnectConfig {
  /** Server URL. Required unless `transport` is supplied (tests / canary). */
  url?: string;
  /** Leaderboard slug; derived from the URL host when omitted. */
  slug?: string;
  /** Bearer token. Presence flips the default credential context to `'free-key'`. */
  authToken?: string;
  /** Override the credential context stamped on the score record. */
  credentialContext?: CredentialContext;
  /**
   * `--pin 2026-07-28`: negotiate the modern era at exactly this revision, with
   * no legacy fallback. Omit for `mode: 'auto'` (DESIGN decision 2).
   */
  pin?: string;
  /** Escape hatch for the full SDK negotiation vocabulary; overrides `pin`. */
  versionMode?: VersionNegotiationMode;
  /** Frame hook. See {@link FrameHook}. */
  onFrame?: FrameHook;
  /** Injectable clock so observed timestamps are testable. */
  now?: () => Date;
  clientInfo?: ClientInfo;
  /**
   * Level injected as `io.modelcontextprotocol/logLevel` into `_meta` on modern
   * requests. `null` disables injection. Default `'debug'`.
   */
  logLevel?: LoggingLevel | null;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Correlation id (taskId) stamped on frames until changed. */
  corrId?: string;
  /** Extra HTTP headers (HTTP transport only). */
  headers?: Record<string, string>;
  /** Transport seam: supply your own (in-memory in tests, stdio for the canary). */
  transport?: Transport;
  /** `fetch` seam for tests. */
  fetchImpl?: typeof fetch;
  /** Round cap for the manual MRTR driver. Default 8. */
  maxMrtrRounds?: number;
  /**
   * Client capabilities advertised to the server. Default `{ elicitation: {} }`:
   * a server only issues `input_required` rounds to a client that declares it
   * can answer them, so without this the MRTR surface is invisible and the
   * harness would score a server as if it never asked for input. We declare the
   * capability and answer manually; `roots` and `sampling` are deliberately NOT
   * declared (deprecated in 2026-07-28, SEP-2577).
   */
  capabilities?: ClientCapabilities;
}

// ---------------------------------------------------------------------------
// Transport wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps a `Transport` so every JSON-RPC frame is observable. Deliberately a
 * thin delegator: the SDK reassigns `onmessage`/`onerror`/`onclose` on the
 * object it is handed, and shadows `start` during the negotiation handover, so
 * the wrapper must behave like a plain transport in every respect.
 */
export class FrameCapturingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(
    private readonly inner: Transport,
    private readonly emit: (dir: FrameDirection, raw: unknown) => void
  ) {
    this.inner.onmessage = (message, extra) => {
      this.emit('in', message);
      this.onmessage?.(message, extra);
    };
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onclose = () => this.onclose?.();
  }

  get hasPerRequestStream(): boolean | undefined {
    return this.inner.hasPerRequestStream;
  }

  /**
   * Read-through only. `StreamableHTTPClientTransport.sessionId` is a
   * getter-only accessor, so a pass-through setter would throw; nothing in the
   * SDK assigns a client transport's session id.
   */
  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  async start(): Promise<void> {
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.emit('out', message);
    await this.inner.send(message, options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  setProtocolVersion = (version: string): void => {
    this.inner.setProtocolVersion?.(version);
  };

  setSupportedProtocolVersions = (versions: string[]): void => {
    this.inner.setSupportedProtocolVersions?.(versions);
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Deep copy so a frame is a snapshot, not a live view into SDK state. */
function freezeFrame(raw: unknown): unknown {
  try {
    return structuredClone(raw);
  } catch {
    try {
      return JSON.parse(JSON.stringify(raw)) as unknown;
    } catch {
      return raw;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Credentials stripped: userinfo, query and fragment removed (DESIGN decision 5). */
export function stripCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

/** `https://mcp.deepwiki.com/mcp` -> `mcp-deepwiki-com`. */
export function slugFromUrl(url: string): string {
  const raw = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

/** A JSON-RPC envelope is an object carrying `jsonrpc: '2.0'`. */
export function isJsonRpcEnvelope(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value['jsonrpc'] === '2.0';
}

/** `YYYY-MM-DD` revisions sort lexically; 2026-07-28 is the first modern one. */
export function isModernRevision(version: string | null | undefined): boolean {
  return typeof version === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(version) && version >= MODERN_PROTOCOL_VERSION;
}

/** Pull the JSON-RPC envelope out of an SSE-framed body (`data:` lines). */
export function parseSseData(body: string): unknown {
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(data);
      if (isJsonRpcEnvelope(parsed)) return parsed;
    } catch {
      /* keep scanning: a keepalive comment frame is not an error */
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Result / MRTR shapes
// ---------------------------------------------------------------------------

/** One deliberately-raw HTTP exchange (probe path only). */
export interface RawExchange {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  /** The JSON-RPC envelope when the body carried one (plain JSON or SSE-framed). */
  envelope: Record<string, unknown> | undefined;
  contentType: string | null;
  sessionId: string | null;
}

export interface MrtrRoundRecord {
  /** 1-based round index. */
  round: number;
  inputRequests: Record<string, unknown>;
  /** Opaque server state, echoed back byte-exact on the next round. */
  requestState: string | undefined;
  /** The JSON-RPC id this round's request went out on (fresh every round). */
  requestId: string | number | undefined;
}

/** Caller answers one MRTR round. Return `undefined` to abandon the call. */
export type MrtrAnswerer = (
  round: MrtrRoundRecord
) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;

export type ToolCallOutcome =
  | { kind: 'result'; result: CallToolResult; rounds: readonly MrtrRoundRecord[] }
  | { kind: 'input_required'; inputRequests: Record<string, unknown>; requestState: string | undefined }
  | { kind: 'mrtr-abandoned'; reason: 'round-cap' | 'caller-declined'; rounds: readonly MrtrRoundRecord[] };

interface ResolvedConfig {
  /**
   * The WIRE target, verbatim, including any query-string credential the host
   * requires (`?api_key=`, `?config=`). Raw probes must post here or they lose
   * the authentication the SDK transport still carries, which silently turns
   * two deterministic hygiene columns into "could not check" (or worse, a false
   * pass) on exactly the hosted servers that need a key. NEVER serialised.
   */
  wireUrl: string | null;
  /** Credential-stripped. The only URL that may reach a report, a tape, a log
   *  line or an error message. */
  url: string | null;
  slug: string;
  credentialContext: CredentialContext;
  onFrame: FrameHook | undefined;
  now: () => Date;
  clientInfo: ClientInfo;
  logLevel: LoggingLevel | null;
  timeoutMs: number | undefined;
  headers: Record<string, string>;
  authToken: string | undefined;
  fetchImpl: typeof fetch;
  maxMrtrRounds: number;
}

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

export class McpConnection {
  private readonly _requestMethodById = new Map<string, string>();
  private readonly _lastRawResult = new Map<string, unknown>();
  private readonly _lastRawError = new Map<string, unknown>();
  private readonly _outboundIds: Array<{ id: string | number; method: string }> = [];
  private _corrId: string | undefined;
  private _closed = false;

  constructor(
    readonly client: Client,
    private readonly cfg: ResolvedConfig,
    private readonly transport: FrameCapturingTransport,
    private readonly _httpObservations: HttpObservation[],
    corrId?: string
  ) {
    this._corrId = corrId;
  }

  // -- identity ------------------------------------------------------------

  /** The `server/discover` result, when the connection negotiated a modern era. */
  get discoverResult(): DiscoverResult | undefined {
    return this.client.getDiscoverResult();
  }

  /**
   * Recomputed on read so `transportShape` / `sessionful` stay honest as more
   * exchanges are observed (a server can answer `initialize` over SSE and
   * `tools/list` as plain JSON).
   */
  get identity(): ServerIdentity {
    return {
      url: this.cfg.url ?? `inproc:${this.cfg.slug}`,
      slug: this.cfg.slug,
      era: this.era,
      negotiatedVersion: this.negotiatedVersion,
      serverInfo: this.client.getServerVersion(),
      instructions: this.client.getInstructions() ?? null,
      capabilities: this.client.getServerCapabilities(),
      transportShape: this.transportShape,
      sessionful: this.sessionful,
      credentialContext: this.cfg.credentialContext
    };
  }

  /**
   * `'sse'` when ANY observed MCP response was SSE-framed, else `'json'`.
   * A transport we cannot observe at the HTTP layer (in-memory, stdio) reports
   * `'json'`: one envelope per response is what `'json'` means for scoring.
   */
  get transportShape(): 'sse' | 'json' {
    return this._httpObservations.some((o) => (o.contentType ?? '').includes('text/event-stream')) ? 'sse' : 'json';
  }

  /** Session-ful when the server ever minted an `mcp-session-id`. */
  get sessionful(): boolean {
    return this.transport.sessionId !== undefined || this._httpObservations.some((o) => o.sessionId !== null);
  }

  get httpObservations(): readonly HttpObservation[] {
    return this._httpObservations;
  }

  /**
   * The PUBLIC (credential-stripped) endpoint, or `null` for non-HTTP
   * transports; probes that need raw fetch must degrade on null. This is a
   * capability check and a display value: requests go to `cfg.wireUrl` inside
   * `rawJsonRpc` / `releaseRawSession`, never to this.
   */
  get httpUrl(): string | null {
    return this.cfg.url;
  }

  get clientInfo(): ClientInfo {
    return this.cfg.clientInfo;
  }

  get credentialContext(): CredentialContext {
    return this.cfg.credentialContext;
  }

  get era(): ProtocolEra {
    return this.client.getProtocolEra() ?? 'legacy';
  }

  get negotiatedVersion(): string | null {
    return this.client.getNegotiatedProtocolVersion() ?? null;
  }

  get sessionId(): string | undefined {
    if (this.transport.sessionId !== undefined) return this.transport.sessionId;
    for (let i = this._httpObservations.length - 1; i >= 0; i -= 1) {
      const observed = this._httpObservations[i]?.sessionId;
      if (observed != null) return observed;
    }
    return undefined;
  }

  // -- frames --------------------------------------------------------------

  get correlationId(): string | undefined {
    return this._corrId;
  }

  /** Stamp subsequent frames with this taskId (DESIGN decision 5). */
  setCorrelationId(corrId: string | undefined): void {
    this._corrId = corrId;
  }

  nowIso(): string {
    return this.cfg.now().toISOString();
  }

  /**
   * Surface a frame the SDK did not produce (raw-fetch probes). Public because
   * probes.ts must route its deliberately-malformed requests through the same
   * recorder as everything else.
   */
  emitFrame(dir: FrameDirection, raw: unknown, observedIso?: string): void {
    this.cfg.onFrame?.(dir, freezeFrame(raw), observedIso ?? this.nowIso(), this._corrId);
  }

  /** Verbatim `result` of the most recent response to `method`, as it hit the wire. */
  lastRawResult(method: string): unknown {
    return this._lastRawResult.get(method);
  }

  /** Verbatim JSON-RPC `error` of the most recent failed response to `method`. */
  lastRawError(method: string): unknown {
    return this._lastRawError.get(method);
  }

  /** Count of outbound requests seen for `method` (MRTR fresh-id accounting). */
  outboundIdsFor(method: string): readonly (string | number)[] {
    return this._outboundIds.filter((entry) => entry.method === method).map((entry) => entry.id);
  }

  /**
   * @internal Wired by {@link connect}: index the frame for `lastRawResult`
   * pairing, then hand it to the caller's hook with its observed timestamp.
   */
  _observeFrame(dir: FrameDirection, raw: unknown, observedIso: string): void {
    if (isRecord(raw)) {
      const id = raw['id'];
      if (dir === 'out' && typeof raw['method'] === 'string' && (typeof id === 'string' || typeof id === 'number')) {
        this._requestMethodById.set(String(id), raw['method']);
        this._outboundIds.push({ id, method: raw['method'] });
        if (this._outboundIds.length > 1024) this._outboundIds.splice(0, 512);
      } else if (dir === 'in' && (typeof id === 'string' || typeof id === 'number')) {
        const method = this._requestMethodById.get(String(id));
        if (method !== undefined) {
          if ('result' in raw) this._lastRawResult.set(method, raw['result']);
          if ('error' in raw) this._lastRawError.set(method, raw['error']);
        }
      }
    }
    this.cfg.onFrame?.(dir, raw, observedIso, this._corrId);
  }

  // -- requests ------------------------------------------------------------

  /**
   * `_meta` for an outgoing request. On the modern era we inject
   * `io.modelcontextprotocol/logLevel`; the SDK auto-attaches the reserved
   * envelope keys around it and user-supplied keys win, so this is purely
   * additive. The legacy era has no such vocabulary and gets nothing.
   */
  metaFor(extra?: Record<string, unknown>): Record<string, unknown> | undefined {
    const meta: Record<string, unknown> = { ...extra };
    if (this.era === 'modern' && this.cfg.logLevel !== null) meta[LOG_LEVEL_META_KEY] = this.cfg.logLevel;
    return Object.keys(meta).length === 0 ? undefined : meta;
  }

  private requestOptions(): { timeout?: number } {
    return this.cfg.timeoutMs === undefined ? {} : { timeout: this.cfg.timeoutMs };
  }

  /**
   * `tools/list` with cacheMode discipline. Defaults to `'bypass'`: the SDK
   * response cache is ON by default and a cached tool surface silently defeats
   * every drift probe (DESIGN decision 8). Use `'refresh'` when you need fresh
   * bytes AND the cached `tools/list` index that `callTool()`'s outputSchema
   * validation reads - `'bypass'` skips cache WRITES too.
   */
  async listTools(opts: { cacheMode?: CacheMode } = {}): Promise<ListToolsResult> {
    const cacheMode: CacheMode = opts.cacheMode ?? 'bypass';
    const meta = this.metaFor();
    return await this.client.listTools(meta === undefined ? undefined : { _meta: meta }, {
      ...this.requestOptions(),
      cacheMode
    });
  }

  /**
   * One `tools/call`. Manual MRTR: an `input_required` answer is handed back
   * rather than auto-fulfilled, so every round stays a frame the agent authored.
   * Routed through `client.callTool` so SDK outputSchema validation still runs -
   * a rejection there is a SERVER finding (`schema-validation-reject`), never
   * attributed to the agent (DESIGN decision 9).
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    opts: { toolDefinition?: Tool } = {}
  ): Promise<ToolCallOutcome> {
    const meta = this.metaFor();
    const params = { name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) };
    const result = (await this.client.callTool(params, {
      ...this.requestOptions(),
      allowInputRequired: true,
      ...(opts.toolDefinition === undefined ? {} : { toolDefinition: opts.toolDefinition })
    })) as unknown;
    if (isInputRequiredResult(result)) {
      return {
        kind: 'input_required',
        inputRequests: (result.inputRequests ?? {}) as Record<string, unknown>,
        requestState: result.requestState
      };
    }
    return { kind: 'result', result: result as CallToolResult, rounds: [] };
  }

  /**
   * The manual multi-round-trip drive surface (DESIGN decision 8).
   *
   * Each round re-enters the request funnel, which allocates a FRESH JSON-RPC id
   * per leg, and the opaque `requestState` string received from the server is
   * passed back by reference - never re-encoded - so the echo is byte-exact.
   * The caller answers each round; returning `undefined` abandons the call.
   * Exceeding `maxRounds` yields `mrtr-abandoned`, which the scorer maps to the
   * `mrtr-abandoned` failure class.
   *
   * Uses the raw request funnel rather than `callTool()` because `callTool()`
   * asserts "outputSchema declared but no structuredContent" on any non-final
   * answer, which an `input_required` round legitimately is.
   */
  async driveToolCall(
    name: string,
    args: Record<string, unknown>,
    answer: MrtrAnswerer,
    opts: { maxRounds?: number } = {}
  ): Promise<ToolCallOutcome> {
    const maxRounds = opts.maxRounds ?? this.cfg.maxMrtrRounds;
    const rounds: MrtrRoundRecord[] = [];
    const meta = this.metaFor();
    let params: Record<string, unknown> = {
      name,
      arguments: args,
      ...(meta === undefined ? {} : { _meta: meta })
    };

    for (let round = 1; round <= maxRounds + 1; round += 1) {
      const before = this.outboundIdsFor('tools/call').length;
      const result = (await this.client.request({ method: 'tools/call', params }, {
        ...this.requestOptions(),
        allowInputRequired: true
      })) as unknown;
      const issued = this.outboundIdsFor('tools/call');
      const requestId = issued.length > before ? issued[issued.length - 1] : undefined;

      if (!isInputRequiredResult(result)) return { kind: 'result', result: result as CallToolResult, rounds };

      const record: MrtrRoundRecord = {
        round,
        inputRequests: (result.inputRequests ?? {}) as Record<string, unknown>,
        requestState: result.requestState,
        requestId
      };
      rounds.push(record);

      if (round > maxRounds) return { kind: 'mrtr-abandoned', reason: 'round-cap', rounds };

      const responses = await answer(record);
      if (responses === undefined) return { kind: 'mrtr-abandoned', reason: 'caller-declined', rounds };

      params = {
        ...params,
        // Mirrors the SDK's own retry-param builder: an empty answer map is
        // omitted rather than sent as `{}`.
        ...(Object.keys(responses).length === 0 ? {} : { inputResponses: responses }),
        // Byte-exact echo: the same immutable string, never re-serialised.
        ...(record.requestState === undefined ? {} : { requestState: record.requestState })
      };
    }
    return { kind: 'mrtr-abandoned', reason: 'round-cap', rounds };
  }

  // -- raw probe path ------------------------------------------------------

  /**
   * Send one hand-built JSON-RPC request over raw `fetch`. Used ONLY where the
   * SDK cannot express a deliberately malformed request (a bogus
   * `protocolVersion`, a mismatched `Mcp-Name`). The outbound envelope is
   * surfaced through `onFrame`; the inbound envelope too, whenever the response
   * body actually carries one.
   *
   * @throws when the connection has no HTTP endpoint (in-memory / stdio).
   */
  async rawJsonRpc(
    body: Record<string, unknown>,
    opts: { headers?: Record<string, string>; httpMethod?: string } = {}
  ): Promise<RawExchange> {
    // The WIRE url: a probe that posts to the credential-stripped copy loses
    // any `?api_key=` the host requires and measures the gateway, not the
    // server. Only `this.cfg.url` (stripped) is ever recorded.
    const url = this.cfg.wireUrl;
    if (url === null) throw new Error('rawJsonRpc requires an HTTP endpoint; this connection has none');

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.cfg.headers,
      ...(this.cfg.authToken === undefined ? {} : { authorization: `Bearer ${this.cfg.authToken}` }),
      ...opts.headers
    };

    this.emitFrame('out', body);

    const response = await this.cfg.fetchImpl(url, {
      method: opts.httpMethod ?? 'POST',
      headers,
      body: JSON.stringify(body)
    });

    const contentType = response.headers.get('content-type');
    const sessionId = response.headers.get('mcp-session-id');
    const bodyText = await response.text();

    let envelope: Record<string, unknown> | undefined;
    if ((contentType ?? '').includes('text/event-stream')) {
      const parsed = parseSseData(bodyText);
      if (isJsonRpcEnvelope(parsed)) envelope = parsed;
    } else {
      try {
        const parsed: unknown = JSON.parse(bodyText);
        if (isJsonRpcEnvelope(parsed)) envelope = parsed;
      } catch {
        /* not JSON: reported through RawExchange, never faked into a frame */
      }
    }

    const observedIso = this.nowIso();
    // The observation is published evidence: record the stripped url, never the
    // one that carries the credential.
    this._httpObservations.push({
      url: this.cfg.url ?? url,
      status: response.status,
      contentType,
      sessionId,
      observedIso
    });
    if (envelope !== undefined) this.emitFrame('in', envelope, observedIso);

    const headerBag: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headerBag[key.toLowerCase()] = value;
    });

    return { status: response.status, headers: headerBag, bodyText, envelope, contentType, sessionId };
  }

  /** Best-effort session teardown for a session-ful server a raw probe woke up. */
  async releaseRawSession(sessionId: string): Promise<void> {
    // Wire url again: a DELETE to the stripped copy is refused on any host that
    // authenticates by query string, so the session a probe minted would leak.
    const url = this.cfg.wireUrl;
    if (url === null) return;
    try {
      await this.cfg.fetchImpl(url, {
        method: 'DELETE',
        headers: {
          'mcp-session-id': sessionId,
          ...(this.cfg.authToken === undefined ? {} : { authorization: `Bearer ${this.cfg.authToken}` })
        }
      });
    } catch {
      /* a server that refuses DELETE is not a finding; it is a courtesy call */
    }
  }

  // -- lifecycle -----------------------------------------------------------

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    try {
      await this.client.close();
    } catch {
      /* a server that drops the socket first is not an eval failure */
    }
  }
}

// ---------------------------------------------------------------------------
// connect()
// ---------------------------------------------------------------------------

/** Thrown when the handshake fails; carries what we know for era forensics. */
export class McpConnectError extends Error {
  constructor(
    message: string,
    readonly detail: {
      url: string | null;
      /** Last HTTP status observed, when any. */
      lastStatus: number | null;
      /**
       * Whether the failure may be read as era evidence at all. DESIGN decision
       * 2: 401/403 and 5xx never are; a 400 may be, after inspecting the body
       * for a modern JSON-RPC error.
       */
      eraEvidence: boolean;
      cause: unknown;
    }
  ) {
    super(message);
    this.name = 'McpConnectError';
  }
}

/**
 * Open a connection, negotiate the era, and record everything the run record
 * needs. `mode: 'auto'` by default; pass `pin` for the separate
 * modern-conformance signal (DESIGN decision 2).
 */
export async function connect(cfg: ConnectConfig): Promise<McpConnection> {
  const now = cfg.now ?? ((): Date => new Date());
  const clientInfo = cfg.clientInfo ?? DEFAULT_CLIENT_INFO;
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const strippedUrl = cfg.url === undefined ? null : stripCredentials(cfg.url);
  const slug = cfg.slug ?? (cfg.url === undefined ? 'inproc' : slugFromUrl(cfg.url));
  const credentialContext: CredentialContext =
    cfg.credentialContext ?? (cfg.authToken === undefined ? 'anonymous' : 'free-key');
  const headers: Record<string, string> = { ...cfg.headers };
  const observations: HttpObservation[] = [];

  const mode: VersionNegotiationMode = cfg.versionMode ?? (cfg.pin === undefined ? 'auto' : { pin: cfg.pin });

  const client = new Client(clientInfo, {
    capabilities: cfg.capabilities ?? DEFAULT_CLIENT_CAPABILITIES,
    versionNegotiation: { mode },
    // DESIGN decision 8: auto-fulfil MUST be off so every MRTR round is a frame
    // the agent authored, on a fresh id, with a byte-exact requestState echo.
    inputRequired: { autoFulfill: false }
  });

  const resolved: ResolvedConfig = {
    wireUrl: cfg.url ?? null,
    url: strippedUrl,
    slug,
    credentialContext,
    onFrame: cfg.onFrame,
    now,
    clientInfo,
    logLevel: cfg.logLevel === undefined ? 'debug' : cfg.logLevel,
    timeoutMs: cfg.timeoutMs,
    headers,
    authToken: cfg.authToken,
    fetchImpl,
    maxMrtrRounds: cfg.maxMrtrRounds ?? 8
  };

  let innerTransport: Transport;
  if (cfg.transport !== undefined) {
    innerTransport = cfg.transport;
  } else {
    if (cfg.url === undefined) throw new Error('connect() needs either a url or a transport');
    const target = strippedUrl ?? cfg.url;
    const instrumentedFetch: typeof fetch = async (input, init) => {
      const response = await fetchImpl(input, init);
      observations.push({
        // Stripped: an HttpObservation reaches the report.
        url: target,
        status: response.status,
        contentType: response.headers.get('content-type'),
        sessionId: response.headers.get('mcp-session-id'),
        observedIso: now().toISOString()
      });
      return response;
    };
    innerTransport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      fetch: instrumentedFetch,
      requestInit: {
        headers: {
          ...headers,
          ...(cfg.authToken === undefined ? {} : { authorization: `Bearer ${cfg.authToken}` })
        }
      }
    });
  }

  // The connection object exists BEFORE the handshake so the negotiation frames
  // (server/discover probe, initialize) are surfaced with their own observed
  // timestamps rather than replayed later at some other clock reading.
  const connRef: { conn: McpConnection | undefined } = { conn: undefined };
  const emit = (dir: FrameDirection, raw: unknown): void => {
    connRef.conn?._observeFrame(dir, freezeFrame(raw), now().toISOString());
  };
  const framing = new FrameCapturingTransport(innerTransport, emit);

  const conn = new McpConnection(client, resolved, framing, observations, cfg.corrId);
  connRef.conn = conn;

  try {
    await client.connect(framing, cfg.timeoutMs === undefined ? undefined : { timeout: cfg.timeoutMs });
  } catch (cause) {
    const lastStatus = observations.length === 0 ? null : (observations[observations.length - 1]?.status ?? null);
    // DESIGN decision 2: 401/403 and 5xx are never era evidence.
    const eraEvidence = lastStatus !== null && lastStatus !== 401 && lastStatus !== 403 && lastStatus < 500;
    await framing.close().catch(() => undefined);
    throw new McpConnectError(
      `MCP connect failed for ${strippedUrl ?? slug}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { url: strippedUrl, lastStatus, eraEvidence, cause }
    );
  }

  return conn;
}
