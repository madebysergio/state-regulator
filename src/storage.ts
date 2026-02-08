import { AppState, CareEvent } from "./types";
import { initialAppState, rebuildFromLog } from "./state";

const STORAGE_KEY = "reactive-care-scheduler:v1";
const TIMEZONE_KEY = "reactive-care-scheduler:tz";

const resolveTimeZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export const loadTimeZone = (): string => {
  if (typeof window === "undefined") return "UTC";
  const stored = window.localStorage.getItem(TIMEZONE_KEY);
  return stored || resolveTimeZone();
};

export const saveTimeZone = (timeZone: string) => {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TIMEZONE_KEY, timeZone);
};

export const loadState = (nowUtcMs: number): AppState => {
  if (typeof window === "undefined") return initialAppState;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialAppState;
    const parsed = JSON.parse(raw) as { eventLog?: CareEvent[] };
    const eventLog = (parsed.eventLog ?? []).map((event) => {
      if ("timestampUtc" in event) {
        return { ...event, timestampUtc: String(event.timestampUtc) };
      }
      const legacy = event as CareEvent & { timestamp?: number };
      const legacyMs = typeof legacy.timestamp === "number" ? legacy.timestamp : Date.now();
      return { ...event, timestampUtc: new Date(legacyMs).toISOString() };
    });
    return rebuildFromLog(eventLog, nowUtcMs);
  } catch {
    return initialAppState;
  }
};

export const saveState = (state: AppState) => {
  if (typeof window === "undefined") return;
  const payload = JSON.stringify({ eventLog: state.eventLog });
  window.localStorage.setItem(STORAGE_KEY, payload);
};
