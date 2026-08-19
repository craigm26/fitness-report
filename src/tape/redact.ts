/**
 * Publish-time tape redaction for Fitness Report.
 *
 * PORTED (MIT) from mcp-tape — Copyright (c) craigm26 — https://github.com/craigm26/mcp-tape
 *   src/redact.ts        (field-name pass, turn-record exemptions, base64 guard)
 *   src/redact-config.ts (rule compilation and pass ordering)
 *   src/jsonpath.ts      (the `$..field` matcher used by `path` rules)
 * Rule set: ./default-redact.json, vendored from the LOCAL mcp-tape checkout
 * (it carries the Google `AIza…` rule that is not in the published bundle).
 *
 * ---------------------------------------------------------------------------
 * REDACTION IS PUBLISH-TIME ONLY. SCORING ALWAYS READS PRE-REDACTION RECORDS.
 * ---------------------------------------------------------------------------
 * DESIGN.md decision 6: the writer does not redact, and every metric is
 * computed from the in-memory (or on-disk unredacted) records. Key-name
 * redaction is deliberately blunt — it destroys legitimate arguments such as
 * `page_token`, `access_key_id`-shaped enum values, and any argument whose name
 * merely contains "token" — so running the scorer over redacted records would
 * corrupt exactly the ambiguous-parameter evidence the report is built on.
 * Redact once, on the copy that gets published to /traces/<runId>/<plane>.jsonl.
 */

import defaultRedact from './default-redact.json' with { type: 'json' };
import type { TapeLine } from '../types.js';

export const REPLACEMENT = '[REDACTED]';

// ---------------------------------------------------------------------------
// Minimal JSONPath (ported from mcp-tape src/jsonpath.ts): enough for the
// `$..field` / `$.a.b` / `$[0]` / `$[*]` shapes the rule files use.
// ---------------------------------------------------------------------------

export type Segment =
  | { type: 'field'; name: string }
  | { type: 'index'; idx: number }
  | { type: 'wildcard' }
  | { type: 'descend'; name: string };

export function compilePath(pattern: string): Segment[] {
  if (!pattern.startsWith('$')) throw new Error(`JSONPath must start with $: ${pattern}`);
  const segs: Segment[] = [];
  let i = 1;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '.') {
      const descend = pattern[i + 1] === '.';
      const start = descend ? i + 2 : i + 1;
      let j = start;
      while (j < pattern.length && /[A-Za-z0-9_]/.test(pattern[j]!)) j++;
      const name = pattern.slice(start, j);
      if (!name) throw new Error(`JSONPath missing field name: ${pattern}`);
      segs.push(descend ? { type: 'descend', name } : { type: 'field', name });
      i = j;
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i);
      if (end === -1) throw new Error(`JSONPath unclosed [: ${pattern}`);
      const inner = pattern.slice(i + 1, end);
      if (inner === '*') {
        segs.push({ type: 'wildcard' });
      } else {
        const n = Number(inner);
        if (!Number.isInteger(n)) throw new Error(`JSONPath bad index: ${inner}`);
        segs.push({ type: 'index', idx: n });
      }
      i = end + 1;
    } else {
      throw new Error(`JSONPath unexpected char at ${i}: ${pattern}`);
    }
  }
  return segs;
}

export function matchSegments(segs: readonly Segment[], path: readonly string[]): boolean {
  return matchSegs(segs, 0, path, 0);
}

function matchSegs(
  segs: readonly Segment[],
  si: number,
  path: readonly string[],
  pi: number,
): boolean {
  if (si === segs.length) return pi === path.length;
  const seg = segs[si]!;
  if (seg.type === 'descend') {
    for (let k = pi; k < path.length; k++) {
      if (path[k] === seg.name && matchSegs(segs, si + 1, path, k + 1)) return true;
    }
    return false;
  }
  if (pi >= path.length) return false;
  if (seg.type === 'field') {
    return path[pi] === seg.name && matchSegs(segs, si + 1, path, pi + 1);
  }
  if (seg.type === 'index') {
    return path[pi] === String(seg.idx) && matchSegs(segs, si + 1, path, pi + 1);
  }
  return matchSegs(segs, si + 1, path, pi + 1); // wildcard
}

// ---------------------------------------------------------------------------
// Legacy field-name pass (mcp-tape src/redact.ts). Substring, case-insensitive
// match against the KEY; the value is replaced wholesale with [REDACTED].
// Numbers and booleans under a matching key survive: `usage.input_tokens`
// matches /token/i but a token COUNT is not a secret, and destroying it would
// silently zero out the cost model.
// ---------------------------------------------------------------------------

const LEGACY_FIELDS: readonly RegExp[] = [
  /password/i,
  /passwd/i,
  /\bpwd\b/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /authorization/i,
  /^bearer$/i,
  /private[_-]?key/i,
  /access[_-]?key/i,
];

// ---------------------------------------------------------------------------
// Opaque replay blobs inside `turn` records must survive verbatim: providers
// reject replayed conversations whose signature / encrypted reasoning bytes
// were altered. Scoped by the CONTAINING block's `type` so a `signature` key
// inside a tool_result (which could be a real JWS a tool returned) is still
// redacted normally.
// ---------------------------------------------------------------------------

export function isExemptTurnField(
  key: string,
  parent: Record<string, unknown> | null | undefined,
): boolean {
  const ptype = parent ? parent['type'] : undefined;
  switch (key) {
    case 'signature':
      return ptype === 'thinking' || ptype === 'redacted_thinking';
    case 'data':
      return ptype === 'redacted_thinking' || ptype === 'reasoning.encrypted';
    case 'encrypted_content':
      return ptype === 'thinking' || ptype === 'reasoning';
    case 'thoughtSignature':
      return ptype === 'thinking' || ptype === 'tool_use';
    default:
      return false;
  }
}

export function isTurnRecord(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)['type'] === 'turn'
  );
}

// A big string only skips the value-regex pass if it is base64 over its ENTIRE
// length: rewriting inside a base64 payload corrupts it, and the unanchored
// patterns backtrack quadratically on whitespace-free megastrings. A single
// character-class scan is linear and bails at the first non-base64 char, so a
// mixed string (which is what a plaintext secret makes it) is scanned normally.
const BASE64_SKIP_MIN = 8 * 1024;
const BASE64_ALPHABET = /^[A-Za-z0-9+/=\r\n]+$/;

export function isLikelyBase64Blob(s: string): boolean {
  return s.length >= BASE64_SKIP_MIN && BASE64_ALPHABET.test(s);
}

const MEDIA_SAMPLE = /^[A-Za-z0-9+/=\r\n_-]+$/;

export function isLikelyMediaBlob(s: string, minBytes: number): boolean {
  if (s.length < minBytes) return false;
  if (s.startsWith('data:') && s.slice(0, 256).includes(';base64,')) return true;
  return MEDIA_SAMPLE.test(s.slice(0, 512)) && MEDIA_SAMPLE.test(s.slice(-64));
}

function mediaDroppedPlaceholder(s: string): string {
  return `[media dropped: ${Buffer.byteLength(s, 'utf8')} bytes]`;
}

function truncateWithMarker(s: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(s, 'utf8');
  if (bytes <= maxBytes) return s;
  return s.slice(0, maxBytes) + ` [fitness-report: truncated, original ${bytes} bytes]`;
}

// ---------------------------------------------------------------------------
// Rule compilation
// ---------------------------------------------------------------------------

interface RawRule {
  type: 'regex' | 'path' | 'truncate' | 'drop-media';
  pattern?: string;
  path?: string;
  maxBytes?: number;
  minBytes?: number;
}

interface TruncateRule {
  segments: Segment[];
  maxBytes: number;
}

export interface CompiledRedact {
  regexes: RegExp[];
  pathRules: Segment[][];
  truncateRules: TruncateRule[];
  dropMediaMinBytes: number | null;
  fields: readonly RegExp[];
  replacement: string;
}

export function compileRules(rules: readonly RawRule[]): CompiledRedact {
  const regexes: RegExp[] = [];
  const pathRules: Segment[][] = [];
  const truncateRules: TruncateRule[] = [];
  let dropMediaMinBytes: number | null = null;
  for (const r of rules) {
    if (r.type === 'regex') {
      if (!r.pattern) throw new Error('redact rule: regex missing pattern');
      regexes.push(new RegExp(r.pattern, 'g'));
    } else if (r.type === 'path') {
      if (!r.path) throw new Error('redact rule: path missing path');
      pathRules.push(compilePath(r.path));
    } else if (r.type === 'truncate') {
      if (!r.path) throw new Error('redact rule: truncate missing path');
      if (typeof r.maxBytes !== 'number' || r.maxBytes <= 0) {
        throw new Error('redact rule: truncate requires a positive maxBytes');
      }
      truncateRules.push({ segments: compilePath(r.path), maxBytes: r.maxBytes });
    } else if (r.type === 'drop-media') {
      if (typeof r.minBytes !== 'number' || r.minBytes <= 0) {
        throw new Error('redact rule: drop-media requires a positive minBytes');
      }
      dropMediaMinBytes =
        dropMediaMinBytes === null ? r.minBytes : Math.min(dropMediaMinBytes, r.minBytes);
    } else {
      // Never silently drop a rule the operator wrote: an unknown type means
      // the vendored file is newer than this code, and failing open would
      // publish whatever that rule was meant to remove.
      throw new Error(`redact rule: unknown type ${JSON.stringify((r as RawRule).type)}`);
    }
  }
  return {
    regexes,
    pathRules,
    truncateRules,
    dropMediaMinBytes,
    fields: LEGACY_FIELDS,
    replacement: REPLACEMENT,
  };
}

const VENDORED_RULES = ((defaultRedact as unknown as { rules?: RawRule[] }).rules ??
  []) as RawRule[];

/** The vendored default rule set, compiled once at module load. */
export const DEFAULT_CONFIG: CompiledRedact = compileRules(VENDORED_RULES);

// ---------------------------------------------------------------------------
// Passes. Order matters: size guards run first so multi-MB strings never reach
// the regex engine, then path rules, then the combined field-name + value-regex
// walk (mcp-tape's redactWalk).
// ---------------------------------------------------------------------------

export function redactValue(value: unknown, cfg: CompiledRedact = DEFAULT_CONFIG): unknown {
  const inTurn = isTurnRecord(value);
  let out = value;
  if (cfg.truncateRules.length > 0) out = applyTruncate(out, cfg, [], null, inTurn);
  if (cfg.dropMediaMinBytes !== null) {
    out = applyDropMedia(out, cfg.dropMediaMinBytes, '', null, inTurn);
  }
  if (cfg.pathRules.length > 0) out = applyPathRules(out, cfg, [], null, inTurn);
  return redactWalk(out, cfg, '', null, inTurn);
}

/**
 * Redact a whole tape for publication. Pure: the input array and its records
 * are never mutated, so the caller keeps its pre-redaction records for scoring.
 */
export function redactTape(lines: readonly TapeLine[], cfg: CompiledRedact = DEFAULT_CONFIG): TapeLine[] {
  return lines.map((line) => redactValue(line, cfg) as TapeLine);
}

// ---------------------------------------------------------------------------
// The published REPORT (report.json / report.md) needs the same treatment as
// the tapes: it is the artifact the leaderboard actually ingests, and it
// carries verbatim server strings (connect error messages, probe body
// snippets, gate detail, server instructions). Two deltas from the tape config:
//
//   1. ANCHORED field names. The tape pass matches key names by SUBSTRING,
//      which would replace whole objects like `trace_stats.…​.cacheReadTokens`
//      (every leaf a number) with "[REDACTED]" and destroy real measurements.
//      Report field rules match the whole key instead.
//   2. An explicit SECRET set. Pattern rules cannot see a bearer token echoed
//      back as `presented <tok>` with no marker word, so the values we know are
//      secret (the --auth-token, the pre-strip URL) are removed by exact match.
// ---------------------------------------------------------------------------

const REPORT_FIELDS: readonly RegExp[] = [
  /^password$/i,
  /^passwd$/i,
  /^pwd$/i,
  /^secret[_-]?[a-z]*$/i,
  /^(?:auth|access|refresh|id|session|bearer|api)?[_-]?tokens?$/i,
  /^api[_-]?key$/i,
  /^authorization$/i,
  /^bearer$/i,
  /^private[_-]?key$/i,
  /^access[_-]?key(?:[_-]?id)?$/i,
];

/** Value rules of the tape config, with anchored (never substring) key rules. */
export const REPORT_CONFIG: CompiledRedact = { ...DEFAULT_CONFIG, fields: REPORT_FIELDS };

/** Only strings long enough to be a credential are worth exact-matching. */
const MIN_SECRET_LENGTH = 6;

/**
 * Replace every occurrence of a known secret in every string of `value`.
 * Pattern rules are necessary but not sufficient: a gateway that answers
 * "unauthorized: presented <tok> for /mcp" hands the token back with no marker
 * for a regex to anchor on.
 */
export function scrubSecrets<T>(value: T, secrets: readonly string[], replacement = REPLACEMENT): T {
  const needles = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH))]
    // Longest first, so a URL containing the token is rewritten before the
    // token itself turns it into a partial match.
    .sort((a, b) => b.length - a.length);
  if (needles.length === 0) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let out = v;
      for (const needle of needles) out = out.split(needle).join(replacement);
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/**
 * The publish-time pass for `report.json` and the markdown rendered from it.
 * Redaction that runs only on the tapes is redaction that does not run: the
 * report is the file the leaderboard reads.
 */
export function redactReport<T>(report: T, secrets: readonly string[] = []): T {
  return scrubSecrets(redactValue(report, REPORT_CONFIG) as T, secrets);
}

function applyTruncate(
  value: unknown,
  cfg: CompiledRedact,
  path: string[],
  parent: Record<string, unknown> | null,
  inTurn: boolean,
): unknown {
  if (typeof value === 'string') {
    const key = path.length > 0 ? path[path.length - 1]! : '';
    if (inTurn && isExemptTurnField(key, parent)) return value;
    for (const r of cfg.truncateRules) {
      if (matchSegments(r.segments, path)) return truncateWithMarker(value, r.maxBytes);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => applyTruncate(v, cfg, [...path, String(i)], parent, inTurn));
  }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      obj[k] = applyTruncate(v, cfg, [...path, k], rec, inTurn);
    }
    return obj;
  }
  return value;
}

function applyDropMedia(
  value: unknown,
  minBytes: number,
  parentKey: string,
  parent: Record<string, unknown> | null,
  inTurn: boolean,
): unknown {
  if (typeof value === 'string') {
    if (inTurn && isExemptTurnField(parentKey, parent)) return value;
    return isLikelyMediaBlob(value, minBytes) ? mediaDroppedPlaceholder(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => applyDropMedia(v, minBytes, parentKey, parent, inTurn));
  }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      obj[k] = applyDropMedia(v, minBytes, k, rec, inTurn);
    }
    return obj;
  }
  return value;
}

function applyPathRules(
  value: unknown,
  cfg: CompiledRedact,
  path: string[],
  parent: Record<string, unknown> | null,
  inTurn: boolean,
): unknown {
  const key = path.length > 0 ? path[path.length - 1]! : '';
  if (inTurn && typeof value === 'string' && isExemptTurnField(key, parent)) return value;
  if (path.length > 0 && cfg.pathRules.some((segs) => matchSegments(segs, path))) {
    return cfg.replacement;
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => applyPathRules(v, cfg, [...path, String(i)], parent, inTurn));
  }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      obj[k] = applyPathRules(v, cfg, [...path, k], rec, inTurn);
    }
    return obj;
  }
  return value;
}

function redactWalk(
  value: unknown,
  cfg: CompiledRedact,
  parentKey: string,
  parentObj: Record<string, unknown> | null,
  inTurn: boolean,
): unknown {
  if (typeof value === 'string') {
    if (inTurn && parentKey && isExemptTurnField(parentKey, parentObj)) return value;
    if (parentKey && cfg.fields.some((r) => r.test(parentKey))) return cfg.replacement;
    if (isLikelyBase64Blob(value)) return value;
    let out = value;
    for (const p of cfg.regexes) {
      p.lastIndex = 0; // shared 'g' regexes are stateful across calls
      out = out.replace(p, cfg.replacement);
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactWalk(v, cfg, parentKey, parentObj, inTurn));
  }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (inTurn && typeof v === 'string' && isExemptTurnField(k, rec)) {
        obj[k] = v;
        continue;
      }
      // A matching key nukes strings and objects wholesale, but leaves scalars
      // alone: `usage.input_tokens` matches /token/i and a COUNT is not a secret.
      obj[k] = cfg.fields.some((r) => r.test(k))
        ? typeof v === 'string' || (v && typeof v === 'object')
          ? cfg.replacement
          : v
        : redactWalk(v, cfg, k, rec, inTurn);
    }
    return obj;
  }
  return value;
}
