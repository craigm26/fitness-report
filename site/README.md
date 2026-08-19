# site/ : the Fitness Report leaderboard

Static leaderboard. No framework, no build step, no runtime dependencies. Open `index.html` from a
local static server and it renders.

```
site/
  index.html      markup and the methods copy (positioning lines, gate order, both divergences)
  style.css       token level CSS, light and dark through prefers-color-scheme
  app.js          vanilla ES module: loads data/runs.json and renders the table
  data/runs.json  array of fitness-report/1 records. Ships with 3 sample runs
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

The sample data in this repository is fabricated for layout work. It is labelled as sample here and
nowhere else, so do not deploy it alongside real rows.

## Rules this page enforces in code

1. **A refusal is a result.** A refused run gets a full row: the `REFUSED` state, the outcome, the
   named gate that stopped it, the gate's reason string, and its counts (`22 of 30 against a threshold
   of 0.90, p = 0.0078`). No cell is ever blank. The probe columns still report, because probes are
   deterministic, cost nothing and run before any gate.
2. **The interval is the finding.** First-try success renders as its Wilson 95% interval with the point
   estimate marked inside it. Listing order uses the point estimate, but a row only takes a lower
   position when another interval sits entirely above it. Rows nothing separates share a position and
   are marked tied. Where two rows still overlap across positions, the lower row says so on its own
   row. No pair of overlapping intervals is ever presented as a settled ordering.
3. **Rankings hold within one runner model.** Rankable runs are grouped by `score.runnerModel` and each
   group is ranked on its own, with the model printed on the group band. Token accounting is not
   comparable across tokenizers, so cross-model ranking is refused rather than approximated.
4. **Every finding links to its evidence.** Findings are rendered with a link to the recorded session.
   When a run has no published tape the row prints `no recording published` instead, so a claim never
   stands here as a bare count.
5. **Replay opens on a click.** The viewer link is an ordinary anchor with `target="_blank"` and
   `rel="noopener noreferrer"`. There are no iframes and nothing is fetched from another origin at
   page load.
6. **Only https links reach the DOM.** URLs from the data file are parsed and rejected unless the
   protocol is https, and all text is written through `textContent`, never `innerHTML`.

## Copy rules

Binding for anything added to this page:

- No em-dashes. Ranges read as `55.2% to 95.3%`.
- Never describe what we do as conformance or compliance testing. That word belongs to the official
  suite at github.com/modelcontextprotocol/conformance, and the methods section quotes the line that
  draws the boundary. Ours is: whether an agent can actually get the job done with the server.
- No letter grades. There is no A to F scale here and there will not be one. States are `SCORED` and
  the named refusals.
- No bare lint counts. Every flag carries a link to the session that justifies it.

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

## Testing

`app.js` runs its bootstrap only when `document` and `window` exist, so the module can be imported in
Node and its pure functions (`rankRuns`, `separates`, `intervalsOverlap`, `refusalOf`, `safeUrl`,
`buildViewerUrl`, `summaryText`) exercised without a browser. `renderBoard(tbody, runs)` takes any
element with the DOM methods it uses, so it can also be driven against a shim.

Syntax check: `node --check site/app.js`.

## Deploying

Agents do not deploy this. The operator deploys from this machine with wrangler, and there is no
GitHub Actions workflow for it.
