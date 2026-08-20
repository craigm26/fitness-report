/**
 * Two-plane tape writer for Fitness Report.
 *
 * PORTED (MIT) from mcp-tape — Copyright (c) craigm26 — https://github.com/craigm26/mcp-tape
 *   src/writer.ts   (TraceWriter)
 *   src/rotation.ts (RotatingWriter)
 * Original license: MIT. This file keeps the serialized-write chain, the
 * meta/end line shapes, and the onFrame broadcast seam, and diverges as
 * required by DESIGN.md decision 6:
 *
 *   DELTA 1 — the writer NEVER stamps wall-clock time. Every line's `t` is
 *     supplied by the caller (the observed timestamp of the frame). The
 *     original called `new Date().toISOString()` at log time, which smears
 *     queueing latency into the recorded timeline and makes latency metrics
 *     unfalsifiable. `close()` may omit `t`, in which case the last observed
 *     line's `t` is reused (still caller-supplied, never Date.now()), and
 *     `durationMs` is DERIVED from the caller's timestamps.
 *   DELTA 2 — caller-supplied output path (TapeWriterOpts.path in src/types.ts).
 *     The original derived `<dir>/<ts>-<label>.jsonl`; we need deterministic
 *     `runs/<runId>/<plane>.jsonl` paths so trace URLs are stable.
 *   DELTA 3 — rotation removed entirely. A rotated tape loses its meta line on
 *     the base path, which breaks every downstream reader (mcp-tape stats, the
 *     mcpreplay viewer) and would silently truncate published evidence.
 *   DELTA 4 — one file holds exactly ONE session. The port inherited `open(path,
 *     'a')` from a writer whose caller derived a fresh `<ts>-<label>.jsonl` path
 *     every time, so append could never collide. DELTA 2 took that guarantee
 *     away: our path is `<outDir>/<plane>.jsonl`, and an operator who reruns
 *     into an out dir they already used silently appended a SECOND meta line and
 *     a second session onto the first run's tape. Everything else in a run
 *     directory is truncated on rewrite (report.json, report.md, suite.json), so
 *     the tape was the one file where the directory stopped describing one run:
 *     the report named run B while the tape served A's frames, and a replay link
 *     for B opened A. `TapeWriter.open` now REFUSES a path that already holds
 *     bytes unless the caller passes `truncate: true` to say, in one explicit
 *     word, that it means to discard the recording that is there.
 *
 * The writer does NOT redact. Redaction runs only on the published copy
 * (see ./redact.ts); scoring reads these pre-redaction records.
 *
 * One writer == one plane == one file (DESIGN decision 4). A single mixed file
 * double-counts every tool call in mcp-tape stats and in the web renderer.
 */

import { mkdir, open, stat, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  TapeEnd,
  TapeEventLine,
  TapeLine,
  TapeMessageLine,
  TapeMeta,
  TapeTurnLine,
  TapeWriterOpts,
} from '../types.js';

/**
 * Additive local extension of the shared TapeWriterOpts contract: a plain
 * `TapeWriterOpts` is always accepted. `onFrame` exists so a live consumer
 * (websocket broadcast, in-memory scorer) can see each frame without a second
 * serialization path. Broadcast failures never suppress disk persistence.
 */
export interface TapeWriterOptions extends TapeWriterOpts {
  onFrame?: (line: TapeLine) => void;
  /**
   * Discard whatever is already at `path` and start a clean tape (DELTA 4).
   * Omitted or false, an existing non-empty file is a hard error: a second
   * session appended to one tape is two runs wearing one run's replay link.
   */
  truncate?: boolean;
}

/**
 * Thrown when a run would have written a second session onto an existing tape.
 * Typed so a caller can tell "this directory already holds a recording" apart
 * from a disk failure and say something useful about it.
 */
export class TapeExistsError extends Error {
  readonly path: string;
  readonly bytes: number;

  constructor(path: string, bytes: number) {
    super(
      `tape: ${path} already holds ${bytes} bytes. One tape file is one session: ` +
        'appending a second run here would serve its frames under the first run\'s ' +
        'replay link. Write to a fresh directory, or pass truncate:true to discard ' +
        'the existing recording.',
    );
    this.name = 'TapeExistsError';
    this.path = path;
    this.bytes = bytes;
  }
}

/**
 * `close()` argument: reason (+ optional caller-observed end timestamp).
 * `type:'end'` is accepted but optional — the writer always writes it — so both
 * `close({reason})` and `close({type:'end', reason})` compile.
 */
export type TapeEndInit = Omit<TapeEnd, 't' | 'durationMs' | 'type'> & {
  t?: string;
  type?: 'end';
};

/** Fields the end line may never carry (DESIGN decision 5: no exitCode — we
 *  wrap no child process; durationMs and type are computed, not supplied). */
const END_RESERVED = new Set(['exitCode', 'durationMs', 'type', 't']);

/**
 * Append-only JSONL sink. Writes are serialized through a promise chain so
 * concurrent, un-awaited log calls land in call order and never interleave a
 * partial line. Ported from RotatingWriter with the rotation path removed.
 */
class SerialAppender {
  private chain: Promise<void> = Promise.resolve();

  private constructor(private readonly fh: FileHandle) {}

  static async open(path: string, truncate: boolean): Promise<SerialAppender> {
    // The run directory is ours to own: callers pass runs/<runId>/<plane>.jsonl
    // and should not have to pre-create it just to start recording.
    await mkdir(dirname(path), { recursive: true });
    if (!truncate) {
      // A zero-byte file is not a recording: an interrupted open, or a
      // pre-created placeholder, must not block a run.
      const existing = await stat(path).catch(() => null);
      if (existing !== null && existing.size > 0) {
        throw new TapeExistsError(path, existing.size);
      }
    }
    // 'w' truncates; 'a' is kept for the checked path so a zero-byte file that
    // appeared between the stat and the open is still written, never clobbered
    // by a mode that assumes the check is still true.
    const fh = await open(path, truncate ? 'w' : 'a');
    return new SerialAppender(fh);
  }

  writeLine(line: string): Promise<void> {
    const next = this.chain.then(() => this.writeOne(line));
    // Don't poison the chain for future calls if this one rejects.
    this.chain = next.catch(() => {});
    return next;
  }

  async sync(): Promise<void> {
    await this.chain.catch(() => {});
    await this.fh.sync();
  }

  async close(): Promise<void> {
    await this.chain.catch(() => {});
    await this.fh.sync();
    await this.fh.close();
  }

  private async writeOne(line: string): Promise<void> {
    await this.fh.write(Buffer.from(line, 'utf8'));
  }
}

export class TapeWriter {
  private lastT: string;
  private closed = false;

  private constructor(
    private readonly out: SerialAppender,
    readonly path: string,
    private readonly startedAt: string,
    private readonly onFrame?: (line: TapeLine) => void,
  ) {
    this.lastT = startedAt;
  }

  /**
   * Open the plane and write its meta line (DESIGN decision 5). Key order is
   * pinned: v, type, startedAt, label, command, then the extension fields, and
   * optional extension fields are omitted entirely when undefined rather than
   * written as null.
   *
   * Throws `TapeExistsError` when `path` already holds a recording and
   * `truncate` was not requested (DELTA 4).
   */
  static async open(opts: TapeWriterOptions): Promise<TapeWriter> {
    const m = opts.meta;
    requireTimestamp(m.startedAt, 'meta.startedAt');
    const out = await SerialAppender.open(opts.path, opts.truncate === true);
    const writer = new TapeWriter(out, opts.path, m.startedAt, opts.onFrame);
    const meta: TapeMeta = {
      v: 1,
      type: 'meta',
      startedAt: m.startedAt,
      label: m.label,
      command: [...m.command],
      ...(m.mcpTapVersion !== undefined ? { mcpTapVersion: m.mcpTapVersion } : {}),
      ...(m.kind !== undefined ? { kind: m.kind } : {}),
      ...(m.source !== undefined ? { source: m.source } : {}),
      ...(m.producer !== undefined ? { producer: m.producer } : {}),
    };
    await writer.emit(meta);
    return writer;
  }

  /** JSON-RPC wire frame. `dir` is reserved for real protocol traffic. */
  async writeMessage(line: TapeMessageLine): Promise<void> {
    requireTimestamp(line.t, 'message.t');
    if (line.dir !== 'in' && line.dir !== 'out') {
      throw new Error(
        `tape: message lines must be dir "in" or "out" (got ${JSON.stringify(line.dir)})`,
      );
    }
    const { t, dir, raw, corr_id, ...rest } = line;
    await this.emit({
      t,
      dir,
      raw,
      ...(corr_id !== undefined ? { corr_id } : {}),
      ...rest,
    } as TapeMessageLine);
  }

  /**
   * Harness-native event (`fitness.gate`, `fitness.task_start`, ...).
   * NEVER dir:"in"/"out": those are reserved for JSON-RPC, and consumers must
   * not feed event lines into request/response pairing (docs/format.md §events).
   */
  async writeEvent(line: TapeEventLine): Promise<void> {
    requireTimestamp(line.t, 'event.t');
    const dir = line.dir as string;
    if (dir === 'in' || dir === 'out') {
      throw new Error(
        'tape: event lines must never use dir "in"/"out" (reserved for JSON-RPC pairing)',
      );
    }
    if (!line.kind) throw new Error('tape: event lines require a `kind`');
    const { t, dir: d, kind, raw, data, corr_id, ...rest } = line;
    // docs/format.md requires `raw` on every line that carries a `dir`, and
    // format-extensions §2 puts the producer-defined payload there. `data` is
    // accepted from callers and mapped onto `raw`; it is never written.
    const payload = raw !== undefined ? raw : data;
    await this.emit({
      t,
      dir: d,
      kind,
      ...(payload !== undefined ? { raw: payload } : {}),
      ...(corr_id !== undefined ? { corr_id } : {}),
      ...rest,
    } as TapeEventLine);
  }

  /** LLM plane turn record. `echoed:true` is mandatory for turns
   *  reconstructed from request bodies (consumers filter them out of pairing). */
  async writeTurn(line: TapeTurnLine): Promise<void> {
    requireTimestamp(line.t, 'turn.t');
    const { t, type, role, blocks, model, usage, timing, echoed, corr_id, ...rest } = line;
    await this.emit({
      t,
      type,
      role,
      blocks: [...blocks],
      ...(model !== undefined ? { model } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(timing !== undefined ? { timing } : {}),
      ...(echoed !== undefined ? { echoed } : {}),
      ...(corr_id !== undefined ? { corr_id } : {}),
      ...rest,
    } as TapeTurnLine);
  }

  /**
   * Write the end line, fsync, and close. Idempotent: a second call is a
   * no-op so error paths can close in a `finally` without masking the
   * original failure.
   *
   * `durationMs` is derived from caller timestamps (end.t - meta.startedAt),
   * never from a wall clock, and is always a finite non-negative number
   * (DESIGN decision 15: never NaN).
   */
  async close(end: TapeEndInit): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const t = end.t ?? this.lastT;
    requireTimestamp(t, 'end.t');
    const extras: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(end as Record<string, unknown>)) {
      if (k === 'reason' || END_RESERVED.has(k)) continue;
      extras[k] = v;
    }
    const line: TapeEnd = {
      t,
      type: 'end',
      reason: end.reason,
      durationMs: durationBetween(this.startedAt, t),
      ...extras,
    };
    await this.emit(line);
    await this.out.close();
  }

  /** Flush the write chain and fsync without closing. */
  async sync(): Promise<void> {
    await this.out.sync();
  }

  private async emit(line: TapeLine): Promise<void> {
    const t = (line as { t?: unknown }).t;
    if (typeof t === 'string' && t.length > 0) this.lastT = t;
    if (this.onFrame) {
      try {
        this.onFrame(line);
      } catch {
        // A broadcast failure must never suppress disk persistence: losing the
        // live wire is tolerable, losing the trace file is not.
      }
    }
    await this.out.writeLine(JSON.stringify(line) + '\n');
  }
}

function requireTimestamp(t: unknown, what: string): asserts t is string {
  if (typeof t !== 'string' || t.length === 0) {
    throw new Error(
      `tape: ${what} must be a caller-supplied ISO timestamp (the writer never stamps wall-clock time)`,
    );
  }
}

/** Non-negative, finite millisecond span between two ISO timestamps. */
function durationBetween(startedAt: string, endedAt: string): number {
  const a = Date.parse(startedAt);
  const b = Date.parse(endedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, b - a);
}
