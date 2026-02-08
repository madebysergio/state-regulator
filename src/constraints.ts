import { AppState, ConstraintConfig, OutputModel } from "./types";

const MS_MIN = 60 * 1000;

export const defaultConfig: ConstraintConfig = {
  minWakeWindowMin: 75,
  maxWakeWindowMin: 130,
  // Short naps signal incomplete recovery, so we shorten the next wake window.
  shortenWakeByMinIfShortNap: 15,
  shortNapThresholdMin: 45,
  // Late naps tend to delay bedtime, so we detect them and protect the night.
  lateNapHour: 15,
  bedtimeLatestHour: 20,
  bedtimeLatestMinute: 0,
  // Pull bedtime earlier to preserve overnight sleep when naps drift late.
  bedtimeEarlierByMinIfLateNap: 30,
  // Routine and setup latency are buffers to prevent last-minute rush.
  routineLatencyMin: 25,
  setupLatencyMin: 10,
  // Late-day naps must be capped to keep sleep pressure intact for bedtime.
  nextNapCapMinIfLateNap: 40,
  // Long feed gaps can destabilize regulation, so we track max intervals.
  feedIntervalMaxMin: 180,
  // Used to estimate expected wake when asleep.
  expectedNapDurationMin: 60,
};

const minutesFromMs = (ms: number) => Math.round(ms / MS_MIN);

const addMinutes = (time: number, minutes: number) => time + minutes * MS_MIN;

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

const dayBoundUtc = (sourceUtc: number, timeZone: string, hour: number, minute: number) => {
  const parts = getZonedParts(sourceUtc, timeZone);
  return getUtcMsFromZoned(
    { year: parts.year, month: parts.month, day: parts.day, hour, minute },
    timeZone
  );
};

const formatTime = (utcMs: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(utcMs));

export const computeOutputs = (
  state: AppState,
  now: number,
  timeZone: string,
  config: ConstraintConfig = defaultConfig
): OutputModel => {
  const summary: string[] = [];
  const windowAllowed: string[] = [];
  const windowSuppressed: string[] = [];
  const activityAllowed: { label: string; expiresAt: number | null }[] = [];
  const activitySuppressed: { label: string; reason: string }[] = [];
  const shifts: { delta: string; status: "applied" | "pending" }[] = [];

  let nextWindow: string | null = null;
  let nextHardStop: string | null = null;
  let nextWindowStartUtc: number | null = null;
  let nextWindowEndUtc: number | null = null;
  let nextHardStopUtc: number | null = null;
  let wakeWindowRemainingMin: number | null = null;
  let expectedWakeUtc: number | null = null;
  let wakeUtilization: number | null = null;
  let sleepPressureTrend: "up" | "down" = "up";
  let regulationRisk: "low" | "rising" | "high" = "rising";
  const currentlyAsleep =
    state.lastNapStart !== null &&
    (state.lastNapEnd === null || state.lastNapEnd < state.lastNapStart);

  if (state.lastWakeTime) {
    const lastNapDurationMin = state.lastNapDuration
      ? state.lastNapDuration / MS_MIN
      : null;
    const shorten =
      lastNapDurationMin !== null &&
      lastNapDurationMin < config.shortNapThresholdMin;

    const minWake = config.minWakeWindowMin - (shorten ? config.shortenWakeByMinIfShortNap : 0);
    const maxWake = config.maxWakeWindowMin - (shorten ? config.shortenWakeByMinIfShortNap : 0);

    const startWindow = addMinutes(state.lastWakeTime, minWake);
    const endWindow = addMinutes(state.lastWakeTime, maxWake);
    nextWindowStartUtc = startWindow;
    nextWindowEndUtc = endWindow;

    nextWindow = `${formatTime(startWindow, timeZone)} – ${formatTime(endWindow, timeZone)}`;

    const lateNap =
      state.lastNapEnd !== null &&
      getZonedParts(state.lastNapEnd, timeZone).hour >= config.lateNapHour;

    let bedtimeLatest = dayBoundUtc(now, timeZone, config.bedtimeLatestHour, config.bedtimeLatestMinute);
    if (lateNap) {
      // Pull bedtime earlier after late naps to guard overnight consolidation.
      bedtimeLatest = addMinutes(bedtimeLatest, -config.bedtimeEarlierByMinIfLateNap);
    }

    const routineLatest = addMinutes(
      bedtimeLatest,
      -(config.routineLatencyMin + config.setupLatencyMin)
    );
    nextHardStopUtc = routineLatest;
    nextHardStop = `Routine latest ${formatTime(routineLatest, timeZone)} (bedtime cap ${formatTime(
      bedtimeLatest,
      timeZone
    )})`;

    const awakeMin = minutesFromMs(now - state.lastWakeTime);
    wakeUtilization = Math.min(1, Math.max(0, awakeMin / maxWake));
    wakeWindowRemainingMin = Math.max(0, Math.round(maxWake - awakeMin));
    sleepPressureTrend = currentlyAsleep ? "down" : "up";

    regulationRisk =
      state.regulationLevel === "low"
        ? "low"
        : state.regulationLevel === "high"
        ? "high"
        : "rising";

    if (currentlyAsleep) {
      windowAllowed.splice(0, windowAllowed.length);
      windowSuppressed.splice(0, windowSuppressed.length);
      activityAllowed.splice(0, activityAllowed.length);
      activitySuppressed.splice(0, activitySuppressed.length);
      nextWindow = null;
      nextHardStop = null;
      nextWindowStartUtc = null;
      nextWindowEndUtc = null;
      nextHardStopUtc = null;
      wakeWindowRemainingMin = null;
    } else if (awakeMin < minWake * 0.6) {
      windowAllowed.push("Regulation / low stimulation", "Outdoor light", "Routine reset");
      windowSuppressed.push("High stimulation", "New novel activities");
      activityAllowed.push(
        { label: "Low-stim movement", expiresAt: endWindow },
        { label: "Quiet bonding", expiresAt: endWindow },
        { label: "Feeding window prep", expiresAt: endWindow }
      );
      activitySuppressed.push(
        { label: "High stimulation", reason: "wake window still early" },
        { label: "New novel activities", reason: "wake window still early" }
      );
    } else if (awakeMin < maxWake * 0.9) {
      windowAllowed.push("Regulation / low stimulation", "Outdoor light", "Routine reset");
      windowSuppressed.push("High stimulation", "New novel activities");
      activityAllowed.push(
        { label: "Active play", expiresAt: endWindow },
        { label: "Outdoor light", expiresAt: endWindow },
        { label: "Routine reset", expiresAt: endWindow }
      );
      activitySuppressed.push(
        { label: "High stimulation", reason: "wake window mid-cycle" },
        { label: "New novel activities", reason: "wake window mid-cycle" }
      );
    } else {
      windowAllowed.push("Regulation / low stimulation", "Routine reset");
      windowSuppressed.push("High stimulation", "New novel activities", "Outdoor light");
      activityAllowed.push(
        { label: "Wind-down", expiresAt: endWindow },
        { label: "Low-light calm", expiresAt: endWindow },
        { label: "Routine start", expiresAt: endWindow }
      );
      activitySuppressed.push(
        { label: "High stimulation", reason: "wake window near cap" },
        { label: "New novel activities", reason: "wake window near cap" },
        { label: "Outdoor light", reason: "wake window near cap" }
      );
    }

    if (awakeMin > maxWake) {
      // When wake windows run long, reduce stimulation to prevent spiral.
      windowAllowed.splice(0, windowAllowed.length, "Regulation / low stimulation");
      windowSuppressed.splice(0, windowSuppressed.length, "High stimulation", "New novel activities", "Outdoor light");
      activityAllowed.splice(
        0,
        activityAllowed.length,
        { label: "Minimal stimulation", expiresAt: endWindow },
        { label: "Reduce novelty", expiresAt: endWindow },
        { label: "Bridge to sleep", expiresAt: endWindow }
      );
      activitySuppressed.splice(
        0,
        activitySuppressed.length,
        { label: "High stimulation", reason: "wake window exceeded" },
        { label: "New novel activities", reason: "wake window exceeded" },
        { label: "Outdoor light", reason: "wake window exceeded" }
      );
    }

    shifts.push({
      delta: `Nap <${config.shortNapThresholdMin} min → next wake window −${config.shortenWakeByMinIfShortNap} min`,
      status: shorten ? "applied" : "pending",
    });
    shifts.push({
      delta: `Nap after ${config.lateNapHour}:00 → bedtime cap −${config.bedtimeEarlierByMinIfLateNap} min`,
      status: lateNap ? "applied" : "pending",
    });

    if (lateNap) {
      shifts.push({
        delta: `Late nap detected → next nap capped at ${config.nextNapCapMinIfLateNap} min`,
        status: "applied",
      });
    } else {
      shifts.push({
        delta: `Late nap detected → next nap capped at ${config.nextNapCapMinIfLateNap} min`,
        status: "pending",
      });
    }
  } else {
    windowAllowed.push("Log first awake");
    windowSuppressed.push("High stimulation", "New novel activities");
    activityAllowed.push(
      { label: "Log first awake", expiresAt: null },
      { label: "Record a feed", expiresAt: null },
      { label: "Start routine when ready", expiresAt: null }
    );
    activitySuppressed.push(
      { label: "High stimulation", reason: "system not yet calibrated" },
      { label: "New novel activities", reason: "system not yet calibrated" }
    );
    shifts.push({
      delta: "First awake marker → system window active",
      status: "pending",
    });
  }

  if (currentlyAsleep && state.lastNapStart) {
    const lateNap =
      state.lastNapEnd !== null &&
      getZonedParts(state.lastNapEnd, timeZone).hour >= config.lateNapHour;
    const estimatedDuration = lateNap
      ? Math.min(config.expectedNapDurationMin, config.nextNapCapMinIfLateNap)
      : config.expectedNapDurationMin;
    expectedWakeUtc = addMinutes(state.lastNapStart, estimatedDuration);
  }

  if (currentlyAsleep && state.lastNapStart) {
    const asleepMin = minutesFromMs(now - state.lastNapStart);
    summary.push(`Asleep for ${asleepMin} min`);
    if (expectedWakeUtc) {
      summary.push(`Expected wake ${formatTime(expectedWakeUtc, timeZone)}`);
    } else {
      summary.push("Expected wake —");
    }
  } else if (state.lastWakeTime) {
    const awakeMin = minutesFromMs(now - state.lastWakeTime);
    summary.push(`Awake for ${awakeMin} min`);
    if (state.lastNapDuration) {
      summary.push(`Last slept ${minutesFromMs(state.lastNapDuration)} min`);
    } else {
      summary.push("Last slept —");
    }
  } else {
    summary.push("Awaiting first awake marker");
    summary.push("Last slept —");
  }

  if (state.lastFeedTime) {
    const feedMin = minutesFromMs(now - state.lastFeedTime);
    summary.push(`Last feed ${feedMin} min ago`);
  } else {
    summary.push("No feed logged yet");
  }

  summary.push(`Regulation level: ${state.regulationLevel}`);

  return {
    stateSummary: summary,
    nextWindow,
    nextHardStop,
    isAsleep: currentlyAsleep,
    nextWindowStartUtc,
    nextWindowEndUtc,
    nextHardStopUtc,
    wakeWindowRemainingMin,
    expectedWakeUtc,
    activityCategories: {
      allowed: activityAllowed,
      suppressed: activitySuppressed,
    },
    windowCategories: {
      allowed: windowAllowed,
      suppressed: windowSuppressed,
    },
    shiftPreview: shifts,
    pressureIndicator: {
      wakeUtilization,
      sleepPressureTrend,
      regulationRisk,
    },
  };
};
