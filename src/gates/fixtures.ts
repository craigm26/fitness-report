/**
 * Known-invalid MCP task suites, so the gates themselves can be tested.
 *
 * A validity gate is untested code. You write one, it passes, and you have
 * learned nothing unless you know it would have failed on a suite that
 * deserved to fail. Almost nobody publishes their invalid environments, so
 * there is nothing to test a gate against. These are ours, MCP native, and
 * they are the fixture bed the canary server (DESIGN decision 16) exists to
 * reproduce against a real transport.
 *
 * Four known-bad suites:
 *
 *   unsolvable_task    the task needs a tool the server does not expose
 *   answer_in_prompt   the answer key is printed in the prompt
 *   null_passable      a model with NO tools answers it from priors
 *   scorer_disagrees   the answer key is not the answer the agent reaches
 *
 * plus two valid controls, so a gate that rejects everything scores zero:
 *
 *   handle_chain          create returns a handle, a later tool consumes it
 *   calibrated_variance   ambiguous parameter name, real error variance
 *
 * THE POINT OF `scorer_disagrees`.
 * It satisfies every structural property the valid fixtures satisfy over any
 * number of seeds: the tool exists, nothing leaks, the prompt is coherent. It
 * is invalid anyway, because the answer key and the agent disagree. If a FREE
 * check flags it, that check is wrong about something else, because nothing in
 * the generated text distinguishes it from a valid suite. That is the finding:
 * a gate can be rigorous, reproducible, and confirm the wrong thing. Only the
 * construct gate reaches it, and here only through the SIMULATED oracle: a
 * genuine scorer/model disagreement cannot be synthesized analytically. This
 * fixture verifies the gate's WIRING, that it calls the oracle, compares, and
 * refuses on mismatch. The construct gate itself must still run against the
 * real judge, the real server and the real suite, every time.
 *
 * Zero model calls. Zero network. Deterministic given a seed.
 */

import type { FitnessTask } from '../types.js';
import { construct } from './construct.js';
import { nullBaselineGate } from './nulls.js';
import { seededRandom } from './order.js';
import { structural } from './structural.js';

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

export interface FixtureTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: readonly string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/**
 * One generated task instance plus the server surface it was generated against.
 *
 * A checker may reason over `tools` and `task`. The underscore fields are what
 * a real drive WOULD produce; they are not visible in the prompt and no free
 * check may read them. They exist so the simulated oracles can stand in for
 * paid model calls in tests.
 */
export interface FixtureCase {
  seed: number;
  /** the server's advertised tools/list surface for this case */
  tools: readonly FixtureTool[];
  task: FitnessTask;
  /** what the suite's scorer calls correct */
  intended: string;
  /** what a reference agent concludes with FULL information and a working server */
  _agentAnswer: string;
  /** what the agent concludes on the real drive, manipulation and all */
  _experimentalAnswer: string;
  /** what a null model (no tools, or a stubbed-empty server) answers */
  _nullAnswer: string;
}

/** The cheapest gate tier that reliably reaches a given known-bad suite. */
export type FixtureCatch = 'structural' | 'null' | 'construct' | 'variance';

export interface Fixture {
  name: string;
  valid: boolean;
  catchableBy: FixtureCatch | null;
  why: string;
  origin: string;
  makeCase: (seed: number) => FixtureCase;
}

/** A structural gate runs for free. Everything else costs calls. */
export function freeToCatch(f: Fixture): boolean {
  return f.catchableBy === 'structural';
}

// ---------------------------------------------------------------------------
// the server surface these suites were generated against
// ---------------------------------------------------------------------------

const obj = (
  properties: Record<string, unknown>,
  required: readonly string[],
): FixtureTool['inputSchema'] => ({ type: 'object', properties, required });

export const FIXTURE_TOOLS: readonly FixtureTool[] = [
  {
    name: 'search_docs',
    description: 'Search the product documentation and return matching passages.',
    inputSchema: obj({ query: { type: 'string' } }, ['query']),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_invoice',
    description: 'Fetch one invoice by its id. Returns the line items and the total.',
    inputSchema: obj({ invoice_id: { type: 'string' } }, ['invoice_id']),
    annotations: { readOnlyHint: true },
  },
  {
    // decision 16: `user` is the ambiguous parameter name; the fix is user_id.
    name: 'lookup_user',
    description: 'Look up a user account.',
    inputSchema: obj({ user: { type: 'string' } }, ['user']),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_ticket',
    description: 'Open a support ticket. Returns the new ticket id.',
    inputSchema: obj({ subject: { type: 'string' } }, ['subject']),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'attach_invoice',
    description: 'Attach an invoice to an existing ticket, by ticket id and invoice id.',
    inputSchema: obj({ ticket_id: { type: 'string' }, invoice_id: { type: 'string' } }, [
      'ticket_id',
      'invoice_id',
    ]),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

// ---------------------------------------------------------------------------
// generators
// ---------------------------------------------------------------------------

function pick<T>(rand: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rand() * xs.length) % xs.length];
}

function money(rand: () => number): string {
  const dollars = 1000 + Math.floor(rand() * 9000);
  const cents = Math.floor(rand() * 100);
  return `${dollars}.${String(cents).padStart(2, '0')}`;
}

function invoiceId(rand: () => number): string {
  return `INV-${3000 + Math.floor(rand() * 6000)}`;
}

/** unsolvable: the task needs `get_weather`, which this server does not expose. */
function makeUnsolvableTask(seed: number): FixtureCase {
  const rand = seededRandom(seed + 101);
  const office = pick(rand, ['Sydney', 'Lisbon', 'Denver', 'Osaka']);
  const answer = `overcast, ${12 + Math.floor(rand() * 10)} degrees`;
  const task: FitnessTask = {
    id: `unsolvable-${seed}`,
    prompt: `Report the current conditions outside the ${office} billing office.`,
    expectedTools: ['get_weather'],
    check: { kind: 'substring', where: 'final_text', value: answer },
    answerKey: answer,
    destructive: false,
  };
  return {
    seed,
    tools: FIXTURE_TOOLS,
    task,
    intended: answer,
    _agentAnswer: 'UNANSWERABLE',
    _experimentalAnswer: 'UNANSWERABLE',
    _nullAnswer: 'UNANSWERABLE',
  };
}

/** answer leak: the total the task asks for is printed in the task. */
function makeAnswerInPrompt(seed: number): FixtureCase {
  const rand = seededRandom(seed + 202);
  const id = invoiceId(rand);
  const total = money(rand);
  const task: FitnessTask = {
    id: `leak-${seed}`,
    prompt: `Invoice ${id} should come to ${total}. Look it up and report its total.`,
    expectedTools: ['get_invoice'],
    check: { kind: 'substring', where: 'final_text', value: total },
    answerKey: total,
    destructive: false,
  };
  return {
    seed,
    tools: FIXTURE_TOOLS,
    task,
    intended: total,
    _agentAnswer: total,
    // a model with no tools at all reads it straight off the prompt
    _nullAnswer: total,
    _experimentalAnswer: total,
  };
}

/** null passable: the answer is in the model's priors, so the server is irrelevant. */
function makeNullPassable(seed: number): FixtureCase {
  const rand = seededRandom(seed + 303);
  const [code, description] = pick(rand, [
    ['404', 'a resource that does not exist'],
    ['200', 'a request that succeeded'],
    ['301', 'a permanently moved resource'],
    ['429', 'a client that is being rate limited'],
  ] as const);
  const task: FitnessTask = {
    id: `null-passable-${seed}`,
    prompt: `Which HTTP status code does this API return for ${description}? Confirm with the docs.`,
    expectedTools: ['search_docs'],
    check: { kind: 'substring', where: 'final_text', value: code },
    answerKey: code,
    destructive: false,
  };
  return {
    seed,
    tools: FIXTURE_TOOLS,
    task,
    intended: code,
    _agentAnswer: code,
    // the whole failure: no tools, right answer
    _nullAnswer: code,
    _experimentalAnswer: code,
  };
}

/** scorer disagrees: the answer key is stale, the server has moved on. */
function makeScorerDisagrees(seed: number): FixtureCase {
  const rand = seededRandom(seed + 404);
  const id = invoiceId(rand);
  const staleKey = money(rand);
  const liveTotal = money(rand);
  const task: FitnessTask = {
    id: `scorer-disagrees-${seed}`,
    prompt: `Look up invoice ${id} and report its total.`,
    expectedTools: ['get_invoice'],
    check: { kind: 'substring', where: 'final_text', value: staleKey },
    answerKey: staleKey,
    destructive: false,
  };
  return {
    seed,
    tools: FIXTURE_TOOLS,
    task,
    intended: staleKey,
    // structurally invisible: the agent reads what the server actually returns
    _agentAnswer: liveTotal,
    _experimentalAnswer: liveTotal,
    _nullAnswer: 'I do not have access to that invoice.',
  };
}

/** valid control: handle chaining, with the error variance a real chain has. */
function makeHandleChain(seed: number): FixtureCase {
  const rand = seededRandom(seed + 505);
  const invoice = invoiceId(rand);
  const ticket = `TKT-${4000 + Math.floor(rand() * 5000)}`;
  const task: FitnessTask = {
    id: `handle-chain-${seed}`,
    prompt:
      `Open a support ticket for a billing dispute about invoice ${invoice}, ` +
      'attach that invoice to the new ticket, and report the ticket id.',
    expectedTools: ['create_ticket', 'attach_invoice'],
    check: { kind: 'tool_called', tool: 'attach_invoice' },
    answerKey: ticket,
    destructive: false,
  };
  // a two step chain drops the handle sometimes. That is signal, not noise.
  const dropped = rand() < 1 / 8;
  return {
    seed,
    tools: FIXTURE_TOOLS,
    task,
    intended: ticket,
    _agentAnswer: ticket,
    _experimentalAnswer: dropped ? 'TKT-UNKNOWN' : ticket,
    _nullAnswer: 'I cannot open tickets without tools.',
  };
}

/** valid control: real error variance, from the ambiguous `user` parameter. */
function makeCalibratedVariance(seed: number): FixtureCase {
  const rand = seededRandom(seed + 606);
  const person = pick(rand, ['dana', 'rui', 'mira', 'omar', 'sena']);
  const uid = `U-${7000 + Math.floor(rand() * 2000)}`;
  const email = `${person}@example.com`;
  const task: FitnessTask = {
    id: `calibrated-${seed}`,
    prompt: `Look up the account with id ${uid} and report the email address on it.`,
    expectedTools: ['lookup_user'],
    check: { kind: 'substring', where: 'final_text', value: email },
    answerKey: email,
    destructive: false,
  };
  // `lookup_user(user)` invites a display name where an id belongs; the source
  // project measured 13 errors in 48 on the equivalent environment.
  const confused = rand() < 13 / 48;
  return {
    seed,
    tools: FIXTURE_TOOLS,
    task,
    intended: email,
    _agentAnswer: email,
    _experimentalAnswer: confused ? `${person}@example.org` : email,
    _nullAnswer: 'unknown@example.com',
  };
}

export const FIXTURES: readonly Fixture[] = [
  {
    name: 'unsolvable_task',
    valid: false,
    catchableBy: 'structural',
    why: 'The task requires a tool the server does not expose, so no agent can complete it and the score measures the generator.',
    origin: 'synthesis against a stale tools/list snapshot',
    makeCase: makeUnsolvableTask,
  },
  {
    name: 'answer_in_prompt',
    valid: false,
    catchableBy: 'structural',
    why: 'The answer key appears verbatim in the prompt, so the task is passable without touching the server.',
    origin: 'judge model echoing its own worked example into the task text',
    makeCase: makeAnswerInPrompt,
  },
  {
    name: 'null_passable',
    valid: false,
    catchableBy: 'null',
    why: 'The answer is in the model priors. Structurally sound, nothing leaks, and a no-tools baseline still passes it.',
    origin: 'doc-search servers whose docs restate widely known facts',
    makeCase: makeNullPassable,
  },
  {
    name: 'scorer_disagrees',
    valid: false,
    catchableBy: 'construct',
    why: 'The answer key is self consistent but is not what the agent reaches from the live server. Structurally indistinguishable from a valid suite, which is exactly why it is dangerous.',
    origin: 'FOIL TURN-1, whose structural gate passed over 200 seeds',
    makeCase: makeScorerDisagrees,
  },
  {
    name: 'handle_chain',
    valid: true,
    catchableBy: null,
    why: 'Stateful two step task: create returns a handle, a later tool consumes it. Real but modest error variance.',
    origin: 'canary create_ticket plus attach_invoice',
    makeCase: makeHandleChain,
  },
  {
    name: 'calibrated_variance',
    valid: true,
    catchableBy: null,
    why: 'Answerable, decisive, with real error variance driven by an ambiguous parameter name.',
    origin: 'canary lookup_user(user); FOIL PID-2 error rate',
    makeCase: makeCalibratedVariance,
  },
];

export function names(): string[] {
  return FIXTURES.map((f) => f.name);
}

export function get(name: string): Fixture {
  const f = FIXTURES.find((x) => x.name === name);
  if (!f) throw new Error(`no fixture ${JSON.stringify(name)}; have ${names().join(', ')}`);
  return f;
}

// ---------------------------------------------------------------------------
// the free checks these fixtures exist to exercise
// ---------------------------------------------------------------------------

/** The answer key as text, or null when there is nothing checkable. */
export function answerKeyText(task: FitnessTask): string | null {
  const k = task.answerKey;
  if (k === null || k === undefined) return null;
  if (typeof k === 'string') return k;
  if (typeof k === 'number' || typeof k === 'boolean') return String(k);
  try {
    return JSON.stringify(k) ?? null;
  } catch {
    return null;
  }
}

/** DESIGN decision 11, FREE tier: the answer-leak string check. */
export function answerLeaks(task: FitnessTask): boolean {
  const key = answerKeyText(task)?.trim();
  if (!key || key.length < 3) return false;
  return task.prompt.toLowerCase().includes(key.toLowerCase());
}

/**
 * Reference FREE check: every expected tool exists on the advertised surface,
 * at least one tool is expected, and the answer key does not leak into the
 * prompt. Rejects both structural failures, passes all valid controls, and
 * passes `null_passable` and `scorer_disagrees`, as any free check must.
 */
export function structurallySound(c: FixtureCase): boolean {
  const surface = new Set(c.tools.map((t) => t.name));
  if (c.task.expectedTools.length === 0) return false;
  if (!c.task.expectedTools.every((t) => surface.has(t))) return false;
  if (answerLeaks(c.task)) return false;
  return true;
}

export function defaultStructuralCheck(
  makeCase: (seed: number) => FixtureCase,
  n = 200,
): boolean {
  return structural(makeCase, structurallySound, { n }).ok;
}

// ---------------------------------------------------------------------------
// simulated oracles: stand-ins for paid calls
// ---------------------------------------------------------------------------

/** Full information, working server, no manipulation. For the construct gate. */
export function simulatedOracle(c: FixtureCase): string {
  return c._agentAnswer;
}

/** The real drive, manipulation and all. For the variance gate. */
export function simulatedExperimentalOracle(c: FixtureCase): string {
  return c._experimentalAnswer;
}

/** A null model: no tools, or a stubbed-empty server. For the null gate. */
export function simulatedNullOracle(c: FixtureCase): string {
  return c._nullAnswer;
}

/** What the suite's scorer calls correct. */
export function truth(c: FixtureCase): string {
  return c.intended;
}

/**
 * Reference check across the FREE, CHEAP and PAID tiers in DESIGN decision
 * 11's cost order. Returns true when the suite is considered valid. Uses the
 * simulated oracles, so it costs nothing and reaches every fixture here.
 */
export async function defaultFullCheck(
  makeCase: (seed: number) => FixtureCase,
  n = 200,
): Promise<boolean> {
  // FREE
  if (!defaultStructuralCheck(makeCase, n)) return false;

  const cases = Array.from({ length: 24 }, (_, i) => makeCase(i));

  // CHEAP: null baselines. INDETERMINATE halts exactly like KILL.
  const nullK = cases.filter((c) => simulatedNullOracle(c) === truth(c)).length;
  const signalK = cases.filter((c) => simulatedExperimentalOracle(c) === truth(c)).length;
  const nb = nullBaselineGate({
    signal: { k: signalK, n: cases.length },
    nulls: [{ label: 'no-tools', k: nullK, n: cases.length }],
  });
  if (!nb.ok) return false;

  // PAID: construct validity.
  const cg = await construct(simulatedOracle, cases, truth, { reps: 1, maxWorkers: 4 });
  return cg.ok;
}

// ---------------------------------------------------------------------------
// the audit
// ---------------------------------------------------------------------------

export type FixtureCheck = (
  makeCase: (seed: number) => FixtureCase,
  n: number,
) => boolean | Promise<boolean>;

export interface AuditOptions {
  /** seeds the check is invited to use. Default 200. */
  n?: number;
  /** which tiers the check under audit actually runs. Default: structural only. */
  reachableBy?: readonly FixtureCatch[];
}

export interface AuditReport {
  caught: readonly string[];
  missed: readonly string[];
  falseAlarms: readonly string[];
  passedValid: readonly string[];
  errors: readonly { name: string; detail: string }[];
  /** invalid fixtures no gate in `reachableBy` can see. Not counted against the check. */
  unreachable: readonly string[];
  reachableMissed: readonly string[];
  nReachableInvalid: number;
  reachableBy: readonly FixtureCatch[];
  ok: boolean;
  summary: string;
}

/**
 * Run a validity check against every fixture.
 *
 * check -- takes a `makeCase(seed) -> FixtureCase` generator and the seed
 *          budget, returns true if it considers that suite VALID. It must not
 *          read the underscore fields.
 *
 * `ok` means: no reachable invalid suite was missed, no valid suite was
 * flagged, and nothing threw. A check that rejects everything scores zero,
 * because the two valid controls become false alarms.
 */
export async function audit(check: FixtureCheck, opts: AuditOptions = {}): Promise<AuditReport> {
  const n = opts.n ?? 200;
  const reachableBy = opts.reachableBy ?? (['structural'] as const);

  const caught: string[] = [];
  const missed: string[] = [];
  const falseAlarms: string[] = [];
  const passedValid: string[] = [];
  const errors: { name: string; detail: string }[] = [];
  const unreachable: string[] = [];

  for (const f of FIXTURES) {
    if (!f.valid && (f.catchableBy === null || !reachableBy.includes(f.catchableBy))) {
      unreachable.push(f.name);
    }
    let saidValid: boolean;
    try {
      saidValid = Boolean(await check(f.makeCase, n));
    } catch (e) {
      errors.push({ name: f.name, detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
      continue;
    }
    if (f.valid) (saidValid ? passedValid : falseAlarms).push(f.name);
    else (saidValid ? missed : caught).push(f.name);
  }

  const reachableMissed = missed.filter((m) => !unreachable.includes(m));
  const nReachableInvalid = FIXTURES.filter(
    (f) => !f.valid && f.catchableBy !== null && reachableBy.includes(f.catchableBy),
  ).length;
  const ok = reachableMissed.length === 0 && falseAlarms.length === 0 && errors.length === 0;

  const lines: string[] = [
    `caught       ${caught.length}/${nReachableInvalid} reachable   [${caught.join(', ')}]`,
    `valid pass   ${passedValid.length}/${FIXTURES.filter((f) => f.valid).length}   [${passedValid.join(', ')}]`,
  ];
  if (reachableMissed.length) {
    lines.push(`MISSED       [${reachableMissed.join(', ')}]   <- a ${reachableBy.join('/')} check should catch these`);
  }
  if (falseAlarms.length) {
    lines.push(`FALSE ALARM  [${falseAlarms.join(', ')}]   <- these suites are valid`);
  }
  if (errors.length) {
    lines.push(`raised       [${errors.map((e) => `${e.name}: ${e.detail}`).join('; ')}]`);
  }
  if (unreachable.length) {
    lines.push('');
    lines.push(`not reachable at tiers [${reachableBy.join(', ')}]: ${unreachable.join(', ')}`);
    lines.push('  scorer_disagrees is structurally identical to a valid suite. If your check');
    lines.push('  flagged it, that is luck or a bug, not detection. Use the construct gate');
    lines.push('  against the real judge, the real server and the real suite.');
  }
  lines.push('');
  lines.push(`verdict      ${ok ? 'OK' : 'INCOMPLETE'}`);

  return {
    caught,
    missed,
    falseAlarms,
    passedValid,
    errors,
    unreachable,
    reachableMissed,
    nReachableInvalid,
    reachableBy,
    ok,
    summary: lines.join('\n'),
  };
}
