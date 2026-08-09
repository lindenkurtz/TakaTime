/**
 * TakaTime — the shared summary shape.
 *
 * PURE. Imports `duration.mjs` and nothing else, so it runs in Node, in a browser,
 * and inside a VS Code webview unchanged. Do not add database, editor, or Node
 * built-in imports here — put those in source.mjs.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Three surfaces read these numbers — the VS Code status bar, the `taka` CLI, and
 * the webview panel. Each one deriving its own totals is how a fork ends up with a
 * dashboard that quietly sums the legacy `duration` field (see METHODOLOGY.md, and
 * see internal/DBQueryV2/ for what that looks like in practice). Every surface
 * consumes `buildSummary()` and nothing else, so there is one place to be wrong.
 *
 * ---------------------------------------------------------------------------
 * UNITS
 * ---------------------------------------------------------------------------
 * Integer milliseconds throughout, matching duration.mjs. `formatted` fields are
 * display sugar and are never summed.
 */

import {
  ALGORITHM_VERSION,
  CONFIG_REGISTRY,
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  DEFAULT_TIME_ZONE,
  computeDurations,
  dayKey,
  formatDuration,
  rank,
  toEpochMs,
} from "./duration.mjs";

/** Bump when the SHAPE of the summary changes, so surfaces can detect a mismatch. */
export const SUMMARY_VERSION = "1.0.0";

/** Trailing window for "this week". Rolling, not calendar — including today. */
export const DEFAULT_WEEK_DAYS = 7;

/** How many rows each leaderboard returns. */
export const DEFAULT_TOP_N = 5;

/** How far back the heatmap runs. 26 weeks fits a readable grid. */
export const DEFAULT_HEATMAP_DAYS = 182;

/** How far back the stacked daily trend runs. */
export const DEFAULT_TREND_DAYS = 30;

/** Series in a stacked trend before the tail is folded into one band. */
export const DEFAULT_STACK_SLOTS = 5;

/** Separator for composite grouping keys. A unit separator cannot occur in a path. */
const SEP = "␟";

/* -------------------------------------------------------------------------- */
/* Calendar arithmetic in an explicit zone                                     */
/* -------------------------------------------------------------------------- */

const offsetFormatterCache = new Map();

/**
 * Offset of `timeZone` from UTC at a given instant, in milliseconds.
 * Positive east of Greenwich. Computed by rendering the instant as wall time and
 * diffing against the same wall time read as UTC — the standard trick, and the only
 * one available without pulling in a date library.
 */
function zoneOffsetMs(epochMs, timeZone) {
  let fmt = offsetFormatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    offsetFormatterCache.set(timeZone, fmt);
  }
  const parts = {};
  for (const p of fmt.formatToParts(new Date(epochMs))) parts[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUTC - epochMs;
}

/**
 * The instant at which `YYYY-MM-DD` begins in `timeZone`.
 *
 * Two passes: the offset is itself a function of the instant, so the first guess is
 * corrected once. That converges everywhere except inside the one ambiguous hour of
 * a DST fall-back, where either answer names a real instant on the right day.
 */
export function startOfDayMs(day, timeZone = DEFAULT_TIME_ZONE) {
  const [y, m, d] = day.split("-").map(Number);
  const wallAsUTC = Date.UTC(y, m - 1, d, 0, 0, 0);
  const guess = wallAsUTC - zoneOffsetMs(wallAsUTC, timeZone);
  const corrected = wallAsUTC - zoneOffsetMs(guess, timeZone);
  return corrected;
}

/**
 * Shift a `YYYY-MM-DD` key by whole calendar days.
 *
 * Pure calendar arithmetic on the date parts — no zone involved, so DST cannot make
 * it skip or repeat a day the way stepping by 86_400_000 ms would.
 */
export function addDays(day, delta) {
  const [y, m, d] = day.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + delta * 86400000;
  const dt = new Date(t);
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Inclusive list of day keys from `from` to `to`. */
export function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Derived dimensions                                                          */
/* -------------------------------------------------------------------------- */

const hourFormatterCache = new Map();

/** Local hour 0..23 of an instant, in an explicit zone. */
function hourOf(epochMs, timeZone) {
  let fmt = hourFormatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit" });
    hourFormatterCache.set(timeZone, fmt);
  }
  return Number(fmt.format(new Date(epochMs)));
}

/**
 * Tag each heartbeat with the derived dimensions duration.mjs cannot compute itself.
 *
 * `computeDurations` resolves an unknown grouping dimension straight off the
 * heartbeat (`hb[dim]`), so decorating the input is the supported way to add one
 * WITHOUT touching the canonical module — which would mean bumping ALGORITHM_VERSION
 * and re-copying it into the website repo, for a display nicety.
 *
 * Returns copies; the caller's heartbeats are never mutated.
 */
function decorate(heartbeats, timeZone) {
  return heartbeats.map((hb) => {
    const t = toEpochMs(hb.timestamp);
    return {
      ...hb,
      hourLocal: String(hourOf(t, timeZone)).padStart(2, "0"),
      // A JOINT key. computeDurations only ever returns marginals, so "how much of
      // Tuesday was project X" has to be asked for as its own dimension. One extra
      // grouping on the existing pass is far cheaper than one ranged pass per day.
      dayProject: `${dayKey(t, timeZone)}${SEP}${hb.project ?? "unknown"}`,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* The summary                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build the summary every TakaTime surface renders.
 *
 * @param {Array<object>} heartbeats  ALL heartbeats, unsorted is fine. The whole
 *   collection is a couple of thousand documents, so there is no reason to page it —
 *   holding everything makes streaks and all-time totals free and removes every
 *   range-boundary edge case from the caller.
 * @param {object} [options]
 * @param {number|string|Date} [options.now=Date.now()]  Injectable for testing.
 * @param {string} [options.timeZone="America/Denver"]
 * @param {number} [options.idleTimeoutSeconds=900]
 * @param {number} [options.weekDays=7]      Length of the trailing window.
 * @param {number} [options.topN=5]          Rows per leaderboard.
 * @param {number} [options.heatmapDays=182]
 * @param {(hb: object) => boolean} [options.filter]
 * @returns {object} See the return literal at the bottom of this function.
 */
export function buildSummary(heartbeats, options = {}) {
  const nowMs = options.now === undefined ? Date.now() : toEpochMs(options.now);
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const idleTimeoutSeconds = options.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
  const weekDays = options.weekDays ?? DEFAULT_WEEK_DAYS;
  const topN = options.topN ?? DEFAULT_TOP_N;
  const heatmapDays = options.heatmapDays ?? DEFAULT_HEATMAP_DAYS;
  const shared = { timeZone, idleTimeoutSeconds, configs: options.configs ?? CONFIG_REGISTRY };

  const points = decorate(options.filter ? heartbeats.filter(options.filter) : heartbeats, timeZone);

  const todayKey = dayKey(nowMs, timeZone);
  const weekStartKey = addDays(todayKey, -(weekDays - 1));

  // ---- one unranged pass: daily series, sessions, all-time -------------------
  // Unranged means sessions are whole and head credits are never duplicated at a
  // boundary, so this is the authoritative view. Everything below either reads off
  // it or re-runs the algorithm over an explicit range.
  const all = computeDurations(points, {
    ...shared,
    groupBy: ["day", "language", "project", "hourLocal", "editor", "dayProject"],
  });

  const dailyMs = all.groups.day ?? {};
  const activeDays = Object.keys(dailyMs).sort();

  // ---- ranged passes ---------------------------------------------------------
  // Leaderboards need a JOINT grouping (this project, in this window), and
  // computeDurations only returns marginals — so the window has to be a real range
  // query rather than a slice of the daily buckets above.
  const week = computeDurations(points, {
    ...shared,
    groupBy: ["project", "language", "file", "gitBranch", "editor", "day"],
    range: { start: startOfDayMs(weekStartKey, timeZone), end: nowMs + 1 },
  });

  const today = computeDurations(points, {
    ...shared,
    groupBy: ["project", "language", "file", "gitBranch"],
    range: { start: startOfDayMs(todayKey, timeZone), end: nowMs + 1 },
  });

  // ---- sessions --------------------------------------------------------------
  const sessions = all.sessions;
  const todaySessions = sessions.filter((s) => s.day === todayKey);
  const lastSession = sessions.length ? sessions[sessions.length - 1] : null;
  const lastBeatMs = lastSession ? lastSession.endMs : null;

  // "Current" is decided by the idle timeout, not by the calendar: a session that
  // started at 23:50 is still current at 00:10.
  const isLive = lastSession !== null && nowMs - lastSession.endMs <= idleTimeoutSeconds * 1000;

  let currentSession = null;
  if (isLive) {
    const inSession = computeDurations(points, {
      ...shared,
      groupBy: ["project", "language", "file"],
      range: { start: lastSession.startMs, end: nowMs + 1 },
    });
    currentSession = {
      startMs: lastSession.startMs,
      lastBeatMs: lastSession.endMs,
      // NOT `nowMs - startMs`. The algorithm credits the gap BETWEEN heartbeats, so
      // the tail of a live session is uncredited by design — inventing it here would
      // be exactly the "duration is an interpretation" mistake METHODOLOGY.md exists
      // to prevent. Surfaces show `msSinceLastBeat` instead, so the lag is visible
      // rather than papered over.
      durationMs: lastSession.durationMs,
      formatted: lastSession.formatted,
      heartbeatCount: lastSession.heartbeatCount,
      msSinceLastBeat: nowMs - lastSession.endMs,
      projects: rank(inSession.groups.project, inSession.totalMs).slice(0, topN),
      languages: rank(inSession.groups.language, inSession.totalMs).slice(0, topN),
      files: rank(inSession.groups.file, inSession.totalMs).slice(0, topN),
    };
  }

  // ---- streaks ---------------------------------------------------------------
  const activeSet = new Set(activeDays);
  // A streak survives a day that has not happened yet: at 09:00 with no heartbeats,
  // yesterday still anchors the count. Breaking it at midnight would make the number
  // flicker to 0 every morning.
  let cursor = activeSet.has(todayKey) ? todayKey : addDays(todayKey, -1);
  let currentStreak = 0;
  while (activeSet.has(cursor)) {
    currentStreak++;
    cursor = addDays(cursor, -1);
  }

  let longestStreak = 0;
  let run = 0;
  let prevDay = null;
  for (const d of activeDays) {
    run = prevDay !== null && addDays(prevDay, 1) === d ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
    prevDay = d;
  }

  // ---- series ----------------------------------------------------------------
  const seriesFor = (fromKey) =>
    daysBetween(fromKey, todayKey).map((day) => ({ day, ms: dailyMs[day] ?? 0 }));

  const weekSeries = seriesFor(weekStartKey);
  const heatmap = seriesFor(addDays(todayKey, -(heatmapDays - 1)));

  // ---- stacked trend ---------------------------------------------------------
  // Which projects get their own band is decided ONCE, over the whole trend window,
  // so a band keeps its identity (and therefore its colour) from day to day. Ranking
  // per-day would repaint the chart every column.
  const trendDays = options.trendDays ?? DEFAULT_TREND_DAYS;
  const stackSlots = options.stackSlots ?? DEFAULT_STACK_SLOTS;
  const trendDayKeys = daysBetween(addDays(todayKey, -(trendDays - 1)), todayKey);
  const trendDaySet = new Set(trendDayKeys);

  const trendProjectMs = Object.create(null);
  for (const [composite, ms] of Object.entries(all.groups.dayProject ?? {})) {
    const sep = composite.indexOf(SEP);
    if (!trendDaySet.has(composite.slice(0, sep))) continue;
    const project = composite.slice(sep + SEP.length);
    trendProjectMs[project] = (trendProjectMs[project] ?? 0) + ms;
  }

  const named = rank(trendProjectMs).slice(0, stackSlots).map((r) => r.key);
  const namedSet = new Set(named);
  const hasOther = Object.keys(trendProjectMs).some((p) => !namedSet.has(p));
  const stackKeys = hasOther ? [...named, "Other"] : named;

  const trendSeries = trendDayKeys.map((day) => {
    const values = Object.fromEntries(stackKeys.map((k) => [k, 0]));
    for (const p of Object.keys(trendProjectMs)) {
      const ms = all.groups.dayProject?.[`${day}${SEP}${p}`] ?? 0;
      if (ms === 0) continue;
      const slot = namedSet.has(p) ? p : "Other";
      values[slot] += ms;
    }
    return { day, total: dailyMs[day] ?? 0, values };
  });

  const hourly = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    ms: all.groups.hourLocal?.[String(h).padStart(2, "0")] ?? 0,
  }));

  // ---- data health -----------------------------------------------------------
  const regime = CONFIG_REGISTRY.find((c) => {
    const from = c.from === null ? -Infinity : Date.parse(c.from);
    const to = c.to === null ? Infinity : Date.parse(c.to);
    return nowMs >= from && nowMs < to;
  });

  const weekActiveDays = weekSeries.filter((d) => d.ms > 0).length;

  return {
    summaryVersion: SUMMARY_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    generatedAtMs: nowMs,
    timeZone,
    idleTimeoutSeconds,

    today: {
      day: todayKey,
      ms: dailyMs[todayKey] ?? 0,
      formatted: formatDuration(dailyMs[todayKey] ?? 0),
      sessionCount: todaySessions.length,
      longestSessionMs: todaySessions.reduce((a, s) => Math.max(a, s.durationMs), 0),
      sessions: todaySessions.map((s) => ({
        startMs: s.startMs,
        endMs: s.endMs,
        durationMs: s.durationMs,
        formatted: s.formatted,
        heartbeatCount: s.heartbeatCount,
      })),
      projects: rank(today.groups.project, today.totalMs).slice(0, topN),
      languages: rank(today.groups.language, today.totalMs).slice(0, topN),
    },

    week: {
      days: weekDays,
      startDay: weekStartKey,
      endDay: todayKey,
      ms: week.totalMs,
      formatted: formatDuration(week.totalMs),
      activeDays: weekActiveDays,
      averageMsPerActiveDay: weekActiveDays ? Math.round(week.totalMs / weekActiveDays) : 0,
      averageMsPerDay: Math.round(week.totalMs / weekDays),
      series: weekSeries,
      sessionCount: week.sessionCount,
      projects: rank(week.groups.project, week.totalMs).slice(0, topN),
      languages: rank(week.groups.language, week.totalMs).slice(0, topN),
      files: rank(week.groups.file, week.totalMs).slice(0, topN),
      branches: rank(week.groups.gitBranch, week.totalMs).slice(0, topN),
      editors: rank(week.groups.editor, week.totalMs),
    },

    currentSession,

    streak: {
      current: currentStreak,
      longest: longestStreak,
      lastActiveDay: activeDays.length ? activeDays[activeDays.length - 1] : null,
    },

    /** Daily totals split by project, for a stacked chart. Bands keep their identity. */
    trend: {
      days: trendDays,
      keys: stackKeys,
      series: trendSeries,
    },

    heatmap,
    hourly,

    allTime: {
      ms: all.totalMs,
      formatted: all.formatted,
      activeDays: activeDays.length,
      firstDay: activeDays[0] ?? null,
      sessionCount: all.sessionCount,
      averageMsPerActiveDay: activeDays.length ? Math.round(all.totalMs / activeDays.length) : 0,
      projects: rank(all.groups.project, all.totalMs).slice(0, topN),
      languages: rank(all.groups.language, all.totalMs).slice(0, topN),
    },

    /**
     * Everything needed to judge whether the numbers above can be trusted.
     * `unstamped` and `inexact` are expected to be zero — see METHODOLOGY.md.
     */
    data: {
      heartbeats: all.countedHeartbeats,
      lastBeatMs,
      msSinceLastBeat: lastBeatMs === null ? null : nowMs - lastBeatMs,
      unstampedHeartbeats: all.unstampedHeartbeats,
      inexactIntervalHeartbeats: all.inexactIntervalHeartbeats,
      configVersionInForce: regime?.version ?? null,
      intervalSecondsInForce: regime?.intervalSeconds ?? null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Display helpers                                                             */
/* -------------------------------------------------------------------------- */

/** `3h12m` — compact form for a status bar, where every character costs space. */
export function formatCompact(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h === 0 && m === 0) return `${total}s`;
  if (h === 0) return `${m}m`;
  return `${h}h${String(m).padStart(2, "0")}m`;
}

/** `4m ago` / `just now` — freshness, so a stalled tracker is visible at a glance. */
export function formatAgo(ms) {
  if (ms === null || ms === undefined) return "never";
  const s = Math.round(ms / 1000);
  if (s < 45) return "just now";
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export { formatDuration };

/**
 * The caveat that belongs under every number this module produces.
 * METHODOLOGY.md argues at length that a low number is not a lazy week; a glanceable
 * widget is exactly where that gets forgotten.
 */
export const FOOTER =
  "Editor activity, not work. Reading, thinking past 15m, and everything outside VS Code count as zero.";
