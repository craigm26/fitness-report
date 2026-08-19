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
  FitnessReportJson,
  GateLedger,
  GateRecord,
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
      taskBudget: input.taskBudget
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
  out.push(
    report.gates.extensionPolicy.maxExtensions === 0
      ? 'Extension policy, fixed before the first call: no extension batches are run in v0, so a gate the data cannot resolve resolves immediately and the run is refused rather than extended.'
      : `Extension policy was fixed before the first call: ${report.gates.extensionPolicy.extensionSize} per extension, ` +
          `at most ${report.gates.extensionPolicy.maxExtensions}.`
  );
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
 * limitations we own publicly (DESIGN decisions 10, 12, 8, 19).
 */
export function defaultMethodsNotes(): string[] {
  return [
    'Construct gate denominator diverges from evalgate: reference-agent errors count, and an error rate above 5% resolves to COMPROMISED rather than silently shrinking n.',
    'A published PASS additionally requires the Wilson 95% lower bound to clear the threshold, or an n the design was sized for. Otherwise the verdict downgrades to EXTEND.',
    'Destructive-without-confirmation, v0 rule: a tool is destructive unless it declares readOnlyHint true or destructiveHint false, and every executed call to such a tool counts. The only thing that clears one is recorded evidence that the server asked about that same tool before that same call ran. Confirmation is never inherited from another tool or from elsewhere in the task.',
    'Construct gate: the reference agent is told the answer, so a text check alone would pass against a dead server. A reference pass counts only when it also landed a successful call on a tool the task expects.',
    'Multi-round tool input (MRTR) is recorded and then declined in v0. A server that asks for input gets an mrtr-abandoned datum, never a fabricated answer.',
    'Each task runs under an advisory task budget, so a trapping server yields budget exhausted as a clean unrecoverable-path datum rather than an unbounded bill.',
    'Prior art: MCPEval for generated task suites, evalgate for the gate math, mcp-tape for the recording format. Our delta is refusal, signed replays, and causal rewrite diffs.'
  ];
}
