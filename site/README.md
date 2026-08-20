# site/ : the Fitness Report leaderboard

Static leaderboard. No framework, no build step, no runtime dependencies. Open `index.html` from a
local static server and it renders.

```
site/
  index.html      markup and the methods copy (positioning lines, gate order, how to read a refusal,
                  extensions, more than one run of the same server, what a cost figure covers, both
                  divergences). Holds the masthead thesis and an empty #stat-strip
  style.css       token level CSS, light and dark through prefers-color-scheme
  app.js          vanilla ES module: loads data/runs.json, fills #stat-strip and renders the table
  data/runs.json  array of fitness-report/1 records, one per published run
  _headers        Cloudflare Pages headers, including the /traces/* rules
```

## Preview locally

```sh
cd site && python3 -m http.server 8080
# then open http://localhost:8080/
```

Opening `index.html` straight off the filesystem will not work: the page fetches `data/runs.json`,
and a `file://` origin blocks that. Any static server is fine.

## Data contract

`data/runs.json` is a JSON array of `FitnessReportJson` values from `src/types.ts`. Nothing else is
read at runtime, and nothing is recomputed here. Intervals, verdicts and p values are rendered exactly
as the harness wrote them, so this page can never disagree with the report JSON or with the markdown.

The two properties the renderer depends on:

- `score` is **absent** on any run that was refused. Not null, not zero. The page tests for the key.
- `outcome` is one of `SCORED`, `GATE_FAILED`, `DEGENERATE`, `INDETERMINATE`, `EXTEND_EXHAUSTED`,
  `COMPROMISED`, `INSUFFICIENT_SURFACE`. Anything unrecognised still renders as a refused row with the
  outcome printed verbatim, because a row that cannot be classified must still be visible.

To publish a run: append its report JSON to the array and copy its two tapes to
`traces/<runId>/mcp.jsonl` and `traces/<runId>/agent.jsonl` on the deployed site. Publish only the
redacted copy. The report's `traceLinks.viewer` should already point at the merged viewer URL; when it
is missing, the page rebuilds it from the two plane URLs.

The file currently in the repository holds real runs against the public server roster, including runs
that produced no score. If you ever put fabricated rows in it for layout work, label them and take them
out before deploying: nothing on the page marks a row as fabricated, and every figure the page prints
is presented as measured.

## Rules this page enforces in code

1. **A refusal is a result.** A refused run gets a full row: the `REFUSED` state, the outcome, the
   named gate that stopped it, the gate's reason string, and its counts (`22 of 30 against a threshold
   of 0.90, p = 0.0078`). No cell is ever blank. The probe columns still report, because probes are
   deterministic, cost nothing and run before any gate.
2. **A refusal is told, not just named.** `Why refused` on each refused row opens a story block built
   from that run's own gate detail. See "The refusal story" below. Naming `noise_exceeds_signal` and
   stopping there teaches a reader nothing, so the panel prints the rates the gate measured, draws the
   comparison, and states in one sentence what those numbers mean.
3. **The interval is the finding.** First-try success renders as its Wilson 95% interval with the point
   estimate marked inside it. Listing order uses the point estimate, but a row only takes a lower
   position when another interval sits entirely above it. Rows nothing separates share a position and
   are marked tied. Where two rows still overlap across positions, the lower row says so on its own
   row. No pair of overlapping intervals is ever presented as a settled ordering.
4. **Rankings hold within one runner model and one task generator.** `rankGroups` bands rankable runs by
   the pair (`runnerModel`, `generatorVersion`) and ranks each band on its own, with both printed on the
   band. Token accounting is not comparable across tokenizers and admission, drop and screen counts are
   not comparable across generator versions, so cross-band ranking is refused rather than approximated.
   `generatorVersion` is read from `run.generatorVersion`, falling back to the structural record's
   synthesis ledger, and a record carrying neither bands as `unrecorded generator`.
   The refused rows are split the same way: `renderBoard` groups them by generator, recorded generators
   first and records that predate the field last, each group saying what the grouping means. And every
   row, ranked or refused, carries `generatorBadgeOf(run)` as a chip in the server cell, so the generator
   is visible without opening the row. A record with no version field is badged
   `generator not recorded`, never as v1.
8. **A dollar figure is read from the record or it is not printed, and a floor is never a total.**
   `runCostOf(run)` composes the runner spend on the tapes with `judgeUsageOf(run)` where the record
   carries it, and everything known to sit outside that figure is listed in `excluded` as words with no
   number attached. A figure with a non empty `excluded` is a floor: `costTotalLine` labels it
   `measured floor, not a total` and prints `at least $x`, with the reason. Tokens are never converted to
   dollars on this page: unknown pricing fails closed, and a price table here would be a second copy of
   the harness's pricing that can drift from it.
9. **Consumed extensions are told as a sequence, in tasks and in trials.** Where a gate record carries
   extension batches, `extensionSentences` prints the registered size, each batch, the pool and the verdict
   the pooled counts resolved to, and says that neither the size nor the maximum moved during the run. A
   batch reports the task count the harness recorded (`ExtensionEvidence.admitted`); the pooled delta is
   printed beside it as trials, never as tasks.
10. **A row names its run, not just its server.** Every row carries the suite hash prefix and the start
    time from its own record, and where a server has more than one published run each of its rows says
    which attempt it is and names the others. Reruns are separate attempts, published in full.
5. **Every finding links to its evidence.** Findings are rendered with a link to the recorded session.
   When a run has no published tape the row prints `no recording published` instead, so a claim never
   stands here as a bare count.
6. **Replay opens on a click.** The viewer link is an ordinary anchor with `target="_blank"` and
   `rel="noopener noreferrer"`. There are no iframes and nothing is fetched from another origin at
   page load.
7. **Only https links reach the DOM.** URLs from the data file are parsed and rejected unless the
   protocol is https, and all text is written through `textContent`, never `innerHTML`.

## The refusal story

`refusalStories(run)` turns a refused run's gate records into an ordered list of stories, refusal gate
first, and `refusalBlock` renders them as the first block of the detail panel. Everything printed comes
out of that one record. There is no per server table and there must never be one: a sentence that is
true of exactly one row is a sentence this page cannot stand behind.

| Family | Source in the record | What the panel prints |
| --- | --- | --- |
| `null_baseline` | `detail.rates[]`, `tNull`, `tAblate`, `killThreshold`, `ratio`, `signalSource` | The worst null model as `k of n` in one sentence, the agent rate it is measured against, the kill threshold, and a bar per null model plus the agent. |
| `structural` and `suite_size` | `nRequested`, `nGenerated`, `nHolding`, `admissionRate`, `minAdmissionRate`, `minGenerated`, `nTasks`, `minTasks`, `toolCount`, `detail.synthesis.yield`, `detail.synthesis.dropsByRule`, `nullScreenDropped`, `nullScreenScreened`, `attribution` | Generated against admitted, the admission rate against its floor, the suite size against the minimum of 8, and one bar for the admission rate. Rejected, trimmed and null screened candidates are printed as three separate counts, with the drop ledger's rule names, because `nRequested - nGenerated` is all three added together. |
| `construct` | `verdict.k/n/threshold`, `detail.constructOracle`, `errorRate`, and `trace_stats.tools[]` | The reference agent's `k of n`, then what the tape shows: total calls, error results, and calls with no matching response. |
| anything else | `reason`, `verdict`, flat `detail` fields | The gate name, the reason string and whatever counts the record carries. Never a blank. |

Two rules inside those builders are load bearing:

- **The two surface gates are one story.** `structural` and `suite_size` both fail on every thin suite
  and describe the same finding, so they are folded together rather than printed twice.
- **A suite the null screen emptied is not a thin surface.** When the suite size record carries
  `attribution` (reason `all_candidates_null_answerable`), the surface story leads with the screen
  counts and the harness's own attribution string, and the row's outcome is `DEGENERATE`. The panel
  never prints a hardcoded claim about what the generator did or did not serialise: what it says about
  drops comes from `dropsByRule` when a ledger is present, and the older no-ledger case is stated as a
  limitation of that record rather than of the harness in general.
- **`protocol_hygiene` is never a refusal story.** The gate record says so itself: a hygiene failure is
  a fact about the server, not evidence that this measurement was invalid. It stays in the probe column
  and the gate ledger.

## Extensions

`extensionPolicyOf(run)` reads the policy the harness registered before the first call
(`gates.extensionPolicy`). `extensionLedgerOf(run, gate)` returns null unless that gate's record shows
extensions were actually consumed, and `extensionLedgers(run)` collects them across gates.

The reader takes the counts by shape rather than by one exact field name: batches from
`detail.extensions`, `detail.extensionBatches`, `detail.batches` or `record.extensions`; a `k of n` pair
from `k`/`n`, `passed`/`total`, `successes`/`attempts` or `hits`/`size`; the pool from `detail.pooled` or
the record's own `verdict`. A record that carries a pool and batches but no initial line has its initial
counts derived as pooled minus the batches, and the sentence says that is where the number came from.

`extensionSentences(ledger)` then prints, in order: the registered protocol and how much of it was used,
what the gate stood at on the registered size, each batch as `k of n`, the pooled `k of n`, and the
verdict on the pooled counts. When the budget is spent and the verdict is still EXTEND it adds the rule
that a gate unresolved after the last extension resolves to FAIL. `refusalStories` appends these to any
story whose gate consumed extensions and did not already carry them, so a gate nobody wrote a builder for
still tells the sequence, and `detailPanel` renders an `Extension ledger` block for any consuming gate
whose story is not on the panel (a scored run, or a gate that consumed extensions and then passed).

A batch's task count and its contribution to the pool are two different numbers. Construct drives each
task at the registered reps, so a batch of 6 tasks at 3 reps moves the pool by 18 trials. The sentences
print `ExtensionEvidence.admitted` as the tasks added and the pooled delta as trials, and say in one
clause why the two differ. The derived delta is used as the batch size only when no task count was
recorded, and it is called trials when it is.

No sentence here ever describes a threshold, a ratio, an alpha or a floor as having moved, because none
of them do. The extension size and the maximum are fixed alongside n in the pre-registration, and a
regenerated task suite is a new run under a new suite hash rather than another extension of this one.

### Which era a record came from

`gates.extensionPolicy` is written on every record, so `{extensionSize: 0, maxExtensions: 0}` is
ambiguous on its own: it is what a harness that registers no extension batch writes, and it is also what
a harness with no extension protocol at all writes. `extensionProtocolOf(run)` separates them from
fields, never from a run id, a date or a server name. A harness that runs the protocol states it on the
gate record that could have bought a batch (`detail.extensionProtocol`, `detail.pooled.policy`,
`detail.extensionsConsumed`, `detail.extensions`) and writes one `gates.extensions` entry per consumed
batch. A record carrying none of that was written before the protocol ran.

`extensionProtocolSentence(state)` then has three readings, and `exhaustedReading(run)` renders the same
distinction inside a refused panel:

| Record | What the page says |
| --- | --- |
| a size and a maximum above zero | registered before the first call, this many consumed, and after the last extension an unresolved gate resolves to FAIL and refuses as `GATE_FAILED` |
| zero, and the protocol stated elsewhere on the record | registered before the first call as no extension batch, so a gate that resolves neither way is refused where it stands, which is the one surviving use of `EXTEND_EXHAUSTED` |
| zero, and nothing else about the protocol | written before the extension protocol ran, so there was never a batch to buy. The arithmetic matches a zero pre-registration and the page says the record does not distinguish the two |

`OUTCOME_NOTES.EXTEND_EXHAUSTED` is worded to be true of all three: the gate resolved neither way and
there was no extension batch left to buy. It never meant that a gate was extended until it looked
decisive, and it never describes a budget that a record does not carry.

## Runs of one server

A server can be driven again at any time, and each drive generates its own suite under its own hash, so
two runs of one server are two measurements rather than two views of one. The pre-registration binds what
happens inside a run. It does not bind how many runs are attempted, and this page does not pretend
otherwise: what it does instead is publish every attempt with its own identity and select none of them.

- `runIdentityOf(run)` reads the run id, generator version, suite hash, its 12 character prefix, the start
  time and the outcome from the record. `runIdentityLine(run)` renders the prefix and the start time as
  one line in the server cell, and missing fields say so rather than rendering blank.
- `serverCohorts(runs)` groups every published run by slug, oldest first, and drops nothing. A record with
  no start time keeps its file order instead of sorting as though it were the oldest.
- `cohortPlaceOf(cohorts, run)` gives a row its attempt number and the identities of its siblings, so a
  row names the other runs of its server even when they sit in another band of the table. Rows also carry
  `data-server` and, for a server with more than one run, the class `is-rerun`.
- `rerunSummary(runs)` feeds the masthead sentence stating that reruns are separate attempts rather than a
  best of, with the counts read from the data.

Refused rows are grouped by server within their generator band and ordered oldest first inside a server.
Ranked bands keep their dominance order untouched, because that ordering is a finding; a rerun in a ranked
band is linked to its siblings by the identity on the row rather than by moving the row.

## Cost

`runCostOf(run)` is the one place a dollar figure is composed:

- `runnerUsd` from `trace_stats.models.cost.totalUsd`, which is what the agent tape recorded.
- `judgeUsd` from `judgeUsageOf(run)`, which looks for judge usage at `run.judgeUsage`,
  `run.run.judgeUsage`, `run.score.judgeUsage` or `run.trace_stats.judgeUsage`, accepts either a single
  entry or an array of per phase entries, and reads each entry's model, calls, tokens and cost by shape.
  Sums cover only the entries that carry the field, so an entry silent about tokens never reads as an
  entry reporting zero of them.
- `totalUsd` is the sum of whichever of those two is present, and null when neither is.
- `excluded` names, in words and without numbers, what is known to be outside the figure: judge spend on
  a run that does not record it, judge usage recorded with no price on file, the generation time null
  screen calls that are on neither plane, any model on the tape the price table could not price, and a
  tape cost block the harness itself marked partial.
- `judgeFloorReasons(judge)` is the judge side of that list, and it is why a PRICED judge figure can still
  be incomplete: `partial: true`, a `byModel` entry with no price on file, calls that returned no usage
  block, and calls that threw before reporting one. Each means dollars were spent that are not in the
  figure. `byModel` is read for model NAMES only and is never summed, because it breaks down totals the
  block already carries.
- `floor` is true whenever a figure exists and `excluded` is not empty.

The panel block prints `runner model, measured` and `judge model, measured` separately, each labelled
`measured floor` and printed as `at least $x` when that side is incomplete. `costTotalLine(cost)` labels
the sum: `measured total` only when nothing known is missing from it, otherwise `measured floor, not a
total`, valued `at least $x`, with one sentence naming the reason. A run whose record carries no dollars
gets no line at all, so a non derivable cost still prints nothing numeric. `boardStats` carries the same
distinction up to the masthead through `floorRuns` and `costIsFloor`, because a sum of floors is a floor.
The row cell says `runner tokens per task`
and `runner cost per task` rather than `tokens per task` and `cost per task`, because the judge's tokens
are not in either number. The masthead figure carries the same disclosure at board level: when no run
records judge spend, the strip says so and publishes no estimate in its place.

The construct story reads `trace_stats.tools[].pending`, which is the mcp-tape count of requests with
no matching response. When `pending` equals `calls`, the panel says the server advertises N tools and
every invocation was rejected before a protocol response existed. That sentence is generated from the
counts, never from a server name, and it does not appear when the counts do not support it.

Where a record does not carry a number, the panel says so. `fmtInt`, `fmtPct` and `fmtUsd` return
`not reported` rather than zero, and a missing figure is never silently dropped.

## The masthead stat strip

`renderStats(node, runs)` fills `#stat-strip` from `boardStats(runs)`: distinct servers, published runs,
scored, refused, and measured model spend. The cost is summed per run through `runCostOf`, so it covers
the runner turns the tapes priced plus judge usage on the runs that record it, and it is labelled with
the number of runs it actually covers, because a total that silently spans nine of sixteen runs is a
wrong number dressed as a right one. When no run scored, the strip says so in a
sentence rather than showing a zero and leaving the reader to guess whether the pass failed to run.

The spend sentence is derived, never assumed. `measuredCostOf` is null both when no model ran and when
nothing that ran had a price on file, so `spendNote` reads `models.summary.assistantTurns` and
`models.cost.unpricedModels` and says which of the two happened. It also refuses to imply the spend is
complete: the generation time null screen calls the runner model once per validated candidate and those
calls are written to neither plane, so when any run carries screen counts the strip prints them, with
their token totals, as spend the tapes cannot see.

`methodsBlock` renders `report.methods` verbatim at the foot of every detail panel, and when any run was
generated with the null screen the strip carries the same disclosure at board level. That array is where
the harness states its known biases, including that a screened suite's null baseline is biased downward
by construction. Dropping it on the floor while the page asserts that no threshold was ever loosened
would make a true sentence do the work of a false one.

The block is a `<details>` element so a reader can fold it away, and it renders open, because a
disclosure that starts closed inside a panel that already starts closed is a disclosure nobody reads.
Above the verbatim list it states two things from the record's own fields rather than from its prose:
whether the generation time null screen ran and what it deleted, and the extension protocol that was
registered before the first call together with how much of it this run consumed. Both are registered
ahead of the first call and both change what every number on the row means, so neither depends on the
harness having written a sentence about it.

`suiteLineageOf(run)` collects suite lineage from `run.suiteLineage`, `run.run.suiteLineage`,
`run.run.lineage` and the synthesis ledger, plus named fields wherever they sit (parent and source suite
hashes, parent run, derived, regenerated and extended from, suite version and generation, generator model
and seed, prompt version). Only primitives render, absent fields render nothing at all, and an unknown
key inside a lineage block still reaches the page with a humanised label. A row that reads
`not recorded` on every run teaches nothing, and a fabricated parent hash would be worse.

The thesis line above the strip is fixed copy in `index.html`: a leaderboard you can trust must be able
to say this measurement was not valid.

## Copy rules

Binding for anything added to this page:

- No em-dashes. Ranges read as `55.2% to 95.3%`.
- Never describe what we do as conformance or compliance testing. That word belongs to the official
  suite at github.com/modelcontextprotocol/conformance, and the methods section quotes the line that
  draws the boundary. Ours is: whether an agent can actually get the job done with the server.
- No letter grades. There is no A to F scale here and there will not be one. States are `SCORED` and
  the named refusals.
- No bare lint counts. Every flag carries a link to the session that justifies it.
- Nothing on this page ever describes a gate as loosened, tuned or relaxed, because none of them are.
  The copy in the refusal panels says the opposite out loud: a degenerate suite is repaired with harder
  tasks, a thin surface with candidates that survive admission. If a future change moves a threshold,
  ratio, floor or alpha in the direction of more scores, that copy becomes a lie and both have to be
  fixed together.

## Headers

`_headers` is Cloudflare Pages format, least specific rule first.

- `/*` gets `nosniff`, a referrer policy and a content security policy that allows scripts and styles
  only from this origin. Keep the page free of inline `<script>` if you edit it, since the policy has
  no script hash or nonce.
- `/data/runs.json` is cached for 60 seconds so a newly published run appears without waiting out a
  CDN TTL.
- `/traces/*` gets `Access-Control-Allow-Origin: *` and a one year immutable cache. The permissive
  origin is required, not incidental: the replay viewer runs on mcpreplay.dev and fetches these files
  from the browser, so without it every replay link is dead. The immutable cache is safe because a
  tape path is addressed by run id and its bytes never change.

## Theme and accessibility

Every colour is a token on `:root`, redefined once under `prefers-color-scheme: dark`. Nothing below
the token block hard codes a colour. `prefers-reduced-motion` and `prefers-contrast` are honoured.
State is never carried by colour alone: each state also has a text label, the interval carries an
`aria-label` describing the rate, the interval and the counts, and the detail toggles are real buttons
with `aria-expanded` and `aria-controls`.

The comparison bars in a refusal panel are decorative and marked `aria-hidden`. Every value they encode
is written next to them as text, so the block reads the same with styles off, under `prefers-contrast`,
and to a screen reader. Below 640px the bars are dropped entirely and the numbers stay.

## Testing

`app.js` runs its bootstrap only when `document` and `window` exist, so the module can be imported in
Node and its pure functions (`rankRuns`, `separates`, `intervalsOverlap`, `refusalOf`, `safeUrl`,
`buildViewerUrl`, `summaryText`, `boardStats`, `refusalStories`, `refusalTeaser`, `traceToolTotals`,
`advertisedToolCount`, `judgeUsageOf`, `judgeFloorReasons`, `runCostOf`, `costTotalLine`,
`extensionLedgerOf`, `extensionSentences`, `extensionFigures`, `extensionProtocolOf`,
`extensionProtocolSentence`, `exhaustedReading`, `runIdentityOf`, `runIdentityLine`, `serverCohorts`,
`cohortPlaceOf`, `rerunSummary`, `suiteLineageOf`, `generatorBadgeOf`) exercised without a browser.
`renderBoard(tbody, runs)` and `renderStats(node, runs)` take any element with the DOM methods they use,
so they can also be driven against a shim.

`test/site.test.js` is that test. It is JavaScript, not TypeScript, because this module ships as it is
with no build step and no declarations: the tsconfig include list covers `test/**/*.ts`, so the file sits
outside the type check and inside the vitest run. It drives the pure functions against fixtures AND
against the published `data/runs.json`, then renders the whole board into a small element shim to check
that every published run reaches the page, that reruns are marked, and that no run is labelled with a
cost total its record cannot support.

`refusalStories` is the one worth testing against real records rather than fixtures: point it at the
published `data/runs.json` and read the sentences it produces. Every one of them has to be true of the
run it came from, and a builder that quietly hardcodes something will show up there immediately.

Syntax check: `node --check site/app.js`.

## Deploying

Agents do not deploy this. The operator deploys from this machine with wrangler, and there is no
GitHub Actions workflow for it.
