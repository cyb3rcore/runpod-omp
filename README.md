# @cyb3rcore/runpod-omp

An [OMP](https://omp.sh) extension that registers a native `runpod` provider:
one model per configured profile, selectable as `runpod/<profile>` in OMP's
model picker. Profiles target three Runpod endpoint kinds — **managed-queue**,
**load-balanced**, and **pod** — and declare their model metadata, request
mode, and retry/fallback policy in versioned YAML. No code; no hard-coded
endpoints.

## Table of contents

- [Which endpoint type?](#which-endpoint-type)
- [Install](#install)
- [Configuration](#configuration)
- [Endpoints](#endpoints)
- [Provider: runpod/&lt;profile&gt;](#provider-runpodprofile)
- [Commands](#commands)
- [Cost](#cost)
- [Operational tools](#operational-tools)
- [Human queue control](#human-queue-control)
- [Observability](#observability)
- [Security model](#security-model)
- [Development](#development)

## Which endpoint type?

| `endpointType` | Use when | How requests reach the worker | Cost basis |
| --- | --- | --- | --- |
| `queue` | Managed serverless job queue | Runpod queue API (`/run`, `/runsync`, `/status`, `/stream`) | Workers × catalog `price.serverless` |
| `load-balanced` | Direct serverless HTTP | Static `invokeUrl` + OpenAI-compatible path | Workers × catalog `price.serverless` |
| `pod` | Dedicated pod; one profile per pod | Control-plane TCP resolution at call time, or static `invokeUrl` | `Pod.cost` USD/hour, accrued from uptime |

Queue and load-balanced profiles require a static `invokeUrl`. Pod profiles
resolve the worker's public TCP address from `GET /v2/pods/<id>` on every call,
so they need none — the address follows pod restarts automatically.

## Install

```sh
omp plugin install @cyb3rcore/runpod-omp
```

Run `/runpod configure` inside OMP to create a profile, or write
`<agent-dir>/runpod.yml` / `<project>/.omp/runpod.yml` by hand (see
[Configuration](#configuration)). OMP registers the `runpod/<profile>` models
when the extension loads; **restart or refresh the session after a config
change**. The guided flow validates input, writes atomically, and never
resolves or stores a secret.

## Configuration

Profiles live in versioned YAML (`version: 1`) and merge from two layers:

- **global** — `<agent-dir>/runpod.yml` (agent dir from `PI_CODING_AGENT_DIR`,
  else OMP's default)
- **project** — `<cwd>/.omp/runpod.yml`; same-named profiles override global
  ones

A missing file is an empty layer. A malformed layer contributes no profiles and
retains its validation errors; the other layer stays active.

### Schema

Every `model` field is required; `request` and `policy` fall back to planned
defaults. `invokeUrl` must be an absolute `http(s)` URL, preserved verbatim.

| Field | Type / allowed values | Required | Default |
| --- | --- | --- | --- |
| `endpointType` | `queue` \| `load-balanced` \| `pod` | yes | — |
| `invokeUrl` | absolute `http(s)` URL | queue/load-balanced yes; pod no | none |
| `pod.id` | non-empty string (Runpod pod id) | endpointType `pod` | — |
| `pod.port` | positive integer | no | `8000` |
| `pod.inferenceApiKey` | string or `{ ref }` (see API keys) | no | none |
| `apiKey` | string or `{ ref }` (see API keys) | no | none |
| `model.id` | non-empty string | yes | — |
| `model.name` | non-empty string | yes | — |
| `model.contextWindow` | positive integer | yes | — |
| `model.maxTokens` | positive integer | yes | — |
| `model.reasoning` | boolean | yes | — |
| `model.input` | non-empty array of `text` / `image` | yes | — |
| `model.supportsTools` | boolean | yes | — |
| `model.supportsVision` | boolean | yes | — |
| `request.mode` | `sync` \| `async` \| `stream` | no | `sync` |
| `request.timeoutMs` | number > 0 | no | `300000` |
| `request.polling.intervalMs` | number > 0 | no | `1000` |
| `request.polling.ttlMs` | number > 0 | no | `1800000` |
| `request.polling.focusAware` | boolean | no | `true` |
| `request.queueAdapter.kind` | `openai-shaped` \| `messages-text` \| `module` | no | `openai-shaped` |
| `request.queueAdapter.module` | non-empty string (kind `module`) | kind `module` | — |
| `request.queueAdapter.export` | non-empty string | no | `adapter` |
| `request.loadBalancedPath` | non-empty string | no | `/v1/chat/completions` |
| `policy.maxAttempts` | positive integer | no | `1` |
| `policy.fallbackProfiles` | array of profile names | no | `[]` |

### API keys

`apiKey` is a reference, never a stored credential. Accepted forms, all
normalized to an unresolved reference:

- `apiKey: NAME` — environment variable, falling back to the literal `NAME`
  (OMP-custom-provider style)
- `apiKey: env:NAME` — explicit environment reference
- `apiKey: "!<command>"` — command reference; trimmed stdout is the key
- `apiKey: { ref: env:NAME }` — reference object (canonical form)

Resolution precedence per call: **profile `apiKey` → OMP-provided key →
`RUNPOD_API_KEY`**. An empty `env:` reference falls through to the next
source; a failing `!command` is an explicit error and never falls back. Every
diagnostic, serialized profile, and tool result strips key material to a
fixed `[redacted]` marker. Stream errors surface the underlying cause with
only known credential bytes redacted (see [Security model](#security-model)).

### Examples

Full profile examples, collapsed:

<details>
<summary>Single queue profile (managed endpoint)</summary>

```yaml
version: 1
profiles:
  my-queue:
    endpointType: queue
    invokeUrl: https://api.runpod.ai/v2/abc123queue
    apiKey:
      ref: env:RUNPOD_API_KEY
    model:
      id: my-worker/serve
      name: My Queue Worker
      contextWindow: 32768
      maxTokens: 4096
      reasoning: false
      input: [text, image]
      supportsTools: true
      supportsVision: true
    request:
      mode: sync            # sync | async | stream
      timeoutMs: 300000
      polling:
        intervalMs: 1000
        ttlMs: 1800000
        focusAware: true
      queueAdapter:
        kind: openai-shaped # openai-shaped | messages-text | module
    policy:
      maxAttempts: 1
      fallbackProfiles: []
```

</details>

<details>
<summary>Main + subs as pods (two profiles, one pod each)</summary>

One profile per pod; the subs pod serves the Q6 quant. No `invokeUrl` — the
plugin resolves each pod's public TCP address at call time, so restarts need
no config change.

**Key separation**: `apiKey` is the control-plane key (pod API + billing);
`pod.inferenceApiKey` (optional) is the only credential forwarded to the
worker (llama.cpp `--api-key`). A keyless pod sends no Authorization header;
the control key never reaches the worker, and the `RUNPOD_API_KEY` env
fallback is suppressed on the inference path on purpose.

Deploy the pod with its llama port exposed as a **TCP** port. If only the
HTTP proxy (`https://<pod-id>-<port>.proxy.runpod.net`) is available, set a
static `invokeUrl` override instead.

```yaml
version: 1
profiles:
  qwen3.8-27b:
    endpointType: pod
    pod:
      id: pod_<main-pod-id>
      port: 8000            # internal llama.cpp port (default 8000)
      inferenceApiKey: env:POD_INFERENCE_KEY   # optional; absent = keyless
    apiKey: env:RUNPOD_API_KEY                 # control-plane key (pod API)
    model:
      id: Qwen3.8-27B-UD-Q8_K_XL
      name: Qwen3.8 27B (Runpod pod)
      contextWindow: 262144
      maxTokens: 12288
      reasoning: true
      input: [text, image]
      supportsTools: true
      supportsVision: true
    request:
      mode: stream
      loadBalancedPath: /v1/chat/completions

  qwen3.8-subs:
    endpointType: pod
    pod:
      id: pod_<subs-pod-id>
      port: 8000
    apiKey: env:RUNPOD_API_KEY
    model:
      id: Qwen3.8-27B-UD-Q6_K_XL
      name: Qwen3.8 27B (Runpod pod subs, Q6)
      contextWindow: 131072
      maxTokens: 8192
      reasoning: true
      input: [text, image]
      supportsTools: true
      supportsVision: true
    request:
      mode: stream
      loadBalancedPath: /v1/chat/completions
```

</details>

<details>
<summary>Main + subs as load-balanced endpoints (two concurrency profiles)</summary>

The same topology on serverless: a **main** profile for the coding agent
(long context, one slot) and a **subs** profile for parallel subagents (many
slots, bounded context). Both point at the same llama.cpp server image; the
endpoint's server-side `CTX_SIZE` / `PARALLEL` environment enforces the
concurrency split, and the profile's `contextWindow` must match the
endpoint's per-slot `CTX_SIZE`.

```yaml
version: 1
profiles:
  qwen3.8-27b:
    endpointType: load-balanced
    invokeUrl: https://<main-endpoint>.api.runpod.ai
    apiKey: env:RUNPOD_API_KEY
    model:
      id: Qwen3.8-27B-UD-Q8_K_XL
      name: Qwen3.8 27B (Runpod)
      contextWindow: 262144
      maxTokens: 12288
      reasoning: true
      input: [text, image]
      supportsTools: true
      supportsVision: true
    request:
      mode: stream
      loadBalancedPath: /v1/chat/completions

  qwen3.8-subs:
    endpointType: load-balanced
    invokeUrl: https://<subs-endpoint>.api.runpod.ai
    apiKey: env:RUNPOD_API_KEY
    model:
      id: Qwen3.8-27B-UD-Q6_K_XL
      name: Qwen3.8 27B (Runpod subs, Q6)
      contextWindow: 131072
      maxTokens: 8192
      reasoning: true
      input: [text, image]
      supportsTools: true
      supportsVision: true
    request:
      mode: stream
      loadBalancedPath: /v1/chat/completions
```

Why the subs quant differs: KV cache is `slots × ctx`, so on a 48 GB A40 the
Q8 (~31.5 GB weights) fits only 4 × 64 K, while the Q6 (~25 GB) frees ~20.6 GB
and fits 4 × 128 K — matching `slots × ctx ≤ ~592K` for this model's
34,816 B/token hybrid KV. Main runs `PARALLEL=1, CTX_SIZE=262144` on Q8; subs
runs `PARALLEL=4, CTX_SIZE=524288, requestCount=4` — four 128 K slots per
worker, scaling to a second worker only when all four are busy (an
8-concurrency ceiling).

**Serve the weights via Runpod's model cache, not a baked image.** Keep the
worker image light, and set the endpoint's console **Model** field to a
**private Hugging Face repo holding only the single quant GGUF and its
mmproj**. Runpod's cache downloads *every* file in the referenced repo, so a
kitchen-sink quant repo (e.g. `unsloth/Qwen3.8-27B-GGUF`, ~416 GB across 30
files) is a trap — mirror just the two files you serve. Workers then boot warm
from `/runpod-volume/huggingface-cache/hub/models--<org>--<name>/snapshots/<hash>/`
with no per-worker re-download. Private repos work: the Model-field pull runs
under Runpod's own HF access, so no endpoint `HF_TOKEN` is required.

</details>

### Retry & fallback

The primary profile is attempted up to `maxAttempts` times, then each named
fallback profile once, in order — with a 1 s backoff between attempts. Only
**transient** failures retry or fall back (HTTP 5xx, e.g. the LB's 502 during
a cold start, and network-level failures). Deterministic failures (4xx, job
failures, output-shape errors) and caller aborts/timeouts surface immediately.

Each fallback profile resolves its own `apiKey` and rebuilds the request with
its own model id. It must serve the same conversation — mind `contextWindow`:
falling from a long-context profile to a bounded one can overflow the smaller
slot. Requests always carry `model.maxTokens` as the generation ceiling, so a
runaway or post-abort task stays bounded.

### Tool calling

OMP's `context.tools` forward as OpenAI function definitions; assistant
history round-trips `tool_calls`; worker tool calls (JSON or SSE, fragmented
`arguments` reassembled) replay as OMP tool-call events with
`stopReason: "toolUse"`. The plugin always passes OMP's tool catalog; declare
`supportsTools: true` to document the capability.

## Endpoints

### Managed-queue (`endpointType: queue`)

`invokeUrl` is the endpoint base (`https://api.runpod.ai/v2/<endpoint-id>`).
The transport drives Runpod's managed-queue API:

| Request mode | Submission | Completion |
| --- | --- | --- |
| `sync` | `POST /runsync?wait=<ms>` | one-shot wait; **downgrades to status polling** if the wait (≤ 5 min) elapses |
| `async` | `POST /run` | polls `GET /status/<id>` until terminal or `polling.ttlMs` elapses |
| `stream` | `POST /run` | consumes `GET /stream/<id>` chunks; downgrades to status polling when no chunks arrive |

Queue jobs report native statuses (`IN_QUEUE`, `IN_PROGRESS`, `COMPLETED`,
`FAILED`, `CANCELLED`, `TIMED_OUT`, plus `RUNNING`/`unknown`/`expired`).
`failed`/`cancelled`/`timed_out` jobs surface as explicit errors naming the
job, its status, and any server-provided detail.

### Load-balanced (`endpointType: load-balanced`)

`invokeUrl` is the endpoint's direct URL (e.g. `*.proxy.runpod.net`). One
OpenAI-compatible HTTP call goes to `invokeUrl + request.loadBalancedPath`
(default `/v1/chat/completions`). `request.mode` `sync` parses the JSON
completion body; `stream` parses SSE. There is no queue to poll, so `async`
does not apply.

### Pod (`endpointType: pod`)

The worker's HTTP base resolves at call time:

- **TCP mode (default)** — `GET /v2/pods/<pod.id>` with the control key
  (profile `apiKey`, else `RUNPOD_API_KEY`). The pod must be `RUNNING`; the
  `runtime.ports` entry for `pod.port` (fallback: the first TCP entry with an
  ip + public pair) yields `http://<ip>:<public>`. The address changes on pod
  reset and re-derives per call, so a restart is invisible to the profile. A
  non-running pod fails with an actionable error naming the state and the
  `/runpod pod start` remedy.
- **Static mode** — a configured `invokeUrl` (HTTP proxy URL
  `https://<pod-id>-<internal-port>.proxy.runpod.net`, or a tunnel) is used
  verbatim; no control-plane lookup happens.

The HTTP call is the load-balanced transport, so `sync`/`stream`, tool
calling, retries, and `policy.fallbackProfiles` behave identically (`async`
does not apply). The proxy form is HTTPS-only with a Cloudflare 100 s cap; the
TCP form has no such cap — hence the default.

### Health & control probes

- **queue** — `GET /health` → normalized worker summary (counts `unknown`
  when unreported; short-TTL cache).
- **load-balanced** — `GET /ping` → 200 is `healthy`, 204 is `initializing`,
  anything else is `unhealthy`.
- **pod** — `GET <resolved address>/health` (with the inference token when
  configured) → 200 is `healthy`, 204 is `initializing`, anything else or a
  resolution failure is `unhealthy`. Never throws; a stopped pod reads
  `unhealthy` with the actionable reason.

## Provider: runpod/&lt;profile&gt;

One `ProviderModelConfig` per merged profile. A model's `id` is its **profile
name** (not the upstream model id), so selecting `runpod/<profile>` selects
that profile. All profile models share the plugin-owned custom API id
`runpod-queue`; the provider-level key reference is `RUNPOD_API_KEY`, and the
base URL is a placeholder OMP requires for registration — real per-request
URLs come from each profile (`invokeUrl`, or the pod's resolved address).

## Commands

One slash command namespace: `/runpod`.

| Command | Behavior |
| --- | --- |
| `/runpod` | List configured profiles (same as `profile`). |
| `/runpod profile` | List profiles, marking the current default. |
| `/runpod profile add <name>` | Guided flow to add a profile. |
| `/runpod profile <name>` | Persist the named profile as the default (unknown names error). |
| `/runpod profile rm <name>` | Delete a profile after interactive confirmation. |
| `/runpod configure` | Guided flow: target scope, fields, confirm; writes atomically, reloads config. |
| `/runpod doctor` | Report global/project source paths, valid profile names, retained validation errors. |
| `/runpod cancel <profile> <id>` | Cancel a queue job after interactive confirmation. |
| `/runpod retry <profile> <id>` | Retry a queue job after interactive confirmation. |
| `/runpod purge <profile>` | Purge pending queue jobs after interactive confirmation. |
| `/runpod cost [profile]` | Fresh cost report (see [Cost](#cost)). Read-only. |
| `/runpod pod` | List pod profiles with live control-plane states. |
| `/runpod pod <profile>` | Full pod report: state, uptime, `$X.XX/hr`, data center, resolved address, readiness. Read-only. |
| `/runpod pod start <profile>` | Start the pod after interactive confirmation. |
| `/runpod pod stop <profile>` | Stop the pod after interactive confirmation — the manual cost lever (Runpod has no native idle auto-stop). |
| `/runpod pod restart <profile>` | Restart the pod after interactive confirmation. |

Queue-changing actions require interactive confirmation; headless sessions
fail closed. Runpod is **time-billed**, so profiles carry no token prices;
OMP's model metadata registers a zero structural cost.

## Cost

`/runpod cost [profile]` (defaults to the extension default profile) shows
the most current numbers:

- **Live (est)** — placed workers × the GPU catalog's `price.serverless`
  (USD/hour), plus accrued spend from each worker's uptime. Marked
  `(N of M workers priced)` when a worker's GPU has no catalog price; never
  guessed.
- **Live (pod)** — for `endpointType: pod`, from the pod API itself:
  `Pod.cost` (USD/hour; 0 when stopped) with accrued = rate × uptime.
  Rendered `Live (pod): $X.XX/hr · ~$Y accrued (state RUNNING)`; no
  GPU-catalog lookup.
- **Billed (actual)** — per-endpoint billing history, last 24 hourly buckets
  with the current hour called out, broken out by GPU, disk, and platform fee.
  Pod profiles narrow the call with `podId`. The billing API lags the live
  state by the platform's ~5 minute billing cycle, which is why the estimate
  sits alongside it.

Pods bill **per minute while running** (disk-only while stopped), so pod cost
control is manual: stop the pod when done (`/runpod pod stop`, or a
creation-time `stop-after` guard). The plugin deliberately adds no idle
auto-stop.

Cost surfaces call the Runpod REST v2 control plane with the profile's
resolved API key; the key needs control-plane/billing scope. A scoped-down
key reports `unavailable` per section without affecting inference. The
endpoint id derives from `invokeUrl` (queue: last path segment;
load-balanced: first label of `<id>.api.runpod.ai`); an underivable URL
reports cost as unavailable. The session status line is not used — OMP lacks
an inline-segment extension API — so cost surfaces here only.

## Operational tools

Models receive read-only tools only. Results are redacted; key material never
appears. The resolved worker address is public pod data, not a secret.

| Tool | Approval | Endpoint family | Operation | Requires job id |
| --- | --- | --- | --- | --- |
| `runpod_health` | read | queue | `GET /health` | no |
| `runpod_ping` | read | load-balanced | `GET /ping` | no |
| `runpod_status` | read | any | `GET /status/<id>` | yes |
| `runpod_pod` | read | pod | pod state + address + readiness | no |

Tools register only when a profile of the matching family exists.
`runpod_status` registers when any profile exists and reports
`supported: false` for targets that cannot serve it (e.g. load-balanced).
`runpod_pod` registers only when at least one pod profile exists and reports
state, `$X.XX/hr`, uptime, data center, resolved address, and readiness.

## Human queue control

Queue-changing actions are slash commands, not model tools:
`/runpod cancel <profile> <id>`, `/runpod retry <profile> <id>`,
`/runpod purge <profile>`. Each requires an explicit queue profile and
interactive confirmation; headless sessions fail closed. A model can inspect
a queue, but cannot cancel, retry, or purge it.

## Observability

The provider can journal every streamSimple turn as JSONL — the OMP-side half
of the debugging pipeline (plugin journal ↔ shim request log ↔ llama-server
log). **Disabled by default**; enable with:

```
RUNPOD_OMP_LOG=/path/to/runpod-provider.log.jsonl
```

Each line records one lifecycle step: `dispatch` (message and tool counts,
`maxTokens`, mode), `dispatch-done` (duration, text/reasoning/tool-call
lengths, usage), `dispatch-error` (message + cause, credential bytes
redacted), `replay-done`, and `failed` (the surfaced error). Unset or empty
`RUNPOD_OMP_LOG` disables journaling; a journal failure never affects the
stream.

## Security model

- Config parsing and the command surface never resolve or emit credential
  bytes; every exposed form (serialized profiles, tool results, diagnostics)
  uses a fixed `[redacted]` marker. Failing `!command` references never fall
  back to another key source.
- Stream failures surface the underlying transport/resolver error verbatim —
  HTTP status and server detail, timeout, abort, output-shape, unknown
  profile — so failures are actionable. Only known credential bytes (the
  resolved or OMP-provided API key) are replaced with `[redacted]`; the
  original error survives as the surfaced error's `cause`.
- Errors never carry resolved key material, command output, or a runner's
  message.

## Development

Requires [Bun](https://bun.sh) (`>=1.3.14`, see `package.json#engines`).

```sh
bun install
bun test          # unit and contract tests
bun run build     # TypeScript and declarations
bun run smoke     # local endpoints with the real OMP CLI
bun run verify    # test, build, and smoke
```

## License

MIT
