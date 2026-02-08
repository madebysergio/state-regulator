export type RegulationLevel = "low" | "medium" | "high";

export type EventType =
  | "FirstAwake"
  | "NapStarted"
  | "NapEnded"
  | "MilkGiven"
  | "SolidsGiven"
  | "RoutineStarted"
  | "Asleep";

export type CareEvent = {
  id: string;
  type: EventType;
  timestampUtc: string;
};

export type CoreState = {
  lastWakeTime: number | null;
  lastNapStart: number | null;
  lastNapEnd: number | null;
  lastNapDuration: number | null;
  lastFeedTime: number | null;
  timeSinceLastFeed: number | null;
  estimatedSleepPressure: number;
  regulationLevel: RegulationLevel;
  totalDaySleep: number;
};

export type AppState = CoreState & {
  eventLog: CareEvent[];
};

export type ConstraintConfig = {
  minWakeWindowMin: number;
  maxWakeWindowMin: number;
  shortenWakeByMinIfShortNap: number;
  shortNapThresholdMin: number;
  lateNapHour: number;
  bedtimeLatestHour: number;
  bedtimeLatestMinute: number;
  bedtimeEarlierByMinIfLateNap: number;
  routineLatencyMin: number;
  setupLatencyMin: number;
  nextNapCapMinIfLateNap: number;
  feedIntervalMaxMin: number;
  expectedNapDurationMin: number;
};

export type OutputModel = {
  stateSummary: string[];
  nextWindow: string | null;
  nextHardStop: string | null;
  isAsleep: boolean;
  nextWindowStartUtc: number | null;
  nextWindowEndUtc: number | null;
  nextHardStopUtc: number | null;
  wakeWindowRemainingMin: number | null;
  expectedWakeUtc: number | null;
  activityCategories: {
    allowed: { label: string; expiresAt: number | null }[];
    suppressed: { label: string; reason: string }[];
  };
  windowCategories: {
    allowed: string[];
    suppressed: string[];
  };
  shiftPreview: { delta: string; status: "applied" | "pending" }[];
  pressureIndicator: {
    wakeUtilization: number | null;
    sleepPressureTrend: "up" | "down";
    regulationRisk: "low" | "rising" | "high";
  };
};
