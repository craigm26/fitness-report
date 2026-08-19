# site/ : the Fitness Report leaderboard

Static leaderboard. No framework, no build step, no runtime dependencies. Open `index.html` from a
local static server and it renders.

```
site/
  index.html      markup and the methods copy (positioning lines, gate order, how to read a refusal,
                  both divergences). Holds the masthead thesis and an empty #stat-strip
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

The construct story reads `trace_stats.tools[].pending`, which is the mcp-tape count of requests with
no matching response. When `pending` equals `calls`, the panel says the server advertises N tools and
every invocation was rejected before a protocol response existed. That sentence is generated from the
counts, never from a server name, and it does not appear when the counts do not support it.

Where a record does not carry a number, the panel says so. `fmtInt`, `fmtPct` and `fmtUsd` return
`not reported` rather than zero, and a missing figure is never silently dropped.

## The masthead stat strip

`renderStats(node, runs)` fills `#stat-strip` from `boardStats(runs)`: distinct servers, published runs,
scored, refused, and measured model spend. The cost is summed from `trace_stats.models.cost.totalUsd`
and is labelled with the number of runs it actually covers, because a total that silently spans nine of
sixteen runs is a wrong number dressed as a right one. When no run scored, the strip says so in a
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
`advertisedToolCount`) exercised without a browser. `renderBoard(tbody, runs)` and
`renderStats(node, runs)` take any element with the DOM methods they use, so they can also be driven
against a shim.

`refusalStories` is the one worth testing against real records rather than fixtures: point it at the
published `data/runs.json` and read the sentences it produces. Every one of them has to be true of the
run it came from, and a builder that quietly hardcodes something will show up there immediately.

Syntax check: `node --check site/app.js`.

## Deploying

Agents do not deploy this. The operator deploys from this machine with wrangler, and there is no
GitHub Actions workflow for it.
