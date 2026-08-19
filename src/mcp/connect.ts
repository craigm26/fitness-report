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
 *
 * ## HTTP-layer failures: the second hook
 *
 * Some servers fail BELOW JSON-RPC. The aws-knowledge gateway advertises five
 * tools and answers `initialize` and `tools/list` normally, then answers every
 * `tools/call` with a bare HTTP 400 whose body is the prose string
 * `"Http operation is not supported for gateway protocol type MCP"`. No JSON-RPC
 * envelope is ever produced, so `onFrame` has nothing to emit: the transport
 * throws out of `send()` and the tape shows a request with no response and no
 * explanation. Five tools, sixteen dead calls, and a recording that cannot say
 * why.
 *
 * The fix is a SECOND hook, {@link EventHook}, wired as `onEvent`. It carries
 * harness-native events (`kind: 'fitness.http_error'`), never JSON-RPC, and the
 * two hooks stay separate on purpose:
 *
 *   - `onFrame` frames are JSON-RPC and get direction-flipped by the recorder
 *     on the way to the tape (transport `'out'` is tape `'in'`). An event fed
 *     through that seam would be flipped into a fake protocol frame and enter
 *     request/response pairing as a phantom call.
 *   - `onEvent` lines land as `dir:'event'` with a `kind`, per DESIGN decision 5
 *     and docs/format-extensions.md §2, and are ignored by every pairing model.
 *
 * The payload (see {@link HttpErrorEvent}) carries the method, the tool name
 * when there was one, the HTTP status, a <=300 character snippet of the response
 * body verbatim, and the thrown message. The snippet is deliberately raw: it is
 * the only evidence of what the gateway actually said, and it is redacted at
 * PUBLISH time along with every other line (src/tape/redact.ts), never here.
 */

import {
  Client,
  LOG_LEVEL_META_KEY,
  SdkHttpError,
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

/**
 * Called for every HARNESS-NATIVE event the connection emits. Deliberately a
 * separate seam from {@link FrameHook}: these lines are written as
 * `dir:'event'` with a `kind` and must never be flipped into, or paired as,
 * JSON-RPC (DESIGN decision 5).
 *
 * @param kind        Event kind, e.g. {@link HTTP_ERROR_EVENT}.
 * @param raw         Producer-defined payload (deep-cloned before it leaves).
 * @param observedIso Observed ISO timestamp, read at the moment of the event.
 * @param corrId      The active correlation id (taskId), when one is set.
 */
export type EventHook = (kind: string, raw: unknown, observedIso: string, corrId?: string) => void;

/** `kind` of the event emitted when a request dies below the JSON-RPC layer. */
export const HTTP_ERROR_EVENT = 'fitness.http_error';

/** Hard cap on the recorded body snippet. Evidence, not a log sink. */
export const HTTP_ERROR_BODY_SNIPPET_MAX = 300;

/**
 * Payload of a {@link HTTP_ERROR_EVENT} line. Every field is what the failure
 * itself said; nothing is inferred.
 */
export interface HttpErrorEvent {
  /** JSON-RPC method that was in flight (`tools/call`, `tools/list`, ...). */
  method: string;
  /** Present when the failing request was a `tools/call`. */
  toolName?: string;
  /** HTTP status, when the failure carried one (absent for a dead socket). */
  status?: number;
  /** Verbatim response body, truncated to {@link HTTP_ERROR_BODY_SNIPPET_MAX}. */
  bodySnippet: string;
  /** The thrown error's message. */
  message: string;
}

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
  /**
   * Harness-native event hook. See {@link EventHook}. Without it an HTTP-layer
   * failure is invisible: the request frame is on the tape and nothing follows
   * it.
   */
  onEvent?: EventHook;
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

// ---------------------------------------------------------------------------
// HTTP-layer failure classification
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `<= max` characters, with the elision marked so a reader is never fooled. */
export function bodySnippet(body: string, max: number = HTTP_ERROR_BODY_SNIPPET_MAX): string {
  if (body.length <= max) return body;
  return `${body.slice(0, max - 1)}…`;
}

/**
 * The SDK's own transport-failure message shapes, verbatim from
 * StreamableHTTPClientTransport: `Error POSTing to endpoint (HTTP <n>): <body>`
 * and `Error POSTing to endpoint: <body>`. Matching this is how a plain `Error`
 * thrown by the transport is told apart from an arbitrary error whose text
 * happens to mention a status.
 */
const SDK_TRANSPORT_MESSAGE = /Error POSTing to endpoint(?: \(HTTP (\d{3})\))?:/;

/**
 * A JSON-RPC error response, which the tape already carries as an inbound
 * frame. `ProtocolError.code` is a NUMBER (the JSON-RPC code); `SdkError.code`
 * is a string enum, so this never catches an SDK-side failure.
 */
function isJsonRpcErrorResponse(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' && Number.isFinite(code);
}

/**
 * HTTP status carried by a thrown TRANSPORT error, when it carried one.
 *
 * Only ever called on an error already known to be transport-level. It used to
 * scrape `/\bHTTP (\d{3})\b/` out of any message, which turned a doc-proxy's
 * `MCP error -32603: Upstream returned HTTP 502 while fetching the doc` into a
 * fabricated HTTP-layer death with a status this client never observed. The
 * message path now reads only the status the SDK itself formats, in its own
 * message shape.
 */
function statusOf(error: unknown): number | undefined {
  const direct = (error as { status?: unknown } | null)?.status;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const data = (error as { data?: unknown } | null)?.data;
  if (isRecord(data) && typeof data['status'] === 'number' && Number.isFinite(data['status'])) {
    return data['status'];
  }
  const parsed = SDK_TRANSPORT_MESSAGE.exec(describeError(error));
  return parsed?.[1] === undefined ? undefined : Number(parsed[1]);
}

/**
 * The response body, verbatim. `SdkHttpError` carries it on `data.text`; when a
 * different transport threw, the SDK's own message shape
 * (`Error POSTing to endpoint: <body>`) is the fallback.
 */
function bodyOf(error: unknown): string {
  const data = (error as { data?: unknown } | null)?.data;
  if (isRecord(data)) {
    for (const key of ['text', 'body', 'bodyText'] as const) {
      const value = data[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  const parsed = /Error POSTing to endpoint(?: \(HTTP \d{3}\))?:\s*([\s\S]+)$/.exec(describeError(error));
  return parsed?.[1] ?? '';
}

/** Undici and friends report a dead socket through `cause.code`. */
const NETWORK_CAUSE = /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_)/;

function isNetworkFailure(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const code = isRecord(cause) ? cause['code'] : undefined;
  if (typeof code === 'string' && NETWORK_CAUSE.test(code)) return true;
  return error instanceof TypeError && /fetch failed|network|terminated|socket/i.test(error.message);
}

/**
 * Classify a thrown error as an HTTP-LAYER failure (the transport died before
 * any JSON-RPC envelope existed) or not.
 *
 * Returns `null` for everything the recording already explains: a JSON-RPC
 * error response is an inbound frame on the tape, an outputSchema rejection is
 * a `schema-validation-reject` finding raised from a well-formed result, and a
 * request timeout is a client-side deadline rather than something the server
 * said. Only failures with NO envelope behind them earn an event, because those
 * are the ones the tape cannot otherwise account for.
 *
 * EVERY FIELD IS WHAT THE FAILURE ITSELF SAID, and the classification is gated
 * on evidence that the transport really died: an `SdkHttpError`, the SDK's own
 * `Error POSTing to endpoint` message shape, or a dead socket. Anything else is
 * left alone, however status-shaped its text. A doc proxy (gitmcp, deepwiki,
 * exa, coingecko are all this shape) answers a failed upstream fetch with a
 * perfectly ordinary JSON-RPC error whose MESSAGE names an HTTP status; the
 * envelope is on the tape, and inventing a `fitness.http_error` beside it
 * asserts a second, unfalsifiable account of the same failure with a status
 * this client never observed. `data.status` on an error that carries a numeric
 * JSON-RPC code is the same trap and is ignored for the same reason.
 */
export function httpLayerFailure(error: unknown): { status?: number; bodySnippet: string; message: string } | null {
  if (error === null || typeof error !== 'object') return null;
  const message = describeError(error);
  const sdkHttp = SdkHttpError.isInstance(error);
  if (!sdkHttp && isJsonRpcErrorResponse(error)) return null;
  if (sdkHttp || SDK_TRANSPORT_MESSAGE.test(message)) {
    const status = statusOf(error);
    // An SdkHttpError is an HTTP failure by construction. A transport-shaped
    // message earns the event only when it also names a 4xx/5xx, because the
    // SDK uses the same wording for failures that never got a status at all.
    if (sdkHttp || (status !== undefined && status >= 400 && status <= 599)) {
      return {
        ...(status === undefined ? {} : { status }),
        bodySnippet: bodySnippet(bodyOf(error)),
        message
      };
    }
  }
  // A socket that never answered is the same blind spot with no status to show.
  if (isNetworkFailure(error)) return { bodySnippet: '', message };
  return null;
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
  onEvent: EventHook | undefined;
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

  /**
   * Surface a harness-native event. Lands on the tape as `dir:'event'` with
   * this `kind`, NEVER as a JSON-RPC message line (DESIGN decision 5).
   */
  emitEvent(kind: string, raw: unknown, observedIso?: string): void {
    this.cfg.onEvent?.(kind, freezeFrame(raw), observedIso ?? this.nowIso(), this._corrId);
  }

  /**
   * Record an HTTP-layer failure as a {@link HTTP_ERROR_EVENT} line and return
   * the payload, or `null` when the error was not one (the caller then just
   * rethrows and the existing JSON-RPC evidence stands).
   *
   * Called from every request path, because this is the ONE failure mode the
   * two tapes cannot otherwise describe: the outbound frame is recorded, the
   * transport throws below JSON-RPC, and no inbound frame ever exists.
   */
  noteHttpError(method: string, toolName: string | undefined, error: unknown): HttpErrorEvent | null {
    const failure = httpLayerFailure(error);
    if (failure === null) return null;
    const payload: HttpErrorEvent = {
      method,
      ...(toolName === undefined ? {} : { toolName }),
      ...(failure.status === undefined ? {} : { status: failure.status }),
      bodySnippet: failure.bodySnippet,
      message: failure.message
    };
    // Observed time, read now: this is when the failure crossed the seam.
    this.emitEvent(HTTP_ERROR_EVENT, payload);
    return payload;
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
    try {
      return await this.client.listTools(meta === undefined ? undefined : { _meta: meta }, {
        ...this.requestOptions(),
        cacheMode
      });
    } catch (error) {
      this.noteHttpError('tools/list', undefined, error);
      throw error;
    }
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
    let result: unknown;
    try {
      result = (await this.client.callTool(params, {
        ...this.requestOptions(),
        allowInputRequired: true,
        ...(opts.toolDefinition === undefined ? {} : { toolDefinition: opts.toolDefinition })
      })) as unknown;
    } catch (error) {
      // A gateway that 400s every tools/call (aws-knowledge) throws here with
      // no envelope behind it. Record what it said, then let the caller's own
      // failure classification run: the throw is still the caller's to handle.
      this.noteHttpError('tools/call', name, error);
      throw error;
    }
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
      let result: unknown;
      try {
        result = (await this.client.request({ method: 'tools/call', params }, {
          ...this.requestOptions(),
          allowInputRequired: true
        })) as unknown;
      } catch (error) {
        this.noteHttpError('tools/call', name, error);
        throw error;
      }
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

    const method = typeof body['method'] === 'string' ? body['method'] : 'raw';
    let response: Response;
    try {
      response = await this.cfg.fetchImpl(url, {
        method: opts.httpMethod ?? 'POST',
        headers,
        body: JSON.stringify(body)
      });
    } catch (error) {
      // A probe whose fetch never came back leaves the same silent gap: an
      // outbound frame with nothing after it. A NON-throwing error status is
      // deliberately not an event; it comes back as RawExchange and the probe
      // renders it as ProbeFinding.evidence.
      this.noteHttpError(method, undefined, error);
      throw error;
    }

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
    onEvent: cfg.onEvent,
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
    // A handshake that died below JSON-RPC gets the same event as a tool call
    // that did: the buffered frames show the attempt, this shows what came back.
    conn.noteHttpError('initialize', undefined, cause);
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
