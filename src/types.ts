/**
 * Shared contracts for Fitness Report v0.
 * Cross-module shapes: do not change without a `// CONTRACT CHANGE:` note.
 * Tape line shapes conform to docs/format.md (v1) + docs/format-extensions.md.
 */

// ---------------------------------------------------------------------------
// Tape (mcp-tape v1 JSONL + extensions). Two files per run: mcp plane + agent plane.
// ---------------------------------------------------------------------------

export interface TapeMeta {
  v: 1;
  type: 'meta';
  startedAt: string; // ISO
  label: string;
  command: readonly string[]; // ["fitness-report", "<url, credentials stripped>"]
  mcpTapVersion?: string;
  kind?: 'mcp' | 'llm' | string;
  source?: string; // "fitness-report@x.y.z"
  producer?: { name: string; version: string; configHash?: string };
}

export interface TapeMessageLine {
  t: string; // observed ISO timestamp (caller-supplied, never wall-clock-at-log-time)
  dir: 'in' | 'out';
  raw: unknown; // verbatim JSON-RPC envelope
  corr_id?: string; // taskId
}

// CONTRACT CHANGE (2026-08-19): the payload of an event line is `raw`, not
// `data`. docs/format.md marks `raw` required on every line carrying a `dir`,
// and docs/format-extensions.md §2 defines it as the producer-defined payload
// for the extended `dir` values (every example line in §2, §5 and §7 uses it).
// We were writing `data`, so a v1 consumer reading the payload out of `raw`
// rendered our gate decisions and per-tool findings as empty lines. `data` is
// still ACCEPTED on input (the writer maps it onto `raw`) and still tolerated
// when reading already-written tapes; it is never written any more.
export interface TapeEventLine {
  t: string;
  dir: 'event' | 'command' | 'telemetry';
  kind: string; // "fitness.gate" | "fitness.task_start" | "fitness.verdict" | "fitness.stream_break" | ...
  /** Producer-defined payload. Required on the wire; `data` is the legacy spelling. */
  raw?: unknown;
  /** @deprecated input-only alias for `raw`, kept so old callers still compile. */
  data?: unknown;
  corr_id?: string;
}

export interface TapeTurnLine {
  t: string;
  type: 'turn';
  role: 'assistant' | 'user' | 'system';
  blocks: readonly unknown[]; // provider-shaped: thinking | text | tool_use | tool_result
  model?: string;
  usage?: unknown;
  timing?: unknown;
  echoed?: boolean; // MUST be true for turns reconstructed from request bodies
  corr_id?: string;
}

export interface TapeEnd {
  t: string;
  type: 'end';
  reason: 'eval_complete' | 'transport_error' | 'producer_shutdown' | string;
  durationMs: number;
  // NO exitCode: we wrap no child process.
}

export type TapeLine = TapeMeta | TapeMessageLine | TapeEventLine | TapeTurnLine | TapeEnd;

export interface TapeWriterOpts {
  path: string; // caller-supplied, deterministic: runs/<runId>/<plane>.jsonl
  meta: Omit<TapeMeta, 'v' | 'type'>;
}

// ---------------------------------------------------------------------------
// Probes (deterministic, zero-token) and connection identity
// ---------------------------------------------------------------------------

export type ProtocolEra = 'modern' | 'legacy';
export type CredentialContext = 'anonymous' | 'free-key' | 'owner-key';

export interface ServerIdentity {
  url: string;
  slug: string;
  era: ProtocolEra;
  negotiatedVersion: string | null; // e.g. "2025-11-25"
  serverInfo?: unknown;
  instructions?: string | null;
  capabilities?: unknown;
  transportShape: 'sse' | 'json';
  sessionful: boolean;
  credentialContext: CredentialContext;
  // CONTRACT CHANGE (integrator, 2026-08-19): DESIGN decision 2 requires
  // getDiscoverResult() to be recorded into the run record, and there was no
  // slot for it. Additive and optional: every existing producer still compiles.
  discover?: unknown;
}

export interface ProbeFinding {
  id: string; // e.g. "spec-currency", "bogus-version-accepted", "header-mismatch-accepted"
  pass: boolean | null; // null = not applicable (must be rendered as "could not check")
  detail: string;
  evidence?: unknown;
}

export interface ProbeResults {
  specCurrency: string | null;
  findings: readonly ProbeFinding[];
}

// ---------------------------------------------------------------------------
// Task suite
// ---------------------------------------------------------------------------

export interface FitnessTask {
  id: string;
  prompt: string; // rendered task text given to the runner agent
  expectedTools: readonly string[]; // tools a correct solution is expected to touch
  check: TaskCheck; // machine-checkable success predicate
  answerKey?: unknown; // never allowed to appear in prompt (leak gate)
  destructive: boolean; // whether a correct solution requires a destructive call
}

export type TaskCheck =
  | { kind: 'substring'; where: 'final_text'; value: string }
  | { kind: 'regex'; where: 'final_text'; pattern: string }
  | { kind: 'tool_called'; tool: string }
  | { kind: 'tool_result_matches'; tool: string; pattern: string }
  | { kind: 'judge'; rubric: string };

export interface TaskSuite {
  serverSlug: string;
  suiteHash: string; // sha256 over canonical JSON of tasks + generator config
  generatorModel: string;
  seed: number;
  tasks: readonly FitnessTask[];
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export type GateOutcome = 'PASS' | 'FAIL' | 'EXTEND';

export interface Verdict {
  outcome: GateOutcome;
  k: number;
  n: number;
  threshold: number;
  alpha: number;
  pValue: number;
}

// CONTRACT CHANGE (pipeline, 2026-08-19): two gate ids added, additively. The
// free gates screen an extension batch exactly as they screen the registered
// suite, and until now they did it with different CONSEQUENCES: a task that
// leaked its answer key or violated the structural property REFUSED the run
// when it arrived in the registered suite and was silently deleted when it
// arrived in a batch bought to resolve the construct gate. A batch is bought
// with the paid tier to settle a verdict, so a defect inside one is evidence
// about the generator, not a task to discard quietly. Those two findings now
// refuse, and they refuse under their own ids rather than adding a SECOND row
// under `answer_leak` / `structural`: both this repo's renderer and the
// leaderboard resolve `refusedAt` with a first-match lookup over `records`, so
// a duplicate id would have published the earlier PASSING row's reason ("ok")
// as the reason the run was refused. Nothing narrows: every existing id, gate
// order and reason string is untouched.
export type GateId =
  | 'structural'
  | 'answer_leak'
  | 'suite_size'
  | 'plan_power'
  | 'null_baseline'
  | 'construct'
  | 'variance'
  | 'order_invariance'
  | 'protocol_hygiene'
  /** An answer key found inside an extension batch. Refuses, like `answer_leak`. */
  | 'extension_answer_leak'
  /** A structural property violated inside an extension batch. Refuses, like `structural`. */
  | 'extension_structural';

export interface GateRecord {
  gate: GateId;
  ok: boolean;
  costTier: 'free' | 'cheap' | 'paid';
  verdict?: Verdict;
  reason: string; // typed reason string, rendered verbatim in refusals
  detail?: unknown;
}

/**
 * The pre-registration, fixed alongside n and persisted BEFORE the first model
 * call. evalgate doctrine, quoted verbatim in src/gates/gates.ts: "EXTEND is not
 * a loophole. The extension size and the maximum number of extensions are fixed
 * in the pre-registration alongside n; after the last extension an unresolved
 * gate resolves to FAIL."
 */
export interface ExtensionPolicy {
  extensionSize: number;
  maxExtensions: number;
}

/** Pooled successes over trials, across the original suite and every extension. */
export interface PooledCounts {
  k: number;
  n: number;
}

// CONTRACT CHANGE (pipeline, 2026-08-19): the extension protocol now RUNS, and
// a consumed extension is a fact about the run that a reader must be able to
// audit without trusting a prose summary. Each consumed extension gets one
// record: which extension it was, the derived seed that produced it, the batch's
// own suiteHash, the task ids that entered the pool, what the batch's free gates
// deleted, and the pooled counts and verdict on BOTH sides of it. Additive and
// optional: a v1 record published before the loop existed stays readable, and a
// zero-extension policy still writes nothing here.
/**
 * One free-gate violation found INSIDE an extension batch.
 *
 * Present means REFUSED. These are the two findings that carry the same
 * consequence in a bought batch as in the registered suite (an answer key the
 * answering model can read, and a task that does not satisfy the property the
 * run depends on), recorded with the batch and the task named so the refusal
 * can be argued with.
 */
export interface ExtensionViolation {
  /** `extension_answer_leak` or `extension_structural`. */
  gate: GateId;
  /** Typed reason string, rendered verbatim in the refusal. */
  reason: string;
  /** 1-based index of the batch this was found in. */
  extensionIndex: number;
  /** The POOLED task id, carrying its deterministic `e<index>-` prefix. */
  taskId: string;
  /** Human readable, no em-dashes: this text reaches the site. */
  detail: string;
}

export interface ExtensionEvidence {
  /** 1-based. Extension 0 does not exist; the original suite is not an extension. */
  index: number;
  /** The gate the extension was bought for. Only `construct` uses one in v0. */
  gate: GateId;
  /** `seed + 1000 * index`. Deterministic and recorded, never wall-clock. */
  seed: number;
  /** suiteHash of the batch exactly as the generator emitted it. */
  batchSuiteHash: string | null;
  /** Ids as POOLED, after the deterministic `e<index>-` prefix. */
  taskIds: readonly string[];
  /** Tasks the generator admitted to the batch, before this pipeline's free gates. */
  generated: number;
  /**
   * Tasks that survived the free gates and were driven. Zero on a batch that
   * REFUSED: a batch carrying a leak or a property violation is void as a
   * whole, and cherry-picking its clean tasks would be selecting on the defect.
   */
  admitted: number;
  /**
   * What each free-gate rule DELETED from the batch without refusing the run.
   *
   * `answerLeak` is retained for record compatibility and is 0 on every run
   * produced since the batch-symmetry rule landed: an answer key inside a batch
   * refuses the run and its offenders are listed in `violations`, never dropped.
   * `duplicate` counts batch tasks that restate a task already in the pool
   * (content level, see the dedupe key); they are dropped, because a restated
   * task is a correlated trial rather than evidence of a broken generator.
   */
  dropped: { nullScreen: number; answerLeak: number; admission: number; duplicate?: number };
  /** True when the batch came back smaller than `extensionSize`. Still consumed. */
  short: boolean;
  pooledBefore: PooledCounts;
  pooledAfter: PooledCounts;
  verdictBefore: GateOutcome | null;
  verdictAfter: GateOutcome | null;
  /** Set when the batch could not be generated at all. The extension is still consumed. */
  failure?: string;
  /**
   * Free-gate violations found inside the batch. Absent when the batch was
   * clean; NON-EMPTY means this run is refused, at the gate each entry names.
   */
  violations?: readonly ExtensionViolation[];
}

export interface GateLedger {
  order: readonly GateId[];
  records: readonly GateRecord[];
  extensionPolicy: ExtensionPolicy; // persisted BEFORE first call
  refusedAt: GateId | null;
  /** One entry per CONSUMED extension, in order. Absent when none was consumed. */
  extensions?: readonly ExtensionEvidence[];
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type FailureClass =
  | 'protocol-error'
  | 'execution-error-recovered'
  | 'execution-error-fatal'
  | 'mrtr-abandoned'
  | 'schema-validation-reject'
  | 'budget-exhausted';

export interface ToolAttribution {
  tool: string;
  calls: number;
  errors: number;
  failureClasses: Partial<Record<FailureClass, number>>;
  p50Ms: number | null;
  p95Ms: number | null;
  declaredDestructive: boolean; // per spec defaults: destructive unless opted out
  inferredDestructive: boolean | null; // judge signal; null when not run
}

export interface TaskResult {
  taskId: string;
  firstTrySuccess: boolean;
  success: boolean;
  toolCalls: number;
  mrtrRounds: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null; // null when pricing unknown (fail closed)
  failure: FailureClass | null;
  destructiveWithoutConfirmation: number;
}

export interface WilsonInterval {
  rate: number;
  low: number;
  high: number;
  k: number;
  n: number;
}

export interface ScoreBlock {
  runnerModel: string; // pinned; rankings only valid within one runner model
  firstTrySuccess: WilsonInterval;
  eventualSuccess: WilsonInterval;
  meanCallsPerCompletedTask: number | null;
  meanTokensPerCompletedTask: number | null; // net of fixed tool-definition overhead
  meanCostPerCompletedTaskUsd: number | null;
  tools: readonly ToolAttribution[];
  tasks: readonly TaskResult[];
  destructiveWithoutConfirmation: number;
  ambiguousParameters: readonly { tool: string; param: string; why: string; evidence: string }[];
  schemaDrift: { checked: boolean; drifted: boolean; detail: string | null };
  toolSurfaceDeltaByCredential: readonly string[] | null;
}

// ---------------------------------------------------------------------------
// Judge spend
// ---------------------------------------------------------------------------

/** Which judge-tier exchange a metered call belongs to. */
export type JudgePhase = 'synthesis' | 'extension_synthesis' | 'null_screen' | 'rubric';

export interface JudgeUsageByModel {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** null when no price row matched this model id (DESIGN 15: fail closed). */
  estCostUsd: number | null;
}

export interface JudgeUsageByPhase {
  phase: JudgePhase;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

// CONTRACT CHANGE (pipeline, 2026-08-19): the judge's spend was measured
// NOWHERE. Task synthesis, its retries, every extension batch, the null screen
// probes and every rubric check touch neither tape (they happen before the suite
// exists, or beside it), so `trace_stats` cannot see a token of it and the
// operator's ledger was guessing a flat figure per run. DESIGN decision 15 says
// every metric is a finite number or ABSENT, never a wrong one, and a guess is a
// wrong one. This block carries what the API's own usage blocks reported.
// Additive and optional: a run with no judge calls omits it entirely.
export interface JudgeUsageBlock {
  /** The judge model this run pinned. Individual calls name their own model. */
  model: string;
  /** Judge-tier exchanges that returned. Excludes the runner loop (it is on the tape). */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /**
   * Sum over the models that HAVE a price row. null when nothing could be
   * priced. A lower bound (never an over-estimate) when `partial` is true.
   */
  estCostUsd: number | null;
  /** True when some usage could not be priced, so the dollar figure is a floor. */
  partial: boolean;
  /** Responses that carried no `usage` block. Counted as calls, not as tokens. */
  uncountedCalls: number;
  /** Calls that threw before returning usage. Their spend is unknowable. */
  failedCalls: number;
  /** Per model id: the null screen runs on the RUNNER model, never the judge. */
  byModel: readonly JudgeUsageByModel[];
  byPhase: readonly JudgeUsageByPhase[];
  /** Every degraded or partial figure says so out loud. */
  notes: readonly string[];
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type RunOutcome =
  | 'SCORED'
  | 'GATE_FAILED'
  | 'DEGENERATE'
  | 'INDETERMINATE'
  | 'EXTEND_EXHAUSTED'
  | 'COMPROMISED' // oracle error rate > 5% in construct gate
  | 'INSUFFICIENT_SURFACE'; // suite below minimum size

export interface FitnessReportJson {
  schema: 'fitness-report/1';
  server: ServerIdentity;
  run: {
    id: string;
    startedAt: string;
    harnessVersion: string;
    runnerModel: string;
    judgeModel: string;
    suiteHash: string;
    taskBudget: number;
    // CONTRACT CHANGE (2026-08-19): the task generator's version is hashed into
    // suiteHash but a hash cannot be compared or grouped on. Two generator
    // versions produce two different denominators (v1 double-counted the repair
    // pass; v2 counts candidates and screens the numerator), so rows from
    // different generators must never be ranked in one table. That decision
    // needs a field a consumer can key on, at the top level, next to the runner
    // model it already refuses to rank across. Both are optional: v1 records
    // published before this field existed stay readable.
    generatorVersion?: string | null;
    /** True when candidates answerable with no server were deleted pre-hash. */
    nullScreenEnabled?: boolean;
    /**
     * Measured judge spend for this run. Absent when no judge call was made.
     * It is NOT in `trace_stats`, which can only price what reached a tape, so
     * a total for the run is `trace_stats` cost PLUS this.
     */
    judgeUsage?: JudgeUsageBlock;
  };
  probes: ProbeResults;
  gates: GateLedger;
  outcome: RunOutcome;
  /** ABSENT (not null, not zero) unless outcome === 'SCORED'. */
  score?: ScoreBlock;
  rewrites?: readonly {
    tool: string;
    current: string;
    proposed: string;
    causalEvidence: string; // link/description of the recorded failures this caused
  }[];
  traceLinks: { mcp: string; agent: string; viewer: string } | null;
  trace_stats?: unknown; // mcp-tape.stats/1-shaped block
  // CONTRACT CHANGE (integrator, 2026-08-19): src/score/metrics.ts returns
  // honesty notes (unknown model pricing, fallback plane, unattributed calls)
  // as a sibling of ScoreBlock, and ScoreBlock had nowhere to carry them. A
  // report that silently drops "tokens are an upper bound" is not honest, so
  // they get a slot here. Additive and optional.
  scoreNotes?: readonly string[];
  /** Divergences and v0 limitations, rendered verbatim into METHODS copy. */
  methods?: readonly string[];
}
