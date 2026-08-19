# Fitness Report — Design Contract (v0)

Find out whether agents can actually drive your MCP server before your customers do.
One scored run = one server version: first-try task success, calls/tokens per completed
task, per-tool failure attribution, and a signed replayable recording of everything the
server did. Before scoring anything, validity gates run against our own generated task
suite and we REFUSE to emit a score when the eval itself is invalid. That refusal is the
product's credibility line.

Positioning rules (binding for all copy):
- NEVER call this "conformance" or "compliance" testing. The official suite
  (github.com/modelcontextprotocol/conformance) owns that word. Our line:
  "Conformance asks whether the server speaks MCP correctly. Fitness Report asks
  whether an agent can actually get the job done with it."
- Against model benchmarks: "MCP Atlas asks which model is best at using tools.
  Fitness Report asks which server is worth using."
- REFUSED (eval invalid) is a first-class, visible leaderboard state, never an error
  or a missing row.
- Every flag/finding must link to the recorded session that justifies it. No bare lint
  counts. (The July 2026 mcpgrade leaderboard died on HN for exactly this.)
- No em-dashes in any site/leaderboard copy (operator's standing style rule).

## Architecture decisions (settled by recon 2026-08-19; do not relitigate)

1. **Run the agent loop ourselves.** MCP transport = `@modelcontextprotocol/client@^2`
   (NOT `@modelcontextprotocol/sdk`, which is v1, pinned to 2025-11-25, and cannot speak
   2026-07-28). Agent loop = `@anthropic-ai/sdk` `beta.messages.toolRunner()` with the
   `mcpTools()` helper from `@anthropic-ai/sdk/helpers/beta/mcp` adapted to our v2 client
   (the documented `MCPClientLike` narrowing seam; budget an afternoon there).
   The Anthropic MCP connector (`mcp_servers`) is REJECTED as engine: tool-calls only,
   no wire frames, no era control; six of eight metrics uncomputable through it.
2. **Dual-era is a hard requirement.** `versionNegotiation: { mode: 'auto' }`; record
   `getProtocolEra()` and `getDiscoverResult()` into the run record. `--pin 2026-07-28`
   CLI flag produces a separate modern-conformance signal. Era detection notes: 401/403
   and 5xx are never era evidence; on 400 inspect the body for modern JSON-RPC errors.
3. **Models.** Runner = `claude-sonnet-5` ($2/$10, permanent price). Judge =
   `claude-opus-5` ($5/$25; Batch API later at 50% off). Haiku 4.5 only behind `--cheap`
   (no adaptive thinking, 200k ctx). Pin the runner model ID into every score record;
   REFUSE to rank two servers scored under different runner models (new tokenizer from
   Opus 4.7 onward inflates tokens ~30%). Report dollars alongside tokens and net out
   the fixed tool-definition overhead (per-model constants: sonnet-5 354, opus-5 286).
4. **Two tapes per run, never one.** `<run>/mcp.jsonl` (kind:"mcp", wire frames as
   `{t,dir:'in'|'out',raw}`) and `<run>/agent.jsonl` (kind:"llm", `type:'turn'` records).
   A single mixed file double-counts every tool call in mcp-tape stats and the web
   renderer (verified empirically). The two merge in the viewer via `?trace=a;b`.
5. **Tape conformance.** We are a format-extensions §9 producer. meta line:
   `{v:1,type:"meta",startedAt,label:<serverSlug>,command:["fitness-report","<url, credentials stripped>"],mcpTapVersion:<harness version>,kind,source:"fitness-report@<ver>",producer:{name:"fitness-report",version,configHash:<suiteHash>}}`.
   end line: `{t,type:"end",reason:"eval_complete"|"transport_error",durationMs}` with NO
   exitCode. Every line carries `corr_id: <taskId>`. Harness-native events are
   `dir:"event"` with `kind:"fitness.gate"|"fitness.task_start"|"fitness.verdict"` etc.,
   NEVER dir:"in"/"out" (those are reserved for JSON-RPC). Unknown-anything must be
   tolerated when reading. Oracle test: `npx mcp-tape stats <file> --json` must parse our
   tapes and agree with our own pairing counts (mcp-tape is a devDependency only; it is
   bin-only on npm, no exports, no types — never import it at runtime).
6. **Tape writer is ported, not imported.** `src/tape/writer.ts` ports TraceWriter +
   RotatingWriter (~191 lines, MIT, attribution header) with three deltas: caller-supplied
   `t` on every line, caller-supplied output path, rotation OFF (maxBytes
   Number.MAX_SAFE_INTEGER). The writer does NOT redact; redaction runs ONLY on the
   published copy (`src/tape/redact.ts`, rules vendored from the LOCAL mcp-tape checkout's
   default-redact.json which includes the unpublished Google-key rule). Score from
   in-memory pre-redaction records; key-name redaction destroys legit args like
   `page_token` and would corrupt ambiguous-parameter evidence.
7. **Publishing/replay links.** Self-host tapes under the leaderboard's own Pages project
   at `/traces/<runId>/<plane>.jsonl` with `_headers`: `/traces/* →
   Access-Control-Allow-Origin: *` + immutable cache. Replay link =
   `https://mcpreplay.dev/?trace=<encodeURIComponent(absolute url)>#view=calls`
   (merge: `?trace=a;b`; before/after rewrite: `?diff=a;b`; iframe: `&embed=1`; the
   viewer is framable, verified). NEVER use POST /api/share on the automated path
   (5/hr rate limit, 30-day TTL, 10MB cap, server-side redaction mutates tapes).
   Trace URLs must be semicolon-free.
8. **Transport realities (verified live).** Three response shapes exist in the wild:
   SSE-framed vs plain `application/json` (AWS, HF, Better Auth are plain JSON — an
   SSE-only client silently fails on 3 of 14), and session-ful (`mcp-session-id`) vs
   stateless (7 of 14 each). The client wrapper must handle all of it. The SDK response
   cache is ON by default: all drift probes MUST pass `cacheMode:'bypass'` (note:
   'bypass' skips cache WRITES too; use 'refresh' when outputSchema validation and fresh
   bytes are both needed). `input_required` auto-fulfil MUST be off
   (`inputRequired: { autoFulfill: false }`) and MRTR rounds driven manually so each
   round is a tape frame authored by the agent, with a fresh JSON-RPC id and byte-exact
   `requestState` echo. Set `io.modelcontextprotocol/logLevel` in `_meta` on every
   modern request or we capture zero server logs. On modern era, emit the required
   headers (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`) — the SDK does this;
   never hand-roll HTTP.
9. **Failure taxonomy (spec-grounded).** protocol-error (JSON-RPC error / thrown by
   client) | execution-error-recovered (`result.isError:true`, agent retried and
   succeeded) | execution-error-fatal | mrtr-abandoned (round cap) | schema-validation-
   reject (SDK rejects structuredContent vs outputSchema — a SERVER finding, never
   attributed to the agent). MCP tool failures arrive as `isError:true` on a SUCCESSFUL
   response; reading only JSON-RPC errors misses the most common failure class.
10. **Destructive-without-confirmation rule.** Spec defaults are aggressive:
    `destructiveHint` defaults TRUE, `readOnlyHint` FALSE. A tool is treated as
    destructive unless it declares `readOnlyHint:true` or `destructiveHint:false`.
    Also derive an independent judge-model destructiveness signal from name/description
    and report declared-vs-inferred disagreement as its own finding.
11. **Refusal architecture.** Gates ordered by cost: FREE (structural, answer-leak
    string check, plan/power sizing, protocol-hygiene probes) → CHEAP (null-model
    baselines: no-tools, stubbed-empty, random-valid-args; INDETERMINATE halts exactly
    like KILL) → PAID (construct: reference agent with full info must hit answer key at
    ≥0.90) → the full drive. On any gate failure the report JSON has NO `score` field
    (absent, not null) and `outcome: 'GATE_FAILED'|'DEGENERATE'|'INDETERMINATE'|
    'EXTEND_EXHAUSTED'` plus the failing gate's k/n/threshold/alpha/p_value and reason
    string. Markdown, leaderboard row, and replay link all render the refusal AS the
    result. Extension policy (`extensionSize`, `maxExtensions`) is persisted in the run
    record BEFORE the first call; after the last extension an unresolved gate resolves
    to FAIL. A regenerated task suite is a NEW run (suiteHash changes), never a retry.
12. **Gate math ports evalgate exactly, with two documented divergences.**
    (a) construct denominator: oracle errors count — gate on errors/(n+errors) > 0.05 →
    outcome 'COMPROMISED' (evalgate silently shrinks n; wrong for flaky remote servers).
    (b) published-PASS symmetry: a leaderboard PASS additionally requires the Wilson
    95% lower bound ≥ threshold OR n ≥ plan(threshold, detectable).n; otherwise the
    verdict downgrades to EXTEND. Both divergences are documented in METHODS copy; we
    own them publicly. Variance gate must catch oracle exceptions (evalgate's doesn't).
    Structural gate adds a minimum admission rate AND minimum absolute n (evalgate
    passes on n_generated=5 of 200).
13. **Minimum suite size.** With a median of 2.5 tools on the open roster, refuse to
    score below n_tasks ≥ 8; render as REFUSED (INSUFFICIENT_SURFACE), not a 2-task 100%.
14. **Deterministic probe columns (zero tokens, run first).** spec-currency (negotiated
    version; bogus-version 1999-01-01 acceptance = hygiene fail — 12 of 14 servers fail
    it today), header conformance on modern era (mismatched Mcp-Name must 400/-32020),
    server/discover MUST-implement (modern), ttlMs/cacheScope capture (public scope on
    auth-varying list = cross-tenant cache finding), deprecation surface, credential
    context (`anonymous|free-key|owner-key` stamped on every score; tool-surface delta
    by credential where a token is available — HF proves this live).
15. **Every metric is a finite number or absent — never NaN, never null-as-zero.**
    Unknown model pricing fails CLOSED (no cost number rather than a wrong one).
16. **Canary server ships in v0.** 11 of 14 open servers are read-only doc search;
    destructive/ambiguous/error surfaces need our own target: `canary/` is a local
    MCP server (official @modelcontextprotocol/server package or v2 middleware) with:
    `delete_record` (destructive, correctly annotated), `transfer_funds` (destructive,
    UNANNOTATED — must be treated destructive by default rule), `lookup_user(user)`
    (ambiguous param name; the fix is user_id), `flaky_search` (500s on a magic input),
    `get_invoice` (returns isError with actionable text), `slow_echo` (latency),
    plus one tool violating its own outputSchema. The canary is also the fixture bed
    for the audit suite (known-bad task suites must be caught by our gates).
17. **Task synthesis.** Judge model reads tools/list schemas + server `instructions`
    (via `getInstructions()` — inject into runner system prompt too) and emits
    parameterized tasks with machine-checkable success predicates; handle-chaining for
    stateful tools (create returns handle, later tools consume it). Answer-leak string
    check + null-baseline are the leak detectors. Task suite is hashed (suiteHash) into
    producer.configHash. Cite MCPEval as prior art in METHODS; our delta is refusal +
    signed replays + causal rewrite diffs.
18. **Rewrite diffs are causal or nothing.** Glama TDQS already scores descriptions in
    the abstract. Ours: "this description caused 4 of 7 wrong-tool selections in these
    recorded sessions; here is the rewrite; here is the re-run delta", linked with
    `?diff=`. Rubric source = Anthropic's "Writing effective tools for AI agents"
    (user_id over user; when-NOT-to-use; search over list-all; domain prefixes).
19. **Cost control.** Every task runs with `output_config.task_budget` (beta
    `task-budgets-2026-03-13`, min 20000) so a trapping server yields "budget exhausted"
    as a clean unrecoverable-path datum, not an unbounded bill. Effort sweep (low vs
    high) is a planned v1 metric; v0 runs effort default.
20. **No GitHub Actions anywhere** (standing doctrine). Local wrangler deploys only,
    and deploys are done by the operator/main session, not by build agents.

## Repo layout & module contracts

All TypeScript, ESM, Node >= 20 (Pi runs 24.16.0), strict. Vitest. `npm test` must pass.
Shared types live in `src/types.ts` (already written — read it first; do not change
cross-module shapes without a `// CONTRACT CHANGE:` comment explaining why).

- `src/tape/writer.ts` + `src/tape/redact.ts` + `test/tape.test.ts` — decision 4,5,6.
  Conformance test writes a golden two-plane run and asserts `npx mcp-tape stats --json`
  parses and matches our counts (skip gracefully if network/npx unavailable).
- `src/gates/gates.ts`, `structural.ts`, `construct.ts`, `variance.ts`, `nulls.ts`,
  `order.ts`, `stats.ts` (wilson/separate/tieRate/normalQuantile) + `test/gates.test.ts`
  — decisions 11,12. Golden vectors (MUST all pass, ported verbatim from evalgate):
  binomCdf(4,10,0.5)===0.376953125; verdict(32,36,.90)=EXTEND p>0.4;
  verdict(33,36,.90)=PASS; verdict(25,36,.90)=FAIL p<0.05; verdict(68,72,.90)=PASS;
  verdict(60,72,.90)=EXTEND; verdict(56,72,.90)=FAIL; plan(.90,.80).n===78;
  wilson(32,36)=(0.747,0.956) @3dp; z(0.975)=1.959964; z(0.80)=0.841621;
  separate(.42,.58)===153-ish (>100); separate(.42,.83)<30, symmetric;
  tieRate(0.854,3)≈0.493. Use log-space or iterative products for comb (53-bit safety).
  Port the fixtures/audit harness shape (Fixture, AuditReport, ok = no reachable
  missed && no false alarms && no errors) with MCP-native known-bad fixtures.
- `src/mcp/connect.ts` + `src/mcp/probes.ts` + `test/mcp.test.ts` — decisions 2,8,14.
  Wrapper owns: era negotiation + recording, frame capture hook (every request/response
  surfaced to the recorder with observed timestamps), cacheMode discipline, manual MRTR
  surface, logLevel _meta injection, session-ful legacy support, JSON+SSE response
  shapes. Probes are pure-transport, zero-token, and return typed ProbeResults.
- `src/tasks/synthesize.ts` + `test/synthesize.test.ts` — decision 17. Anthropic SDK,
  judge model; deterministic given (schemas, seed) modulo model nondeterminism; unit
  tests use canned schemas with a stubbed client (no live API in tests).
- `src/score/stats.ts` + `src/score/metrics.ts` + `test/score.test.ts` — decisions 3,9,
  10,15. Port pairing math from mcp-tape src/stats-model.ts (buildMcpPairs with
  `${source}::${id}` keying fix, buildTurnPairs, echoed:true filter, isError-aware
  toolResultError, percentile). Embed an `mcp-tape.stats/1`-shaped block as
  `trace_stats` in the report.
- `src/report/render.ts` + `test/report.test.ts` — decisions 11,15,18. Emits
  `fitness-report/1` JSON (score ABSENT on refusal) + markdown. Refusal renders as the
  result with the named gate.
- `src/run/agent.ts` + `src/cli.ts` — integration layer (built AFTER the above):
  toolRunner loop over our client, two-plane recording, task_budget, gate-ordered
  pipeline free→cheap→paid→drive, `fitness-report run <url> [--auth-token] [--pin]
  [--out runs/<id>]`.
- `canary/server.ts` — decision 16. Local stdio or HTTP MCP server, official server SDK.
- `site/` — static leaderboard (no framework, vanilla ES modules), REFUSED as
  first-class state, replay links per decision 7, `_headers` file, columns: server,
  outcome/score, first-try success (with Wilson interval rendered as interval — 
  overlapping intervals are indistinguishable, never a ranking), spec currency,
  protocol hygiene, credential context, replay link. Copy rules at top of this file.
  Not deployed by agents.

## Verified open-server roster (Tier A candidates; do not add unverified hosts)

cloudflare docs https://docs.mcp.cloudflare.com/mcp (2 tools, stateless, SSE)
deepwiki https://mcp.deepwiki.com/mcp (3, stateless) · context7 https://mcp.context7.com/mcp (2)
gitmcp https://gitmcp.io/docs (4, session) · microsoft learn https://learn.microsoft.com/api/mcp (3, session)
aws knowledge https://knowledge-mcp.global.api.aws/mcp (5, session, plain JSON)
hugging face https://huggingface.co/mcp (4 anon, plain JSON, session) · astro https://mcp.docs.astro.build/mcp (1)
vercel docs https://mcp.vercel.com/docs/mcp (1) · coingecko https://mcp.api.coingecko.com/mcp (2, session)
exa https://mcp.exa.ai/mcp (2, session) · convex https://mcp.convex.dev/mcp (4)
better auth https://mcp.better-auth.com/mcp (2, plain JSON) · svelte https://mcp.svelte.dev/mcp (4, session)

Smoke-test target for v0 e2e: Cloudflare Docs MCP (2 read-only tools) + local canary.
Budget guard: e2e smoke uses claude-sonnet-5, <= 3 tasks against the real server. The
full 14-server sweep is an OPERATOR decision, not a build step.
