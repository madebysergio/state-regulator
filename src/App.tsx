import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlarmClock,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Gauge,
  Info,
  Layers3,
  Sparkles,
  Timer,
} from "lucide-react";
import { computeOutputs, defaultConfig } from "./constraints";
import { applyEvent, buildEvent, initialAppState, rebuildFromLog } from "./state";
import { EventType } from "./types";
import { loadState, loadTimeZone, saveState, saveTimeZone } from "./storage";

const EVENT_TYPES: { type: EventType; label: string; hint: string }[] = [
  { type: "FirstAwake", label: "First awake", hint: "Day start marker" },
  { type: "RoutineStarted", label: "Routine started", hint: "Prep latency starts" },
  { type: "MilkGiven", label: "Milk given", hint: "Feed marker" },
  { type: "SolidsGiven", label: "Solids given", hint: "Feed marker" },
  { type: "NapStarted", label: "Nap started", hint: "Sleep block begins" },
  { type: "NapEnded", label: "Nap ended", hint: "Auto-calculates duration" },
  { type: "Asleep", label: "Asleep", hint: "Night sleep start" },
];

const MS_MIN = 60 * 1000;

const EVENT_LABELS = EVENT_TYPES.reduce<Record<EventType, string>>((acc, event) => {
  acc[event.type] = event.label;
  return acc;
}, {} as Record<EventType, string>);

const formatTimeZoned = (utcMs: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(utcMs));

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

const formatDateTimeInput = (utcMs: number, timeZone: string) => {
  const parts = getZonedParts(utcMs, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(
    parts.minute
  )}`;
};

const formatCountdown = (minutes: number) => {
  if (minutes <= 0) return "0 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
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

const StatusIcon = ({ variant }: { variant: "allowed" | "suppressed" }) => (
  <svg
    className={`h-4 w-4 ${variant === "allowed" ? "text-allowed" : "text-suppressed"}`}
    viewBox="0 0 16 16"
    aria-hidden="true"
    focusable="false"
  >
    {variant === "allowed" ? (
      <path
        d="M3.5 8.5l3 3 6-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ) : (
      <path
        d="M4 4l8 8M12 4l-8 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    )}
  </svg>
);

export default function App() {
  const initialNowRef = useRef<number | null>(null);
  const shiftInitRef = useRef(false);
  if (initialNowRef.current === null) {
    initialNowRef.current = Date.now();
  }
  const initialNow = initialNowRef.current;
  const [nowUtcMs, setNowUtcMs] = useState(() => initialNow);
  const [state, setState] = useState(() => loadState(initialNow));
  const [timeZone, setTimeZone] = useState(() => loadTimeZone());
  const [selectedEvent, setSelectedEvent] = useState<EventType>("FirstAwake");
  const [editId, setEditId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>("");
  const [shiftExpanded, setShiftExpanded] = useState<boolean>(true);
  const [eventLogExpanded, setEventLogExpanded] = useState<boolean>(false);
  const [selectedUpcomingId, setSelectedUpcomingId] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    const stored = window.localStorage.getItem("reactive-care-scheduler:theme");
    if (stored === "dark" || stored === "light") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("reactive-care-scheduler:theme", theme);
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowUtcMs(Date.now()), 30 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden) {
        setNowUtcMs(Date.now());
      }
    };
    window.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleVisibility);
    return () => {
      window.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleVisibility);
    };
  }, []);

  useEffect(() => {
    saveState(state);
  }, [state]);

  useEffect(() => {
    saveTimeZone(timeZone);
  }, [timeZone]);

  useEffect(() => {
    setState((prev) => rebuildFromLog(prev.eventLog, nowUtcMs));
  }, [nowUtcMs]);


  const outputs = useMemo(
    () => computeOutputs(state, nowUtcMs, timeZone, defaultConfig),
    [state, nowUtcMs, timeZone]
  );
  const wakePct =
    outputs.pressureIndicator.wakeUtilization === null
      ? null
      : Math.max(0, Math.min(100, Math.round(outputs.pressureIndicator.wakeUtilization * 100)));
  const napStarts = state.eventLog
    .filter((event) => event.type === "NapStarted")
    .map((event) => Date.parse(event.timestampUtc));
  const historyDelta =
    napStarts.length >= 2
      ? (() => {
          const last = napStarts[napStarts.length - 1];
          const prev = napStarts[napStarts.length - 2];
          const deltaMin = Math.round((last - prev) / MS_MIN);
          if (deltaMin === 0) return null;
          const direction = deltaMin < 0 ? "earlier" : "later";
          return `Nap detected ${Math.abs(deltaMin)} min ${direction} than previous → adjusted next nap time`;
        })()
      : null;
  const hasInsights =
    outputs.shiftPreview.some((item) => item.status === "applied") || Boolean(historyDelta);
  useEffect(() => {
    if (!shiftInitRef.current) {
      setShiftExpanded(hasInsights);
      shiftInitRef.current = true;
    }
  }, [hasInsights]);
  const eventCount = state.eventLog.length;
  const shiftUpdatedAt = formatTimeZoned(nowUtcMs, timeZone);
  const wakeRemaining =
    outputs.wakeWindowRemainingMin !== null ? outputs.wakeWindowRemainingMin : null;
  const nextWindowCountdown =
    outputs.nextWindowStartUtc !== null
      ? Math.max(0, Math.ceil((outputs.nextWindowStartUtc - nowUtcMs) / MS_MIN))
      : null;
  const hardStopCountdown =
    outputs.nextHardStopUtc !== null
      ? Math.max(0, Math.ceil((outputs.nextHardStopUtc - nowUtcMs) / MS_MIN))
      : null;
  const expectedWakeCountdown =
    outputs.expectedWakeUtc !== null
      ? Math.max(0, Math.ceil((outputs.expectedWakeUtc - nowUtcMs) / MS_MIN))
      : null;
  const napInProgress =
    state.lastNapStart !== null &&
    (state.lastNapEnd === null || state.lastNapEnd < state.lastNapStart);
  const canLog: Record<EventType, boolean> = {
    FirstAwake: state.lastWakeTime === null,
    RoutineStarted: !outputs.isAsleep && state.lastWakeTime !== null,
    MilkGiven: true,
    SolidsGiven: true,
    NapStarted: !napInProgress,
    NapEnded: napInProgress,
    Asleep: !outputs.isAsleep,
  };
  const nextExpectedEvent: EventType | null = outputs.isAsleep
    ? "NapEnded"
    : state.lastWakeTime === null
    ? "FirstAwake"
    : napInProgress
    ? "NapEnded"
    : wakeRemaining !== null && wakeRemaining <= 30
    ? "RoutineStarted"
    : "NapStarted";

  const upcomingCandidates = [
    outputs.expectedWakeUtc
      ? {
          id: "expected-wake",
          label: "Expected wake",
          timeUtc: outputs.expectedWakeUtc,
          prep: "Reset environment for wake window",
        }
      : null,
    outputs.nextWindowStartUtc
      ? {
          id: "nap-window",
          label: "Nap window",
          timeUtc: outputs.nextWindowStartUtc,
          rangeEndUtc: outputs.nextWindowEndUtc,
          prep: "Prepare sleep space",
        }
      : null,
    outputs.nextHardStopUtc
      ? {
          id: "routine-latest",
          label: "Routine latest",
          timeUtc: outputs.nextHardStopUtc,
          prep: "Wind down, reduce stimulation",
        }
      : null,
    state.lastFeedTime
      ? {
          id: "next-feed",
          label: "Feed window",
          timeUtc: state.lastFeedTime + defaultConfig.feedIntervalMaxMin * MS_MIN,
          prep: "Prep feeding supplies",
        }
      : null,
  ].filter(Boolean) as {
    id: string;
    label: string;
    timeUtc: number;
    rangeEndUtc?: number | null;
    prep: string;
  }[];

  const timelineItems = upcomingCandidates
    .filter((item) => item.timeUtc >= nowUtcMs && item.timeUtc <= nowUtcMs + 4 * 60 * MS_MIN)
    .sort((a, b) => a.timeUtc - b.timeUtc);

  useEffect(() => {
    if (!editId) return;
    const event = state.eventLog.find((item) => item.id === editId);
    if (!event) return;
    setEditValue(formatDateTimeInput(Date.parse(event.timestampUtc), timeZone));
  }, [editId, state.eventLog, timeZone]);

  const addEvent = () => {
    const event = buildEvent(selectedEvent, nowUtcMs);
    setState((prev) => applyEvent(prev, event, nowUtcMs));
  };

  const startEdit = (eventId: string) => {
    setEditId(eventId);
  };

  const commitEdit = () => {
    if (!editId || !editValue) return;
    const [datePart, timePart] = editValue.split("T");
    if (!datePart || !timePart) return;
    const [year, month, day] = datePart.split("-").map(Number);
    const [hour, minute] = timePart.split(":").map(Number);
    const newTimestampUtc = getUtcMsFromZoned({ year, month, day, hour, minute }, timeZone);
    if (Number.isNaN(newTimestampUtc)) return;
    setState((prev) => {
      const eventLog = prev.eventLog.map((event) =>
        event.id === editId
          ? { ...event, timestampUtc: new Date(newTimestampUtc).toISOString() }
          : event
      );
      return rebuildFromLog(
        eventLog.sort((a, b) => Date.parse(a.timestampUtc) - Date.parse(b.timestampUtc)),
        nowUtcMs
      );
    });
    setEditId(null);
  };

  const clearAll = () => setState(initialAppState);

  return (
    <div className="min-h-screen bg-app px-6 pb-16 pt-8 text-ink dark:bg-app-dark dark:text-gh-text md:px-12 md:pt-10 lg:px-16 lg:pt-12">
      <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-muted dark:text-gh-muted">Reactive regulator</p>
          <h1 className="font-display text-4xl leading-tight md:text-5xl">
            Care Scheduling System
          </h1>
        </div>
        <button
          className="inline-flex items-center gap-2 rounded-full border border-panel-strong bg-white px-4 py-2 text-sm font-semibold text-ink shadow-sm dark:border-gh-border dark:bg-gh-surface dark:text-gh-text"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          type="button"
        >
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </button>
      </header>

      <section className="mt-4 flex items-center justify-between rounded-2xl bg-panel px-6 py-4 shadow-panel dark:shadow-panel-dark dark:bg-gh-surface md:px-8">
        <span className="text-sm uppercase tracking-[0.2em] text-muted dark:text-gh-muted">Now</span>
        <strong className="font-display text-4xl md:text-5xl">
          {formatTimeZoned(nowUtcMs, timeZone)}
        </strong>
      </section>

      <section className="mt-6 rounded-2xl bg-panel p-6 shadow-panel dark:shadow-panel-dark dark:bg-gh-surface md:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 font-display text-2xl">
            <Timer className="h-6 w-6 text-accent dark:text-gh-accent" />
            Upcoming events
          </h2>
          <button
            className="rounded-full bg-accent px-6 py-3 text-base font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => setSelectedUpcomingId(timelineItems[0]?.id ?? null)}
            type="button"
            disabled={timelineItems.length === 0}
          >
            What should I prep?
          </button>
        </div>
        <div className="mt-4 min-h-[140px] rounded-2xl bg-white p-4 dark:bg-gh-surface-2">
          {timelineItems.length === 0 ? (
            <div className="flex h-full items-center gap-3 text-sm text-muted dark:text-gh-muted">
              <div className="h-10 w-40 animate-pulse rounded-full bg-panel-strong dark:bg-gh-border" />
              Calculating...
            </div>
          ) : (
            <div className="flex gap-3 overflow-x-auto pb-2">
              <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-full border border-panel-strong text-xs uppercase tracking-[0.2em] text-muted dark:border-gh-border dark:text-gh-muted">
                Now
              </div>
              {timelineItems.map((item) => {
                const minutes = Math.max(0, Math.ceil((item.timeUtc - nowUtcMs) / MS_MIN));
                const urgency =
                  minutes <= 15
                    ? "border-suppressed/40 text-suppressed"
                    : minutes <= 30
                    ? "border-warning/40 text-warning"
                    : "border-allowed/40 text-allowed";
                return (
                  <button
                    key={item.id}
                    className={`min-h-[100px] min-w-[180px] rounded-2xl border bg-white p-4 text-left transition dark:bg-gh-surface ${urgency} ${
                      selectedUpcomingId === item.id ? "ring-2 ring-accent/30" : ""
                    }`}
                    onClick={() =>
                      setSelectedUpcomingId(selectedUpcomingId === item.id ? null : item.id)
                    }
                    type="button"
                  >
                    <div className="text-xs uppercase tracking-[0.08em] text-muted dark:text-gh-muted">
                      {`in ${formatCountdown(minutes)}`}
                    </div>
                    <div className="mt-2 text-lg font-semibold text-ink dark:text-gh-text">
                      {item.label}
                    </div>
                    <div className="mt-1 text-sm text-muted dark:text-gh-muted">
                      {item.rangeEndUtc
                        ? `${formatTimeZoned(item.timeUtc, timeZone)} – ${formatTimeZoned(
                            item.rangeEndUtc,
                            timeZone
                          )}`
                        : formatTimeZoned(item.timeUtc, timeZone)}
                    </div>
                    {selectedUpcomingId === item.id ? (
                      <div className="mt-3 text-sm text-ink dark:text-gh-text">{item.prep}</div>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section className="mt-6 rounded-2xl bg-panel p-6 shadow-panel dark:shadow-panel-dark dark:bg-gh-surface md:p-7">
        <h2 className="flex items-center gap-2 font-display text-2xl">
          <AlarmClock className="h-6 w-6 text-accent dark:text-gh-accent" />
          Next windows
        </h2>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl bg-white p-5 dark:bg-gh-surface-2">
            <div className="text-xs uppercase tracking-[0.08em] text-muted dark:text-gh-muted">
              Next allowed window
            </div>
            <div className="mt-3 flex flex-wrap items-baseline gap-3">
              {outputs.isAsleep ? (
                <span className="text-4xl font-semibold text-ink dark:text-gh-text">Asleep</span>
              ) : nextWindowCountdown !== null ? (
                <span className="text-4xl font-semibold text-ink dark:text-gh-text">
                  {formatCountdown(nextWindowCountdown)}
                </span>
              ) : (
                <span className="text-2xl font-semibold text-muted dark:text-gh-muted animate-pulse">
                  Calculating...
                </span>
              )}
              {!outputs.isAsleep && outputs.nextWindowStartUtc ? (
                <span className="text-sm text-muted dark:text-gh-muted">
                  starts {formatTimeZoned(outputs.nextWindowStartUtc, timeZone)}
                </span>
              ) : null}
            </div>
            {outputs.isAsleep && outputs.expectedWakeUtc ? (
              <div className="mt-2 text-sm text-muted dark:text-gh-muted">
                {expectedWakeCountdown !== null
                  ? `Expected wake in ${formatCountdown(expectedWakeCountdown)}`
                  : `Expected wake ${formatTimeZoned(outputs.expectedWakeUtc, timeZone)}`}
              </div>
            ) : null}
            {!outputs.isAsleep ? (
              <div className="mt-4 border-t border-panel-strong pt-3 dark:border-gh-border">
                <div className="text-xs uppercase tracking-[0.08em] text-muted dark:text-gh-muted">
                  Allowed now
                </div>
                <ul className="mt-2 grid gap-2">
                  {outputs.windowCategories.allowed.map((item) => (
                    <li key={item} className="flex items-center gap-2 text-allowed">
                      <StatusIcon variant="allowed" />
                      <span className="text-sm text-ink dark:text-gh-text">{item}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 text-xs uppercase tracking-[0.08em] text-muted dark:text-gh-muted">
                  Suppressed now
                </div>
                <ul className="mt-2 grid gap-2">
                  {outputs.windowCategories.suppressed.map((item) => (
                    <li key={item} className="flex items-center gap-2 text-suppressed">
                      <StatusIcon variant="suppressed" />
                      <span className="text-sm text-ink dark:text-gh-text">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          <div className="rounded-2xl bg-white p-5 dark:bg-gh-surface-2">
            <div className="text-xs uppercase tracking-[0.08em] text-muted dark:text-gh-muted">
              Next hard stop
            </div>
            <div className="mt-3 flex flex-wrap items-baseline gap-3">
              {hardStopCountdown !== null ? (
                <span className="text-4xl font-semibold text-ink dark:text-gh-text">
                  {formatCountdown(hardStopCountdown)}
                </span>
              ) : (
                <span className="text-2xl font-semibold text-muted dark:text-gh-muted animate-pulse">
                  Calculating...
                </span>
              )}
              {outputs.nextHardStopUtc ? (
                <span className="text-sm text-muted dark:text-gh-muted">
                  at {formatTimeZoned(outputs.nextHardStopUtc, timeZone)}
                </span>
              ) : null}
            </div>
            {outputs.nextHardStopUtc ? (
              <div className="mt-3 text-sm text-ink dark:text-gh-text">
                After solids → Wind down for bottle → Nap (estimated{" "}
                {formatTimeZoned(outputs.nextHardStopUtc, timeZone)})
              </div>
            ) : null}
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-muted dark:text-gh-muted">
          <div className="h-px flex-1 bg-panel-strong dark:bg-gh-border" />
          <ChevronDown className="h-4 w-4" />
          <span>Event log</span>
          <div className="h-px flex-1 bg-panel-strong dark:bg-gh-border" />
        </div>
      </section>

      <section className="mt-6 rounded-2xl bg-panel p-6 shadow-panel dark:shadow-panel-dark dark:bg-gh-surface md:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 font-display text-2xl">
            <Gauge className="h-6 w-6 text-accent dark:text-gh-accent" />
            Wake window status
          </h2>
          <button
            className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.08em] text-muted dark:text-gh-muted"
            type="button"
            title="Wake window utilization tracks time since last wake against the max window."
          >
            <Info className="h-4 w-4" />
            Info
          </button>
        </div>
        <div className="mt-4 rounded-2xl bg-white p-5 dark:bg-gh-surface-2">
          <div className="flex flex-wrap items-center gap-4">
            <div
              className={`text-4xl font-semibold ${
                outputs.pressureIndicator.regulationRisk === "high"
                  ? "text-suppressed"
                  : outputs.pressureIndicator.regulationRisk === "rising"
                  ? "text-warning"
                  : "text-allowed"
              } ${wakeRemaining === null ? "animate-pulse" : ""}`}
            >
              {wakeRemaining !== null ? `${wakeRemaining} min remaining` : "Calculating..."}
            </div>
            {outputs.pressureIndicator.regulationRisk !== "low" ? (
              <AlertTriangle
                className={`h-6 w-6 ${
                  outputs.pressureIndicator.regulationRisk === "high"
                    ? "text-suppressed"
                    : "text-warning"
                }`}
              />
            ) : null}
          </div>
          <div className="mt-2 text-sm text-muted dark:text-gh-muted">
            {outputs.pressureIndicator.regulationRisk === "high"
              ? "Approaching overtired window"
              : outputs.pressureIndicator.regulationRisk === "rising"
              ? "Window tightening"
              : "Window stable"}
          </div>
          <div className="mt-4">
            <div className="relative h-8 rounded-full bg-panel-strong dark:bg-gh-border">
              <div className="absolute inset-0 grid grid-cols-3 gap-2 px-2">
                <div className="rounded-full bg-allowed/40" />
                <div className="rounded-full bg-warning/40" />
                <div className="rounded-full bg-suppressed/40" />
              </div>
              {wakePct !== null ? (
                <div
                  className="absolute top-1/2 h-8 w-8 -translate-y-1/2 rounded-full border-2 border-white bg-ink dark:border-gh-surface dark:bg-gh-text"
                  style={{ left: `calc(${wakePct}% - 16px)` }}
                />
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section className="mt-6 rounded-2xl bg-panel p-6 shadow-panel dark:shadow-panel-dark dark:bg-gh-surface md:p-7">
        <h2 className="flex items-center gap-2 font-display text-2xl">
          <Activity className="h-6 w-6 text-accent dark:text-gh-accent" />
          Quick event input
        </h2>
        <div className="mt-4 flex flex-col gap-3">
          {EVENT_TYPES.map((event) => {
            const highlightRoutine =
              event.type === "RoutineStarted" &&
              outputs.pressureIndicator.regulationRisk === "rising" &&
              (outputs.pressureIndicator.wakeUtilization ?? 0) >= 0.85 &&
              outputs.windowCategories.allowed.includes("Routine reset");
            const isNext = nextExpectedEvent === event.type;
            return (
              <button
                key={event.type}
                className={`w-full min-h-[72px] rounded-2xl border px-5 py-4 text-left text-base transition ${
                  selectedEvent === event.type
                    ? "border-accent bg-accent-soft dark:bg-gh-surface-2"
                    : "border-transparent bg-white dark:bg-gh-surface-2"
                } ${highlightRoutine || isNext ? "ring-2 ring-accent/30 border-accent" : ""} ${
                  !canLog[event.type] ? "cursor-not-allowed opacity-50" : ""
                }`}
                onClick={() => setSelectedEvent(event.type)}
                type="button"
                disabled={!canLog[event.type]}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="block text-lg font-medium">{event.label}</span>
                    <small className="text-sm text-muted dark:text-gh-muted">{event.hint}</small>
                  </div>
                  {isNext ? (
                    <span className="rounded-full border border-accent px-3 py-1 text-xs uppercase tracking-[0.1em] text-accent">
                      Up next
                    </span>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            className="rounded-full border border-accent px-6 py-3 text-base font-semibold text-accent"
            onClick={addEvent}
            type="button"
          >
            Log {EVENT_TYPES.find((event) => event.type === selectedEvent)?.label}
          </button>
          <button
            className="rounded-full border border-panel-strong px-6 py-3 text-base dark:border-gh-border"
            onClick={clearAll}
            type="button"
          >
            Reset day
          </button>
        </div>
      </section>

      <section className="mt-6 rounded-2xl bg-panel p-6 shadow-panel dark:shadow-panel-dark dark:bg-gh-surface md:p-7">
        <h2 className="flex items-center gap-2 font-display text-2xl">
          <Activity className="h-6 w-6 text-accent dark:text-gh-accent" />
          Current system state
        </h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {outputs.stateSummary.map((item) => (
            <li
              key={item}
              className="rounded-xl bg-white p-5 text-base font-medium dark:bg-gh-surface-2"
            >
              {item}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6 rounded-2xl bg-panel p-6 shadow-panel dark:shadow-panel-dark dark:bg-gh-surface md:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 font-display text-2xl">
            <Layers3 className="h-6 w-6 text-accent dark:text-gh-accent" />
            Shift preview
          </h2>
          <button
            className="inline-flex items-center gap-2 rounded-full border border-panel-strong px-4 py-2 text-sm dark:border-gh-border"
            onClick={() => setShiftExpanded(!shiftExpanded)}
            type="button"
          >
            {shiftExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            {shiftExpanded ? "Collapse" : "Expand"}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-panel-strong bg-accent-soft px-4 py-3 text-sm dark:border-gh-border dark:bg-gh-surface-2">
          <Sparkles className="h-4 w-4 text-accent dark:text-gh-accent" />
          <span className="text-ink dark:text-gh-text">
            Updated {shiftUpdatedAt} based on {eventCount} logged events
          </span>
        </div>
        {shiftExpanded ? (
          <ul className="mt-4 flex flex-col gap-3">
            {historyDelta ? (
              <li className="flex items-center gap-3 rounded-xl border border-accent/40 bg-accent-soft px-4 py-3 text-sm font-semibold text-ink dark:border-gh-accent/50 dark:bg-gh-surface-2 dark:text-gh-text">
                <span className="text-xs text-accent">●</span>
                <span>{historyDelta}</span>
              </li>
            ) : null}
            {outputs.shiftPreview.map((item) => (
              <li
                key={item.delta}
                className={`flex items-center gap-3 rounded-xl border border-panel-strong px-4 py-3 text-sm dark:border-gh-border ${
                  item.status === "applied"
                    ? "bg-white text-ink dark:bg-gh-surface-2 dark:text-gh-text font-semibold"
                    : "bg-white/70 text-muted dark:bg-gh-surface-2 dark:text-gh-muted"
                }`}
              >
                <span
                  className={`text-xs ${
                    item.status === "applied" ? "text-accent" : "text-muted"
                  }`}
                >
                  ●
                </span>
                <span>{item.delta}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-4 text-sm text-muted dark:text-gh-muted">
            {hasInsights ? "Insights ready." : "No new shifts yet."}
          </div>
        )}
      </section>

      <section className="mt-6 rounded-2xl bg-panel p-6 shadow-panel dark:shadow-panel-dark dark:bg-gh-surface md:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 font-display text-2xl">
            <ClipboardList className="h-6 w-6 text-accent dark:text-gh-accent" />
            Event log
          </h2>
          {eventCount > 0 ? (
            <button
              className="inline-flex items-center gap-2 rounded-full border border-panel-strong px-4 py-2 text-sm dark:border-gh-border"
              onClick={() => setEventLogExpanded(!eventLogExpanded)}
              type="button"
            >
              {eventLogExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              {eventLogExpanded ? "Hide" : "Show"}
            </button>
          ) : null}
        </div>
        {eventCount === 0 ? (
          <div className="mt-3 text-sm text-muted dark:text-gh-muted">No events logged yet.</div>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            {(eventLogExpanded ? state.eventLog : state.eventLog.slice(0, 2)).map((event) => (
              <div
                key={event.id}
                className="flex min-h-[64px] flex-wrap items-center justify-between gap-4 rounded-xl bg-white p-4 dark:bg-gh-surface-2"
              >
                <div className="flex flex-col gap-1">
                  <strong className="text-base">{EVENT_LABELS[event.type]}</strong>
                  <span className="text-xl font-semibold">
                    {formatTimeZoned(Date.parse(event.timestampUtc), timeZone)}
                  </span>
                </div>
                {editId === event.id ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2 rounded-full border border-panel-strong bg-white px-4 py-3 shadow-[0_0_0_1px_rgba(0,0,0,0.02)] dark:border-gh-border dark:bg-gh-surface">
                      <input
                        type="datetime-local"
                        className="bg-transparent text-sm outline-none"
                        value={editValue}
                        onChange={(eventTarget) => setEditValue(eventTarget.target.value)}
                      />
                      <span className="flex h-7 w-7 items-center justify-center rounded-full border border-panel-strong text-muted">
                        <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                          <path
                            d="M7 3v2M17 3v2M4 8h16M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                    </div>
                    <button
                      className="rounded-full bg-accent px-6 py-3 text-base font-semibold text-white"
                      onClick={commitEdit}
                      type="button"
                    >
                      Save
                    </button>
                  </div>
                ) : (
                  <button
                    className="rounded-full border border-panel-strong px-6 py-3 text-base dark:border-gh-border"
                    onClick={() => startEdit(event.id)}
                    type="button"
                  >
                    Edit time
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <footer className="mt-6 text-sm text-muted dark:text-gh-muted">
        <p>State-driven regulator</p>
      </footer>
    </div>
  );
}
