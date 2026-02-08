import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlarmClock, ClipboardList, Gauge, Layers3 } from "lucide-react";
import { computeOutputs, defaultConfig } from "./constraints";
import { applyEvent, buildEvent, initialAppState, rebuildFromLog } from "./state";
import { EventType } from "./types";
import { loadState, loadTimeZone, saveState, saveTimeZone } from "./storage";

const EVENT_TYPES: { type: EventType; label: string; hint: string }[] = [
  { type: "FirstAwake", label: "First awake", hint: "Day start marker" },
  { type: "NapStarted", label: "Nap started", hint: "Sleep block begins" },
  { type: "NapEnded", label: "Nap ended", hint: "Auto-calculates duration" },
  { type: "MilkGiven", label: "Milk given", hint: "Feed marker" },
  { type: "SolidsGiven", label: "Solids given", hint: "Feed marker" },
  { type: "RoutineStarted", label: "Routine started", hint: "Prep latency starts" },
  { type: "Asleep", label: "Asleep", hint: "Night sleep start" },
];

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

      <section className="mt-4 flex items-center justify-between rounded-2xl bg-panel px-6 py-5 shadow-panel dark:shadow-panel-dark dark:bg-gh-surface md:px-8">
        <span className="text-sm uppercase tracking-[0.2em] text-muted dark:text-gh-muted">Now</span>
        <strong className="font-display text-5xl md:text-6xl">
          {formatTimeZoned(nowUtcMs, timeZone)}
        </strong>
      </section>

      <section className="mt-6 grid gap-5 hd:grid-cols-2">
        <div className="rounded-2xl bg-panel p-6 shadow-panel dark:shadow-panel-dark dark:bg-gh-surface md:p-7">
          <h2 className="flex items-center gap-2 font-display text-xl">
            <Layers3 className="h-5 w-5 text-accent dark:text-gh-accent" />
            Shift preview
          </h2>
          <ul className="mt-3 flex flex-col gap-2">
            {outputs.shiftPreview.map((item) => (
              <li
                key={item.delta}
                className={`flex items-center gap-2 text-sm ${
                  item.status === "applied" ? "text-ink" : "text-muted/70"
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
        </div>
        <div className="rounded-2xl bg-panel p-6 shadow-panel dark:shadow-panel-dark dark:bg-gh-surface md:p-7">
          <h2 className="flex items-center gap-2 font-display text-xl">
            <Activity className="h-5 w-5 text-accent dark:text-gh-accent" />
            Quick event input
          </h2>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {EVENT_TYPES.map((event) => {
              const highlightRoutine =
                event.type === "RoutineStarted" &&
                outputs.pressureIndicator.regulationRisk === "rising" &&
                (outputs.pressureIndicator.wakeUtilization ?? 0) >= 0.85 &&
                outputs.windowCategories.allowed.includes("Routine reset");
              return (
                <button
                  key={event.type}
                  className={`rounded-2xl border px-4 py-4 text-left text-base transition ${
                    selectedEvent === event.type
                      ? "border-accent bg-accent-soft dark:bg-gh-surface-2"
                      : "border-transparent bg-white dark:bg-gh-surface-2"
                  } ${highlightRoutine ? "ring-2 ring-warning/30 border-warning" : ""}`}
                  onClick={() => setSelectedEvent(event.type)}
                  type="button"
                >
                  <span className="block text-base font-medium">{event.label}</span>
                  <small className="text-sm text-muted dark:text-gh-muted">{event.hint}</small>
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              className="rounded-full bg-accent px-6 py-3 text-base font-semibold text-white"
              onClick={addEvent}
              type="button"
            >
              Log {EVENT_TYPES.find((event) => event.type === selectedEvent)?.label}
            </button>
            <button
              className="rounded-full border border-panel-strong px-6 py-3 text-base"
              onClick={clearAll}
              type="button"
            >
              Reset day
            </button>
          </div>
        </div>
      </section>

      <section className="mt-6 rounded-2xl bg-panel p-6 shadow-panel dark:shadow-panel-dark dark:bg-gh-surface md:p-7">
        <h2 className="flex items-center gap-2 font-display text-lg">
          <Gauge className="h-5 w-5 text-accent dark:text-gh-accent" />
          Constraint pressure
        </h2>
        <div className="mt-3 rounded-2xl bg-white p-4 dark:bg-gh-surface-2">
          <div className="flex items-center justify-between text-xs uppercase tracking-[0.08em] text-muted dark:text-gh-muted">
            <span>Wake window utilization</span>
            <span>{wakePct === null ? "—" : `${wakePct}%`}</span>
          </div>
          <div className="mt-3">
            <div className="relative h-3 rounded-full bg-panel-strong dark:bg-gh-border">
              <div className="absolute inset-0 grid grid-cols-3 gap-1 px-1">
                <div className="rounded-full bg-allowed/50"></div>
                <div className="rounded-full bg-warning/50"></div>
                <div className="rounded-full bg-suppressed/50"></div>
              </div>
              {wakePct !== null ? (
                <div
                  className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 border-white bg-ink dark:border-gh-surface dark:bg-gh-text"
                  style={{ left: `calc(${wakePct}% - 6px)` }}
                />
              ) : null}
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between">
            <div className="text-sm">
              <span className="text-muted dark:text-gh-muted">Trend</span>
              <strong className="ml-2 font-semibold">{outputs.pressureIndicator.sleepPressureTrend === "up" ? "↑" : "↓"}</strong>
            </div>
            <div className="text-sm">
              <span className="text-muted dark:text-gh-muted">Risk</span>
              <strong
                className={`ml-2 font-semibold ${
                  outputs.pressureIndicator.regulationRisk === "low"
                    ? "text-allowed"
                  : outputs.pressureIndicator.regulationRisk === "high"
                    ? "text-suppressed"
                    : "text-warning"
                }`}
              >
                {outputs.pressureIndicator.regulationRisk}
              </strong>
            </div>
          </div>
        </div>
      </section>

      <section className="mt-6 rounded-2xl bg-panel p-6 shadow-panel dark:shadow-panel-dark dark:bg-gh-surface md:p-7">
        <h2 className="flex items-center gap-2 font-display text-xl">
          <AlarmClock className="h-5 w-5 text-accent dark:text-gh-accent" />
          Next windows
        </h2>
        <div className="mt-3 rounded-2xl bg-white p-4 dark:bg-gh-surface-2">
          <span className="text-sm text-muted dark:text-gh-muted">Next allowed window</span>
          <strong className="mt-1 block text-xl font-semibold">
            {outputs.isAsleep ? "Asleep" : outputs.nextWindow ?? "Awaiting first awake"}
          </strong>
          {!outputs.isAsleep ? (
            <div className="mt-3 border-t border-panel-strong pt-3 dark:border-gh-border">
              <p className="text-xs uppercase tracking-[0.08em] text-muted dark:text-gh-muted">Allowed now</p>
              <ul className="mt-2 grid gap-2">
                {outputs.windowCategories.allowed.map((item) => (
                  <li key={item} className="flex items-center gap-2 text-allowed">
                    <StatusIcon variant="allowed" />
                    <span className="text-sm text-ink dark:text-gh-text">{item}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs uppercase tracking-[0.08em] text-muted dark:text-gh-muted">Suppressed now</p>
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
        <div className="mt-3 rounded-2xl bg-white p-4 dark:bg-gh-surface-2">
          <span className="text-sm text-muted dark:text-gh-muted">Next hard stop</span>
          <strong className="mt-1 block text-xl font-semibold">
            {outputs.isAsleep ? "—" : outputs.nextHardStop ?? "Pending"}
          </strong>
        </div>
      </section>

      <section className="mt-6 rounded-2xl bg-panel p-6 shadow-panel dark:shadow-panel-dark dark:bg-gh-surface md:p-7">
        <h2 className="flex items-center gap-2 font-display text-xl">
          <Activity className="h-5 w-5 text-accent dark:text-gh-accent" />
          Current system state
        </h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2 md:grid-cols-3">
          {outputs.stateSummary.map((item) => (
            <li key={item} className="rounded-xl bg-white p-3 text-sm font-medium dark:bg-gh-surface-2">
              {item}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6 rounded-2xl bg-panel p-6 shadow-panel dark:shadow-panel-dark dark:bg-gh-surface md:p-7">
        <h2 className="flex items-center gap-2 font-display text-xl">
          <ClipboardList className="h-5 w-5 text-accent dark:text-gh-accent" />
          Event log
        </h2>
        {state.eventLog.length === 0 ? (
          <div className="mt-2 text-sm text-muted dark:text-gh-muted">No events logged yet.</div>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {state.eventLog.map((event) => (
              <div
                key={event.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-4 dark:bg-gh-surface-2"
              >
                <div className="flex flex-col gap-1">
                  <strong className="text-sm">{EVENT_LABELS[event.type]}</strong>
                  <span className="text-xl font-semibold">
                    {formatTimeZoned(Date.parse(event.timestampUtc), timeZone)}
                  </span>
                </div>
                {editId === event.id ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2 rounded-full border border-panel-strong bg-white px-4 py-2 shadow-[0_0_0_1px_rgba(0,0,0,0.02)] dark:border-gh-border dark:bg-gh-surface">
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
