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
