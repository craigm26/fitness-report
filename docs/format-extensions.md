# Trace format extensions for non-MCP producers

The v1 [trace format](format.md) was specified around MCP JSON-RPC because that's the traffic mcp-tape captures today. The format is **deliberately open and stable** so other producers (robot stacks, agent runtimes, custom test harnesses) can emit the same `.jsonl` shape and play through the same renderer.

This document is a normative extension of v1 that lays out:

1. How non-MCP producers identify themselves in the stream.
2. How non-RPC payloads ride inside the `raw` field without breaking existing consumers.
3. How signed / attested events (e.g., RCAN) preserve their provenance when bridged into the trace plane.
4. How an AI-decision provenance block (modeled on RCAN §16 / `ai`) rides alongside each frame for renderer plugins to surface.
5. Cross-producer correlation so a `tools/call` from the MCP plane and the robot-side event it triggered land on the same timeline with the same correlation id.

The extension is a **compatible extension** to v1, not a strict superset. New *fields* are optional and additive (`source`, `producer`, `attest`, `ai`, `corr_id`, `end.reason`). Two existing v1 surfaces are loosened, and tolerant v1 consumers are expected to absorb that:

- The `dir` value-space is expanded with `"event"` / `"command"` / `"telemetry"` (alongside v1's `"in"` / `"out"`). v1 §"Version policy" already directs renderers to ignore unknown values gracefully, so existing renderers will see these as unknown-but-tolerable.
- `end.exitCode`, required in v1 for process producers, is **optional when `source` is not `mcp-tape`**, i.e. for adapters that aren't processes. A new `end.reason` field replaces it semantically.

v1 [format.md](format.md) has been updated with cross-references so a consumer reading just v1 isn't surprised by either change.

Concrete example throughout this doc: the **OpenCastor robotics stack** ([opencastor.com](https://opencastor.com), [rcan.dev](https://rcan.dev)). RCAN already emits a signed event stream of every AI-driven robot action; an `rcan-to-jsonl` adapter (owned by opencastor-ops, not mcp-tape) converts that stream into frames that mcp-replay can render side-by-side with mcp-tape captures of the same session's MCP traffic.

## 1. Producer attribution

Every line MAY carry a `source` field. `source` identifies the producer that emitted the line and is used by the renderer to:

- group lines by producer in the timeline
- pick a renderer plugin (e.g., `rcan-adapter` lines render with the RCAN view, `mcp-tape` lines render with the JSON-RPC view)
- attribute errors back to a producer when ingest goes wrong

```json
{ "v": 1, "type": "meta", "startedAt": "2026-05-15T01:00:00.000Z",
  "label": "robot-md-gateway",
  "command": ["robot-md-gateway", "--robot", "alice"],
  "source": "mcp-tape@0.1.1",
  "producer": { "name": "mcp-tape", "version": "0.1.1" } }
```

| Field | Type | Notes |
|---|---|---|
| `source` | string | Short identifier in `name[@version]` form. `mcp-tape@0.1.1`, `rcan-adapter@0.1.0`, `castor-gateway@3.0.4`. |
| `producer` | object | Optional, structured version of the above. `{ name, version, configHash? }`. `configHash` lets renderers warn when the producer was reconfigured mid-trace. |

When `source` is omitted, consumers MUST assume `mcp-tape` (back-compat with v1).

## 2. Non-MCP frame envelope

v1 defines two `dir` values: `"in"` (client → server) and `"out"` (server → client). Both assume a single bidirectional pipe carrying JSON-RPC.

The extension defines additional `dir` values for one-way producer streams. The `raw` field's contents are producer-defined when `dir` is anything other than `"in"` / `"out"`. Renderers fall back to a generic JSON-tree view unless a plugin is registered for the producer.

| `dir` | Meaning | `raw` shape |
|---|---|---|
| `"in"` | (v1) client → server | JSON-RPC 2.0 envelope |
| `"out"` | (v1) server → client | JSON-RPC 2.0 envelope |
| `"event"` | producer emitted a one-way event (no bidirectional pipe) | producer-defined |
| `"command"` | a command was issued at this layer | producer-defined |
| `"telemetry"` | passive telemetry sample (no command involved) | producer-defined |

The set is intentionally small. New `dir` values added in a future minor version of this extension must be ignorable by renderers that don't recognize them, and they MUST NOT collide with `"in"` / `"out"` semantics.

Producers SHOULD also set a `kind` field on each line to disambiguate when one producer emits multiple shapes:

```json
{ "t": "2026-05-15T01:00:01.234Z",
  "dir": "command", "kind": "rcan.INVOKE",
  "source": "rcan-adapter@0.1.0",
  "raw": { /* RCAN INVOKE envelope, verbatim */ } }
```

`kind` is a free-form string. Conventional values: `mcp.request` / `mcp.response` / `mcp.notification` for MCP frames, `rcan.<MSG_TYPE>` for RCAN, `protocol66.<event>` for OpenCastor's Safety Layer. The string `rcan.INVOKE` here mirrors the RCAN spec's message-type naming so renderer plugins can switch on the literal type name.

## 3. Attestation pass-through

Producers that already sign their events (RCAN: Ed25519 + ML-DSA-65 hybrid signatures per the `pqc-hybrid-v1` profile; OpenCastor's chained `HMAC-SHA256` audit log; any future signed transport) MUST preserve the signature when bridging into the trace plane. The renderer does not verify (verification stays at the producer) but the trace MUST round-trip the bytes that *would* verify so a downstream auditor can re-run the check.

```json
{ "t": "2026-05-15T01:00:01.234Z",
  "dir": "command", "kind": "rcan.INVOKE",
  "source": "rcan-adapter@0.1.0",
  "raw": { "msg_id": "01J…", "principal": "spiffe://opencastor/alice",
           "ruri": "rcan://alice/arm",
           "command": { "verb": "move", "args": { "x": 0.5, "y": 0.2 } } },
  "attest": {
    "alg": "pqc-hybrid-v1",
    "ed25519_sig": "MEUCIQ…",
    "mldsa65_sig": "AAEC…",
    "key_id": "alice/2026-05-13",
    "chain_prev": "9f3b2a…",
    "chain_hmac": "7c1d4e…"
  } }
```

| Field | Type | Notes |
|---|---|---|
| `attest.alg` | string | Signature algorithm or signature-profile identifier. `pqc-hybrid-v1`, `ed25519`, `hmac-sha256-chain`. |
| `attest.*_sig` | string | One or more base64-encoded signatures, depending on `alg`. |
| `attest.key_id` | string | The signing key's identifier (matches the producer's key registry; RCAN exposes via API). |
| `attest.chain_prev` | string | (chained-audit producers) hex digest of the previous chained record. |
| `attest.chain_hmac` | string | (chained-audit producers) HMAC for this record. Tamper-evident across the file. |

Renderers MAY surface a "signed" badge per line and refuse to render an `attest`-claiming frame whose payload doesn't round-trip canonical-JSON-stable. **Renderers MUST NOT silently strip `attest`**: consumers downstream may rely on it.

## 4. AI-decision provenance block

When an event was produced by, or in direct response to, an AI inference, producers SHOULD include an `ai` block. The field set mirrors RCAN §16 ("AI Accountability") to keep the cognition-tooling renderers and the RCAN audit chain on the same vocabulary.

```json
{ "t": "2026-05-15T01:00:01.234Z",
  "dir": "command", "kind": "rcan.INVOKE",
  "source": "rcan-adapter@0.1.0",
  "raw": { "command": { "verb": "move", "args": { "x": 0.5, "y": 0.2 } } },
  "ai": {
    "provider": "anthropic",
    "model": "claude-opus-4-7",
    "model_version": "claude-opus-4-7[1m]",
    "layer": "tier-2/strategic",
    "confidence": 0.91,
    "inference_latency_ms": 437,
    "thought_id": "thought-01J0X…",
    "escalated": false
  } }
```

| Field | Type | Notes |
|---|---|---|
| `ai.provider` | string | `anthropic`, `openai`, `local`. Matches RCAN. |
| `ai.model` | string | Marketing name. |
| `ai.model_version` | string | Exact version pin. |
| `ai.layer` | string | OpenCastor's "tiered brain" layer if applicable. Free string otherwise. |
| `ai.confidence` | number | 0..1. If a confidence gate fired, also set `escalated`. |
| `ai.inference_latency_ms` | number | Whatever the producer measured. |
| `ai.thought_id` | string | RCAN thought-log id. Lets the renderer cross-link to a chain-of-thought viewer if registered. |
| `ai.escalated` | bool | True when a HiTL / GuardianAgent gate fired and the command was held. |

This is the field set that lets a renderer answer "**which model, at which confidence, drove this physical motion?**", the headline question for AI-accountable robotics, and the bridge from the MCP `tools/call` to the RCAN-audited physical effect.

## 5. Cross-producer correlation

A single agent decision often becomes multiple wire events:

```
Claude → robot-md-mcp (MCP tools/call invoke_skill)         ┐
       → robot-md-gateway (Protocol 66 safety gate, RCAN)   │  same decision
       → OpenCastor Tiered Brain → RCAN INVOKE → driver     │  three producers
```

To put all three on the same merged timeline in mcp-replay with a visible "these are one decision" grouping, the producers SHOULD propagate a shared `corr_id`. Three illustrative lines from three different producers (pseudocode; actual frames carry the full `raw` envelope per §1-4):

```jsonc
// from mcp-tape capture of the agent → robot-md-mcp pipe
{ "t": "...", "dir": "in",      "source": "mcp-tape@0.1.1",
  "kind": "mcp.request", "corr_id": "thought-01J0X",
  "raw": { "jsonrpc": "2.0", "id": 42, "method": "tools/call",
           "params": { "name": "invoke_skill" } } }

// from the rcan-adapter, same decision arriving at the RCAN bus
{ "t": "...", "dir": "command", "source": "rcan-adapter@0.1.0",
  "kind": "rcan.INVOKE", "corr_id": "thought-01J0X",
  "raw": { "msg_id": "01J0X-INVOKE", "ruri": "rcan://alice/arm" } }

// from castor-gateway, the Protocol-66 gate decision on the same command
{ "t": "...", "dir": "event",   "source": "castor-gateway@3.0.4",
  "kind": "protocol66.gate.allowed", "corr_id": "thought-01J0X",
  "raw": { "gate": "confidence", "threshold": 0.85, "observed": 0.91 } }
```

Recommended `corr_id` source: the AI-inference `thought_id` (also carried in `ai.thought_id` above). Producers below the AI layer pick it up from the inbound MCP request and propagate it through their own envelopes. When no AI inference is involved (purely deterministic flow), producers MAY synthesize a ULID and propagate it the same way.

Renderers with merge support (mcp-replay's drag-multi-file flow, or `?trace=a;b;c`) SHOULD group adjacent frames sharing a `corr_id` into a single collapsible row in the timeline and "decision" entry in the call inspector. v1-only renderers ignore the field and continue to interleave strictly by `t`.

## 6. End-of-stream marker

The v1 `end` line carries `exitCode` and `durationMs`. For non-process producers (an `rcan-adapter` tailing a long-lived bus, or a `castor-gateway` streaming continuously) those are meaningless. The extension makes `exitCode` optional when `source` is set to anything other than `mcp-tape` and adds a `reason` field:

```json
{ "t": "...", "type": "end", "reason": "subscriber_unsubscribed", "durationMs": 30000 }
```

Conventional `reason` values: `process_exit` (default, when `exitCode` is present), `subscriber_unsubscribed`, `producer_shutdown`, `transport_error`.

## 7. Concrete example: RCAN→JSONL bridge

A complete short trace produced by a hypothetical `rcan-adapter` listening on the RCAN bus while a single arm-move decision flows through. (Field values are illustrative.)

```jsonl
{"v":1,"type":"meta","startedAt":"2026-05-15T01:00:00.000Z","label":"alice-rcan","command":["rcan-adapter","--robot","alice"],"source":"rcan-adapter@0.1.0","producer":{"name":"rcan-adapter","version":"0.1.0","configHash":"f3a1b2"}}
{"t":"2026-05-15T01:00:01.234Z","dir":"command","kind":"rcan.INVOKE","source":"rcan-adapter@0.1.0","corr_id":"thought-01J0X","raw":{"msg_id":"01J0X-INVOKE","principal":"spiffe://opencastor/alice","ruri":"rcan://alice/arm","command":{"verb":"move","args":{"x":0.5,"y":0.2}},"confidence":0.91,"hitl":false,"timestamp_ms":1763161201234,"outcome":null},"attest":{"alg":"pqc-hybrid-v1","ed25519_sig":"MEUCIQ","mldsa65_sig":"AAEC","key_id":"alice/2026-05-13","chain_prev":"9f3b2a","chain_hmac":"7c1d4e"},"ai":{"provider":"anthropic","model":"claude-opus-4-7","model_version":"claude-opus-4-7[1m]","layer":"tier-2/strategic","confidence":0.91,"inference_latency_ms":437,"thought_id":"thought-01J0X","escalated":false}}
{"t":"2026-05-15T01:00:01.298Z","dir":"event","kind":"protocol66.gate.allowed","source":"rcan-adapter@0.1.0","corr_id":"thought-01J0X","raw":{"msg_id":"01J0X-GATE","gate":"confidence","threshold":0.85,"observed":0.91,"decision":"allow"}}
{"t":"2026-05-15T01:00:01.811Z","dir":"event","kind":"rcan.INVOKE_RESULT","source":"rcan-adapter@0.1.0","corr_id":"thought-01J0X","raw":{"msg_id":"01J0X-RESULT","ref_msg_id":"01J0X-INVOKE","outcome":"ok","completed_at_ms":1763161201811,"duration_ms":577}}
{"t":"2026-05-15T01:00:30.000Z","type":"end","source":"rcan-adapter@0.1.0","reason":"subscriber_unsubscribed","durationMs":30000}
```

Drag that file plus a `mcp-tape` capture of the same session onto mcpreplay.dev and they interleave by `t`. Renderers with the (eventual) RCAN plugin will:

- group all four lines sharing `corr_id: "thought-01J0X"` into one expandable "decision" row
- show the `ai` block as a provenance badge
- show the `attest` round-trip as a verifiable signature badge
- render the `command.args` as a structured table instead of raw JSON

Renderers without the plugin still show all four lines, in order. The timeline summary falls back to `kind` for non-JSON-RPC frames (mcp-replay's `summarizeMessage` handles this as of the same release that ships this extension doc), so an unconfigured renderer surfaces `rcan.INVOKE` / `protocol66.gate.allowed` in the row rather than rendering blank. The Raw view always shows the full JSON regardless of plugin support.

Normative: renderers MUST NOT error on unknown `kind` values, MUST NOT error on `dir` values outside `"in"` / `"out"`, and SHOULD display `kind` as the row summary when no JSON-RPC discriminator (`method` / `result` / `error`) is present.

## 8. What the extension does NOT define

- **No verification.** Renderers do not validate `attest`. That stays at the producer (RCAN audit chain, OpenCastor `castor audit --verify`, etc.).
- **No transport.** The `.jsonl` file is the surface. Whether the producer wrote it via a file, a websocket (`mcp-tape --serve`-shape), or a future HTTP upload is outside this doc.
- **No identity model.** `principal`, `ruri`, and key registries belong to the producer's protocol (RCAN). The trace plane just round-trips them.
- **No replay-prevention guarantees.** The trace file is a log; it doesn't enforce `msg_id` uniqueness. Producers that need that (RCAN does, per `msg_id` for replay prevention) enforce it at their own layer.
- **No schema for `raw`.** Producer-defined. Renderer plugins are how the renderer learns shapes.

The bridge stays loosely coupled: the cognition-tooling family doesn't take a dependency on RCAN, OpenCastor, or any specific robotics protocol. The producer side takes a dependency on this format spec, which is versioned (`v: 1`), additive, and public.

## 9. Producer responsibilities checklist

For someone writing a new adapter (RCAN-to-JSONL, ROS-to-JSONL, MQTT-to-JSONL, etc.):

- [ ] First line is `meta` with `v: 1`, `source`, `producer.name`, `producer.version`.
- [ ] Each subsequent line has `t` (ISO-8601, ms precision, UTC).
- [ ] Each subsequent line has `dir` and (recommended) `kind`.
- [ ] `raw` is the verbatim original envelope from the source protocol.
- [ ] When the source carries a signature, populate `attest` losslessly.
- [ ] When the event was AI-driven, populate `ai` (use RCAN §16 names).
- [ ] When the decision spans multiple producers, propagate `corr_id`.
- [ ] Last line is `end` with `reason`. `exitCode` only when the producer is a process and it exited.
- [ ] Redact secrets before writing. The marker is producer-defined; mcp-tape uses `"[REDACTED]"`.
- [ ] Don't break v1: every field above is optional; the renderer must still work if half are missing.
