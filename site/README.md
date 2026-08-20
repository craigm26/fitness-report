# site/ : the Fitness Report leaderboard

Static leaderboard. No framework, no build step, no runtime dependencies. Open `index.html` from a
local static server and it renders.

```
site/
  index.html      markup and the methods copy (positioning lines, gate order, how to read a refusal,
                  extensions, more than one run of the same server, what is not in these numbers, both
                  divergences). Holds the masthead thesis and the empty hosts the renderer fills:
                  #ledger, #board, #disclosures, #standing-notes, #record
  style.css       token level CSS: seven declared colours, everything else derived with color-mix,
                  light and dark defined on :root, in prefers-color-scheme and in [data-theme]
  app.js          vanilla ES module: loads data/runs.json, renders the ledger, the board, the methods
                  disclosures and one addressable run record at a time
  data/runs.json  array of fitness-report/1 records, one per published run
  _headers        Cloudflare Pages headers, including the /traces/* rules
```

## The four zones

The page is an issued record, not a scoreboard, and it reads top to bottom in that order.

| Zone | What it is | Rendered by |
| --- | --- | --- |
| A masthead | the thesis as the largest type on the page, and the count that proves it | `thesisCountLine(boardStats(runs))` into `#thesis-count` |
| B outcome ledger | four counts in the order the gates run, one tick per published run, one spend sentence | `renderLedger(node, runs)` into `#ledger` |
| C board | one row per run, grouped by outcome family, no expandable panels anywhere | `renderBoard(node, runs)` into `#board` |
| D run record | one run in full, at `#run/<runId>`, opened from a row or a tick | `renderRecord(node, run, ctx)` into `#record` |

Zone D is the reason there are no panels in Zone C. Every run has its own address, browser back works,
the source row stays marked while its record is open, and closing returns focus to the row's own
`Open the record` control. Above 1100px the record is a 560px pane on the right with the board still
visible; below that it takes the viewport with a scrim, and the body scroll is locked while it is open.

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

1. **A refusal is a result, and it occupies the result's space.** Every row has one result well, in the
   same slot, on a shared 0 to 100 axis drawn once at the top of the column. A scored run draws its
   Wilson interval with the point marked inside it. A refused run draws a hatched span across the whole
   axis with its outcome code boxed inside it, in the display face, at the weight a number would have
   had. The two states are told apart by pattern and by text, never by colour alone, and the slot is
   never empty. The probe field still reports, because probes are deterministic, cost nothing and run
   before any gate.
2. **A refusal is told, not just named.** The decision field on the row carries the outcome code, the
   gate that stopped it, the reason string and the one measured comparison that made it
   (`refusalTeaser(run)`). `Open the record` leads with that comparison drawn. Naming
   `noise_exceeds_signal` and stopping there teaches a reader nothing, so Tier 1 of the record prints
   the rates the gate measured, draws the comparison, and states in one sentence what they mean.
3. **The interval is the finding, and there are no positions.** First-try success is drawn on the shared
   axis, and the axis does the comparing. A position would only be honest if one interval lay entirely
   above another; `scoredSeparation(runs)` checks every pair and reports which, if any, are separated.
   On the published runs none are, so the scored group says out loud that nothing separates its rows and
   the page prints no order at all. `boardOrderLine(runs)` says the same above the board, before a
   reader pays any scrolling for it, and both sentences are derived from the intervals rather than
   written into the copy. The rank chips (`rank-solo`, `rank-tied`, `rank-none`) are gone: a chip
   claiming a tie is a weaker statement than an axis that shows it.
4. **Runs are only ever read within one runner model and one task generator.** `rankGroups` still bands
   scored runs by the pair (`runnerModel`, `generatorVersion`) and the scored group prints one line per
   band. Token accounting is not comparable across tokenizers and admission, drop and screen counts are
   not comparable across generator versions, so cross-band comparison is refused rather than
   approximated. `generatorVersion` is read from `run.generatorVersion`, falling back to the structural
   record's synthesis ledger, and a record carrying neither reads as `unrecorded generator`. Every row,
   scored or refused, carries `generatorBadgeOf(run)` and its runner model as chips in the run field, and
   a refusal group holding more than one generator says so in its group note. A record with no version
   field is chipped `generator not recorded`, never as v1.
5. **A run's family is read from its record, never inferred.** `outcomeFamilyOf(run)` takes the cost
   tier from the gate that stopped the run (`free`, `cheap`, `paid`) and nothing else. A refusal whose
   record does not carry a cost tier goes into its own `unclassified` bucket, which says exactly that,
   rather than being assigned a tier from a table of gate names kept on this page. `familyBuckets` is
   the one grouping function: the ledger reads it in cost ladder order and the board reads it with the
   scored runs first.
6. **A dollar figure is read from the record or it is not printed, and a floor is never a total.**
   `runCostOf(run)` composes the runner spend on the tapes with `judgeUsageOf(run)` where the record
   carries it, and everything known to sit outside that figure is listed in `excluded` as words with no
   number attached. A figure with a non empty `excluded` is a floor: `costTotalLine` labels it
   `measured floor, not a total` and prints `at least $x`, with the reason. Tokens are never converted to
   dollars on this page: unknown pricing fails closed, and a price table here would be a second copy of
   the harness's pricing that can drift from it.
7. **Consumed extensions are told as a sequence, in tasks and in trials.** Where a gate record carries
   extension batches, `extensionSentences` prints the registered size, each batch, the pool and the verdict
   the pooled counts resolved to, and says that neither the size nor the maximum moved during the run. A
   batch reports the task count the harness recorded (`ExtensionEvidence.admitted`); the pooled delta is
   printed beside it as trials, never as tasks.
8. **A row names its run, not just its server.** Every row carries the suite hash prefix and the start
   time from its own record, and where a server has more than one published run each of its rows says
   which attempt it is and names the others by suite hash and outcome. Reruns are separate attempts,
   published in full. The siblings' own start times are on their own rows, in this run's record, and in
   the row's `title`, so the row names them without reprinting five lines of timestamps.
9. **A note the harness writes on every run is published once.** `standingNotes(runs)` finds the method
   notes that every run of a generator carries; `renderStandingNotes` publishes them verbatim, once,
   under Methods; `ownMethodNotes(run, standing)` gives a record only the notes that are its own and
   says how many standing notes it also carries, with a link to where they are. Nothing is dropped and
   nothing is summarised. On the published data that is 214 note printings before and 54 after (36 run
   specific notes plus 18 standing ones published once), with every distinct note still on the page.
10. **Every finding links to its evidence.** Findings are rendered with a link to the recorded session,
    named so a link list says which run and which finding each one belongs to. When a run has no
    published tape the row prints `no recording published` instead, so a claim never stands here as a
    bare count.
11. **Replay opens on a click.** The viewer link is an ordinary anchor with `target="_blank"` and
    `rel="noopener noreferrer"`. There are no iframes and nothing is fetched from another origin at
    page load.
12. **Only https links reach the DOM.** URLs from the data file are parsed and rejected unless the
    protocol is https, and all text is written through `textContent`, never `innerHTML`.

## The refusal story

`refusalStories(run)` turns a refused run's gate records into an ordered list of stories, refusal gate
first, and `decidingTier` renders the primary one as Tier 1 of the run record. Everything printed comes
out of that one record. There is no per server table and there must never be one: a sentence that is
true of exactly one row is a sentence this page cannot stand behind.

| Family | Source in the record | What the record prints |
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
still carries the sequence. The sequence itself is prose about how a gate was resolved, not the finding
that decided the run, so it renders in Tier 3 of the record as an `Extension ledger` fold, for a refused
gate and for a scored run that reached its number through extensions alike.

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
  row names the other runs of its server even when they sit in another group of the board. Rows also carry
  `data-server` and, for a server with more than one run, the class `is-rerun`.
- `rerunSummary(runs)` feeds the masthead sentence stating that reruns are separate attempts rather than a
  best of, with the counts read from the data.

Inside every group, rows are ordered by generator (recorded generators first), then by server, then
oldest run first, so two attempts at one server are read next to each other rather than as unrelated
rows. No group carries an order that claims anything: the board prints no positions at all.

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

The cost tier prints `runner model, measured` and `judge model, measured` separately, each labelled
`measured floor` and printed as `at least $x` when that side is incomplete. `costTotalLine(cost)` labels
the sum: `measured total` only when nothing known is missing from it, otherwise `measured floor, not a
total`, valued `at least $x`, with one sentence naming the reason. A run whose record carries no dollars
gets no line at all, so a non derivable cost still prints nothing numeric. `boardStats` carries the same
distinction up to the ledger through `floorRuns` and `costIsFloor`, because a sum of floors is a floor.
The row cell says `runner tokens per task`
and `runner cost per task` rather than `tokens per task` and `cost per task`, because the judge's tokens
are not in either number. The ledger figure carries the same disclosure at board level: `spendLine`
names the runs whose judge spend is not recorded and publishes no estimate in its place.

The construct story reads `trace_stats.tools[].pending`, which is the mcp-tape count of requests with
no matching response. When `pending` equals `calls`, the record says the server advertises N tools and
every invocation was rejected before a protocol response existed. That sentence is generated from the
counts, never from a server name, and it does not appear when the counts do not support it.

Where a record does not carry a number, the record view says so. `fmtInt`, `fmtPct` and `fmtUsd` return
`not reported` rather than zero, and a missing figure is never silently dropped.

## The outcome ledger, and where the four stat cells went

The four masthead stat cells are gone. Three of them (servers tested, scored, refused) are readable off
the ledger, and the fourth was never a statistic: it was a disclosure with a dollar sign on it, and it
stops pretending.

`renderLedger(node, runs)` builds Zone B from `familyBuckets(runs, LEDGER_ORDER)`:

- **One cell per family, in the order the gates actually run**, cheapest first. Each carries the count in
  the display face, the outcome codes its own runs carry with their counts, and one line of plain
  language about that tier. The tier lines in `FAMILY_NOTES` describe the tier, never a server, and are
  true of every run in the family by construction. The scored cell instead carries
  `scoredSeparation(runs).line`, which is derived from the intervals.
- **One tick per published run**, grouped the same way, each a link to that run's record with an
  accessible name that says which server and which outcome. That strip is the ten second answer to
  "what happened here" and it is how you reach any single run without scrolling the board.
- **One spend sentence.** `spendLine(boardStats(runs))` prints the figure, marks it `a floor` when
  `costIsFloor` is true with the words linking to `#methods-not-in-numbers`, and names what is missing
  from the counts rather than from an assumption. A pass whose records carry no dollars gets no figure
  and a sentence saying so.

The four stacked disclosure paragraphs that used to sit under the strip are now one Methods block.
`renderDisclosures(node, runs)` writes them into `#disclosures` under **What is not in these numbers**,
each with its own id so a figure elsewhere can link to the exact claim that qualifies it. The text is
unchanged and is not shortened: the floor versus total distinction is the point. `spendNote(stats)` is
still the sentence that says what the figure is made of, and it is still derived, never assumed:
`measuredCostOf` is null both when no model ran and when nothing that ran had a price on file, so
`spendNote` reads `models.summary.assistantTurns` and `models.cost.unpricedModels` and says which of the
two happened. The generation time null screen calls the runner model once per validated candidate and
those calls are written to neither plane, so when any run carries screen counts the disclosure prints
them, with their token totals, as spend the tapes cannot see.

## The run record

`renderRecord(node, run, {standing, cohort})` builds Zone D in three tiers.

**Tier 1, the comparison that decided this run.** The outcome code, the gate, the reason string, then
the primary refusal story drawn: its headline, its meter, its figures and its sentences. A scored run
gets the result well at full size plus the score figures. A reader who opened one row should understand
the decision before scrolling, which is why the gate ledger is not here.

**Tier 2, the audit trail.** Reading this outcome (`exhaustedReading`, only where it applies), other
gates that also failed, the gate ledger, probe findings with an evidence link each, per tool
attribution, what this run cost, the run record itself with its suite lineage, and the chain of custody
back to the two tapes. Wide tables sit in their own `overflow-x: auto` container, so a table that cannot
shrink below its min-content width scrolls itself instead of escaping the record.

**Tier 3, folded.** The extension ledger sequence, this run's own method notes, and the raw recorded
counts per gate. `<details>` elements, closed by default. Nothing here is hidden from the page: it is
published and reachable, and it does not compete with the finding.

`methodsFold` states two things from the record's own fields rather than from its prose: whether the
generation time null screen ran and what it deleted, and the extension protocol that was registered
before the first call together with how much of it this run consumed. Both are registered ahead of the
first call and both change what every number on the row means, so neither depends on the harness having
written a sentence about it. The verbatim notes below them come from `ownMethodNotes`, and the fold says
how many standing notes the run also carries and links to where they are published.

Records are built on demand. The collapsed page carries the board and nothing else, and one record is in
the DOM at a time.

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
- No positions, ranks, medals or ties. On the published intervals nothing separates anything, so a
  printed position would be a claim the evidence does not carry. If one interval ever does lie entirely
  above another, `scoredSeparation` names the pair in words; it does not turn into a leaderboard.
- No scoreboard vernacular anywhere: no medals, no 1 / 2 / 3, no green ticks, no red error states, no
  gradient KPI cards. The vocabulary is a lab's: issued, record, result, hold, retained sample.
- A refusal is never red or amber, and never an error state. It is indigo, because it is a hold: a
  deliberate act by the harness, recorded and signed. A fact about the SERVER (a failed protocol probe,
  an unannotated destructive tool) wears `--fault` instead. If those two ever share a colour, a reader
  cannot tell a decision about our measurement from a finding about someone else's server.
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

## Layout

There is no scroll container on this page except the run record pane and the two wide tables inside it.
That is deliberate, and it is what fixed the reported overlaps.

- **The board is a CSS grid, not a table with a horizontal scroller.** Six explicit columns above
  1080px, a two column layout with explicit `grid-area` placement between 640px and 1079px, and one
  column with the label in a left gutter below that. The track count never changes with the width, so
  nothing reflows into a shape nobody tested. Measured at 360, 380, 480, 640, 768, 1024, 1280 and
  1440px: zero horizontal page scroll and zero elements crossing the viewport edge.
- **The column strip actually sticks.** It could not before: `.table-scroll` set `overflow-x: auto`,
  which makes the used value of `overflow-y` `auto` as well, so the sticky header resolved against a
  container with no height constraint and never moved. With the scroller gone, `position: sticky`
  resolves against the viewport and works.
- **Every field carries its own label in the DOM, on every row, in every layout.** Above 1080px the
  labels are clipped and the strip carries them visually; below that they become visible in the gutter.
  Assistive tech always hears which field it is in, and the strip is `aria-hidden` because it is
  decoration.
- **Long strings always wrap and never `nowrap`.** Slugs, suite hashes, run ids and trace URLs get
  `overflow-wrap: anywhere`, including inside chips. `.gen-chip` used to set both `nowrap` and
  `overflow-wrap: anywhere`; `nowrap` won, and that is how a generator string pushed out of its column.
- **Markers cannot leave their track.** The interval point is placed at
  `calc(var(--rate) * (100% - 3px))` with a unitless ratio, and the track is `overflow: hidden`, so a
  point estimate of 1.0 sits inside the axis rather than half outside it. Same for the meter threshold.
- **The skip link is out of flow.** It is clipped to 1px rather than parked at `left: -9999px`, which
  still participates in layout.

## Theme and accessibility

Seven colours are declared: `--paper`, `--record`, `--ink`, `--rule`, `--measure`, `--refuse`,
`--fault`. Everything else is derived from them with `color-mix`, so a tint cannot drift from the colour
it came from. Each is defined once on bare `:root`, once under `prefers-color-scheme: dark` guarded with
`:root:not([data-theme="light"])`, and once under `:root[data-theme="dark"]`. No colour is defined only
inside a media query. Every derived token carries its computed hex on the line above the `color-mix`, so
a parser that does not understand `color-mix` still gets the right colour rather than none.

`--refuse` is indigo, and that is the argument the page makes. Amber says caution and red says failure,
and both frame a refusal as something that went wrong. A refusal here is a hold: a decision by the
harness, recorded and signed. `--fault` is the only extra hue and it exists so that a fact about the
server (a failed protocol probe, an unannotated destructive tool) never wears the same colour as a
decision about our own measurement.

Contrast is measured, not assumed. `--ink-quiet` (66% ink) is the floor for small text and clears 4.9:1
against every surface it is used on in both themes. `--ink-faint` (58% ink) is used only on `--paper`
and `--record`, where it clears 4.7:1, and never on a wash. `--rule` is a hairline; the axis, the field
edges and focus rings use `--rule-strong`, which clears 3:1. A sweep over every text node on the board
and inside an open record, in both themes, against the composited background, reports zero elements
below the required ratio. `prefers-contrast: more` collapses `--rule` to `--ink-faint` and both quiet
tokens to `--ink`.

Motion is one moment: the record fades in over 120ms. `prefers-reduced-motion: reduce` removes it, and
nothing else on the page animates.

State is never carried by colour alone. Every state has a text label, the result well carries an
`aria-label` describing the rate, the interval and the counts (or the outcome code and its gate), and
the filter controls are real buttons with `aria-pressed`. Touch targets outside running prose are at
least 44px tall and 24px wide, including the ledger ticks, which are 24 by 44 with a 12px bar drawn
inside them. The links that remain smaller are all inline in a sentence, which is the WCAG exemption.

Evidence links carry accessible names that say which run and which finding they belong to, so a link
list is not forty links all reading `evidence`.

The comparison bars in a record are decorative and marked `aria-hidden`. Every value they encode is
written next to them as text, so the block reads the same with styles off, under `prefers-contrast`, and
to a screen reader.

### Type, and the faces this page does not load

Three roles: a display face for the wordmark, the thesis, the outcome codes and the ledger counts; a
text face for prose and labels; a mono face for every number, hash, id and url, always with
`font-variant-numeric: tabular-nums`. The display face is a monospace at 700 with tracking, which keeps
the page's whole typographic argument inside the register of recorded data instead of borrowing an
editorial serif.

The design called for Martian Mono, IBM Plex Sans and IBM Plex Mono from Google Fonts. They are not
loaded, and that is not an oversight. `_headers` sets `default-src 'self'` with no `font-src` and
`style-src 'self' 'unsafe-inline'`, so both the stylesheet request to `fonts.googleapis.com` and the
font files from `fonts.gstatic.com` would be blocked, and the page would ship a dependency it cannot
fetch. `--font-display`, `--font-text` and `--font-mono` carry system stacks instead. If the operator
ever wants the specified faces, the change is a `font-src` and `style-src` edit in `_headers`, which is
a deploy decision and not a renderer one.

## Testing

`app.js` runs its bootstrap only when `document` and `window` exist, so the module can be imported in
Node and its pure functions exercised without a browser: `rankRuns`, `separates`, `intervalsOverlap`,
`scoredSeparation`, `scoredBands`, `outcomeFamilyOf`, `familyBuckets`, `refusalOf`, `safeUrl`,
`buildViewerUrl`, `summaryText`, `boardOrderLine`, `thesisCountLine`, `boardStats`, `spendLine`,
`spendNote`, `refusalStories`, `refusalTeaser`, `scoredTeaser`, `decisiveLine`, `traceToolTotals`,
`advertisedToolCount`, `judgeUsageOf`, `judgeFloorReasons`, `runCostOf`, `costTotalLine`,
`extensionLedgerOf`, `extensionSentences`, `extensionFigures`, `attachExtensionLedger`,
`extensionProtocolOf`, `extensionProtocolSentence`, `exhaustedReading`, `runIdentityOf`,
`runIdentityLine`, `serverCohorts`, `cohortPlaceOf`, `rerunSummary`, `suiteLineageOf`,
`generatorBadgeOf`, `recordIdOf`, `indexRuns`, `routeFromHash`, `methodNotesOf`, `standingNotes`,
`ownMethodNotes`.

`renderBoard(node, runs)`, `renderLedger(node, runs)`, `renderRecord(node, run, ctx)`,
`renderDisclosures(node, runs)` and `renderStandingNotes(node, runs)` take any element with the DOM
methods they use, so they can also be driven against a shim. Everything that needs a real browser
(routing, focus, the filter, scroll locking) lives behind `main()` and its event handlers, so none of
the render functions touch `querySelector`, `focus`, `history` or `location`.

`test/site.test.js` is that test. It is JavaScript, not TypeScript, because this module ships as it is
with no build step and no declarations: the tsconfig include list covers `test/**/*.ts`, so the file sits
outside the type check and inside the vitest run. It drives the pure functions against fixtures AND
against the published `data/runs.json`, then renders the whole board and every run record into a small
element shim to check that:

- every published run reaches the board, with its own suite hash and start time, and reruns are marked;
- every row has a result well, and every refused well carries its outcome code;
- no position, rank chip or tie claim appears anywhere;
- every run has a unique url safe record key that round trips through `routeFromHash`;
- every record leads with the deciding comparison and puts the gate ledger below it;
- every evidence link has a distinguishing accessible name;
- own notes plus standing notes equal each run's whole methods block, so nothing is lost;
- a run is labelled `measured total` only when `runCostOf(run).complete`, and `measured floor, not a
  total` with `at least $x` otherwise, with the reason either on the label or in the list below it;
- a record with a field deleted renders nothing for it: no zero, no placeholder, no `undefined`.

Two of those assertions changed with the data rather than with the code. The suite used to assert that
no published run records judge spend, and that every cost figure is therefore a floor. A record written
since then does record it, completely, so those tests now assert the rule (`complete` implies total,
anything else implies floor) instead of the snapshot.

`refusalStories` is the one worth testing against real records rather than fixtures: point it at the
published `data/runs.json` and read the sentences it produces. Every one of them has to be true of the
run it came from, and a builder that quietly hardcodes something will show up there immediately.

Syntax check: `node --check site/app.js`.

## Deploying

Agents do not deploy this. The operator deploys from this machine with wrangler, and there is no
GitHub Actions workflow for it.
