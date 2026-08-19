# mcp-replay trace format (v1)

A trace is a newline-delimited JSON file (`.jsonl`) that records the JSON-RPC traffic between an MCP client and a single MCP server. One JSON object per line. UTF-8 encoded.

The format is open and stable. Any producer can emit traces in this shape; [mcp-tape](https://github.com/craigm26/mcp-tape) is the reference producer.

## Line types

Every line is one of four shapes: `meta` (first line), message lines, `turn` records, or `end` (last line).

### `meta`: first line

```json
{
  "v": 1,
  "type": "meta",
  "startedAt": "2026-05-12T23:00:00.000Z",
  "label": "filesystem",
  "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/home/me"],
  "mcpTapVersion": "0.1.0"
}
```

| Field | Required | Description |
|---|---|---|
| `v` | yes | Format version. Currently `1`. |
| `type` | yes | Literal `"meta"`. |
| `startedAt` | yes | ISO-8601 UTC timestamp with millisecond precision. |
| `label` | yes | Short human-readable name for the trace (used in UI tabs). |
| `command` | yes | The argv used to launch the server. |
| `mcpTapVersion` | no | Version of the producing tool, if any. |
| `kind` | no | What kind of session this trace records. Defined values: `"mcp"` (MCP JSON-RPC traffic, the v1 default), `"llm"` (recorded LLM API traffic), `"cc-session"` (an imported Claude Code session transcript). Consumers MUST assume `"mcp"` when the field is absent. Unknown values MUST be tolerated (render as a generic trace). |
| `source` | no | Producer attribution in `name[@version]` form, e.g. `"mcp-tape@0.5.0"`. See [format-extensions.md](format-extensions.md) §1. Producers of turn records SHOULD emit it. |
| `producer` | no | Structured producer attribution, `{ name, version, configHash? }`. See [format-extensions.md](format-extensions.md) §1. Producers of turn records SHOULD emit it. |

### Message lines

```json
{"t": "2026-05-12T23:00:00.123Z", "dir": "in", "raw": { ... JSON-RPC payload ... }}
```

| Field | Required | Description |
|---|---|---|
| `t` | yes | ISO-8601 UTC timestamp with millisecond precision. |
| `dir` | yes | `"in"` = client → server. `"out"` = server → client. Producers other than mcp-tape may emit additional values (`"event"`, `"command"`, `"telemetry"`); see [format-extensions.md](format-extensions.md). v1-only renderers MUST ignore unknown `dir` values gracefully (see §"Version policy"). |
| `raw` | yes | Verbatim JSON-RPC 2.0 message, post-redaction. May be a request, response, or notification. Producers other than mcp-tape MAY carry non-JSON-RPC payloads here; see [format-extensions.md](format-extensions.md). |

The `raw` field contains the unmodified JSON-RPC envelope. Consumers extract `method` / `id` / `params` / `result` / `error` from there.

### Turn records

A `turn` record captures one conversational turn of an LLM session: a user prompt, an assistant response (thinking, text, tool calls), a tool result, or a system marker. Turn records are the shared shape consumed by the Turns view and produced by session importers (`mcp-tape cc`) and LLM recorders. This section is the normative spec; other documents add only additive optional fields.

```json
{"t": "2026-07-16T00:00:01.000Z", "type": "turn", "role": "assistant",
 "model": "claude-example-1",
 "blocks": [{"type": "thinking", "thinking": "..."},
            {"type": "text", "text": "..."},
            {"type": "tool_use", "id": "toolu_01", "name": "Read", "input": {}}],
 "usage": {"input_tokens": 12, "output_tokens": 345,
           "cache_read_input_tokens": 6789, "cache_creation_input_tokens": 0},
 "timing": {"duration_ms": 4200},
 "source": "cc"}
```

| Field | Required | Description |
|---|---|---|
| `t` | yes | ISO-8601 UTC timestamp with millisecond precision. For imported sessions this is the source transcript's timestamp, not import time. |
| `type` | yes | Literal `"turn"`. |
| `role` | yes | `"user"`, `"assistant"`, or `"system"`. |
| `blocks` | yes | Ordered array of content blocks (see below). May be empty. |
| `model` | no | Provider model id, e.g. `"claude-opus-4-7"`. Typically present on assistant turns only. |
| `usage` | no | Token usage for the turn: `{input_tokens, output_tokens, cache_read_input_tokens?, cache_creation_input_tokens?, thinking_tokens?}`. Subject to the usage invariant below. |
| `timing` | no | `{ttft_ms?, duration_ms?}`. Milliseconds. Importers derive `duration_ms` from source timestamps; `ttft_ms` is only available to live recorders. |
| `source` | no | Short producer or origin tag for this record, e.g. `"cc"`. |

Every field beyond `t` / `type` / `role` / `blocks` MUST be treated as optional by consumers. Producers MAY attach additional fields; consumers MUST ignore fields they do not understand.

#### Block types

Blocks are provider-shaped: they carry the fields the underlying provider API uses, so a turn round-trips the source content faithfully. Defined block types:

| Block `type` | Fields | Description |
|---|---|---|
| `thinking` | `thinking` (string) | Model thinking / reasoning text. Producers SHOULD drop provider signature fields by default. |
| `text` | `text` (string) | Visible assistant or user text. |
| `tool_use` | `id` (string), `name` (string), `input` (object) | A tool invocation issued by the assistant. `id` pairs with a later `tool_result` block's `tool_use_id`. |
| `tool_result` | `tool_use_id` (string), `content` (string or array), `is_error?` (bool) | The result of a prior `tool_use`. Producers MAY attach a `structured` field carrying a richer machine-shaped payload. |

Renderers MUST ignore unknown block `type` values inside `blocks` and render a neutral placeholder for them; an unknown block never invalidates the turn.

#### Usage invariant

Normative, shared by every producer of turn records:

- `usage.input_tokens` EXCLUDES cache-read and cache-creation tokens. Cached tokens are reported only in their own fields (`cache_read_input_tokens`, `cache_creation_input_tokens`).
- `usage.thinking_tokens`, when present, is a SUBSET of `output_tokens`, never additive to it. Total output is `output_tokens` alone.
- Producers MUST normalize provider-reported usage to this shape at record time. Consumers sum turn usage fields directly, without provider-specific correction.

#### Tolerance rules

- Renderers MUST NOT error on unknown top-level `type` values. Unknown record types are skipped or rendered generically, never fatal.
- Renderers MUST ignore unknown block `type` values inside `blocks` and render a placeholder.
- Renderers MUST render mixed traces: old `{t, dir, raw}` message lines interleaved with `turn` records in one file.
- Renderers MUST treat every turn field beyond `t` / `type` / `role` / `blocks` as optional.

#### Importers and `end.reason`

Producers that import an existing transcript (rather than wrapping a live process) end the trace with `reason` instead of `exitCode`:

```json
{"t": "2026-07-16T00:10:00.000Z", "type": "end", "reason": "imported", "durationMs": 600000}
```

`"imported"` is a conventional `reason` value meaning the trace was converted from a pre-existing session transcript; `t` and `durationMs` come from the source timestamps. See the `end` line's `exitCode` conditionality below: importers are non-process-wrap producers and omit `exitCode` even when they identify as mcp-tape (e.g. `source: "mcp-tape@0.6.0"`).

### `end`: last line

```json
{
  "t": "2026-05-12T23:00:30.000Z",
  "type": "end",
  "exitCode": 0,
  "durationMs": 30000
}
```

| Field | Required | Description |
|---|---|---|
| `t` | yes | ISO-8601 UTC timestamp at which the proxy closed. |
| `type` | yes | Literal `"end"`. |
| `exitCode` | conditional | Child process exit code. `0` is success. Required when `kind` is absent or `"mcp"` AND the producer wraps a process (the classic mcp-tape proxy). Non-process-wrap producers, including importers, omit `exitCode` and use `end.reason` instead, regardless of what `source` says; an importer emitting `source: "mcp-tape@<ver>"` with `reason` and no `exitCode` is conformant. See [format-extensions.md](format-extensions.md) §6. |
| `reason` | no | Why the stream ended, for producers that do not report `exitCode`. Conventional values: `process_exit` (default when `exitCode` is present), `imported` (the trace was converted from a pre-existing session transcript), plus the values in [format-extensions.md](format-extensions.md) §6 (`subscriber_unsubscribed`, `producer_shutdown`, `transport_error`). |
| `durationMs` | yes | Milliseconds between the `meta.startedAt` and this line. |

## LLM recording addendum (`kind: "llm"`)

Normative for producers that record LLM API traffic (the reference producer is `mcp-tape llm`). Everything here is additive under `v: 1`; the tolerance rules above already make these lines safe for v1 renderers.

### Meta

The meta line sets `kind: "llm"`. Producers SHOULD also emit `source` and `producer` (format-extensions.md §1).

### Additive turn fields

LLM producers add three OPTIONAL fields to turn records. Consumers MUST tolerate their absence and MUST ignore them on non-llm traces:

| Field | Type | Description |
|---|---|---|
| `endpoint` | string | The provider path the exchange used, query string removed, `--map` prefix stripped (e.g. `"/v1/messages"`, `"/v1/chat/completions"`). |
| `stream` | boolean | `true` when the assistant turn was assembled from a streamed response (SSE or NDJSON); `false` for a single JSON body. |
| `echoed` | boolean | `true` when the turn came from a REQUEST body rather than a response, i.e. the client re-sent it as context. Only assistant turns are ever marked. |

Assistant turns from a stream that was severed early MAY carry `truncated: true` and a `stop_reason` of `"truncated"`; the content blocks then hold everything assembled up to the cut.

#### `echoed`: resent context, not a generation

Chat APIs are stateless, so a client re-sends the prior assistant response with every follow-up request. A recording proxy therefore sees each assistant message twice: once assembled from the response stream (carrying `model`, `usage`, and `timing`), and again inside the next request (carrying none of them). Producers MUST mark the second kind `echoed: true`.

Consumers:

- MUST NOT count `echoed` turns as model calls, and MUST exclude them from per-model token, cost, cache, and latency aggregates. They describe no generation; counting them produces a phantom `(no model)` row.
- SHOULD omit them from turn-by-turn reading views, where they are a verbatim duplicate of the turn immediately above.
- MUST keep them in the record stream. What a client actually sent upstream is the auditable part of a trace, and a truncated or edited resend is exactly the sort of thing a reader may be looking for.

### The `history_elided` block

Chat APIs are stateless, so clients re-send the full conversation on every request. A producer that elides already-recorded history from the tape marks the splice with a `history_elided` block as the FIRST block of the first recorded turn of that request:

```json
{"type": "history_elided", "count": 2,
 "sha256": "<64 lowercase hex chars>",
 "request_sha256": "<64 lowercase hex chars>"}
```

| Field | Description |
|---|---|
| `count` | Number of leading messages of the request's messages array that were elided from the tape. Forwarding to the provider is never affected. |
| `sha256` | Chained rolling hash of the elided prefix (construction below). |
| `request_sha256` | Plain SHA-256 (lowercase hex) of the raw request body bytes, exactly as sent upstream. |

Renderers treat `history_elided` under the unknown-block tolerance rule; it never invalidates the turn.

#### Rolling-hash construction (normative)

`sha256` is NOT a SHA-256 of the concatenated prefix bytes. It is a chained rolling hash over per-message digests, computed exactly as follows (matching the reference implementation in mcp-tape `src/llm-dedup.ts`):

1. Let `H(s)` be the lowercase-hex SHA-256 digest of the UTF-8 bytes of string `s`.
2. Seed: `rolling[0] = H("")` (the digest of the empty string).
3. For each elided message `m_i` of the request's messages array, in order, for `i = 1..count`:
   - `h_i = H(JSON.stringify(m_i))`, where `JSON.stringify` is applied to the parsed message value (JavaScript semantics: no added whitespace, key order as parsed from the request body).
   - `rolling[i] = H(rolling[i-1] + h_i)`, where `+` is plain string concatenation of the two lowercase-hex digests.
4. `sha256 = rolling[count]`.

A consumer holding the same `count` leading message values can therefore recompute and verify the marker. `request_sha256` is independently verifiable against the raw request body bytes.

### Event lines (`dir: "event"`, `kind: "llm.*"`)

LLM producers record exchange metadata as extension message lines with `dir: "event"`, `source: "llm"`, and a `kind` in the `llm.*` namespace. Rule: llm event lines NEVER use `dir: "in"` or `dir: "out"`; those values are reserved for MCP JSON-RPC message lines, and consumers MUST NOT feed `dir: "event"` lines into request/response pairing even when `raw` carries an `id`.

Defined kinds:

| `kind` | Meaning |
|---|---|
| `llm.request` | One per recorded generation exchange: `raw` carries `endpoint`, scrubbed `url`, `method`, `status`, `stream`, `request_sha256`, allowlisted `headers` / `response_headers`, plus `system` (the request's top-level system prompt, when present) and `tools_count` (number of tool definitions; tool bodies are never recorded). |
| `llm.exchange` | A recorded exchange without turn records. Compact form for recognized non-generation endpoints (`count_tokens`, model lists): `raw` is `{method, endpoint, status}` only. Tolerant-capture form for unrecognized response shapes: `raw` additionally carries the (redacted) response `body`, or a `reason` explaining why the body was not captured (e.g. a non-identity `content-encoding`). |
| `llm.error` | Upstream or routing failure: `raw` carries `endpoint`/`url`, an `error` or `status`, and for HTTP errors the (redacted) response `body`. |
| `llm.truncated` | A stream was severed before its natural end: `raw` carries `endpoint`, `url`, `reason` (`client_abort`, `upstream_disconnect`, `idle_timeout`, `upstream_error: ...`), and `bytes_so_far`. |

### End line

The standalone LLM proxy (`mcp-tape llm` with no child command) wraps no process: it is a non-process-wrap producer and ends the trace with `reason: "producer_shutdown"` and NO `exitCode`, per the `end` line's conditionality rules. When the producer wraps a child command, the end line carries the child's `exitCode` as usual.

## Ordering and timing

- Lines appear in the order the proxy observed them on its pipes. This is approximately wall-clock chronological but is not guaranteed to be strictly monotonic across the two pipes. `dir:"in"` and `dir:"out"` are interleaved as the proxy read them, not as the server processed them.
- Timestamps are millisecond precision; messages within the same millisecond are extremely rare in practice but theoretically possible.

## Redaction

Producers may redact sensitive substrings in `raw` before writing the line. The replacement marker is implementation-defined; mcp-tape uses the literal string `"[REDACTED]"`. Consumers MUST NOT assume `raw` round-trips bit-for-bit to what was on the wire.

The `meta.command` may include arguments that were on the original process command line. Producers should treat command-line redaction the same way as message redaction.

## Multi-server traces

This format describes **one server per file**. To represent a multi-server session, write one file per server and merge by timestamp in the renderer. The mcpreplay.dev URL grammar supports this directly:

```
https://mcpreplay.dev/?trace=https://x.example/a.jsonl;https://x.example/b.jsonl
```

## Loading from PlatAtlas

Traces uploaded via `mcp-tape upload --public` (PlatAtlas 0.3.0+) are
fetchable at:

```
https://<subdomain>.platatlas.com/api/traces/<uuid>
```

They serve `application/x-ndjson` with `Access-Control-Allow-Origin: *`
and a 5-minute public `Cache-Control`. Use them in mcp-replay via the
existing `?trace=` grammar, with no new URL shape and no new code path:

```
https://mcpreplay.dev/?trace=https://<subdomain>.platatlas.com/api/traces/<uuid>
```

Private traces (default) return 401 to cross-origin fetches and are not
viewable through mcpreplay.dev. View them in PlatAtlas's own UI when it
lands, or pass `--public` at upload time.

## Version policy

Breaking changes increment `v`. Additive fields (e.g., adding optional members to `meta`) do not change `v`. Renderers should ignore unknown fields and fall back gracefully when unfamiliar `type` values appear.

**Turn records are additive under `v: 1`.** Introducing the `turn` top-level `type` (and the optional meta `kind` field) does not bump `v`, because the ecosystem tolerance rules above make a new `type` value safe: conforming renderers ignore unknown types instead of failing the file. Known consumer gap, documented as the compatibility caveat: the shipped iOS 1.0 app drops unknown record types (including `turn`) into its `skippedLines` count with no crash but also no UI signal, and a turn-only trace hits its empty-trace guard; iOS 1.1 adds native turn parsing.

For AI-decision provenance and correlation fields, reuse the `ai.thought_id` / `corr_id` vocabulary defined in [format-extensions.md](format-extensions.md) §4 and §5 rather than inventing parallel fields on turn records.

## Extensions for non-MCP producers

The fields above describe MCP JSON-RPC traffic captured by [mcp-tape](https://github.com/craigm26/mcp-tape). Other producers (robot stacks (RCAN), agent runtimes, custom test harnesses) can emit conforming `.jsonl` using the compatible extension at [format-extensions.md](format-extensions.md). The extension covers producer attribution, non-RPC payload envelopes (new `dir` values), signature pass-through, AI-decision provenance (modeled on the RCAN §16 `ai` block), cross-producer correlation, and `end.exitCode`'s conditional optionality for non-process producers. v1 renderers should keep working on extension files because §"Version policy" already directs them to ignore unknown values and fall back gracefully, but the extension is not a strict superset and is documented as such.
