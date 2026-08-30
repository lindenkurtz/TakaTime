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
 * HUMAN AND AI TIME
 * ---------------------------------------------------------------------------
 * Heartbeats now arrive from two kinds of tracker: editors, and coding agents. The
 * split is derived HERE, at read time, from the `editor` field — there is no `agent`
 * field in the database and no migration invented one. Two things follow:
 *
 *   - Top-level totals are the UNION of human and agent activity, not the editor's
 *     alone. `split` carries the decomposition on every window.
 *   - Human and agent time OVERLAP and must never be added. `split.overlapMs` is the
 *     intersection; `humanOnlyMs + overlapMs + aiOnlyMs === unionMs` exactly.
 *
 * The three bands are a GROUPING DIMENSION over the merged stream, not arithmetic on
 * two separate totals. That distinction is load-bearing. Defining the overlap as
 * `human + ai - union` looks equivalent and is not: when the two streams interleave
 * sparsely rather than co-occurring, merging them closes a gap neither stream can see
 * alone, the union exceeds the sum, and the "overlap" goes negative. Deriving the
 * bands from one pass instead makes the partition exact by construction — it is the
 * same additivity invariant every other dimension has — and it is what lets the split
 * be broken down per day and per project without the error compounding.
 *
 * ECHO SUPPRESSION. When an agent writes a file that is open in VS Code, the editor
 * fires `onDidChangeTextDocument` and logs a heartbeat — the editor cannot tell who
 * made the edit. Those heartbeats are DUPLICATE OBSERVATIONS of work the agent's own
 * heartbeats already cover, and counting them inflated human time by 9.4% over the
 * measured corpus. They are dropped from attribution entirely rather than reassigned,
 * because reassigning them would double-count against the agent stream.
 *
 * Echo suppression needs `options.aiWrites`; with none it is a no-op and every number
 * is what it was before agents existed. That is deliberate — a machine that has not
 * run the importer under-reports rather than reporting something invented.
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
  resolveInterval,
  toEpochMs,
} from "./duration.mjs";

/**
 * Bump when the SHAPE of the summary changes, so surfaces can detect a mismatch.
 *
 * 2.0.0 is a MEANING change as well as a shape change: top-level totals became the
 * union of human and agent activity, where before they were editor activity alone.
 * A number from 1.x is not comparable with a number from 2.x on the same data.
 */
export const SUMMARY_VERSION = "2.0.0";

/**
 * `editor` values written by coding agents rather than by a human at a keyboard.
 * The `agent` dimension is derived from this set; nothing is stored.
 */
export const AI_EDITORS = new Set(["ClaudeCode"]);

/**
 * How long after an agent writes a file the editor's echo of that write can arrive.
 *
 * VS Code relays an external write to an open document within a second or two, but
 * the heartbeat is throttled, so the observation can surface later. 20s is wide
 * enough to catch the relay and far narrower than the 120s throttle, so it cannot
 * swallow a genuine edit made a minute after the agent finished.
 */
export const ECHO_WINDOW_MS = 20_000;

/**
 * Tolerance for a heartbeat that lands just BEFORE the write it echoes. The agent
 * records the instant it issued the edit; the editor may observe the buffer change a
 * moment sooner, and clocks within one process tree are not perfectly ordered.
 */
export const ECHO_LEAD_MS = 2_000;

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

/** True when this heartbeat came from a coding agent rather than a human's editor. */
export function agentOf(heartbeat) {
  return AI_EDITORS.has(heartbeat.editor) ? "ai" : "human";
}

/**
 * Index agent file-writes by path for echo lookup.
 *
 * A Map of path -> ascending write instants. Built once per `buildSummary` call and
 * probed by binary search, so the join stays O(n log n) rather than the O(n·m) a
 * naive scan over a few thousand heartbeats and a few hundred writes would cost.
 */
function echoIndex(aiWrites) {
  const byFile = new Map();
  for (const w of aiWrites ?? []) {
    if (!w?.file) continue;
    let ms;
    try {
      ms = toEpochMs(w.timestamp);
    } catch {
      continue;
    }
    let arr = byFile.get(w.file);
    if (!arr) byFile.set(w.file, (arr = []));
    arr.push(ms);
  }
  for (const arr of byFile.values()) arr.sort((a, b) => a - b);
  return byFile;
}

/** Did an agent write `file` close enough to `t` for this heartbeat to be its echo? */
function isEcho(index, file, t) {
  const writes = index.get(file);
  if (!writes) return false;
  // Any write in [t - ECHO_WINDOW_MS, t + ECHO_LEAD_MS] explains this heartbeat.
  const lo = t - ECHO_WINDOW_MS;
  const hi = t + ECHO_LEAD_MS;
  let a = 0;
  let b = writes.length - 1;
  while (a <= b) {
    const mid = (a + b) >> 1;
    if (writes[mid] < lo) a = mid + 1;
    else if (writes[mid] > hi) b = mid - 1;
    else return true;
  }
  return false;
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
function decorate(heartbeats, timeZone, index) {
  return heartbeats.map((hb) => {
    const t = toEpochMs(hb.timestamp);
    const agent = agentOf(hb);
    return {
      ...hb,
      agent,
      // Only a human editor can echo an agent: the agent's own heartbeats are the
      // original observation, not a relay of it.
      echo: agent === "human" && isEcho(index, hb.name, t),
      hourLocal: String(hourOf(t, timeZone)).padStart(2, "0"),
      // A JOINT key. computeDurations only ever returns marginals, so "how much of
      // Tuesday was project X" has to be asked for as its own dimension. One extra
      // grouping on the existing pass is far cheaper than one ranged pass per day.
      dayProject: `${dayKey(t, timeZone)}${SEP}${hb.project ?? "unknown"}`,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* The human / agent split                                                     */
/* -------------------------------------------------------------------------- */

/** The three disjoint bands. Order is stacking order, quietest activity first. */
export const MODES = ["human-only", "concurrent", "ai-only"];

/**
 * Tag each heartbeat with which of the three bands its contribution belongs to.
 *
 * A heartbeat is `concurrent` when the OTHER stream also observed something within
 * the throttle interval in force at that instant — the finest resolution at which
 * either stream can see anything, so a narrower window would report concurrency that
 * the data cannot resolve and a wider one would invent it. The interval is resolved
 * per heartbeat rather than fixed, so the v2 era (300s) is judged at its own
 * resolution instead of v3's.
 *
 * Attribution follows the same rule as every other dimension: the band is read off
 * the EARLIER heartbeat of each pair, the one the contribution is credited to. That
 * is what makes the bands sum to the total exactly.
 *
 * Mutates the points in place — they are already private copies made by `decorate`.
 */
function tagConcurrency(points, configs) {
  const byAgent = { human: [], ai: [] };
  for (const p of points) byAgent[p.agent].push(toEpochMs(p.timestamp));
  byAgent.human.sort((a, b) => a - b);
  byAgent.ai.sort((a, b) => a - b);

  const nearest = (sorted, t) => {
    let lo = 0;
    let hi = sorted.length - 1;
    let best = Infinity;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const d = Math.abs(sorted[mid] - t);
      if (d < best) best = d;
      if (sorted[mid] < t) lo = mid + 1;
      else hi = mid - 1;
    }
    return best;
  };

  for (const p of points) {
    const t = toEpochMs(p.timestamp);
    const other = p.agent === "human" ? byAgent.ai : byAgent.human;
    const windowMs = resolveInterval(p, configs).intervalSeconds * 1000;
    p.mode = nearest(other, t) <= windowMs ? "concurrent" : `${p.agent}-only`;
  }
  return points;
}

/** Read the three bands off a completed pass's `mode` grouping. */
function splitOf(result) {
  const g = result.groups.mode ?? {};
  const humanOnlyMs = g["human-only"] ?? 0;
  const overlapMs = g.concurrent ?? 0;
  const aiOnlyMs = g["ai-only"] ?? 0;
  const unionMs = result.totalMs;

  // Derived from the bands rather than measured separately, so they always reconcile:
  // a human was at the keyboard during human-only AND concurrent time, and an agent
  // was working during ai-only AND concurrent time.
  const humanMs = humanOnlyMs + overlapMs;
  const aiMs = aiOnlyMs + overlapMs;

  return {
    humanMs,
    humanFormatted: formatDuration(humanMs),
    aiMs,
    aiFormatted: formatDuration(aiMs),
    /** Time both were active. Counted in `humanMs` AND `aiMs`; never add those two. */
    overlapMs,
    overlapFormatted: formatDuration(overlapMs),
    /** These three partition `unionMs` exactly, in integer milliseconds. */
    humanOnlyMs,
    aiOnlyMs,
    unionMs,
    unionFormatted: formatDuration(unionMs),
    /** Agent share of the union, 0..1. The headline "how much of this was the model". */
    aiShare: unionMs === 0 ? 0 : aiMs / unionMs,
  };
}

/**
 * Split a joint `key␟mode` grouping into per-key bands.
 * Used for both the per-project table and the daily trend.
 */
function bandsByKey(joint) {
  const out = new Map();
  for (const [composite, ms] of Object.entries(joint ?? {})) {
    const i = composite.indexOf(SEP);
    const key = composite.slice(0, i);
    const mode = composite.slice(i + SEP.length);
    let row = out.get(key);
    if (!row) out.set(key, (row = { humanOnlyMs: 0, overlapMs: 0, aiOnlyMs: 0 }));
    if (mode === "concurrent") row.overlapMs += ms;
    else if (mode === "ai-only") row.aiOnlyMs += ms;
    else row.humanOnlyMs += ms;
  }
  return out;
}

/** Per-project human/agent breakdown, ranked by combined time. */
function projectSplit(joint, topN) {
  return [...bandsByKey(joint)]
    .map(([key, b]) => {
      const totalMs = b.humanOnlyMs + b.overlapMs + b.aiOnlyMs;
      const humanMs = b.humanOnlyMs + b.overlapMs;
      const aiMs = b.aiOnlyMs + b.overlapMs;
      return {
        key,
        ...b,
        humanMs,
        aiMs,
        totalMs,
        humanFormatted: formatDuration(humanMs),
        aiFormatted: formatDuration(aiMs),
        aiShare: totalMs === 0 ? 0 : aiMs / totalMs,
      };
    })
    .sort((a, b) => b.totalMs - a.totalMs || a.key.localeCompare(b.key))
    .slice(0, topN);
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
 * @param {Array<{timestamp: *, file: string}>} [options.aiWrites]  Instants at which
 *   a coding agent modified a file, from the `aiWrites` collection. Used only to
 *   suppress echo heartbeats; omitting it leaves every editor heartbeat in place.
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

  const index = echoIndex(options.aiWrites);
  const decorated = decorate(options.filter ? heartbeats.filter(options.filter) : heartbeats, timeZone, index);

  // Echo heartbeats never reach the algorithm. They are the editor's relay of an
  // agent's write, so the agent's own heartbeats already account for that time;
  // keeping them would credit the same work twice and file it under the wrong agent.
  const points = tagConcurrency(
    decorated.filter((hb) => !hb.echo),
    shared.configs,
  );
  const echoHeartbeats = decorated.length - points.length;

  // Joint keys. computeDurations only returns marginals, so "how much of Tuesday was
  // the agent" and "how much of this project was" each have to be asked for as their
  // own dimension — one extra grouping on a pass that is happening anyway.
  for (const p of points) {
    p.dayMode = `${dayKey(toEpochMs(p.timestamp), timeZone)}${SEP}${p.mode}`;
    p.projectMode = `${p.project ?? "unknown"}${SEP}${p.mode}`;
  }

  const todayKey = dayKey(nowMs, timeZone);
  const weekStartKey = addDays(todayKey, -(weekDays - 1));

  // ---- one unranged pass: daily series, sessions, all-time -------------------
  // Unranged means sessions are whole and head credits are never duplicated at a
  // boundary, so this is the authoritative view. Everything below either reads off
  // it or re-runs the algorithm over an explicit range.
  const all = computeDurations(points, {
    ...shared,
    groupBy: [
      "day",
      "language",
      "project",
      "hourLocal",
      "editor",
      "agent",
      "mode",
      "dayProject",
      "dayMode",
      "projectMode",
    ],
  });

  // What suppression actually cost, as a number rather than a claim.
  //
  // Measured against the HUMAN stream, not the union. Against the union it is nearly
  // zero by construction — the agent's own heartbeats already cover that span, which
  // is the whole reason the echoes are redundant — and quoting that number would make
  // a correction worth hours look like it was worth seconds. What echo suppression
  // actually moves is how much of that span is attributed to a person.
  const allSplit = splitOf(all);

  // Measured through the SAME derivation as the human total it is a correction to.
  // Re-tagged on fresh copies rather than reusing `points`, because concurrency is a
  // property of the stream: leaving the echoes in changes which agent heartbeats look
  // concurrent, and tagging in place would corrupt the real pass.
  const echoRemovedMs = echoHeartbeats
    ? splitOf(
        computeDurations(
          tagConcurrency(
            decorated.map((hb) => ({ ...hb })),
            shared.configs,
          ),
          { ...shared, groupBy: ["mode"] },
        ),
      ).humanMs - allSplit.humanMs
    : 0;

  const dailyMs = all.groups.day ?? {};
  const activeDays = Object.keys(dailyMs).sort();

  // ---- ranged passes ---------------------------------------------------------
  // Leaderboards need a JOINT grouping (this project, in this window), and
  // computeDurations only returns marginals — so the window has to be a real range
  // query rather than a slice of the daily buckets above.
  const weekRange = { start: startOfDayMs(weekStartKey, timeZone), end: nowMs + 1 };
  const todayRange = { start: startOfDayMs(todayKey, timeZone), end: nowMs + 1 };

  const week = computeDurations(points, {
    ...shared,
    groupBy: ["project", "language", "file", "gitBranch", "editor", "agent", "mode", "day", "projectMode"],
    range: weekRange,
  });

  const today = computeDurations(points, {
    ...shared,
    groupBy: ["project", "language", "file", "gitBranch", "agent", "mode"],
    range: todayRange,
  });

  // ---- human / agent splits --------------------------------------------------
  // Read straight off the `mode` grouping of the passes above. No extra passes and
  // no arithmetic between separate totals — see the header for why that matters.
  const weekSplit = splitOf(week);
  const todaySplit = splitOf(today);

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

  // ---- the daily human / AI mix ----------------------------------------------
  // The question the split cannot answer on its own: is this changing? Read off the
  // same joint day-by-mode grouping as everything else, so each column adds to that
  // day's total exactly and the chart can be stacked without a reconciliation step.
  const agentBands = bandsByKey(all.groups.dayMode);
  const agentTrendSeries = trendDayKeys.map((day) => {
    const b = agentBands.get(day) ?? { humanOnlyMs: 0, overlapMs: 0, aiOnlyMs: 0 };
    const total = dailyMs[day] ?? 0;
    const aiMs = b.aiOnlyMs + b.overlapMs;
    return {
      day,
      total,
      values: { "human-only": b.humanOnlyMs, concurrent: b.overlapMs, "ai-only": b.aiOnlyMs },
      /** Agent share OF THAT DAY. Null on a day with no activity — a day you did not
       *  code has no mix, and plotting it as 0% would draw a trend that is not there. */
      aiShare: total === 0 ? null : aiMs / total,
    };
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
      split: todaySplit,
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
      split: weekSplit,
      /** Per-project human vs agent time. The "what am I spending time on" table. */
      projectSplit: projectSplit(week.groups.projectMode, topN),
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

    /**
     * The same days split by human/agent instead of by project. Three fixed bands, so
     * unlike `trend` there is no identity to preserve and no "Other" slot.
     */
    agentTrend: {
      days: trendDays,
      keys: MODES,
      series: agentTrendSeries,
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
      split: allSplit,
      projectSplit: projectSplit(all.groups.projectMode, topN),
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

      /**
       * Editor heartbeats dropped as an agent's echo, and how much HUMAN time that
       * removed. Both zero on a machine with no agent write records — which means
       * unsuppressed echo, not absent echo. See the header.
       */
      echoHeartbeats,
      echoRemovedMs,
      echoRemovedFormatted: formatDuration(echoRemovedMs),
      /** Write observations available for the join; zero means suppression was off. */
      aiWrites: (options.aiWrites ?? []).length,
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
  "Tracked tool activity, not work. Reading, thinking past 15m, and everything outside " +
  "an editor or agent count as zero. Human and AI totals overlap — never add them.";
