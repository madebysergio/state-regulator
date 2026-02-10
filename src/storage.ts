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
    const parsed = JSON.parse(raw) as {
      eventLog?: CareEvent[];
      autoSuppressed?: { type: string; timestampUtc: string }[];
    };
    const eventLog = (parsed.eventLog ?? []).map((event) => {
      if (event && typeof event === "object") {
        const record = event as Record<string, unknown>;
        if ("timestampUtc" in record) {
          return {
            ...(record as CareEvent),
            timestampUtc: String(record.timestampUtc),
          };
        }
        const legacyMs =
          typeof record.timestamp === "number" ? (record.timestamp as number) : nowUtcMs;
        return {
          ...(record as CareEvent),
          timestampUtc: new Date(legacyMs).toISOString(),
        };
      }
      return {
        id: `legacy-${nowUtcMs}-${Math.random().toString(16).slice(2)}`,
        type: "FirstAwake",
        timestampUtc: new Date(nowUtcMs).toISOString(),
      } as CareEvent;
    });
    const autoSuppressed = (parsed.autoSuppressed ?? []).filter(
      (entry) => entry && typeof entry === "object" && "type" in entry && "timestampUtc" in entry
    ) as { type: string; timestampUtc: string }[];
    return rebuildFromLog(
      eventLog,
      nowUtcMs,
      autoSuppressed.map((entry) => ({
        type: entry.type as CareEvent["type"],
        timestampUtc: String(entry.timestampUtc),
      }))
    );
  } catch {
    return initialAppState;
  }
};

export const saveState = (state: AppState) => {
  if (typeof window === "undefined") return;
  const payload = JSON.stringify({
    eventLog: state.eventLog,
    autoSuppressed: state.autoSuppressed,
  });
  window.localStorage.setItem(STORAGE_KEY, payload);
};
