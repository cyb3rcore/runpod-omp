## 1.4.0

- **feat:** filter forwarded tools with request.toolAllowlist (`0a3abc3`)
  - Add an optional per-profile allowlist of tool names; when set, only those tools are sent to the worker.
- Lets profiles trim the tool surface the model sees.

- **fix:** keep object properties named pattern/format in tool schemas (`ec5c36f`)
  - Strip `pattern`/`format` only when they are JSON-Schema constraint keywords (string values).
- Tool parameters that merely share the name, like grep's required `pattern`, are forwarded verbatim so the model emits the call with its required argument.

- **fix:** report prompt-cache hits and real exchange timing (`980db13`)
  - Surface llama.cpp's prompt-cache hits as cache-read tokens in the usage tooltip instead of a hardcoded zero.
- Measure direct (load-balanced) exchanges end to end and report time-to-first-token, so the token-rate and TTFT tooltip shows real numbers.
- Queue transports intentionally omit timing, because queue wait would corrupt the reported rate.

- **docs:** mirror the live subs pod profile in the pod example (`7bbea5a`)
  The pod example now matches the deployed subs pod: keyless worker (no pod.inferenceApiKey), policy maxAttempts: 3, model name, and a note that the id is the live pod's. Mirror maxAttempts: 3 in the load-balanced example too.

- **docs:** restructure for fast scanning — endpoint decision table, collapsible examples, corrected cost claims (`1b3a1e0`)
  Add a 'Which endpoint type?' decision table (queue / load-balanced / pod) and a table of contents so both serverless and pod readers find their path immediately. Collapse the three full YAML examples into <details> blocks. Remove the stale status-line claims (the refresher is disabled pending OMP's inline-segment API), drop the duplicated health-probes section, and tighten prose throughout.

## 1.3.0

- **feat:** pod profile support — TCP address derivation, lifecycle commands, pod tool, cost (`54fa4cf`)

  Add `endpointType: pod` profiles for dedicated Runpod pods:

  - the worker's public TCP address is resolved at call time from the control plane (`GET /v2/pods/{id}` → `runtime.ports`); a static `invokeUrl` override covers proxy/tunnel setups;
  - `/runpod pod`, `/runpod pod <profile>`, and `/runpod pod start|stop|restart <profile>` lifecycle commands with interactive confirmation (headless sessions fail closed);
  - `runpod_pod` read-only tool reporting state, `$X.XX/hr`, uptime, data center, resolved address, and readiness;
  - `/runpod cost` gains a live pod section (`Pod.cost`, USD/hour; 0 when stopped) with accrued spend from uptime; billing narrows to the pod;
  - streaming, tool calling, retries, and fallback profiles are inherited from the load-balanced transport; only `pod.inferenceApiKey` is ever forwarded to the worker — the account-scoped control key stays on the control plane.

  The guided `/runpod configure` flow gained the pod endpoint type, and `/runpod profile` marks pod profiles with `(pod)`.

- **docs:** reflect the Q6 subs setup — 4×128K slots, stream mode (`ad216ad`)

  - subs profile: Qwen3.8-27B-UD-Q6_K_XL, contextWindow 131072
  - both profiles on mode: stream (thinking streams; no more whole-response buffering)
  - concurrency paragraph: PARALLEL=4, CTX_SIZE=524288, requestCount=4, 8-concurrency ceiling — with the KV-budget rationale for Q6 vs Q8 on A40
  - model-cache note: private repos work via the Model field (no endpoint HF_TOKEN needed)

## 1.2.1

- **fix:** request usage in streamed responses (`965f199`)
  OpenAI-compliant streamed responses omit the usage object unless the
client sends stream_options.include_usage; llama.cpp honors that. Without
it, streamed turns showed no per-turn token counts. Send
stream_options:{include_usage:true} whenever streaming.

## 1.2.0

- **feat:** per-request journal, disabled by default (`c8ad8f5`)
  Opt-in via RUNPOD_OMP_LOG=<path>: JSONL lifecycle entries per streamSimple
turn — dispatch (request summary: message/tool counts, maxTokens, mode),
dispatch-done (duration, text/reasoning/toolcall lengths, usage),
dispatch-error (message + cause, credentials redacted), replay-done, and
failed (surfaced error). Journal writes are synchronous, best-effort, and
never affect the stream.

This is the OMP-side half of the debugging pipeline (plugin journal ↔
shim request log ↔ llama-server log) for correlating one failing turn.

## 1.1.0

- **fix:** strip regex pattern/format from forwarded tool schemas (`6a5f96e`)
  llama.cpp's JSON-schema→grammar converter passes regex-ish constraint
keywords through into the GBNF grammar, whose parser rejects escapes like
\d. One such schema (mcp__runpod_get_capacity.cudaVersions, pattern
'^\\d{1,2}\\.\\d{1,2}$') failed the entire request at sampler init
with HTTP 400 'Failed to initialize samplers: failed to parse grammar'.

Sanitize tool parameter schemas recursively before forwarding (drop pattern
and format at every level). OMP still validates arguments locally against
the original schema, so no safety is lost on the wire.

- **feat:** wire OpenAI tool calling end-to-end (`b486380`)
  - forward OMP context.tools as OpenAI function definitions
- round-trip assistant history tool calls as wire message.tool_calls
  (Qwen3 templates require them before a tool-role result)
- decode tool_calls from JSON completions; reassemble fragmented
  delta.tool_calls from SSE by index
- replay tool calls as OMP toolcall_start/delta/end events with ToolCall
  content blocks and stopReason toolUse
- profile configs now declare supportsTools: true

Fixes the observed failure: the model emitted OMP tool-call syntax as plain
text because the plugin dropped context.tools and never parsed tool_calls.

- **feat:** retry transient failures per policy, bound maxTokens (`74e40c5`)
  - wire the schema'd-but-dead policy into dispatch: the primary profile is
  attempted up to maxAttempts with a 1s backoff, then each fallbackProfile
  once; only transient failures (HTTP 5xx, network) retry or fall back —
  deterministic 4xx/shape/job errors and aborts/timeouts surface immediately
- transports mark 5xx and network errors as retryable (isRetryableError)
- always send model.maxTokens as the generation ceiling so a runaway or
  post-abort (zombie) task cannot burn the slot unbounded
- fallback candidates resolve their own apiKey and rebuild the request

Fixes the 502s observed in production: the Runpod LB returns 502 while a
worker cold-starts or routes to a bad/stale worker; retries now absorb those
transients instead of hard-failing the turn.

- **docs:** document main+subs concurrency profiles example (`1609392`)

## 1.0.2

- **fix:** surface actionable errors, hoist system messages, replay thinking (`3c34734`)
  - stream failures now surface the underlying transport/resolver error with
  only known credential bytes redacted, instead of a fixed [redacted] marker
  (the production failure was a llama.cpp 500 hidden behind it)
- hoist and merge system messages into one at index 0: Qwen3 chat templates
  reject a mid-conversation system message with a 500, and OMP injects
  developer messages mid-turn (reminders, interjections)
- capture reasoning_content (JSON + SSE) and replay it as OMP thinking
  blocks; profile models now register as reasoning models

- **chore:** suspend statusline until upstream inline-segment API agreed (`3d2bc2d`)
  The session status hook rendered a 'Runpod profile: ...' row on its own
line below the status bar (OMP 17.3.7 has no extension API for inline
first-line segments: SEGMENTS is a closed registry, ui.setStatus draws
below, ui.setFooter is a no-op interactively). Pending an upstream API
discussion for extension-provided status segments, touch no statusline
at all: no rows above or below, the operator's default footer is left
untouched. The refresher code is preserved commented-out as the
re-enable seam; hook registration and session-state bookkeeping stay.

## 1.0.1

- **fix:** bind status line to runpod profile selected after session_start (`bd4e59b`)
  The session status line was installed only when the active model was a
runpod profile at session_start; getActiveProfileId ran once and an
undefined result early-returned with no refresher. Selecting a runpod
model afterward (or the model resolving ~150ms after session start)
never surfaced the profile/cost segment.

Start the refresher whenever UI is present and re-resolve the active
profile on every tick (OMP's ctx.model is a live accessor), clearing the
status when no runpod profile is active. Adds injectable refresher
interval options so late-binding is testable deterministically.

## 1.0.0

- **feat:** add Runpod OMP provider plugin (`2bb48c7`)
