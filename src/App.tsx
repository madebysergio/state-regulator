import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Activity,
  AlarmClock,
  AlertTriangle,
  Trash2,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Gauge,
  Info,
  Layers3,
  X,
} from "lucide-react";
import {
  Baby,
  Cake,
  Clock,
  Moon,
  MoonStars,
  Smiley,
  Sparkle,
  StarFour,
  Sun,
  SunHorizon,
} from "phosphor-react";
import { computeOutputs, defaultConfig } from "./constraints";
import { applyEvent, buildEvent, initialAppState, rebuildFromLog } from "./state";
import { EventType } from "./types";
import { loadState, loadTimeZone, saveState, saveTimeZone } from "./storage";

type PredictedType = "milk" | "solids" | "nap" | "bedtime";
type PredictedEvent = {
  id: string;
  type: PredictedType;
  label: string;
  timeUtc: number;
  rangeEndUtc: number | null;
  prep: string;
};

const EVENT_TYPES: { type: EventType; label: string; hint: string }[] = [
  { type: "FirstAwake", label: "First awake", hint: "Day start marker" },
  { type: "RoutineStarted", label: "Routine started", hint: "Prep latency starts" },
  { type: "MilkGiven", label: "Milk given", hint: "Feed marker" },
  { type: "SolidsGiven", label: "Solids given", hint: "Feed marker" },
  { type: "NapStarted", label: "Nap started", hint: "Sleep block begins" },
  { type: "NapEnded", label: "Nap ended", hint: "Auto-calculates duration" },
  { type: "Asleep", label: "Bedtime", hint: "Night sleep start" },
];

const MS_MIN = 60 * 1000;
const EASE_CURVE = "ease-[cubic-bezier(0.22,0.61,0.36,1)]";

// Flexible reminders removed.

const makePredictedEvent = (
  data: Omit<PredictedEvent, "rangeEndUtc"> & { rangeEndUtc?: number | null }
): PredictedEvent => ({
  ...data,
  rangeEndUtc: data.rangeEndUtc ?? null,
});

const EVENT_LABELS = EVENT_TYPES.reduce<Record<EventType, string>>((acc, event) => {
  acc[event.type] = event.label;
  return acc;
}, {} as Record<EventType, string>);

const EVENT_ICONS: Record<EventType, JSX.Element> = {
  FirstAwake: <Sun className="h-5 w-5 text-accent dark:text-gh-accent" />,
  RoutineStarted: <Sparkle className="h-5 w-5 text-accent dark:text-gh-accent" />,
  MilkGiven: <Baby className="h-5 w-5 text-accent dark:text-gh-accent" />,
  SolidsGiven: <Cake className="h-5 w-5 text-accent dark:text-gh-accent" />,
  NapStarted: <MoonStars className="h-5 w-5 text-accent dark:text-gh-accent" />,
  NapEnded: <Moon className="h-5 w-5 text-accent dark:text-gh-accent" />,
  Asleep: <MoonStars className="h-5 w-5 text-accent dark:text-gh-accent" />,
};

const formatTimeZoned = (utcMs: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(utcMs));

const formatDateZoned = (utcMs: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
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

const zonedToUtc = (
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string
) => {
  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const zoned = getZonedParts(utcGuess, timeZone);
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const actual = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute);
  return utcGuess + (desired - actual);
};

const formatCountdown = (minutes: number) => {
  if (minutes <= 0) return "0 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
};

const formatAge = (minutes: number) => {
  if (minutes <= 0) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (mins === 0) return `${hours} hr ago`;
  return `${hours} hr ${mins} min ago`;
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

const getStateIcon = (item: string) => {
  if (item.startsWith("Sleeping") || item.startsWith("Bedtime")) {
    return <MoonStars className="h-5 w-5 text-accent dark:text-gh-accent" />;
  }
  if (item.startsWith("Expected wake") || item.startsWith("Last slept")) {
    return <SunHorizon className="h-5 w-5 text-accent dark:text-gh-accent" />;
  }
  if (item.startsWith("Last feed") || item.startsWith("No feed")) {
    return <Baby className="h-5 w-5 text-accent dark:text-gh-accent" />;
  }
  if (item.startsWith("How baby's doing")) {
    return <Smiley className="h-5 w-5 text-accent dark:text-gh-accent" />;
  }
  return <StarFour className="h-5 w-5 text-accent dark:text-gh-accent" />;
};

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
  const [eventLogModalOpen, setEventLogModalOpen] = useState<boolean>(false);
  const [eventLogSort, setEventLogSort] = useState<"latest" | "oldest">("latest");
  const [selectedUpcomingId, setSelectedUpcomingId] = useState<string | null>(null);
  const [predictionsUpdatedAt, setPredictionsUpdatedAt] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    const stored = window.localStorage.getItem("reactive-care-scheduler:theme");
    if (stored === "dark" || stored === "light") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [toasts, setToasts] = useState<{ id: string; message: string }[]>([]);
  const [wakeInfoOpen, setWakeInfoOpen] = useState(false);
  const [isXL, setIsXL] = useState(false);
  const [upcomingRowsToShow, setUpcomingRowsToShow] = useState(1);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("reactive-care-scheduler:theme", theme);
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const pushToast = (message: string) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((prev) => [...prev, { id, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 2600);
  };

  useEffect(() => {
    const timer = window.setInterval(() => setNowUtcMs(Date.now()), 10 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(min-width: 1280px)");
    const update = () => setIsXL(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
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

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setPredictionsUpdatedAt(formatTimeZoned(nowUtcMs, timeZone));
    }, 120);
    return () => window.clearTimeout(timeout);
  }, [state.eventLog]);

  const lastAsleepUtc =
    [...state.eventLog]
      .filter((event) => event.type === "Asleep")
      .map((event) => Date.parse(event.timestampUtc))
      .filter((timestamp) => !Number.isNaN(timestamp) && timestamp <= nowUtcMs)
      .pop() ?? null;
  const desiredWakeUtc = (() => {
    if (!lastAsleepUtc) return null;
    const bedtimeParts = getZonedParts(lastAsleepUtc, timeZone);
    const bedtimeMinutes = bedtimeParts.hour * 60 + bedtimeParts.minute;
    const desiredMinutes = 7 * 60;
    const dayOffset = bedtimeMinutes >= desiredMinutes ? 1 : 0;
    return zonedToUtc(
      {
        year: bedtimeParts.year,
        month: bedtimeParts.month,
        day: bedtimeParts.day + dayOffset,
        hour: 7,
        minute: 0,
      },
      timeZone
    );
  })();
  const nightSleepDurationMin =
    lastAsleepUtc && desiredWakeUtc
      ? Math.max(0, Math.round((desiredWakeUtc - lastAsleepUtc) / MS_MIN))
      : defaultConfig.nightSleepDurationMin;
  const outputs = computeOutputs(state, nowUtcMs, timeZone, {
    ...defaultConfig,
    nightSleepDurationMin,
  });
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
  const napInProgress =
    state.lastNapStart !== null &&
    (state.lastNapEnd === null || state.lastNapEnd < state.lastNapStart);
  const lastEventType =
    state.eventLog.length > 0 ? state.eventLog[state.eventLog.length - 1].type : null;
  const isNightSleep = outputs.isAsleep && lastEventType === "Asleep";
  const canLog: Record<EventType, boolean> = {
    FirstAwake: true,
    RoutineStarted: true,
    MilkGiven: true,
    SolidsGiven: true,
    NapStarted: true,
    NapEnded: true,
    Asleep: true,
  };

  const feedWindowStartUtc = state.lastFeedTime && !outputs.isAsleep
    ? state.lastFeedTime + defaultConfig.feedIntervalMinMin * MS_MIN
    : null;
  const feedWindowEndUtc = state.lastFeedTime && !outputs.isAsleep
    ? state.lastFeedTime + defaultConfig.feedIntervalMaxMin * MS_MIN
    : null;
  const TOLERANCE_WINDOW_MIN = 20;
  const FINAL_WAKE_THRESHOLD_MIN = 240;

  const getLastEvent = (type: EventType) =>
    [...state.eventLog]
      .filter((event) => event.type === type)
      .map((event) => Date.parse(event.timestampUtc))
      .filter((timestamp) => !Number.isNaN(timestamp) && timestamp <= nowUtcMs)
      .pop() ?? null;

  const deriveCurrentState = () => {
    const hungerPressure = state.timeSinceLastFeed
      ? Math.min(1, state.timeSinceLastFeed / (defaultConfig.feedIntervalMaxMin * MS_MIN))
      : 0;
    const sleepPressure = state.estimatedSleepPressure;
    const wakeDuration = state.lastWakeTime
      ? Math.max(0, (nowUtcMs - state.lastWakeTime) / MS_MIN)
      : 0;
    const lastSolids = getLastEvent("SolidsGiven");
    const lastMilk = getLastEvent("MilkGiven");
    const lastNap = getLastEvent("NapEnded") ?? getLastEvent("NapStarted");
    const dayClosed =
      Boolean(lastSolids) &&
      Boolean(lastMilk) &&
      wakeDuration > FINAL_WAKE_THRESHOLD_MIN;
    return {
      hungerPressure,
      sleepPressure,
      wakeDuration,
      lastSolids,
      lastMilk,
      lastNap,
      dayClosed,
    };
  };

  const isEventSatisfied = (predicted: PredictedEvent, logged: typeof state.eventLog) => {
    const tolerance = TOLERANCE_WINDOW_MIN * MS_MIN;
    const matchType = (type: PredictedType): EventType =>
      type === "milk"
        ? "MilkGiven"
        : type === "solids"
          ? "SolidsGiven"
          : type === "nap"
            ? "NapStarted"
            : "Asleep";
    const targetType = matchType(predicted.type);
    return logged.some((event) => {
      if (event.type !== targetType) return false;
      const delta = Math.abs(Date.parse(event.timestampUtc) - predicted.timeUtc);
      return delta < tolerance;
    });
  };

  const resolveNextAction = (snapshot: ReturnType<typeof deriveCurrentState>) => {
    if (snapshot.dayClosed) return { type: "bedtime" as const };
    if (snapshot.hungerPressure > snapshot.sleepPressure) {
      if (!snapshot.lastSolids) return { type: "solids" as const };
      if (!snapshot.lastMilk) return { type: "milk" as const };
      return { type: "milk" as const };
    }
    if (snapshot.sleepPressure > snapshot.hungerPressure) {
      return { type: "nap" as const };
    }
    return null;
  };

  const resolveSecondaryAction = (
    snapshot: ReturnType<typeof deriveCurrentState>,
    next: { type: PredictedType } | null
  ) => {
    if (!next) return null;
    if (next.type === "milk" && !snapshot.lastSolids) return { type: "solids" as const };
    if (next.type === "nap" && snapshot.hungerPressure > 0.7) return { type: "milk" as const };
    return null;
  };

  const buildPredictedEvents = (): PredictedEvent[] => {
    if (state.eventLog.length === 0) return [];

    const capUtc = outputs.nextHardStopUtc ?? null;
    const napDurationMin = defaultConfig.expectedNapDurationMin;

    const scheduleFromWake = (wakeUtc: number): PredictedEvent[] => {
      const nap1Start = wakeUtc + 3 * 60 * MS_MIN;
      const nap1End = nap1Start + napDurationMin * MS_MIN;
      const nap2Start = nap1End + 3.5 * 60 * MS_MIN;
      const nap2End = nap2Start + napDurationMin * MS_MIN;
      const bedtimeRaw = nap2End + 4 * 60 * MS_MIN;
      const bedtimeUtc = capUtc ? Math.min(capUtc, bedtimeRaw) : bedtimeRaw;

      const candidates: PredictedEvent[] = [
        makePredictedEvent({
          id: `feed-morning-${wakeUtc}`,
          type: "milk",
          label: "Bottle feed",
          timeUtc: wakeUtc + 10 * MS_MIN,
          prep: "Prep feeding supplies",
        }),
        makePredictedEvent({
          id: `solids-breakfast-${wakeUtc}`,
          type: "solids",
          label: "Solids",
          timeUtc: wakeUtc + 45 * MS_MIN,
          prep: "Prep solids",
        }),
        makePredictedEvent({
          id: `nap1-${nap1Start}`,
          type: "nap",
          label: "Nap window",
          timeUtc: nap1Start,
          rangeEndUtc: nap1End,
          prep: "Prepare sleep space",
        }),
        makePredictedEvent({
          id: `feed-postnap1-${nap1End}`,
          type: "milk",
          label: "Bottle feed",
          timeUtc: nap1End + 15 * MS_MIN,
          prep: "Prep feeding supplies",
        }),
        makePredictedEvent({
          id: `solids-lunch-${nap1End}`,
          type: "solids",
          label: "Solids",
          timeUtc: nap1End + 60 * MS_MIN,
          prep: "Prep solids",
        }),
        makePredictedEvent({
          id: `nap2-${nap2Start}`,
          type: "nap",
          label: "Nap window",
          timeUtc: nap2Start,
          rangeEndUtc: nap2End,
          prep: "Prepare sleep space",
        }),
        makePredictedEvent({
          id: `feed-postnap2-${nap2End}`,
          type: "milk",
          label: "Bottle feed",
          timeUtc: nap2End + 15 * MS_MIN,
          prep: "Prep feeding supplies",
        }),
        makePredictedEvent({
          id: `solids-dinner-${nap2End}`,
          type: "solids",
          label: "Solids",
          timeUtc: nap2End + 120 * MS_MIN,
          prep: "Prep solids",
        }),
        makePredictedEvent({
          id: `feed-final-${bedtimeUtc}`,
          type: "milk",
          label: "Bottle feed",
          timeUtc: bedtimeUtc - 30 * MS_MIN,
          prep: "Prep bedtime feed",
        }),
        makePredictedEvent({
          id: `bedtime-${bedtimeUtc}`,
          type: "bedtime",
          label: "Bedtime cap",
          timeUtc: bedtimeUtc,
          prep: "Bedtime buffer",
        }),
      ];

      return candidates
        .filter((entry) => (capUtc ? entry.timeUtc <= capUtc : true))
        .filter((entry) => entry.timeUtc > nowUtcMs)
        .sort((a, b) => a.timeUtc - b.timeUtc);
    };

    if (outputs.isAsleep) {
      if (!outputs.expectedWakeUtc) return [];
      return [
        makePredictedEvent({
          id: "expected-wake",
          type: "bedtime" as const,
          label: "Expected wake",
          timeUtc: outputs.expectedWakeUtc,
          prep: "Start the day",
        }),
        ...scheduleFromWake(outputs.expectedWakeUtc),
      ];
    }

    if (state.lastWakeTime) {
      return scheduleFromWake(state.lastWakeTime);
    }

    return [];
  };
  const lastRealLog =
    [...state.eventLog]
      .filter((event) => !event.autoPredicted && event.type !== "RoutineStarted")
      .map((event) => ({ event, ts: Date.parse(event.timestampUtc) }))
      .filter((item) => !Number.isNaN(item.ts) && item.ts <= nowUtcMs)
      .pop() ?? null;
  const loggedAsleep = lastRealLog?.event.type === "Asleep";
  const predictedEvents = buildPredictedEvents();
  const predictedExpectedWakeUtc =
    outputs.isAsleep
      ? predictedEvents.find((event) => event.label === "Expected wake")?.timeUtc ?? null
      : null;
  const effectiveExpectedWakeUtc =
    outputs.isAsleep && predictedExpectedWakeUtc ? predictedExpectedWakeUtc : outputs.expectedWakeUtc;
  const expectedWakeCountdown =
    effectiveExpectedWakeUtc !== null
      ? Math.max(0, Math.ceil((effectiveExpectedWakeUtc - nowUtcMs) / MS_MIN))
      : null;
  const sleepProgressPct =
    outputs.isAsleep && effectiveExpectedWakeUtc && lastAsleepUtc
      ? Math.max(
        0,
        Math.min(
          100,
          Math.round(
            ((nowUtcMs - lastAsleepUtc) / (effectiveExpectedWakeUtc - lastAsleepUtc)) * 100
          )
        )
      )
      : null;
  const upcomingEvents = predictedEvents.filter(
    (predicted) => !isEventSatisfied(predicted, state.eventLog)
  );
  const timelineItems: Array<PredictedEvent & { effectiveTimeUtc: number }> = upcomingEvents.map((item) => ({
    ...item,
    effectiveTimeUtc: item.timeUtc,
  }));
  const nextThreeTimeline = timelineItems;
  const upNext = upcomingEvents[0] ?? null;
  const resolverSnapshot = deriveCurrentState();
  const resolvedAction = resolveNextAction(resolverSnapshot);
  const resolvedUpNextType: EventType | null = resolvedAction
    ? resolvedAction.type === "milk"
      ? "MilkGiven"
      : resolvedAction.type === "solids"
        ? "SolidsGiven"
        : resolvedAction.type === "nap"
          ? "NapStarted"
          : "Asleep"
    : null;
  const upNextType = outputs.isAsleep ? "FirstAwake" : resolvedUpNextType;
  const orderedEvents = (() => {
    const base = [...EVENT_TYPES];
    if (!canLog.FirstAwake) {
      const firstAwakeIndex = base.findIndex((event) => event.type === "FirstAwake");
      if (firstAwakeIndex > -1) {
        const [item] = base.splice(firstAwakeIndex, 1);
        base.push(item);
      }
    }
    if (loggedAsleep) {
      const firstAwakeIndex = base.findIndex((event) => event.type === "FirstAwake");
      if (firstAwakeIndex > -1) {
        const [item] = base.splice(firstAwakeIndex, 1);
        base.unshift(item);
      }
    }
    if (upNextType) {
      const nextIndex = base.findIndex((event) => event.type === upNextType);
      if (nextIndex > -1) {
        const [item] = base.splice(nextIndex, 1);
        base.unshift(item);
      }
    }
    return base;
  })();
  const sortedEventLog = [...state.eventLog].sort((a, b) =>
    eventLogSort === "latest"
      ? Date.parse(b.timestampUtc) - Date.parse(a.timestampUtc)
      : Date.parse(a.timestampUtc) - Date.parse(b.timestampUtc)
  );
  const groupedEventLog = (() => {
    const groups: { date: string; events: typeof sortedEventLog }[] = [];
    const map = new Map<string, typeof sortedEventLog>();
    sortedEventLog.forEach((event) => {
      const dateKey = formatDateZoned(Date.parse(event.timestampUtc), timeZone);
      if (!map.has(dateKey)) {
        map.set(dateKey, []);
      }
      map.get(dateKey)?.push(event);
    });
    map.forEach((events, date) => {
      groups.push({ date, events });
    });
    return groups;
  })();

  const activityListRef = useRef<HTMLDivElement | null>(null);
  const prevLogSignatureRef = useRef<string>("");
  const logSignature = state.eventLog
    .map((event) => `${event.id}:${event.timestampUtc}:${event.type}`)
    .join("|");

  useLayoutEffect(() => {
    if (!activityListRef.current) return;
    const currentSignature = `${logSignature}|${upNextType ?? "none"}`;
    if (currentSignature === prevLogSignatureRef.current) return;
    prevLogSignatureRef.current = currentSignature;
    if (!orderedEvents[0]) return;
    const target = activityListRef.current.querySelector<HTMLButtonElement>(
      `[data-event-type="${orderedEvents[0].type}"]`
    );
    if (!target) return;
    activityListRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [logSignature, orderedEvents, upNextType]);

  useEffect(() => {
    if (upNextType) {
      setSelectedEvent(upNextType);
    }
  }, [upNextType]);

  const currentStatus = outputs.isAsleep
    ? "Sleeping"
    : napInProgress
      ? "Napping"
      : state.lastFeedTime && nowUtcMs - state.lastFeedTime < 30 * MS_MIN
        ? "Feeding"
        : state.lastWakeTime && nowUtcMs - state.lastWakeTime < 30 * MS_MIN
          ? "Getting ready"
          : "Playtime";
  const routineDurations = (() => {
    const events = [...state.eventLog]
      .map((event) => ({ event, ts: Date.parse(event.timestampUtc) }))
      .filter((item) => !Number.isNaN(item.ts))
      .sort((a, b) => a.ts - b.ts);
    const durations: number[] = [];
    events.forEach((entry, index) => {
      if (entry.event.type !== "RoutineStarted") return;
      const next = events.slice(index + 1).find((item) => item.event.type !== "RoutineStarted");
      if (!next) return;
      const minutes = Math.max(0, Math.round((next.ts - entry.ts) / MS_MIN));
      if (minutes > 0) durations.push(minutes);
    });
    return durations;
  })();
  const longestRoutine = routineDurations.length ? Math.max(...routineDurations) : null;
  const shortestRoutine = routineDurations.length ? Math.min(...routineDurations) : null;

  useEffect(() => {
    if (selectedUpcomingId && !timelineItems.find((item) => item.id === selectedUpcomingId)) {
      setSelectedUpcomingId(null);
    }
  }, [selectedUpcomingId, timelineItems]);

  const rowsPerView = isXL ? 3 : 1;
  const maxUpcomingRows = Math.max(1, Math.ceil(nextThreeTimeline.length / rowsPerView));

  useEffect(() => {
    setUpcomingRowsToShow(Math.min(2, maxUpcomingRows));
  }, [nextThreeTimeline.length, maxUpcomingRows]);

  const visibleUpcoming = nextThreeTimeline.slice(0, upcomingRowsToShow * rowsPerView);
  const canShowMoreUpcoming = upcomingRowsToShow < maxUpcomingRows;

  useEffect(() => {
    if (!editId) return;
    const event = state.eventLog.find((item) => item.id === editId);
    if (!event) return;
    setEditValue(formatDateTimeInput(Date.parse(event.timestampUtc), timeZone));
  }, [editId, state.eventLog, timeZone]);

  const addEvent = () => {
    const event = buildEvent(selectedEvent, nowUtcMs);
    setState((prev) => applyEvent(prev, event, nowUtcMs));
    pushToast(`Logged ${EVENT_TYPES.find((item) => item.type === selectedEvent)?.label}`);
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
      const target = prev.eventLog.find((event) => event.id === editId);
      const updatedTimestampUtc = new Date(newTimestampUtc).toISOString();
      const eventLog = prev.eventLog.map((event) =>
        event.id === editId
          ? { ...event, timestampUtc: updatedTimestampUtc, autoPredicted: false }
          : event
      );
      const autoSuppressed = target?.autoPredicted
        ? [
          ...prev.autoSuppressed,
          { type: target.type, timestampUtc: target.timestampUtc },
        ]
        : prev.autoSuppressed;
      return rebuildFromLog(
        eventLog.sort((a, b) => Date.parse(a.timestampUtc) - Date.parse(b.timestampUtc)),
        nowUtcMs,
        autoSuppressed
      );
    });
    setEditId(null);
    pushToast("Log updated");
  };

  const clearAll = () => {
    setState(initialAppState);
    pushToast("Start over");
  };

  const deleteEvent = (eventId: string) => {
    setState((prev) => {
      const target = prev.eventLog.find((event) => event.id === eventId);
      const eventLog = prev.eventLog.filter((event) => event.id !== eventId);
      const autoSuppressed = target?.autoPredicted
        ? [
          ...prev.autoSuppressed,
          { type: target.type, timestampUtc: target.timestampUtc },
        ]
        : prev.autoSuppressed;
      return rebuildFromLog(eventLog, nowUtcMs, autoSuppressed);
    });
  };


  return (
    <div className="min-h-screen bg-app px-6 pb-16 pt-8 text-ink dark:bg-app-dark dark:text-gh-text md:px-12 md:pt-10 lg:px-16 lg:pt-12">
      <header className="flex items-center justify-end">
        <button
          className={`inline-flex items-center gap-2 rounded-full border border-panel-strong bg-white px-4 py-2 text-sm font-semibold text-ink shadow-sm transition-all duration-300 ${EASE_CURVE} dark:border-gh-border dark:bg-gh-surface dark:text-gh-text`}
          onClick={() => {
            const next = theme === "dark" ? "light" : "dark";
            setTheme(next);
            pushToast(next === "dark" ? "Dark mode enabled" : "Light mode enabled");
          }}
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

      <div className="mt-6 flex flex-col gap-6">
        <section className="rounded-2xl bg-panel p-6 shadow-panel dark:shadow-panel-dark dark:bg-gh-surface md:p-7 flex flex-col">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 font-display text-2xl">
              <ClipboardList className="h-6 w-6 text-accent dark:text-gh-accent" />
              Today's log
            </h2>
            <div className="flex items-center gap-2">
              <div className="relative">
                <select
                  className="appearance-none rounded-full border border-panel-strong bg-white px-3 py-2 pr-10 text-sm dark:border-gh-border dark:bg-gh-surface"
                  value={eventLogSort}
                  onChange={(eventTarget) =>
                    setEventLogSort(eventTarget.target.value as "latest" | "oldest")
                  }
                >
                  <option value="latest">Latest</option>
                  <option value="oldest">Oldest</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted dark:text-gh-muted" />
              </div>
            </div>
          </div>
          <div className="mt-4 grid gap-6 xl:grid-cols-2">
            <div>
              <h3 className="text-xs uppercase tracking-[0.08em] text-muted dark:text-gh-muted">
                Log activity
              </h3>
              <div className="mt-3 relative">
                <div
                  ref={activityListRef}
                  className="h-[190px] snap-y snap-mandatory overflow-y-auto pr-2 space-y-3"
                >
                  {orderedEvents.map((event) => {
                    const highlightRoutine =
                      event.type === "RoutineStarted" &&
                      outputs.pressureIndicator.regulationRisk === "rising" &&
                      (outputs.pressureIndicator.wakeUtilization ?? 0) >= 0.85 &&
                      outputs.windowCategories.allowed.includes("Routine reset");
                    const isNext = upNextType === event.type;
                    return (
                      <button
                        key={event.type}
                        data-event-type={event.type}
                        className={`w-full min-h-[76px] snap-start rounded-2xl border px-5 py-4 text-left text-base transition-all duration-300 ${EASE_CURVE} ${selectedEvent === event.type
                            ? "border-accent bg-accent-soft dark:bg-gh-surface-2"
                            : "border-transparent bg-white dark:bg-gh-surface-2"
                          } ${highlightRoutine || isNext ? "ring-2 ring-accent/30 border-accent" : ""}`}
                        onClick={() => setSelectedEvent(event.type)}
                        type="button"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            {EVENT_ICONS[event.type]}
                            <div>
                              <span className="block text-lg font-medium">{event.label}</span>
                              <small className="text-sm text-muted dark:text-gh-muted">
                                {event.hint}
                              </small>
                            </div>
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
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b from-transparent to-panel dark:to-gh-surface" />
              </div>
              <div className="mt-4 flex w-full flex-col gap-3">
                <button
                  className={`w-full rounded-full bg-accent px-6 py-3 text-base font-semibold text-white transition-all duration-300 ${EASE_CURVE}`}
                  onClick={addEvent}
                  type="button"
                >
                  Log {EVENT_TYPES.find((event) => event.type === selectedEvent)?.label}
                </button>
                <button
                  className={`w-full rounded-full border border-panel-strong bg-white px-6 py-3 text-base transition-all duration-300 ${EASE_CURVE} dark:border-gh-border dark:bg-gh-surface`}
                  onClick={clearAll}
                  type="button"
                >
                  Start over
                </button>
              </div>
            </div>

            <div>
              <h3 className="text-xs uppercase tracking-[0.08em] text-muted dark:text-gh-muted">
                Today's log
              </h3>
              {eventCount === 0 ? (
                <div className="mt-3 text-sm text-muted dark:text-gh-muted">No events logged yet.</div>
              ) : (
                <div className="mt-3 flex flex-col gap-4">
                  {groupedEventLog.map((group) => (
                    <div key={group.date} className="flex flex-col gap-3">
                      <div className="text-xs uppercase tracking-[0.08em] text-muted dark:text-gh-muted">
                        {group.date}
                      </div>
                      {group.events.slice(0, 2).map((event) => (
                        <div
                          key={event.id}
                          className="flex min-h-[64px] flex-col items-start gap-4 rounded-xl bg-white p-4 fade-in dark:bg-gh-surface-2 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:gap-3">
                            <div className="sm:shrink-0">{EVENT_ICONS[event.type]}</div>
                            <div className="flex w-full flex-col gap-2">
                              <strong className="text-[24px]">{EVENT_LABELS[event.type]}</strong>
                              {event.autoPredicted ? (
                                <small className="w-fit rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[9px] uppercase tracking-[0.16em] text-accent dark:border-gh-accent/50 dark:bg-gh-accent/10 dark:text-gh-accent">
                                  auto-predicted
                                </small>
                              ) : null}
                              <span className="text-base font-semibold text-accent dark:text-gh-accent">
                                {formatTimeZoned(Date.parse(event.timestampUtc), timeZone)}
                              </span>
                              <small className="text-sm text-muted dark:text-gh-muted">
                                {formatAge(
                                  Math.max(
                                    0,
                                    Math.round((nowUtcMs - Date.parse(event.timestampUtc)) / MS_MIN)
                                  )
                                )}
                              </small>
                            </div>
                          </div>
                          <div className="flex w-full items-center gap-2 sm:w-auto">
                            {editId === event.id ? (
                              <>
                                <div className="flex w-full items-center gap-2 rounded-full border border-panel-strong bg-white px-4 py-3 shadow-[0_0_0_1px_rgba(0,0,0,0.02)] dark:border-gh-border dark:bg-gh-surface sm:w-auto">
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
                                  className={`w-full h-11 rounded-full bg-accent px-6 text-base font-semibold text-white transition-all duration-300 ${EASE_CURVE} sm:w-auto`}
                                  onClick={commitEdit}
                                  type="button"
                                >
                                  Save
                                </button>
                              </>
                            ) : (
                              <button
                                className={`w-full h-11 whitespace-nowrap rounded-full border border-panel-strong px-6 text-base transition-all duration-300 ${EASE_CURVE} dark:border-gh-border sm:w-auto`}
                                onClick={() => startEdit(event.id)}
                                type="button"
                              >
                                Edit time
                              </button>
                            )}
                            <button
                              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-panel-strong text-muted transition-all duration-300 ${EASE_CURVE} dark:border-gh-border dark:text-gh-muted`}
                              onClick={() => deleteEvent(event.id)}
                              type="button"
                              aria-label="Delete log"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              {eventCount > 2 ? (
                <button
                  className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full border border-panel-strong px-4 py-3 text-sm dark:border-gh-border"
                  onClick={() => setEventLogModalOpen(true)}
                  type="button"
                >
                  <ChevronDown className="h-4 w-4" />
                  See full log
                </button>
              ) : null}
            </div>
          </div>
        </section>

        <section className="rounded-2xl bg-panel p-6 shadow-panel dark:shadow-panel-dark dark:bg-gh-surface md:p-7 xl:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 font-display text-2xl">
              <Clock className="h-6 w-6 text-accent dark:text-gh-accent" />
              What's coming up
            </h2>
            {predictionsUpdatedAt ? (
              <span className="rounded-full border border-panel-strong px-3 py-1 text-xs uppercase tracking-[0.08em] text-muted dark:border-gh-border dark:text-gh-muted">
                Updated {predictionsUpdatedAt}
              </span>
            ) : null}
          </div>
          <div className="mt-2 text-sm text-muted dark:text-gh-muted">
            Updates after each log.
          </div>
          <div className="mt-4 flex h-full max-h-full flex-col rounded-2xl bg-white p-5 dark:bg-gh-surface-2">
            {nextThreeTimeline.length === 0 ? (
              <div className="flex h-full items-center gap-3 text-sm text-muted dark:text-gh-muted">
                <div className="h-10 w-40 animate-pulse rounded-full bg-panel-strong dark:bg-gh-border" />
                Calculating...
              </div>
            ) : (
              <>
                <div className="text-xs uppercase tracking-[0.2em] text-muted dark:text-gh-muted">
                  Now
                </div>
                <div className="mt-3 grid grid-cols-1 gap-4 overflow-hidden pr-2 transition-all duration-300 xl:grid-cols-3">
                  {visibleUpcoming.map((item) => {
                    const minutes = Math.max(
                      0,
                      Math.ceil((item.effectiveTimeUtc - nowUtcMs) / MS_MIN)
                    );
                    const showStatus = minutes <= 0;
                      const upcomingIcon =
                        item.label === "Expected wake" ? (
                          <SunHorizon className="h-5 w-5 text-accent dark:text-gh-accent" />
                        ) : item.type === "milk" ? (
                          <Baby className="h-5 w-5 text-accent dark:text-gh-accent" />
                        ) : item.type === "nap" ? (
                          <MoonStars className="h-5 w-5 text-accent dark:text-gh-accent" />
                        ) : (
                          <Sparkle className="h-5 w-5 text-accent dark:text-gh-accent" />
                        );
                    return (
                      <button
                        key={item.id}
                        className={`w-full rounded-2xl border border-allowed/40 bg-white p-5 text-left transition-all duration-300 ${EASE_CURVE} fade-in dark:border-allowed/30 dark:bg-gh-surface-2 ${selectedUpcomingId === item.id ? "ring-2 ring-accent/30" : ""
                          }`}
                        onClick={() =>
                          setSelectedUpcomingId(selectedUpcomingId === item.id ? null : item.id)
                        }
                        type="button"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            {upcomingIcon}
                            <div>
                              <div className="text-xs uppercase tracking-[0.08em] text-muted dark:text-gh-muted">
                                {showStatus ? currentStatus : `in ${formatCountdown(minutes)}`}
                              </div>
                              <div className="mt-2 text-2xl font-semibold text-ink dark:text-gh-text">
                                {item.label}
                              </div>
                              <div className="mt-2 text-lg font-semibold text-accent dark:text-gh-accent">
                                {item.rangeEndUtc
                                  ? `${formatTimeZoned(item.timeUtc, timeZone)} – ${formatTimeZoned(
                                    item.rangeEndUtc,
                                    timeZone
                                  )}`
                                  : formatTimeZoned(item.timeUtc, timeZone)}
                              </div>
                            </div>
                          </div>
                          <Sparkle className="h-4 w-4 text-accent dark:text-gh-accent" />
                        </div>
                        {selectedUpcomingId === item.id ? (
                          <div className="mt-3 text-sm text-ink dark:text-gh-text">{item.prep}</div>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
          {nextThreeTimeline.length > rowsPerView ? (
            <div className="mt-auto pt-4 flex w-full flex-col gap-2">
              <button
                className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-panel-strong px-4 py-3 text-sm dark:border-gh-border"
                type="button"
                onClick={() =>
                  setUpcomingRowsToShow((prev) => Math.min(maxUpcomingRows, prev + 1))
                }
                disabled={!canShowMoreUpcoming}
              >
                <ChevronDown className="h-4 w-4" />
                {canShowMoreUpcoming ? "Show more" : "All shown"}
              </button>
              {upcomingRowsToShow > 1 ? (
                <button
                  className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-panel-strong px-4 py-3 text-sm dark:border-gh-border"
                  type="button"
                  onClick={() => setUpcomingRowsToShow(1)}
                >
                  Collapse
                </button>
              ) : null}
              {nextThreeTimeline.some((item) => item.label === "Nap window") ? (
                <div className="text-xs text-muted dark:text-gh-muted">
                  Extra nap available if needed.
                </div>
              ) : null}
            </div>
          ) : null}
        </section>

        <section className="rounded-2xl bg-panel p-6 shadow-panel dark:shadow-panel-dark dark:bg-gh-surface md:p-7">
          <h2 className="flex items-center gap-2 font-display text-2xl">
            <Activity className="h-6 w-6 text-accent dark:text-gh-accent" />
            Right now
          </h2>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {outputs.stateSummary.map((item, index) => (
              <li
                key={`${item}-${index}`}
                className="rounded-xl bg-white p-5 text-base font-medium dark:bg-gh-surface-2"
              >
                <div className="flex items-center gap-3">
                  {getStateIcon(item)}
                  <span>{item}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-2xl bg-panel p-6 shadow-panel dark:shadow-panel-dark dark:bg-gh-surface md:p-7">
          <h2 className="flex items-center gap-2 font-display text-2xl">
            <Sparkle className="h-6 w-6 text-accent dark:text-gh-accent" />
            Routine activity
          </h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-white p-5 text-base font-medium dark:bg-gh-surface-2">
              <div className="text-xs uppercase tracking-[0.08em] text-muted dark:text-gh-muted">
                Longest routine
              </div>
              <div className="mt-2 text-2xl font-semibold text-ink dark:text-gh-text">
                {longestRoutine !== null ? formatCountdown(longestRoutine) : "—"}
              </div>
            </div>
            <div className="rounded-xl bg-white p-5 text-base font-medium dark:bg-gh-surface-2">
              <div className="text-xs uppercase tracking-[0.08em] text-muted dark:text-gh-muted">
                Shortest routine
              </div>
              <div className="mt-2 text-2xl font-semibold text-ink dark:text-gh-text">
                {shortestRoutine !== null ? formatCountdown(shortestRoutine) : "—"}
              </div>
            </div>
          </div>
        </section>

      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <section className="rounded-2xl bg-panel p-6 shadow-panel dark:shadow-panel-dark dark:bg-gh-surface md:p-7 xl:col-span-2">
          <h2 className="flex items-center gap-2 font-display text-2xl">
            <AlarmClock className="h-6 w-6 text-accent dark:text-gh-accent" />
            Next steps
          </h2>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl bg-white p-5 dark:bg-gh-surface-2">
              <div className="text-xs uppercase tracking-[0.08em] text-muted dark:text-gh-muted">
                Next chance
              </div>
              <div className="mt-3 flex flex-wrap items-baseline gap-3">
                {outputs.isAsleep ? (
                  <span className="text-4xl font-semibold text-ink dark:text-gh-text">
                    Expected wake
                  </span>
                ) : nextWindowCountdown !== null ? (
                  <span className="text-4xl font-semibold text-ink dark:text-gh-text">
                    {nextWindowCountdown === 0 ? currentStatus : formatCountdown(nextWindowCountdown)}
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
              {outputs.isAsleep && effectiveExpectedWakeUtc ? (
                <div className="mt-2 text-sm text-muted dark:text-gh-muted">
                  {expectedWakeCountdown !== null
                    ? `Expected wake in ${formatCountdown(expectedWakeCountdown)}`
                    : `Expected wake ${formatTimeZoned(effectiveExpectedWakeUtc, timeZone)}`}
                </div>
              ) : null}
              {outputs.isAsleep && effectiveExpectedWakeUtc ? (
                <div className="mt-1 text-sm text-muted dark:text-gh-muted">
                  Next: Morning feed and the first wake window.
                </div>
              ) : null}
              {!outputs.isAsleep ? (
                <div className="mt-4 border-t border-panel-strong pt-3 dark:border-gh-border">
                  <div className="text-xs uppercase tracking-[0.08em] text-muted dark:text-gh-muted">
                    OK now
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
                    Skip for now
                  </div>
                  <ul className="mt-2 grid gap-2">
                    {outputs.windowCategories.suppressed.map((item) => (
                      <li key={item} className="flex items-center gap-2 text-suppressed">
                        <StatusIcon variant="suppressed" />
                        <span className="text-sm text-ink dark:text-gh-text">{item}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 text-xs uppercase tracking-[0.08em] text-muted dark:text-gh-muted">
                    Recommended activities
                  </div>
                  <ul className="mt-2 grid gap-2">
                    {outputs.activityCategories.allowed.map((item) => (
                      <li key={item.label} className="flex items-center gap-2 text-allowed">
                        <StatusIcon variant="allowed" />
                        <span className="text-sm text-ink dark:text-gh-text">{item.label}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            <div className="rounded-2xl bg-white p-5 text-sm text-muted dark:bg-gh-surface-2 dark:text-gh-muted">
              —
            </div>
          </div>
          <div className="mt-4 flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-muted dark:text-gh-muted">
            <div className="h-px flex-1 bg-panel-strong dark:bg-gh-border" />
            <ChevronDown className="h-4 w-4" />
            <span>Today's log</span>
            <div className="h-px flex-1 bg-panel-strong dark:bg-gh-border" />
          </div>
        </section>

        <section className="rounded-2xl bg-panel p-6 shadow-panel dark:shadow-panel-dark dark:bg-gh-surface md:p-7 xl:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 font-display text-2xl">
              <Gauge className="h-6 w-6 text-accent dark:text-gh-accent" />
              Time until wake
            </h2>
            <button
              className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.08em] text-muted dark:text-gh-muted"
              type="button"
              onClick={() => setWakeInfoOpen(true)}
            >
              <Info className="h-4 w-4" />
              Info
            </button>
          </div>
          <div className="mt-4 rounded-2xl bg-white p-5 dark:bg-gh-surface-2">
            <div className="flex flex-wrap items-center gap-4">
              <div
                className={`text-4xl font-semibold ${outputs.pressureIndicator.regulationRisk === "high"
                    ? "text-suppressed"
                    : outputs.pressureIndicator.regulationRisk === "rising"
                      ? "text-warning"
                      : "text-allowed"
                  } ${wakeRemaining === null && !outputs.isAsleep ? "animate-pulse" : ""}`}
              >
                {outputs.isAsleep
                  ? expectedWakeCountdown !== null
                    ? `Wake in ${formatCountdown(expectedWakeCountdown)}`
                    : "Wake in —"
                  : wakeRemaining !== null
                    ? wakeRemaining === 0 && outputs.pressureIndicator.regulationRisk === "high"
                      ? "Overtired"
                      : `${wakeRemaining} min remaining`
                    : "Calculating..."}
              </div>
              {outputs.isAsleep ? (
                <MoonStars className="h-6 w-6 text-accent dark:text-gh-accent" />
              ) : null}
              {!outputs.isAsleep && outputs.pressureIndicator.regulationRisk !== "low" ? (
                <AlertTriangle
                  className={`h-6 w-6 ${outputs.pressureIndicator.regulationRisk === "high"
                      ? "text-suppressed"
                      : "text-warning"
                    }`}
                />
              ) : null}
            </div>
            <div className="mt-2 text-sm text-muted dark:text-gh-muted">
              {outputs.isAsleep
                ? expectedWakeCountdown !== null
                  ? `Expected wake in ${formatCountdown(expectedWakeCountdown)}`
                  : "Expected wake time pending"
                : outputs.pressureIndicator.regulationRisk === "high"
                  ? wakeRemaining === 0
                    ? "Overtired window"
                    : "Approaching overtired window"
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
                {outputs.isAsleep && sleepProgressPct !== null ? (
                  <div
                    className={`absolute top-1/2 h-8 w-8 -translate-y-1/2 rounded-full border-2 border-white bg-ink transition-all duration-500 ${EASE_CURVE} dark:border-gh-surface dark:bg-gh-text`}
                    style={{ left: `calc(${sleepProgressPct}% - 16px)` }}
                  />
                ) : wakePct !== null ? (
                  <div
                    className={`absolute top-1/2 h-8 w-8 -translate-y-1/2 rounded-full border-2 border-white bg-ink transition-all duration-500 ${EASE_CURVE} dark:border-gh-surface dark:bg-gh-text`}
                    style={{ left: `calc(${wakePct}% - 16px)` }}
                  />
                ) : null}
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-2xl bg-panel p-6 shadow-panel dark:shadow-panel-dark dark:bg-gh-surface md:p-7 xl:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 font-display text-2xl">
              <Layers3 className="h-6 w-6 text-accent dark:text-gh-accent" />
              Today's pattern
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
            <Sparkle className="h-4 w-4 text-accent dark:text-gh-accent" />
            <span className="text-ink dark:text-gh-text">
              Updated {shiftUpdatedAt} based on {eventCount} logged events
            </span>
          </div>
          {shiftExpanded ? (
            <ul className="mt-4 flex flex-col gap-3 fade-in">
              {historyDelta ? (
                <li className="flex items-center gap-3 rounded-xl border border-accent/40 bg-accent-soft px-4 py-3 text-sm font-semibold text-ink dark:border-gh-accent/50 dark:bg-gh-surface-2 dark:text-gh-text">
                  <span className="text-xs text-accent">●</span>
                  <span>{historyDelta}</span>
                </li>
              ) : null}
              {outputs.shiftPreview.map((item) => (
                <li
                  key={item.delta}
                  className={`flex items-center gap-3 rounded-xl border border-panel-strong px-4 py-3 text-sm dark:border-gh-border ${item.status === "applied"
                      ? "bg-white text-ink dark:bg-gh-surface-2 dark:text-gh-text font-semibold"
                      : "bg-white/70 text-muted dark:bg-gh-surface-2 dark:text-gh-muted"
                    }`}
                >
                  <span
                    className={`text-xs ${item.status === "applied" ? "text-accent" : "text-muted"
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

      </div>


      <footer className="mt-6 text-sm text-muted dark:text-gh-muted">
        <p>State-driven regulator</p>
      </footer>

      {toasts.length > 0 ? (
        <div className="fixed bottom-6 right-6 z-50 flex w-[280px] flex-col gap-2">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={`rounded-2xl border border-panel-strong bg-white px-4 py-3 text-sm font-semibold text-ink shadow-panel transition-all duration-300 ${EASE_CURVE} toast-anim dark:border-gh-border dark:bg-gh-surface dark:text-gh-text dark:shadow-panel-dark`}
            >
              {toast.message}
            </div>
          ))}
        </div>
      ) : null}

      {eventLogModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-6">
          <button
            className="absolute inset-0 bg-black/40"
            type="button"
            aria-label="Close event log"
            onClick={() => setEventLogModalOpen(false)}
          />
          <div className="relative w-full max-w-3xl rounded-2xl border border-panel-strong bg-white p-6 shadow-panel dark:border-gh-border dark:bg-gh-surface dark:shadow-panel-dark">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xl font-semibold text-ink dark:text-gh-text">Full log</h3>
              <div className="flex items-center gap-2">
                <span className="min-w-[44px] pl-1 text-xs uppercase tracking-[0.08em] text-muted dark:text-gh-muted">
                  Sort
                </span>
                <div className="relative">
                  <select
                    className="appearance-none rounded-full border border-panel-strong bg-white px-3 py-2 pr-10 text-sm dark:border-gh-border dark:bg-gh-surface"
                    value={eventLogSort}
                    onChange={(eventTarget) =>
                      setEventLogSort(eventTarget.target.value as "latest" | "oldest")
                    }
                  >
                    <option value="latest">Latest</option>
                    <option value="oldest">Oldest</option>
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted dark:text-gh-muted" />
                </div>
              </div>
              <button
                className="flex h-10 w-10 items-center justify-center rounded-full border border-panel-strong text-muted dark:border-gh-border dark:text-gh-muted"
                type="button"
                aria-label="Close"
                onClick={() => setEventLogModalOpen(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 max-h-[70vh] overflow-y-auto pr-2">
              <div className="flex flex-col gap-4">
                {groupedEventLog.map((group) => (
                  <div key={group.date} className="flex flex-col gap-3">
                    <div className="text-xs uppercase tracking-[0.08em] text-muted dark:text-gh-muted">
                      {group.date}
                    </div>
                    {group.events.map((event) => (
                      <div
                        key={event.id}
                        className="flex min-h-[64px] flex-wrap items-center justify-between gap-4 rounded-xl bg-white p-4 dark:bg-gh-surface-2"
                      >
                        <div className="flex items-center gap-3">
                          {EVENT_ICONS[event.type]}
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center justify-between gap-2">
                              <strong className="text-[24px]">{EVENT_LABELS[event.type]}</strong>
                              {event.autoPredicted ? (
                                <small className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[9px] uppercase tracking-[0.16em] text-accent dark:border-gh-accent/50 dark:bg-gh-accent/10 dark:text-gh-accent">
                                  auto-predicted
                                </small>
                              ) : null}
                            </div>
                            <span className="text-base font-semibold text-accent dark:text-gh-accent">
                              {formatTimeZoned(Date.parse(event.timestampUtc), timeZone)}
                            </span>
                            <small className="text-sm text-muted dark:text-gh-muted">
                              {formatAge(
                                Math.max(
                                  0,
                                  Math.round((nowUtcMs - Date.parse(event.timestampUtc)) / MS_MIN)
                                )
                              )}
                            </small>
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            className={`rounded-full border border-panel-strong px-6 py-3 text-base transition-all duration-300 ${EASE_CURVE} dark:border-gh-border`}
                            onClick={() => startEdit(event.id)}
                            type="button"
                          >
                            Edit time
                          </button>
                          <button
                            className={`flex h-11 w-11 items-center justify-center rounded-full border border-panel-strong text-muted transition-all duration-300 ${EASE_CURVE} dark:border-gh-border dark:text-gh-muted`}
                            onClick={() => deleteEvent(event.id)}
                            type="button"
                            aria-label="Delete log"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}


      {wakeInfoOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-6">
          <button
            className="absolute inset-0 bg-black/40"
            type="button"
            aria-label="Close time until tired info"
            onClick={() => setWakeInfoOpen(false)}
          />
          <div className="relative w-full max-w-xl rounded-2xl border border-panel-strong bg-white p-6 shadow-panel dark:border-gh-border dark:bg-gh-surface dark:shadow-panel-dark">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xl font-semibold text-ink dark:text-gh-text">
                Time until wake
              </h3>
              <button
                className="flex h-10 w-10 items-center justify-center rounded-full border border-panel-strong text-muted dark:border-gh-border dark:text-gh-muted"
                type="button"
                aria-label="Close"
                onClick={() => setWakeInfoOpen(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 text-sm text-muted dark:text-gh-muted">
              This meter tracks time since the last wake and how close the day is to the tired zone.
              Green is comfortable, amber means the window is tightening, and red means it’s
              getting late for rest.
            </div>
          </div>
        </div>
      ) : null}

    </div>
  );
}
