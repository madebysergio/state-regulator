import { AppState, CareEvent, CoreState, EventType, RegulationLevel } from "./types";

const MS_MIN = 60 * 1000;

export const initialCoreState: CoreState = {
  lastWakeTime: null,
  lastNapStart: null,
  lastNapEnd: null,
  lastNapDuration: null,
  lastFeedTime: null,
  timeSinceLastFeed: null,
  estimatedSleepPressure: 0,
  regulationLevel: "medium",
  totalDaySleep: 0,
};

export const initialAppState: AppState = {
  ...initialCoreState,
  eventLog: [],
};

const levelFromSignals = (
  sleepPressure: number,
  timeSinceFeedMin: number | null
): RegulationLevel => {
  if (sleepPressure >= 0.8 || (timeSinceFeedMin !== null && timeSinceFeedMin >= 180)) {
    return "high";
  }
  if (sleepPressure <= 0.35 && (timeSinceFeedMin ?? 0) < 120) {
    return "low";
  }
  return "medium";
};

const computeSleepPressure = (
  lastWakeTime: number | null,
  lastNapDurationMin: number | null,
  now: number
) => {
  if (!lastWakeTime) return 0;
  const awakeMin = Math.max(0, (now - lastWakeTime) / MS_MIN);
  const napPenalty = lastNapDurationMin !== null && lastNapDurationMin < 45 ? 0.15 : 0;
  return Math.min(1, awakeMin / 150 + napPenalty);
};

export const recomputeCoreState = (events: CareEvent[], now: number): CoreState => {
  const nextState: CoreState = { ...initialCoreState };
  let totalDaySleep = 0;

  for (const event of events) {
    const timestamp = Date.parse(event.timestampUtc);
    switch (event.type) {
      case "FirstAwake":
        nextState.lastWakeTime = timestamp;
        nextState.lastNapStart = null;
        nextState.lastNapEnd = null;
        nextState.lastNapDuration = null;
        break;
      case "NapStarted":
        nextState.lastNapStart = timestamp;
        break;
      case "NapEnded":
        nextState.lastNapEnd = timestamp;
        if (nextState.lastNapStart) {
          const duration = Math.max(0, timestamp - nextState.lastNapStart);
          nextState.lastNapDuration = duration;
          totalDaySleep += duration;
        }
        nextState.lastWakeTime = timestamp;
        break;
      case "MilkGiven":
      case "SolidsGiven":
        nextState.lastFeedTime = timestamp;
        break;
      case "Asleep":
        // Marks the start of a longer sleep block; treat as nap start for pressure reset.
        nextState.lastNapStart = timestamp;
        break;
      case "RoutineStarted":
        break;
      default:
        break;
    }
  }

  nextState.totalDaySleep = totalDaySleep;
  nextState.timeSinceLastFeed = nextState.lastFeedTime
    ? Math.max(0, now - nextState.lastFeedTime)
    : null;

  const lastNapDurationMin = nextState.lastNapDuration
    ? nextState.lastNapDuration / MS_MIN
    : null;
  nextState.estimatedSleepPressure = computeSleepPressure(
    nextState.lastWakeTime,
    lastNapDurationMin,
    now
  );
  const timeSinceFeedMin = nextState.timeSinceLastFeed
    ? nextState.timeSinceLastFeed / MS_MIN
    : null;
  nextState.regulationLevel = levelFromSignals(
    nextState.estimatedSleepPressure,
    timeSinceFeedMin
  );

  return nextState;
};

export const buildEvent = (type: EventType, timestamp: number): CareEvent => ({
  id: `${type}-${timestamp}-${Math.random().toString(16).slice(2)}`,
  type,
  timestampUtc: new Date(timestamp).toISOString(),
});

export const applyEvent = (state: AppState, event: CareEvent, now: number): AppState => {
  const eventLog = [...state.eventLog, event].sort(
    (a, b) => Date.parse(a.timestampUtc) - Date.parse(b.timestampUtc)
  );
  const core = recomputeCoreState(eventLog, now);
  return { ...core, eventLog };
};

export const rebuildFromLog = (eventLog: CareEvent[], now: number): AppState => {
  const core = recomputeCoreState(eventLog, now);
  return { ...core, eventLog };
};
