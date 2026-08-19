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

export type GateId =
  | 'structural'
  | 'answer_leak'
  | 'suite_size'
  | 'plan_power'
  | 'null_baseline'
  | 'construct'
  | 'variance'
  | 'order_invariance'
  | 'protocol_hygiene';

export interface GateRecord {
  gate: GateId;
  ok: boolean;
  costTier: 'free' | 'cheap' | 'paid';
  verdict?: Verdict;
  reason: string; // typed reason string, rendered verbatim in refusals
  detail?: unknown;
}

export interface GateLedger {
  order: readonly GateId[];
  records: readonly GateRecord[];
  extensionPolicy: { extensionSize: number; maxExtensions: number }; // persisted BEFORE first call
  refusedAt: GateId | null;
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
