import { AppState, CareEvent, CoreState, EventType, RegulationLevel } from "./types";
import { defaultConfig } from "./constraints";

const MS_MIN = 60 * 1000;
const DAY_START_HOUR = 7;

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
  autoSuppressed: [],
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
    if (Number.isNaN(timestamp) || timestamp > now) {
      continue;
    }
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

const BASELINE_TOLERANCE_MIN = 20;
const resolveTimeZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const getZonedParts = (utcMs: number, timeZone: string) => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(utcMs));
  const lookup = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: lookup("year"),
    month: lookup("month"),
    day: lookup("day"),
    hour: lookup("hour"),
    minute: lookup("minute"),
  };
};

const getTimeZoneOffsetMs = (utcMs: number, timeZone: string) => {
  const parts = getZonedParts(utcMs, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return utcMs - asUtc;
};

const getUtcMsFromZoned = (
  zoned: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string
) => {
  const tentative = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute);
  const offset = getTimeZoneOffsetMs(tentative, timeZone);
  return tentative + offset;
};

const getDayStartUtc = (utcNow: number) => {
  const timeZone = resolveTimeZone();
  const parts = getZonedParts(utcNow, timeZone);
  const todayStart = getUtcMsFromZoned(
    { year: parts.year, month: parts.month, day: parts.day, hour: DAY_START_HOUR, minute: 0 },
    timeZone
  );
  if (todayStart > utcNow) {
    return todayStart - 24 * 60 * 60 * 1000;
  }
  return todayStart;
};

const hasMatchingEvent = (
  events: CareEvent[],
  type: EventType,
  timestamp: number
) => {
  const tolerance = BASELINE_TOLERANCE_MIN * MS_MIN;
  return events.some((event) => {
    if (event.type !== type) return false;
    const eventTime = Date.parse(event.timestampUtc);
    if (Number.isNaN(eventTime)) return false;
    return Math.abs(eventTime - timestamp) <= tolerance;
  });
};

const isSuppressedAuto = (
  suppressed: { type: EventType; timestampUtc: string }[],
  type: EventType,
  timestamp: number
) => {
  const tolerance = BASELINE_TOLERANCE_MIN * MS_MIN;
  return suppressed.some((entry) => {
    if (entry.type !== type) return false;
    const entryTime = Date.parse(entry.timestampUtc);
    if (Number.isNaN(entryTime)) return false;
    return Math.abs(entryTime - timestamp) <= tolerance;
  });
};

const isCoreEvent = (event: CareEvent) =>
  event.type !== "RoutineStarted";

const buildBaselineEvents = (
  firstWakeUtc: number,
  horizonUtc: number
): CareEvent[] => {
  const events: CareEvent[] = [];
  let wakeStart = firstWakeUtc;
  let cycle = 0;
  const maxCycles = 8;
  while (wakeStart < horizonUtc && cycle < maxCycles) {
    const feedTime = wakeStart + defaultConfig.feedIntervalMinMin * MS_MIN;
    if (feedTime <= horizonUtc) {
      events.push({
        id: `auto-feed-${feedTime}`,
        type: "MilkGiven",
        timestampUtc: new Date(feedTime).toISOString(),
        autoPredicted: true,
      });
    }

    const napStart = wakeStart + defaultConfig.minWakeWindowMin * MS_MIN;
    if (napStart <= horizonUtc) {
      events.push({
        id: `auto-nap-start-${napStart}`,
        type: "NapStarted",
        timestampUtc: new Date(napStart).toISOString(),
        autoPredicted: true,
      });
      const napEnd = napStart + defaultConfig.expectedNapDurationMin * MS_MIN;
      if (napEnd <= horizonUtc) {
        events.push({
          id: `auto-nap-end-${napEnd}`,
          type: "NapEnded",
          timestampUtc: new Date(napEnd).toISOString(),
          autoPredicted: true,
        });
        wakeStart = napEnd;
      } else {
        break;
      }
    } else {
      break;
    }
    cycle += 1;
  }
  return events;
};

const normalizeEventLog = (
  eventLog: CareEvent[],
  now: number,
  suppressed: { type: EventType; timestampUtc: string }[]
): CareEvent[] => {
  const ordered = [...eventLog].sort(
    (a, b) => Date.parse(a.timestampUtc) - Date.parse(b.timestampUtc)
  );
  const hasFirstAwake = ordered.some(
    (event) => event.type === "FirstAwake" && !event.autoPredicted
  );
  const cleaned = ordered.filter(
    (event) => !(event.type === "FirstAwake" && event.autoPredicted && hasFirstAwake)
  );
  const hasAnyFirstAwake = cleaned.some((event) => event.type === "FirstAwake");
  const withFirstAwake = (() => {
    if (hasAnyFirstAwake) return cleaned;
    const predictedTime = getDayStartUtc(now);
    const predicted: CareEvent = {
      id: `auto-first-awake-${predictedTime}`,
      type: "FirstAwake",
      timestampUtc: new Date(predictedTime).toISOString(),
      autoPredicted: true,
    };
    return [...cleaned, predicted];
  })();

  const realEvents = withFirstAwake.filter(
    (event) => !event.autoPredicted && isCoreEvent(event)
  );
  const lastThreeReal = realEvents.slice(-3);
  const horizonUtc = lastThreeReal.length
    ? Math.max(...lastThreeReal.map((event) => Date.parse(event.timestampUtc)))
    : now;
  const firstWake = withFirstAwake.find((event) => event.type === "FirstAwake");
  if (!firstWake) {
    return withFirstAwake.sort(
      (a, b) => Date.parse(a.timestampUtc) - Date.parse(b.timestampUtc)
    );
  }
  const firstWakeUtc = Date.parse(firstWake.timestampUtc);
  if (Number.isNaN(firstWakeUtc)) {
    return withFirstAwake.sort(
      (a, b) => Date.parse(a.timestampUtc) - Date.parse(b.timestampUtc)
    );
  }

  const baselineEvents = buildBaselineEvents(firstWakeUtc, horizonUtc);
  const merged = [...withFirstAwake];
  baselineEvents.forEach((candidate) => {
    const candidateTime = Date.parse(candidate.timestampUtc);
    if (Number.isNaN(candidateTime)) return;
    if (isSuppressedAuto(suppressed, candidate.type, candidateTime)) return;
    if (hasMatchingEvent(merged, candidate.type, candidateTime)) return;
    merged.push(candidate);
  });

  return merged.sort(
    (a, b) => Date.parse(a.timestampUtc) - Date.parse(b.timestampUtc)
  );
};

export const buildEvent = (type: EventType, timestamp: number): CareEvent => ({
  id: `${type}-${timestamp}-${Math.random().toString(16).slice(2)}`,
  type,
  timestampUtc: new Date(timestamp).toISOString(),
});

export const applyEvent = (state: AppState, event: CareEvent, now: number): AppState => {
  const eventLog = normalizeEventLog([...state.eventLog, event], now, state.autoSuppressed);
  const core = recomputeCoreState(eventLog, now);
  return { ...core, eventLog, autoSuppressed: state.autoSuppressed };
};

export const rebuildFromLog = (
  eventLog: CareEvent[],
  now: number,
  autoSuppressed: { type: EventType; timestampUtc: string }[] = []
): AppState => {
  const normalized = normalizeEventLog(eventLog, now, autoSuppressed);
  const core = recomputeCoreState(normalized, now);
  return { ...core, eventLog: normalized, autoSuppressed };
};
