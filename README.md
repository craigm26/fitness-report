# Fitness Report

Find out whether agents can actually drive your MCP server before your customers do.

One scored run against one server version. You get first-try task success with a
confidence interval, calls and tokens per completed task, per-tool failure
attribution, suggested tool-description rewrites grounded in recorded failures,
and a replayable recording of everything the server actually did on the wire.

Before scoring anything, Fitness Report runs validity gates against its own
generated task suite. When the eval itself is invalid, it refuses to emit a
score, and the refusal is published as the result. A leaderboard number you can
trust has to be able to say "this measurement was not valid" out loud.

The very first live run did exactly that. Against a real documentation server,
the no-tools null model passed the generated tasks, meaning the tasks could be
answered from the model's own knowledge without touching the server. The gate
returned noise_exceeds_signal and the run published a refusal instead of a
flattering score. That behavior is the product.

## What it is not

Conformance asks whether the server speaks MCP correctly. Fitness Report asks
whether an agent can actually get the job done with it. For spec conformance,
use the official suite at github.com/modelcontextprotocol/conformance.

MCP Atlas and its peers ask which model is best at using tools. Fitness Report
asks which server is worth using. Same arena, opposite question.

## How a run works

1. Deterministic probes, zero tokens: protocol era and spec currency, bogus
   version hygiene, header conformance, cache hints, deprecation surface.
2. Task synthesis from the server's own tool schemas and instructions.
3. Validity gates in cost order: structural and answer-leak checks free, null
   model baselines cheap, the construct gate paid. Any failure refuses the run.
4. The drive: a real agent works every task while both planes are recorded as
   mcp-tape JSONL, wire frames on one tape and model turns on the other.
5. Scoring and rendering. On refusal, the report has no score field at all.

```bash
npm install
npx vitest run                       # 268 tests, no network, no API key
npx tsx src/cli.ts run https://docs.mcp.cloudflare.com/mcp --max-tasks 12 --out runs/my-run
```

The runner model is pinned into every score record. Runs made with different
runner models are never ranked against each other.

## Methods notes

Two documented divergences from the evalgate ancestry, both explained in
DESIGN.md: oracle errors count in the construct gate's denominator, and a
published PASS additionally requires the Wilson lower bound to clear the
threshold or the run to be sized with adequate achieved power at its own n.
Extension batches are not run in v0; an unresolved gate refuses immediately.

Prior art we build on gratefully: MCPEval (arXiv 2507.12806) for schema-driven
task synthesis, mcp-tape and mcp-replay for the recording format and viewer,
and the FOIL evalgate work for the validity-gate discipline.

## License

MIT
