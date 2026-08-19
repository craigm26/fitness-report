/**
 * Deterministic transport probes (DESIGN decision 14). Zero tokens, no model,
 * run FIRST - they are part of the FREE gate tier (decision 11).
 *
 * Every probe returns a {@link ProbeFinding}. `pass: null` is a first-class
 * value meaning "could not check" and MUST render as such: a probe that cannot
 * run is never silently a pass, and never silently a fail.
 *
 * Probes use the SDK wherever the SDK can express the request. Raw `fetch` is
 * used ONLY where the request is deliberately malformed and the SDK would
 * (correctly) refuse to build it - a bogus `protocolVersion`, a mismatched
 * `Mcp-Name`. Every such request still goes through
 * {@link McpConnection.rawJsonRpc}, so it lands in the tape like anything else.
 */

import type { ProbeFinding, ProbeResults } from '../types.js';
import { MODERN_PROTOCOL_VERSION, isModernRevision, type McpConnection } from './connect.js';

/** The protocol revision no server can legitimately support. */
export const BOGUS_PROTOCOL_VERSION = '1999-01-01';

/** A tool name no server can have registered, so a rejected probe has no side effects. */
export const PROBE_TOOL_NAME = '__fitness_report_probe_tool__';

/** The value we put in `Mcp-Name`, guaranteed to disagree with the body. */
export const PROBE_MISMATCHED_NAME = '__fitness_report_mismatched_name__';

/** JSON-RPC error code for a header/body disagreement (SEP-2243 `HEADER_MISMATCH`). */
export const HEADER_MISMATCH_CODE = -32020;

const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';

export interface ProbeConfig {
  /** Probe ids to skip (e.g. on a server the operator flagged as fragile). */
  skip?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `401`/`403`/`5xx` tell us about auth and outages, never about hygiene or era. */
function statusIsInconclusive(status: number): boolean {
  return status === 401 || status === 403 || status >= 500;
}

function errorOf(envelope: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const error = envelope?.['error'];
  return isRecord(error) ? error : undefined;
}

function resultOf(envelope: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const result = envelope?.['result'];
  return isRecord(result) ? result : undefined;
}

function couldNotCheck(id: string, detail: string, evidence?: unknown): ProbeFinding {
  return { id, pass: null, detail, ...(evidence === undefined ? {} : { evidence }) };
}

// ---------------------------------------------------------------------------
// spec-currency
// ---------------------------------------------------------------------------

/**
 * Which protocol revision the connection actually negotiated. A legacy
 * negotiation is not a conformance failure - the 2025 revisions are still
 * valid - but it IS the currency signal the leaderboard column reports.
 */
export function probeSpecCurrency(conn: McpConnection): ProbeFinding {
  const version = conn.negotiatedVersion;
  if (version === null) {
    return couldNotCheck('spec-currency', 'connected but the SDK reported no negotiated protocol version');
  }
  const modern = isModernRevision(version);
  return {
    id: 'spec-currency',
    pass: modern,
    detail: modern
      ? `negotiated ${version} (modern era, >= ${MODERN_PROTOCOL_VERSION})`
      : `negotiated ${version} (legacy era; the current revision is ${MODERN_PROTOCOL_VERSION})`,
    evidence: { negotiatedVersion: version, era: conn.era }
  };
}

// ---------------------------------------------------------------------------
// bogus-version acceptance
// ---------------------------------------------------------------------------

/**
 * Offer `initialize` a protocol version that cannot exist. A hygienic server
 * either rejects it or counter-offers a version it does support; a server that
 * echoes `1999-01-01` back has no version validation at all and FAILS.
 *
 * Deliberately driven on the LEGACY path via raw `fetch`: the SDK will not
 * build an `initialize` for an unsupported revision, and a modern-only endpoint
 * answering with the unsupported-protocol-version error is itself a pass.
 */
export async function probeBogusVersion(conn: McpConnection): Promise<ProbeFinding> {
  const id = 'bogus-version-accepted';
  if (conn.httpUrl === null) {
    return couldNotCheck(id, 'could not check: this connection has no HTTP endpoint (in-memory or stdio transport)');
  }

  const exchange = await conn.rawJsonRpc({
    jsonrpc: '2.0',
    id: 'fitness-probe-bogus-version',
    method: 'initialize',
    params: {
      protocolVersion: BOGUS_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: conn.clientInfo
    }
  });

  // Release the session this probe minted - but never one that is our own
  // (a server that hands every caller the same session id would otherwise have
  // its live connection torn down by its own hygiene probe).
  if (exchange.sessionId !== null && exchange.sessionId !== conn.sessionId) {
    await conn.releaseRawSession(exchange.sessionId);
  }

  const evidence = {
    status: exchange.status,
    offered: BOGUS_PROTOCOL_VERSION,
    envelope: exchange.envelope,
    bodySnippet: exchange.envelope === undefined ? exchange.bodyText.slice(0, 400) : undefined
  };

  // The status check comes FIRST, exactly as probeModernHeaderConformance does
  // it. An auth gateway that answers 401 with a JSON-RPC error body never let
  // the initialize reach the target server, so reading that error as "the
  // server rejected the bogus version" credits the target with hygiene our own
  // gateway performed.
  if (statusIsInconclusive(exchange.status)) {
    return couldNotCheck(
      id,
      `could not check: the server answered HTTP ${exchange.status} (auth or outage, never hygiene evidence)`,
      evidence
    );
  }

  if (exchange.envelope === undefined) {
    return couldNotCheck(
      id,
      `could not check: the server answered HTTP ${exchange.status} with a body that is not a JSON-RPC envelope`,
      evidence
    );
  }

  const error = errorOf(exchange.envelope);
  if (error !== undefined) {
    return {
      id,
      pass: true,
      detail: `rejected the bogus protocolVersion ${BOGUS_PROTOCOL_VERSION} with JSON-RPC error ${String(error['code'])}`,
      evidence
    };
  }

  const result = resultOf(exchange.envelope);
  const answered = result?.['protocolVersion'];
  if (typeof answered !== 'string') {
    return couldNotCheck(
      id,
      'could not check: the initialize result carried no protocolVersion string',
      evidence
    );
  }
  if (answered === BOGUS_PROTOCOL_VERSION) {
    return {
      id,
      pass: false,
      detail: `ACCEPTED protocolVersion ${BOGUS_PROTOCOL_VERSION} and echoed it back: the server does not validate the negotiated revision at all`,
      evidence: { ...evidence, answeredVersion: answered }
    };
  }
  return {
    id,
    pass: true,
    detail: `counter-offered ${answered} instead of the bogus ${BOGUS_PROTOCOL_VERSION}`,
    evidence: { ...evidence, answeredVersion: answered }
  };
}

// ---------------------------------------------------------------------------
// modern header conformance
// ---------------------------------------------------------------------------

/**
 * SEP-2243: on a modern connection over Streamable HTTP the `Mcp-Name` header
 * mirrors the body's `params.name`, and a disagreement MUST be rejected with
 * HTTP 400 / JSON-RPC `-32020`. We send a well-formed enveloped `tools/call`
 * whose header names a different tool than the body.
 *
 * The body names a tool that cannot exist, so a server that skips the check
 * still performs no side effect - it just answers something other than -32020,
 * which is the finding.
 *
 * Legacy era: `pass: null`, could-not-check. The 2025 revision has no such
 * headers, so there is nothing to conform to.
 */
export async function probeModernHeaderConformance(conn: McpConnection): Promise<ProbeFinding> {
  const id = 'header-mismatch-accepted';
  if (conn.era !== 'modern') {
    return couldNotCheck(
      id,
      `could not check: SEP-2243 header conformance is defined on the modern era only; this connection negotiated ${conn.negotiatedVersion ?? 'an unknown revision'} (legacy)`
    );
  }
  if (conn.httpUrl === null) {
    return couldNotCheck(
      id,
      'could not check: SEP-2243 headers exist only on Streamable HTTP; this connection has no HTTP endpoint'
    );
  }
  const version = conn.negotiatedVersion;
  if (version === null) {
    return couldNotCheck(id, 'could not check: no negotiated protocol version to put in the envelope');
  }

  const sessionId = conn.sessionId;
  const exchange = await conn.rawJsonRpc(
    {
      jsonrpc: '2.0',
      id: 'fitness-probe-header-mismatch',
      method: 'tools/call',
      params: {
        name: PROBE_TOOL_NAME,
        arguments: {},
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: version,
          [CLIENT_INFO_META_KEY]: conn.clientInfo,
          [CLIENT_CAPABILITIES_META_KEY]: {}
        }
      }
    },
    {
      headers: {
        'mcp-protocol-version': version,
        'mcp-method': 'tools/call',
        // The whole point: this disagrees with params.name in the body.
        'mcp-name': PROBE_MISMATCHED_NAME,
        ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId })
      }
    }
  );

  const error = errorOf(exchange.envelope);
  const code = typeof error?.['code'] === 'number' ? (error['code'] as number) : undefined;
  const evidence = {
    status: exchange.status,
    jsonRpcErrorCode: code,
    headerName: PROBE_MISMATCHED_NAME,
    bodyName: PROBE_TOOL_NAME,
    envelope: exchange.envelope,
    bodySnippet: exchange.envelope === undefined ? exchange.bodyText.slice(0, 400) : undefined
  };

  if (statusIsInconclusive(exchange.status)) {
    return couldNotCheck(
      id,
      `could not check: the server answered HTTP ${exchange.status} (auth or outage, never conformance evidence)`,
      evidence
    );
  }
  if (exchange.status === 400 && code === HEADER_MISMATCH_CODE) {
    return {
      id,
      pass: true,
      detail: `rejected the mismatched Mcp-Name with HTTP 400 / JSON-RPC ${HEADER_MISMATCH_CODE}, as SEP-2243 requires`,
      evidence
    };
  }
  if (code === HEADER_MISMATCH_CODE) {
    return {
      id,
      pass: false,
      detail: `returned JSON-RPC ${HEADER_MISMATCH_CODE} but on HTTP ${exchange.status}; SEP-2243 requires 400`,
      evidence
    };
  }
  return {
    id,
    pass: false,
    detail: `did not enforce the Mcp-Name / params.name cross-check: answered HTTP ${exchange.status}${code === undefined ? ' with no JSON-RPC error' : ` / JSON-RPC ${code}`} instead of 400 / ${HEADER_MISMATCH_CODE}`,
    evidence
  };
}

// ---------------------------------------------------------------------------
// server/discover presence
// ---------------------------------------------------------------------------

/**
 * `server/discover` is a MUST-implement on the modern era; the negotiated
 * connection already proves it, because that is exactly the probe the SDK ran
 * to select the era. We report the recorded {@link DiscoverResult}.
 */
export function probeDiscoverPresent(conn: McpConnection): ProbeFinding {
  const id = 'server-discover-present';
  if (conn.era !== 'modern') {
    return couldNotCheck(
      id,
      `could not check: server/discover is a 2026-07-28 MUST; this connection negotiated ${conn.negotiatedVersion ?? 'an unknown revision'} (legacy)`
    );
  }
  const discover = conn.discoverResult;
  if (discover === undefined) {
    return {
      id,
      pass: false,
      detail: 'negotiated the modern era but no server/discover result was recorded',
      evidence: { rawDiscover: conn.lastRawResult('server/discover') }
    };
  }
  return {
    id,
    pass: true,
    detail: `server/discover answered with supportedVersions [${discover.supportedVersions.join(', ')}]`,
    evidence: {
      supportedVersions: discover.supportedVersions,
      capabilities: discover.capabilities,
      hasInstructions: typeof discover.instructions === 'string' && discover.instructions.length > 0
    }
  };
}

// ---------------------------------------------------------------------------
// ttlMs / cacheScope capture
// ---------------------------------------------------------------------------

/**
 * SEP-2549 cache hints on `tools/list`. Read from the VERBATIM wire result
 * (the SDK lifts these fields off the typed result), fetched with
 * `cacheMode: 'bypass'` so we never read our own cache back.
 *
 * A `public` scope on a list that varies by credential is a cross-tenant cache
 * finding: a shared cache may hand one principal's tool surface to another.
 * We can only assert that when we are NOT anonymous, since an anonymous list is
 * the same for everybody by construction.
 */
export async function probeCacheHints(conn: McpConnection): Promise<ProbeFinding> {
  const id = 'cache-hints';
  if (conn.era !== 'modern') {
    return couldNotCheck(
      id,
      `could not check: ttlMs/cacheScope are 2026-07-28 fields; this connection negotiated ${conn.negotiatedVersion ?? 'an unknown revision'} (legacy)`
    );
  }

  // A tools/list that violates its own schema still put bytes on the wire, and
  // the frame recorder caught them: read the raw result either way, so a
  // schema-rejecting server is not silently exempt from the cache-hint check.
  let listError: unknown;
  try {
    await conn.listTools({ cacheMode: 'bypass' });
  } catch (cause) {
    listError = cause;
  }
  const raw = conn.lastRawResult('tools/list');
  if (!isRecord(raw)) {
    return couldNotCheck(
      id,
      listError === undefined
        ? 'could not check: no tools/list response was observed (the server advertises no tools capability, so the SDK short-circuits)'
        : `could not check: tools/list failed before a result reached the wire (${listError instanceof Error ? listError.message : String(listError)})`
    );
  }

  const ttlMs = typeof raw['ttlMs'] === 'number' ? (raw['ttlMs'] as number) : null;
  const cacheScope = raw['cacheScope'] === 'public' || raw['cacheScope'] === 'private' ? (raw['cacheScope'] as 'public' | 'private') : null;
  const evidence = { ttlMs, cacheScope, credentialContext: conn.credentialContext };

  if (cacheScope === null || ttlMs === null) {
    return {
      id,
      pass: false,
      detail: `tools/list omitted the required SEP-2549 cache hints (ttlMs=${String(ttlMs)}, cacheScope=${String(cacheScope)})`,
      evidence
    };
  }
  if (cacheScope === 'public' && conn.credentialContext !== 'anonymous') {
    return {
      id,
      pass: false,
      detail: `tools/list advertises cacheScope=public (ttlMs=${ttlMs}) on an authenticated connection (${conn.credentialContext}): a shared cache may serve one principal's tool surface to another`,
      evidence
    };
  }
  return {
    id,
    pass: true,
    detail: `tools/list cache hints: ttlMs=${ttlMs}, cacheScope=${cacheScope}`,
    evidence
  };
}

// ---------------------------------------------------------------------------
// deprecation surface
// ---------------------------------------------------------------------------

interface DeprecationNote {
  where: string;
  what: string;
}

/**
 * What the server still advertises that the negotiated revision has deleted or
 * deprecated. On the modern era `capabilities.tasks` and a tool carrying the
 * removed `execution` field are DELETED vocabulary and fail; tools that merely
 * describe themselves as deprecated are recorded as notes.
 *
 * Legacy era: `pass: null` - the 2025 revision still defines that vocabulary, so
 * advertising it there is correct, not a finding.
 */
export async function probeDeprecationSurface(conn: McpConnection): Promise<ProbeFinding> {
  const id = 'deprecation-surface';
  const notes: DeprecationNote[] = [];
  const deleted: DeprecationNote[] = [];

  const capabilities = conn.identity.capabilities;
  if (isRecord(capabilities)) {
    if (capabilities['tasks'] !== undefined) {
      deleted.push({ where: 'capabilities.tasks', what: 'the tasks capability was deleted in 2026-07-28' });
    }
    if (capabilities['experimental'] !== undefined) {
      notes.push({ where: 'capabilities.experimental', what: 'non-standard surface advertised' });
    }
  }

  let toolCount = 0;
  try {
    const listed = await conn.listTools({ cacheMode: 'bypass' });
    toolCount = listed.tools.length;
    for (const tool of listed.tools) {
      const asRecord = tool as unknown as Record<string, unknown>;
      if (asRecord['execution'] !== undefined) {
        deleted.push({ where: `tools/${tool.name}.execution`, what: 'the execution field was deleted in 2026-07-28' });
      }
      const meta = asRecord['_meta'];
      if (isRecord(meta) && Object.keys(meta).some((k) => /deprecat/i.test(k))) {
        notes.push({ where: `tools/${tool.name}._meta`, what: 'carries a deprecation marker' });
      }
      if (typeof tool.description === 'string' && /\bdeprecat/i.test(tool.description)) {
        notes.push({ where: `tools/${tool.name}.description`, what: 'describes itself as deprecated' });
      }
    }
  } catch (cause) {
    return couldNotCheck(id, `could not check: tools/list failed (${cause instanceof Error ? cause.message : String(cause)})`, {
      notes
    });
  }

  const evidence = { deletedVocabulary: deleted, notes, toolCount, era: conn.era };

  if (conn.era !== 'modern') {
    return couldNotCheck(
      id,
      `could not check: deleted-vocabulary checks are defined against ${MODERN_PROTOCOL_VERSION}; this connection negotiated ${conn.negotiatedVersion ?? 'an unknown revision'}${notes.length === 0 ? '' : ` (${notes.length} deprecation note(s) recorded)`}`,
      evidence
    );
  }
  if (deleted.length > 0) {
    return {
      id,
      pass: false,
      detail: `advertises vocabulary deleted in ${MODERN_PROTOCOL_VERSION}: ${deleted.map((d) => d.where).join(', ')}`,
      evidence
    };
  }
  return {
    id,
    pass: true,
    detail:
      notes.length === 0
        ? 'no deleted or deprecated surface advertised'
        : `no deleted vocabulary; ${notes.length} deprecation note(s): ${notes.map((n) => n.where).join(', ')}`,
    evidence
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

type ProbeStep = { id: string; run: (conn: McpConnection) => Promise<ProbeFinding> | ProbeFinding };

const STEPS: readonly ProbeStep[] = [
  { id: 'spec-currency', run: probeSpecCurrency },
  { id: 'bogus-version-accepted', run: probeBogusVersion },
  { id: 'header-mismatch-accepted', run: probeModernHeaderConformance },
  { id: 'server-discover-present', run: probeDiscoverPresent },
  { id: 'cache-hints', run: probeCacheHints },
  { id: 'deprecation-surface', run: probeDeprecationSurface }
];

/**
 * Run every deterministic probe. Never throws: a probe that blows up becomes a
 * `pass: null` "could not check" finding, because a crashed probe is not a
 * server failure and must never be scored as one.
 */
export async function runProbes(conn: McpConnection, cfg: ProbeConfig = {}): Promise<ProbeResults> {
  const skip = new Set(cfg.skip ?? []);
  const findings: ProbeFinding[] = [];

  for (const step of STEPS) {
    if (skip.has(step.id)) {
      findings.push(couldNotCheck(step.id, 'could not check: probe skipped by configuration'));
      continue;
    }
    try {
      findings.push(await step.run(conn));
    } catch (cause) {
      findings.push(
        couldNotCheck(step.id, `could not check: probe threw (${cause instanceof Error ? cause.message : String(cause)})`, {
          error: cause instanceof Error ? { name: cause.name, message: cause.message } : String(cause)
        })
      );
    }
  }

  return { specCurrency: conn.negotiatedVersion, findings };
}
