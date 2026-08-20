/**
 * Report rendering (DESIGN decisions 11, 15, 18).
 *
 * Two outputs from one input: `fitness-report/1` JSON and the markdown a human
 * reads. The load-bearing rule is decision 11: on any gate failure the JSON has
 * NO `score` field. Absent, not null, not zero. `buildReport` is the only place
 * that decides, so no caller can accidentally publish a score for a run whose
 * validity gates refused it.
 *
 * Copy rules (top of DESIGN.md) are enforced here, not left to reviewers:
 * no em-dashes, no A-to-F grades, REFUSED renders AS the result with the gate
 * that stopped it named, and every finding carries the replay link that proves
 * it.
 */

import type {
  ExtensionEvidence,
  ExtensionPolicy,
  FitnessReportJson,
  GateLedger,
  GateRecord,
  JudgeUsageBlock,
  ProbeResults,
  RunOutcome,
  ScoreBlock,
  ServerIdentity,
  Verdict
} from '../types.js';

export const REPORT_SCHEMA = 'fitness-report/1';

/** DESIGN decision 7. Trace URLs must be semicolon-free; the viewer splits on it. */
export function viewerUrl(mcpTraceUrl: string, agentTraceUrl: string): string | null {
  if (mcpTraceUrl.includes(';') || agentTraceUrl.includes(';')) return null;
  const merged = `${encodeURIComponent(mcpTraceUrl)};${encodeURIComponent(agentTraceUrl)}`;
  return `https://mcpreplay.dev/?trace=${merged}#view=calls`;
}

export interface ReportInput {
  runId: string;
  startedAt: string;
  harnessVersion: string;
  runnerModel: string;
  judgeModel: string;
  suiteHash: string;
  taskBudget: number;
  /** Task generator version. Rows from different generators are never ranked together. */
  generatorVersion?: string | null;
  nullScreenEnabled?: boolean;
  /** Measured judge spend. Absent when the run made no judge-tier call. */
  judgeUsage?: JudgeUsageBlock;
  server: ServerIdentity;
  probes: ProbeResults;
  gates: GateLedger;
  outcome: RunOutcome;
  /** Ignored unless `outcome === 'SCORED'` (DESIGN decision 11). */
  score?: ScoreBlock;
  scoreNotes?: readonly string[];
  methods?: readonly string[];
  traceLinks?: { mcp: string; agent: string; viewer: string } | null;
  traceStats?: unknown;
  rewrites?: FitnessReportJson['rewrites'];
}

export function buildReport(input: ReportInput): FitnessReportJson {
  const scored = input.outcome === 'SCORED' && input.score !== undefined;
  const report: FitnessReportJson = {
    schema: REPORT_SCHEMA,
    server: input.server,
    run: {
      id: input.runId,
      startedAt: input.startedAt,
      harnessVersion: input.harnessVersion,
      runnerModel: input.runnerModel,
      judgeModel: input.judgeModel,
      suiteHash: input.suiteHash,
      taskBudget: input.taskBudget,
      // Written whenever the caller knows it. A run whose synthesis threw has
      // no generator to name, and `null` says that rather than guessing.
      ...(input.generatorVersion === undefined ? {} : { generatorVersion: input.generatorVersion }),
      ...(input.nullScreenEnabled === undefined ? {} : { nullScreenEnabled: input.nullScreenEnabled }),
      // Measured, never a per-run guess, and absent when there was nothing to
      // measure. It is NOT in trace_stats: no judge call reaches a tape, so a
      // total for the run is the trace_stats cost plus this one.
      ...(input.judgeUsage === undefined ? {} : { judgeUsage: input.judgeUsage })
    },
    probes: input.probes,
    gates: input.gates,
    outcome: input.outcome,
    // The refusal contract: the key itself is absent on anything but SCORED.
    ...(scored ? { score: input.score as ScoreBlock } : {}),
    ...(input.rewrites !== undefined ? { rewrites: input.rewrites } : {}),
    traceLinks: input.traceLinks ?? null,
    ...(input.traceStats !== undefined ? { trace_stats: input.traceStats } : {}),
    ...(input.scoreNotes !== undefined && input.scoreNotes.length > 0 ? { scoreNotes: input.scoreNotes } : {}),
    ...(input.methods !== undefined && input.methods.length > 0 ? { methods: input.methods } : {})
  };
  return report;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function interval(w: { rate: number; low: number; high: number; k: number; n: number }): string {
  return `${pct(w.rate)} (${w.k} of ${w.n}), 95% interval ${pct(w.low)} to ${pct(w.high)}`;
}

function num(v: number | null, digits = 2): string {
  return v === null || !Number.isFinite(v) ? 'not available' : v.toFixed(digits);
}

function verdictLine(v: Verdict): string {
  return (
    `${v.outcome}: ${v.k} of ${v.n} against a threshold of ${v.threshold}, ` +
    `p = ${v.pValue.toExponential(2)}, alpha = ${v.alpha}`
  );
}

function probeMark(pass: boolean | null): string {
  if (pass === null) return 'could not check';
  return pass ? 'pass' : 'FAIL';
}

/** The refused-run headline. Never an error, never a missing row (decision 11). */
export function refusalHeadline(report: FitnessReportJson): string {
  const gate = report.gates.refusedAt;
  const record = gate === null ? undefined : report.gates.records.find((r) => r.gate === gate);
  const where = gate === null ? 'an unnamed gate' : `the ${gate.replace(/_/g, ' ')} gate`;
  const reason = record === undefined ? '' : ` Reason: ${record.reason}.`;
  return `REFUSED (${report.outcome}). This run stopped at ${where}.${reason}`;
}

function gateRow(record: GateRecord): string {
  const status = record.ok ? 'pass' : 'REFUSED';
  // Separated, because the two are different statements about the same gate:
  // `reason` is the typed refusal string and `verdict` is the counts it came
  // from. Run together they read as one sentence asserting both.
  const verdict = record.verdict === undefined ? '' : `; ${verdictLine(record.verdict)}`;
  return `| ${record.gate} | ${record.costTier} | ${status} | ${record.reason}${verdict} |`;
}

/**
 * The extension protocol, described as the thing that RUNS.
 *
 * The v0 copy said no extension batch is ever run, which stopped being true the
 * day the loop landed, and a methods section that describes a procedure the run
 * did not perform is the same defect in the other direction. Every number here
 * comes off the persisted pre-registration, so the copy cannot drift from the
 * policy the run actually committed to before its first model call.
 */
export function extensionCopy(gates: GateLedger): string[] {
  const { extensionSize, maxExtensions } = gates.extensionPolicy;
  if (maxExtensions === 0 || extensionSize === 0) {
    return [
      'Extension policy, fixed before the first model call: no extension batches. A gate the data cannot ' +
        'resolve resolves immediately and the run is refused rather than extended.'
    ];
  }
  const consumed = gates.extensions ?? [];
  const lines = [
    `Extension policy, fixed before the first model call: ${extensionSize} new tasks per extension, at most ` +
      `${maxExtensions}. An under-resolved gate buys one batch from the same generator at a derived seed, past the ` +
      'same free gates and the same null baselines, run at the same reps. The verdict is then the three-outcome ' +
      'rule applied to the POOLED counts, and the score covers the pooled suite. After the last extension an ' +
      'unresolved gate resolves to FAIL. The size and the maximum are not operator settings and a suite ' +
      'regenerated outside this protocol is a new run, never a retry.',
    'The free gates screen a bought batch with the SAME consequences they carry on the registered suite. An ' +
      'answer key an agent could read, or a task that violates the structural property, refuses the whole run and ' +
      'names the batch and the task. Ordinary admission drops, generation-time null screen deletions, and tasks ' +
      'that restate one already in the pool are dropped and counted, never refused.'
  ];
  if (consumed.length === 0) {
    lines.push('No extension was consumed on this run.');
    return lines;
  }
  lines.push('');
  lines.push('| extension | seed | tasks pooled | pooled before | pooled after | note |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const e of consumed) {
    lines.push(
      `| ${e.index} of ${maxExtensions} | ${e.seed} | ${e.admitted} of ${e.generated}${e.short ? ' (short)' : ''} | ` +
        `${e.pooledBefore.k} of ${e.pooledBefore.n}${e.verdictBefore === null ? '' : `, ${e.verdictBefore}`} | ` +
        `${e.pooledAfter.k} of ${e.pooledAfter.n}${e.verdictAfter === null ? '' : `, ${e.verdictAfter}`} | ` +
        `${cell(extensionNote(e))} |`
    );
  }
  return lines;
}

/**
 * Why a batch produced what it produced.
 *
 * A batch that could not be generated at all, and a batch voided by a free-gate
 * violation, both publish as `0 of 0` or `0 of 6` in the counts. Without this
 * the reader sees an unexplained short row and the most important thing the
 * extension protocol can find (the generator handed us a leaking task) is
 * legible only to someone who opens the JSON.
 */
export function extensionNote(e: ExtensionEvidence): string {
  const notes: string[] = [];
  if (typeof e.failure === 'string' && e.failure.length > 0) {
    notes.push(`batch not generated: ${e.failure}`);
  }
  for (const violation of e.violations ?? []) {
    notes.push(`REFUSED at ${violation.gate}: ${violation.taskId}, ${violation.reason}`);
  }
  const duplicate = e.dropped.duplicate ?? 0;
  if (duplicate > 0) {
    notes.push(`${duplicate} task(s) already in the pool, dropped as duplicates`);
  }
  if (e.dropped.admission > 0) notes.push(`${e.dropped.admission} dropped at admission`);
  if (e.dropped.nullScreen > 0) notes.push(`${e.dropped.nullScreen} deleted by the null screen`);
  return notes.length === 0 ? 'clean batch' : notes.join('; ');
}

/** Table-cell safe: no pipes, no newlines. The text itself is never rewritten. */
function cell(text: string): string {
  return text.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
}

/** Judge spend, which no tape can see and which the site adds to the trace cost. */
function judgeUsageLines(usage: JudgeUsageBlock): string[] {
  const cost =
    usage.estCostUsd === null
      ? 'not available (no price row matched, failing closed)'
      : `$${usage.estCostUsd.toFixed(4)}${usage.partial ? ' (lower bound)' : ''}`;
  return [
    `- Judge spend: ${usage.calls} call(s), ${usage.inputTokens} input and ${usage.outputTokens} output tokens, ${cost}`,
    // A figure the run itself calls a lower bound cannot be handed to the next
    // sentence as a component of a total. When any judge call went unpriced,
    // returned no usage, or failed, the only honest arithmetic downstream is a
    // floor, and the sentence has to say floor in both halves.
    usage.estCostUsd === null
      ? '- Judge spend is measured from the API usage blocks and is NOT in the trace statistics. It could not be priced here, so no total for this run can be stated.'
      : usage.partial
        ? `- Judge spend is measured from the API usage blocks and is NOT in the trace statistics. This figure is a lower bound${usage.uncountedCalls > 0 ? `, ${usage.uncountedCalls} call(s) reported no usage` : ''}${usage.failedCalls > 0 ? `, ${usage.failedCalls} call(s) failed` : ''}, so a run total is AT LEAST the trace cost plus $${usage.estCostUsd.toFixed(4)}.`
        : `- Judge spend is measured from the API usage blocks and is NOT in the trace statistics. A total for this run is the trace cost plus $${usage.estCostUsd.toFixed(4)}.`
  ];
}

function ledgerTable(gates: GateLedger): string[] {
  const lines = [
    '| gate | cost | result | reason |',
    '| --- | --- | --- | --- |',
    ...gates.records.map(gateRow)
  ];
  if (gates.records.length === 0) lines.push('| (none ran) | | | |');
  return lines;
}

export function renderMarkdown(report: FitnessReportJson): string {
  const out: string[] = [];
  const s = report.server;

  out.push(`# Fitness Report: ${s.slug}`);
  out.push('');
  out.push(
    'Conformance asks whether the server speaks MCP correctly. ' +
      'Fitness Report asks whether an agent can actually get the job done with it.'
  );
  out.push('');

  if (report.outcome === 'SCORED') {
    out.push(`## Result: SCORED`);
  } else {
    out.push(`## Result: REFUSED`);
    out.push('');
    out.push(refusalHeadline(report));
  }
  out.push('');

  out.push('## Server');
  out.push('');
  out.push(`- URL: ${s.url}`);
  out.push(`- Protocol era: ${s.era}, negotiated ${s.negotiatedVersion ?? 'nothing'}`);
  out.push(`- Transport: ${s.transportShape === 'sse' ? 'SSE framed' : 'plain JSON'}, ${s.sessionful ? 'session-ful' : 'stateless'}`);
  out.push(`- Credential context: ${s.credentialContext}`);
  out.push('');

  out.push('## Run');
  out.push('');
  out.push(`- Run id: ${report.run.id}`);
  out.push(`- Started: ${report.run.startedAt}`);
  out.push(`- Runner model: ${report.run.runnerModel} (rankings are only valid within one runner model)`);
  out.push(`- Judge model: ${report.run.judgeModel}`);
  out.push(`- Suite hash: ${report.run.suiteHash}`);
  out.push(`- Task budget: ${report.run.taskBudget} tokens`);
  if (report.run.judgeUsage !== undefined) out.push(...judgeUsageLines(report.run.judgeUsage));
  out.push('');

  out.push('## Validity gates');
  out.push('');
  out.push(
    `Gates are PRICED cheapest first: free, then cheap, then paid, then the full drive. ` +
      `The rows below are listed in the order each gate was DECIDED, which is not the same thing: ` +
      `the null baselines are measured in the cheap tier, but their kill rule needs a real signal to ` +
      `compare the noise floor against, so that row is recorded after the first pass that produces one.`
  );
  out.push('');
  out.push(...extensionCopy(report.gates));
  out.push('');
  out.push(...ledgerTable(report.gates));
  out.push('');

  out.push('## Protocol probes');
  out.push('');
  out.push(`Negotiated revision: ${report.probes.specCurrency ?? 'unknown'}`);
  out.push('');
  out.push('| finding | result | detail |');
  out.push('| --- | --- | --- |');
  for (const finding of report.probes.findings) {
    out.push(`| ${finding.id} | ${probeMark(finding.pass)} | ${finding.detail.replace(/\|/g, '/')} |`);
  }
  out.push('');

  if (report.score !== undefined) {
    const score = report.score;
    out.push('## Score');
    out.push('');
    out.push(`- First-try task success: ${interval(score.firstTrySuccess)}`);
    out.push(`- Eventual task success: ${interval(score.eventualSuccess)}`);
    out.push(`- Mean tool calls per completed task: ${num(score.meanCallsPerCompletedTask)}`);
    out.push(`- Mean tokens per completed task (net of tool-definition overhead): ${num(score.meanTokensPerCompletedTask, 0)}`);
    out.push(`- Mean cost per completed task: ${score.meanCostPerCompletedTaskUsd === null ? 'not available (unknown pricing, failing closed)' : `$${score.meanCostPerCompletedTaskUsd.toFixed(4)}`}`);
    out.push(`- Destructive calls with no confirmation in front of them: ${score.destructiveWithoutConfirmation}`);
    out.push('');
    out.push('Overlapping intervals are indistinguishable. Do not read an ordering into them.');
    out.push('');

    if (score.tools.length > 0) {
      out.push('### Per-tool attribution');
      out.push('');
      out.push('| tool | calls | errors | p50 ms | p95 ms | declared destructive |');
      out.push('| --- | --- | --- | --- | --- | --- |');
      for (const tool of score.tools) {
        out.push(
          `| ${tool.tool} | ${tool.calls} | ${tool.errors} | ${tool.p50Ms ?? 'n/a'} | ${tool.p95Ms ?? 'n/a'} | ${tool.declaredDestructive ? 'yes' : 'no'} |`
        );
      }
      out.push('');
    }

    if (score.tasks.length > 0) {
      out.push('### Per-task results');
      out.push('');
      out.push('| task | first try | eventual | tool calls | failure |');
      out.push('| --- | --- | --- | --- | --- |');
      for (const task of score.tasks) {
        out.push(
          `| ${task.taskId} | ${task.firstTrySuccess ? 'pass' : 'no'} | ${task.success ? 'pass' : 'no'} | ${task.toolCalls} | ${task.failure ?? 'none'} |`
        );
      }
      out.push('');
    }
  } else {
    out.push('## Score');
    out.push('');
    out.push(
      'No score. The eval did not clear its own validity gates, so publishing a number ' +
        'would be publishing a number about nothing. The refusal is the result.'
    );
    out.push('');
  }

  if (report.traceLinks !== null) {
    out.push('## Evidence');
    out.push('');
    out.push(`- MCP plane recording: ${report.traceLinks.mcp}`);
    out.push(`- Agent plane recording: ${report.traceLinks.agent}`);
    out.push(`- Replay both together: ${report.traceLinks.viewer}`);
    out.push('');
  }

  if (report.scoreNotes !== undefined && report.scoreNotes.length > 0) {
    out.push('## Honesty notes');
    out.push('');
    for (const note of report.scoreNotes) out.push(`- ${note}`);
    out.push('');
  }

  if (report.methods !== undefined && report.methods.length > 0) {
    out.push('## Methods');
    out.push('');
    for (const note of report.methods) out.push(`- ${note}`);
    out.push('');
  }

  return out.join('\n');
}

/**
 * The v0 methods copy every run carries. These are the divergences and the
 * limitations we own publicly (DESIGN decisions 10, 11, 12, 8, 19).
 *
 * The extension paragraphs describe the protocol that NOW RUNS. They are
 * deliberately specific about what it cannot be used for: the size and the
 * maximum are fixed in the pre-registration alongside n, an unresolved gate
 * resolves to FAIL after the last extension, and a suite regenerated outside
 * the protocol is a NEW run. No em-dashes: this text reaches the site.
 *
 * THE POLICY NUMBERS ARE AN ARGUMENT, never literals in this file. The
 * pre-registration is one frozen constant in the pipeline; prose that restated
 * it was free to disagree with it, and a pre-registration the published copy
 * contradicts is not a pre-registration. Callers pass the same object the run
 * persisted into its own record, so the sentence and the behaviour move
 * together or not at all.
 */
export function defaultMethodsNotes(policy: ExtensionPolicy): string[] {
  const { extensionSize, maxExtensions } = policy;
  const registered =
    maxExtensions === 0 || extensionSize === 0
      ? 'Extension protocol, pre-registered before the first model call: no extension batches at all. A gate the registered suite cannot resolve is resolved on its first evaluation and the run is refused rather than extended.'
      : `Extension protocol, pre-registered before the first model call: ${extensionSize} new tasks per extension, at most ${maxExtensions}. When the construct gate returns EXTEND, one batch is generated by the same generator at a derived seed, screened by the same free gates and measured by the same three null baselines, and run at the same reps. Successes and trials are then POOLED across the original suite and every consumed extension, and the three-outcome rule is re-applied to the pooled counts.`;
  return [
    'Construct gate denominator diverges from evalgate: reference-agent errors count, and an error rate above 5% resolves to COMPROMISED rather than silently shrinking n.',
    'A published PASS additionally requires the Wilson 95% lower bound to clear the threshold, or an n the design was sized for. Otherwise the verdict downgrades to EXTEND.',
    registered,
    'The free gates screen a bought batch with the SAME consequences they carry on the registered suite. An answer key that reaches the answering model (through a batch task prompt, its bound parameters, the server instructions or a tool description) refuses the run, and so does a batch task that violates the structural property the run depends on, which is an unbound placeholder left in the rendered prompt or an empty prompt. The refusal names the batch and the offending task. A leak or a property violation inside a batch bought to resolve a gate is evidence about the generator, not a task to quietly discard, and the batch is voided whole rather than mined for its clean tasks.',
    'Three findings inside a batch are DROPS and not refusals, each counted per batch in the run record: a task naming a tool the server does not expose (ordinary admission), a candidate the generation-time null screen deleted, and a task that restates one already in the pool. The duplicate rule is content level, not id level: two tasks are the same task when their rendered prompts agree after whitespace collapsing and case folding and their expected tools and their success check agree. Without it the deterministic e-index id prefix would hide the collision and a restated task would inflate the pooled n with a trial that is perfectly correlated with one already counted.',
    'EXTEND is not a loophole. The extension size and the maximum number of extensions are fixed in the pre-registration alongside n; after the last extension an unresolved gate resolves to FAIL, not to another extension and not to a missing row. There is no optional stopping: a run completes its registered size or is void, and a task suite regenerated outside this protocol is a NEW run with a new suite hash, never a retry.',
    'When a run extends and the pooled gate passes, the drive and the score cover the FULL pooled suite. Extension tasks are recorded under their own correlation ids exactly like original tasks, and the published suite hash covers the pooled set with the per-batch lineage in suite-meta.json.',
    'Judge spend (task synthesis and its retries, every extension batch, the generation-time null screen probes, and every rubric check) reaches neither tape, so the trace statistics cannot price it. It is measured from the API usage blocks and published as run.judgeUsage. A total for a run is the trace cost plus that figure.',
    'Destructive-without-confirmation, v0 rule: a tool is destructive unless it declares readOnlyHint true or destructiveHint false, and every executed call to such a tool counts. The only thing that clears one is recorded evidence that the server asked about that same tool before that same call ran. Confirmation is never inherited from another tool or from elsewhere in the task.',
    'Construct gate: the reference agent is told the answer, so a text check alone would pass against a dead server. A reference pass counts only when it also landed a successful call on a tool the task expects.',
    'Multi-round tool input (MRTR) is recorded and then declined in v0. A server that asks for input gets an mrtr-abandoned datum, never a fabricated answer.',
    'Each task runs under an advisory task budget, so a trapping server yields budget exhausted as a clean unrecoverable-path datum rather than an unbounded bill.',
    'Prior art: MCPEval for generated task suites, evalgate for the gate math, mcp-tape for the recording format. Our delta is refusal, signed replays, and causal rewrite diffs.'
  ];
}
