# @cyb3rcore/runpod-omp

An [OMP](https://omp.sh) extension package that registers a native `runpod`
provider: **one model per configured Runpod profile** (`runpod/<profile>` in
OMP's model picker). Each profile declares how its Runpod endpoint is invoked —
either a **managed-queue** endpoint (`/run`, `/runsync`, `/status`, `/stream`,
`/cancel`, …) or a **load-balanced** endpoint (direct OpenAI-compatible HTTP) —
plus its model metadata, request mode, and retry/fallback policy.

Everything is configured through versioned YAML profiles, not code. There are
no hard-coded endpoints.

## What it adds

- Native `runpod` provider models: one selectable `runpod/<profile>` model for
  each configured profile.
- Managed-queue and load-balanced endpoint transports.
- `/runpod` profile, configuration, diagnostics, explicit human queue control,
  and cost commands.
- Read-only operational tools for the model.
- Live cost estimation in the session status line and `/runpod cost`.

## Install

Install the package through OMP:

```sh
omp plugin install @cyb3rcore/runpod-omp
```

Then start OMP and run `/runpod configure` to create a profile. The guided flow
validates the endpoint, writes either the global or project configuration
atomically, and does not resolve or store a secret. Restart or refresh the
session after a configuration change; OMP registers native provider models when
the extension loads. Select `runpod/<profile>` in OMP's model picker.

For a declarative setup, create either `<agent-dir>/runpod.yml` or
`<project>/.omp/runpod.yml` as described in [Configuration](#configuration).

## Development

Requires [Bun](https://bun.sh) (`>=1.3.14`, see `package.json#engines`).

```sh
bun install
bun test          # unit and contract tests
bun run build     # TypeScript and declarations
bun run smoke     # local endpoints with the real OMP CLI
bun run verify    # test, build, and smoke
```

## Configuration

Profiles are declared in versioned YAML (`version: 1`) and merged from two
layers:

- **global**: `<agent-dir>/runpod.yml`
- **project**: `<cwd>/.omp/runpod.yml` — same-named profiles override global
  ones; global-only profiles are kept; project-only profiles are added.

The agent directory derives from `PI_CODING_AGENT_DIR` if set, otherwise OMP's
default agent directory. A missing file is an empty layer; a malformed layer
contributes no profiles while its validation errors are retained (the other
layer stays active).

### Profile example

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

  my-lb:
    endpointType: load-balanced
    invokeUrl: https://xyz123.proxy.runpod.net
    apiKey: RUNPOD_API_KEY   # an environment-variable name (see API keys)
    model:
      id: runpod/my-vlm
      name: My Load-Balanced VLM
      contextWindow: 8192
      maxTokens: 2048
      reasoning: false
      input: [text, image]
      supportsTools: true
      supportsVision: true
```

### Schema

Every field under `model` is **required** (no model-level defaults). `request`
and `policy` are optional and fall back to the planned defaults. `invokeUrl`
must be an absolute `http(s)` URL; its exact spelling is preserved verbatim.

| Field | Type / allowed values | Required | Default |
| --- | --- | --- | --- |
| `endpointType` | `queue` \| `load-balanced` | yes | — |
| `invokeUrl` | absolute `http(s)` URL | yes | — |
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

`apiKey` is a **reference**, never a literal-secret requirement. The parser
accepts several forms and normalizes all of them to an unresolved reference —
no credential bytes are ever read, stored, or echoed during configuration:

- `apiKey: NAME` — an environment-variable name (resolved env-first, then as a
  literal, OMP-custom-provider style);
- `apiKey: env:NAME` — an explicit environment-variable reference;
- `apiKey: "!<command>"` — a command reference run through OMP's command
  runner; its trimmed stdout is the key;
- `apiKey: { ref: env:NAME }` — a reference object (the canonical form the
  command surface writes back).

Resolution precedence for an actual call is: **profile `apiKey` reference →
the OMP-provided key → `RUNPOD_API_KEY` from the environment.** A missing or
empty `env:` reference falls through to the OMP key and then
`RUNPOD_API_KEY`; a `!command` reference that fails or produces no output is
an explicit error and **never** falls back. If no source yields a key, the
call fails with a redacted error (never a credential).

Every diagnostic, serialized profile, tool result, and error strips key
material to a fixed `[redacted]` marker.

## Provider: `runpod/<profile>`

The extension registers a single provider named `runpod` and exposes one
`ProviderModelConfig` per merged profile. A model's `id` is its **profile
name** (not the upstream served model id), so selecting `runpod/<profile>` in
OMP's native model picker selects that profile. All profile models share the
plugin-owned custom API id `runpod-queue`; the provider-level API key
reference is `RUNPOD_API_KEY` and the base URL is a placeholder OMP requires
for registration (real per-request URLs come from each profile's
`invokeUrl`).

## Endpoints

### Managed-queue (`endpointType: queue`)

`invokeUrl` is the endpoint base (`https://api.runpod.ai/v2/<endpoint-id>`).
The transport drives Runpod's managed-queue API:

| Request mode | Submission | Completion |
| --- | --- | --- |
| `sync` | `POST /runsync?wait=<ms>` | one-shot wait; **downgrades to status polling** if the wait (≤ 5 min) elapses before completion |
| `async` | `POST /run` | polls `GET /status/<id>` until terminal or the profile `polling.ttlMs` elapses |
| `stream` | `POST /run` | consumes `GET /stream/<id>` chunks; downgrades to status polling when no chunks arrive |

Queue jobs report native statuses (`IN_QUEUE`, `IN_PROGRESS`, `COMPLETED`,
`FAILED`, `CANCELLED`, `TIMED_OUT`, plus `RUNNING`/`unknown`/`expired`).
`failed`/`cancelled`/`timed_out` jobs surface as explicit, redacted errors.

### Load-balanced (`endpointType: load-balanced`)

`invokeUrl` is the endpoint's direct URL (e.g. a `*.proxy.runpod.net`
address). Requests are a single OpenAI-compatible HTTP call to
`invokeUrl + request.loadBalancedPath` (default `/v1/chat/completions`).
Response parsing follows `request.mode`: a JSON completion body for `sync`, an
SSE `text/event-stream` for `stream`. There is no queue to poll, so `async`
does not apply to a load-balanced endpoint.

### Health & control probes

- **queue**: `GET /health` → a normalized worker summary (counts are `unknown`
  when not reported, with a short-TTL cache).
- **load-balanced**: `GET /ping` → HTTP 200 is `healthy`, 204 is
  `initializing`, anything else (or a transport failure) is `unhealthy`.

## Commands

One slash command namespace is registered: `/runpod`.

| Command | Behavior |
| --- | --- |
| `/runpod` | List configured profiles (same as `profile`). |
| `/runpod profile` | List profiles, marking the current default. |
| `/runpod profile add <name>` | Guided flow to add a profile. |
| `/runpod profile <name>` | Persist the named profile as the default (unknown names error). |
| `/runpod profile rm <name>` | Delete a profile after interactive confirmation. |
| `/runpod configure` | Guided flow: choose target scope, collect fields, confirm, write the profile document atomically, reload config. |
| `/runpod doctor` | Report global/project source paths, valid profile names, and retained validation errors. |
| `/runpod cancel <profile> <id>` | Cancel a queue job after interactive confirmation. |
| `/runpod retry <profile> <id>` | Retry a queue job after interactive confirmation. |
| `/runpod purge <profile>` | Purge pending queue jobs after interactive confirmation. |
| `/runpod cost [profile]` | Fresh cost report: live estimate (workers × serverless price) plus actual billed amounts (last 24h + current hour). Read-only. |

Runpod serverless is **time-billed**, so profiles carry no token prices. OMP's
model metadata registers a zero structural cost; real cost surfaces live in the
status line and `/runpod cost`.

### Cost

The session status line appends a live burn-rate estimate while a runpod
profile is active: `Runpod profile: <name> · est $X.XX/hr`, refreshed every
minute. `/runpod cost [profile]` (defaults to the extension default profile)
shows the most up-to-date numbers available:

- **Live (est)** — placed workers × the GPU catalog's `price.serverless`
  (USD/hour), plus accrued spend from each worker's uptime. Updated from the
  live worker list; marked `(N of M workers priced)` when a worker's GPU has
  no catalog price, and never guessed.
- **Billed (actual)** — per-endpoint billing history, last 24 hourly buckets
  with the current hour's bucket called out, broken out by GPU, disk, and
  platform fee. The billing API lags the live state by the platform's ~5
  minute billing cycle, which is why the estimate sits alongside it.

Cost surfaces call the Runpod REST v2 control plane (`api.runpod.io/v2`) with
the profile's resolved API key, so the key needs control-plane/billing scope;
a scoped-down key reports `unavailable` per section without affecting
inference. The endpoint id is derived from `invokeUrl` (queue: last path
segment; load-balanced: first label of `<id>.api.runpod.ai`); an
underivable URL reports the cost sections as unavailable.

### Configuration writes and live refresh

When `/runpod configure` or `profile add` writes a profile document, the write
is **atomic** (temp file + rename, no partial artifacts) and the extension
**reloads the merged config in place**, so the command-visible profile list
reflects the write immediately. However, making the new/edited model selectable
in OMP's **native model picker requires an extension/session reload**: OMP
cannot bring a newly registered native provider model live mid-session, so the
extension intentionally does **not** re-register providers after a write. After
changing config, **restart (or refresh) the session** so OMP reloads the runpod
provider models. It is never claimed that config changes take effect live.

## Operational tools

Models receive only read-only operational tools. Results are redacted and never
include key material.

| Tool | Approval | Endpoint family | Operation | Requires job id |
| --- | --- | --- | --- | --- |
| `runpod_health` | read | queue | `GET /health` | no |
| `runpod_ping` | read | load-balanced | `GET /ping` | no |
| `runpod_status` | read | any | `GET /status/<id>` | yes |

- Tools register only when a profile of the matching endpoint family exists.
  `runpod_status` registers when any profile exists and reports
  `supported: false` for targets that cannot serve it, such as a
  load-balanced profile.

## Human queue control

Queue-changing actions are slash commands, not model tools:

- `/runpod cancel <profile> <id>`
- `/runpod retry <profile> <id>`
- `/runpod purge <profile>`

Each action requires an explicit queue profile and interactive confirmation.
Headless sessions fail closed. A model can inspect a queue, but it cannot
cancel, retry, or purge it.

## Security model

- Config parsing and the command surface never resolve or emit credential
  bytes; every exposed form (serialized profiles, tool results, errors, and
  diagnostics) uses a fixed `[redacted]` marker. `!command` references that
  fail never fall back to another key source.
- Errors never carry resolved key material, command output, or a runner's
  message.

## License

MIT
