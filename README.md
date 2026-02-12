# Reactive Care Scheduler

State-driven, event-based caregiving scheduler that recalculates windows, caps, and buffers in real time. It is not a calendar and does not output fixed plans.

## Run

```sh
npm install
npm run dev
```

## Build

```sh
npm run build
npm run preview
```

## Notes

- Events are stored as UTC instants and rendered in the user’s timezone.
- All derived state is recomputed from the event log and the authoritative UTC "now".
- Persistence uses `localStorage` only.

## Behavior Notes (Current Build)

- “Up next” is resolved from current state (resolver), not from the predictions list.
- “What’s coming up” is derived from a baseline schedule that shifts relative to the last real log.
- Routine logs are tracked for duration stats only and do not affect predictions or state.
- Auto-predicted logs are labeled and can be edited or deleted.
- After bedtime, upcoming events show the next morning’s expected wake without creating new logs.
