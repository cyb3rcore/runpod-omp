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
