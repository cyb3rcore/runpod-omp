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
