/**
 * TakaTime — canonical duration algorithm.
 *
 * PURE. ZERO-DEPENDENCY. ESM. No database, no VS Code, no Node built-ins.
 * This file is copied verbatim into consuming repos (e.g. the personal website).
 * Do not add imports to it. Do not fork it — change it here and re-copy.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * A heartbeat is an OBSERVATION ("this file was being edited at this instant"),
 * not a duration. Pre-v3 heartbeats carry a `duration` field, but it is just the
 * tracker's throttle interval frozen at write time — an interpretation baked into
 * the raw log. The throttle changed on 2026-04-23, so summing `duration` mixes two
 * incompatible regimes and is WRONG. See METHODOLOGY.md.
 *
 * This module derives durations at QUERY time from timestamps, so historical data
 * stays valid across future config changes.
 *
 * ---------------------------------------------------------------------------
 * THE ALGORITHM
 * ---------------------------------------------------------------------------
 * Given heartbeats sorted ascending by timestamp:
 *
 *   1. Start a new session whenever gap(prev, current) > IDLE_TIMEOUT.
 *   2. For each consecutive pair inside a session, credit gap(prev, current) to
 *      the language / project / branch / file of the EARLIER heartbeat.
 *   3. Credit the first heartbeat of each session with intervalSeconds resolved
 *      from its own configVersion. The throttle had been running for up to one
 *      interval before it fired, so this recovers the head of the session.
 *
 *   session duration = span(first, last) + intervalSeconds(first)
 *   single-heartbeat session duration = intervalSeconds(first)
 *
 * The head-credit term is what makes this config-invariant: when the throttle
 * shortens, the first heartbeat of a session arrives earlier (span grows) while
 * the credit shrinks by roughly the same amount.
 *
 * ---------------------------------------------------------------------------
 * UNITS
 * ---------------------------------------------------------------------------
 * Every duration this module RETURNS is an integer count of MILLISECONDS.
 * Every duration this module ACCEPTS as an option is in SECONDS (matching how
 * the parameters are discussed in METHODOLOGY.md).
 *
 * Integer milliseconds are what make the additivity invariant exact rather than
 * approximate: summing any grouping dimension reproduces `totalMs` bit-for-bit,
 * with no floating-point drift. Use `formatDuration()` / `toSeconds()` for display.
 */

/**
 * Bump on any change to attribution or accounting that would move numbers.
 * Consumers should record this next to any derived stat they persist.
 */
export const ALGORITHM_VERSION = "1.0.0";

/** A gap longer than this ends the session. 15 minutes. */
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 900;

/**
 * Daily buckets are cut at midnight in THIS zone, not UTC and not the viewer's
 * local zone. See METHODOLOGY.md — the stored `date` field is unreliable
 * (it was written in whatever zone the machine happened to be in) and is ignored.
 */
export const DEFAULT_TIME_ZONE = "America/Denver";

/**
 * Tracker config regimes. This array is the SOURCE OF TRUTH — the `configs`
 * collection in MongoDB is populated from it by scripts/migrate-config-version.mjs,
 * never the other way round.
 *
 * `from` is inclusive, `to` is exclusive, both full ISO-8601 instants. Date-only
 * boundaries are not good enough: the v1 -> v2 cutover happened mid-afternoon.
 *
 * Boundaries are EMPIRICAL — read off the data, not off the git log. Commits landed
 * on 2026-04-21 but the rebuilt binary was not actually installed until 2026-04-23,
 * and the heartbeats are what describe the heartbeats.
 */
export const CONFIG_REGISTRY = [
  {
    version: 1,
    intervalSeconds: 120,
    scope: "per-file",
    from: "2026-04-03T00:00:00.000Z",
    to: "2026-04-23T20:57:09.808Z",
  },
  {
    version: 2,
    intervalSeconds: 300,
    scope: "global",
    from: "2026-04-23T20:57:09.808Z",
    to: "2026-08-08T20:36:00.000Z",
  },
  {
    version: 3,
    intervalSeconds: 120,
    scope: "global",
    from: "2026-08-08T20:36:00.000Z",
    to: null,
  },
];

/** Dimensions grouped by default. `day` is bucketed in `timeZone`. */
export const DEFAULT_GROUP_BY = ["language", "project", "gitBranch", "file", "day"];

/** Heartbeat field backing each grouping dimension. `day` is computed. */
const DIMENSION_FIELDS = {
  language: "language",
  project: "project",
  gitBranch: "gitBranch",
  file: "name",
  editor: "editor",
  os: "os",
  configVersion: "configVersion",
};

const UNKNOWN = "unknown";

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Coerce a heartbeat timestamp to epoch milliseconds.
 * Accepts a Date (what the MongoDB driver hands back), an ISO string, or a number.
 */
export function toEpochMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  throw new TypeError(`Cannot interpret ${JSON.stringify(value)} as a timestamp`);
}

/**
 * Resolve the throttle interval (in seconds) that was in force for a heartbeat.
 *
 * Preferred path: the heartbeat's own `configVersion`, stamped at write time.
 *
 * DOCUMENTED FALLBACK: heartbeats with no `configVersion` resolve by matching their
 * timestamp against the config registry. That is a GUESS, not a fact — it assumes the
 * writing tracker followed the regime timeline recorded here.
 *
 * All current data is stamped, so nothing relies on this today. It stays supported
 * because `-configVersion` is optional on the writer: callers spawn it
 * fire-and-forget with stdio discarded, so estimating a heartbeat beats losing it.
 *
 * Never throws; if nothing matches, the nearest regime by time is used. Inspect
 * `.exact` and `.reason` to see which path was taken.
 */
export function resolveInterval(heartbeat, configs = CONFIG_REGISTRY) {
  const declared = heartbeat.configVersion;
  if (declared !== undefined && declared !== null) {
    const hit = configs.find((c) => c.version === declared);
    if (hit) {
      return { intervalSeconds: hit.intervalSeconds, version: hit.version, exact: true, reason: "configVersion" };
    }
    // Stamped with a version we do not know about. Fall through to date resolution
    // rather than throwing — an unreadable heartbeat is worse than an estimated one.
  }

  const ms = toEpochMs(heartbeat.timestamp);
  for (const c of configs) {
    const from = c.from === null ? -Infinity : Date.parse(c.from);
    const to = c.to === null ? Infinity : Date.parse(c.to);
    if (ms >= from && ms < to) {
      return {
        intervalSeconds: c.intervalSeconds,
        version: c.version,
        exact: false,
        reason: declared === undefined || declared === null ? "date-fallback" : "unknown-version-date-fallback",
      };
    }
  }

  // Outside every declared window (a heartbeat older than the registry). Clamp to
  // whichever regime is closest in time so the caller still gets a number.
  let best = configs[0];
  let bestDistance = Infinity;
  for (const c of configs) {
    const from = c.from === null ? -Infinity : Date.parse(c.from);
    const to = c.to === null ? Infinity : Date.parse(c.to);
    const distance = ms < from ? from - ms : ms - to;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = c;
    }
  }
  return { intervalSeconds: best.intervalSeconds, version: best.version, exact: false, reason: "out-of-range-clamp" };
}

const dayFormatterCache = new Map();

/** `YYYY-MM-DD` for an instant, in an explicit IANA time zone. */
export function dayKey(epochMs, timeZone = DEFAULT_TIME_ZONE) {
  let fmt = dayFormatterCache.get(timeZone);
  if (!fmt) {
    // en-CA renders as YYYY-MM-DD, which sorts lexicographically.
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFormatterCache.set(timeZone, fmt);
  }
  return fmt.format(new Date(epochMs));
}

/** Integer milliseconds -> fractional seconds. Display only. */
export function toSeconds(ms) {
  return ms / 1000;
}

/** Integer milliseconds -> `4h45m00s`. Display only. */
export function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  const sign = total < 0 ? "-" : "";
  const s = Math.abs(total);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${sign}${h}h${String(m).padStart(2, "0")}m${String(sec).padStart(2, "0")}s`;
}

/**
 * Earliest instant a range query must FETCH from, so that a session straddling
 * `rangeStart` is recognised instead of being split into a spurious new session.
 *
 * Build your database query with this, not with the range start:
 *
 *   const from = lookbackStart("2026-08-02T00:00:00-06:00");
 *   db.collection("logs").find({ timestamp: { $gte: new Date(from), $lt: rangeEnd } })
 */
export function lookbackStart(rangeStart, options = {}) {
  const idle = options.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
  const lookback = options.lookbackSeconds ?? idle;
  return toEpochMs(rangeStart) - lookback * 1000;
}

/* -------------------------------------------------------------------------- */
/* The algorithm                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Compute durations from raw heartbeats.
 *
 * @param {Array<object>} heartbeats  Raw log documents. Sorted internally, so the
 *   caller's order does not matter. Not mutated.
 * @param {object} [options]
 * @param {number} [options.idleTimeoutSeconds=900]
 * @param {string} [options.timeZone="America/Denver"]  Zone for daily bucketing.
 * @param {Array}  [options.configs=CONFIG_REGISTRY]
 * @param {string[]} [options.groupBy]  Any of: language, project, gitBranch, file,
 *   editor, os, configVersion, day.
 * @param {{start: *, end: *}} [options.range]  Range mode. `start` inclusive,
 *   `end` exclusive. Heartbeats before `start` are used as session CONTEXT but
 *   their contributions are clipped out of the totals.
 * @param {number} [options.lookbackSeconds]  Defaults to idleTimeoutSeconds.
 * @param {(hb: object) => boolean} [options.filter]  Applied before anything else,
 *   e.g. `hb => hb.editor === "VsCode"`.
 *
 * @returns {object} Totals in integer milliseconds. See `groups`, `totalMs`.
 */
export function computeDurations(heartbeats, options = {}) {
  const idleTimeoutSeconds = options.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS;
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const configs = options.configs ?? CONFIG_REGISTRY;
  const groupBy = options.groupBy ?? DEFAULT_GROUP_BY;
  const idleMs = idleTimeoutSeconds * 1000;

  const rangeStartMs = options.range ? toEpochMs(options.range.start) : -Infinity;
  const rangeEndMs = options.range ? toEpochMs(options.range.end) : Infinity;
  const lookbackSeconds = options.lookbackSeconds ?? idleTimeoutSeconds;
  const fetchFromMs = options.range ? rangeStartMs - lookbackSeconds * 1000 : -Infinity;

  // ---- normalise -----------------------------------------------------------
  let points = [];
  for (const hb of heartbeats) {
    if (options.filter && !options.filter(hb)) continue;
    const t = toEpochMs(hb.timestamp);
    if (t < fetchFromMs || t >= rangeEndMs) continue;
    points.push({ t, hb });
  }
  points.sort((a, b) => a.t - b.t);

  // ---- accumulate ----------------------------------------------------------
  const groups = {};
  for (const dim of groupBy) groups[dim] = Object.create(null);

  let totalMs = 0;
  let countedHeartbeats = 0;
  let contextHeartbeats = 0;
  let inexactIntervalHeartbeats = 0;
  let unstampedHeartbeats = 0;
  const sessions = [];
  let current = null;

  const credit = (point, ms) => {
    // Clipping is BY ATTRIBUTION POINT, not by time overlap: a contribution
    // belongs wholly to the heartbeat it is credited to. This is the same rule
    // that puts a gap in the day of its earlier heartbeat, so daily buckets sum
    // exactly to range totals.
    if (point.t < rangeStartMs) return;
    totalMs += ms;
    for (const dim of groupBy) {
      const key =
        dim === "day"
          ? dayKey(point.t, timeZone)
          : String(point.hb[DIMENSION_FIELDS[dim] ?? dim] ?? UNKNOWN);
      groups[dim][key] = (groups[dim][key] ?? 0) + ms;
    }
  };

  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    const prev = i > 0 ? points[i - 1] : null;
    const isHead = prev === null || point.t - prev.t > idleMs;

    if (point.t >= rangeStartMs) {
      countedHeartbeats++;
      if (point.hb.configVersion === undefined || point.hb.configVersion === null) unstampedHeartbeats++;
    } else {
      contextHeartbeats++;
    }

    if (isHead) {
      if (current) sessions.push(finishSession(current, timeZone));
      const resolved = resolveInterval(point.hb, configs);
      if (!resolved.exact) inexactIntervalHeartbeats++;
      const headCreditMs = resolved.intervalSeconds * 1000;
      current = {
        startMs: point.t,
        endMs: point.t,
        headCreditMs,
        headConfigVersion: resolved.version,
        headIntervalExact: resolved.exact,
        heartbeatCount: 0,
        clipped: point.t < rangeStartMs,
      };
      credit(point, headCreditMs);
    }

    current.endMs = point.t;
    current.heartbeatCount++;

    // Credit the gap to THIS heartbeat (the earlier of the pair).
    const next = i + 1 < points.length ? points[i + 1] : null;
    if (next) {
      const gap = next.t - point.t;
      if (gap <= idleMs) credit(point, gap);
    }
  }
  if (current) sessions.push(finishSession(current, timeZone));

  return {
    algorithmVersion: ALGORITHM_VERSION,
    idleTimeoutSeconds,
    timeZone,
    range: options.range ? { startMs: rangeStartMs, endMs: rangeEndMs, lookbackSeconds } : null,

    /** Integer milliseconds. Every group in `groups` sums to exactly this. */
    totalMs,
    totalSeconds: toSeconds(totalMs),
    formatted: formatDuration(totalMs),

    /** `{ language: { js: ms, ... }, day: { "2026-08-07": ms, ... }, ... }` */
    groups,

    sessions,
    sessionCount: sessions.length,

    /** Heartbeats inside the range whose contributions were counted. */
    countedHeartbeats,
    /** Heartbeats pulled in only by the lookback buffer, to avoid splitting a session. */
    contextHeartbeats,
    /**
     * Counted heartbeats carrying no `configVersion`, attributed by the date
     * fallback. Expected to be zero — every tracker stamps at write time and all
     * historical data is backfilled. Non-zero means a tracker is misconfigured and
     * part of this result rests on an assumption. See METHODOLOGY.md.
     */
    unstampedHeartbeats,
    /**
     * The subset of the above that actually mattered: SESSION HEADS whose interval
     * had to be estimated. An unstamped heartbeat in the middle of a session costs
     * nothing, because only heads consume an interval — so this is usually much
     * smaller than `unstampedHeartbeats`, and it is the number that bounds the
     * error the fallback can introduce.
     */
    inexactIntervalHeartbeats,
  };
}

function finishSession(s, timeZone) {
  const spanMs = s.endMs - s.startMs;
  const durationMs = spanMs + s.headCreditMs;
  return {
    startMs: s.startMs,
    endMs: s.endMs,
    spanMs,
    headCreditMs: s.headCreditMs,
    headConfigVersion: s.headConfigVersion,
    headIntervalExact: s.headIntervalExact,
    durationMs,
    formatted: formatDuration(durationMs),
    heartbeatCount: s.heartbeatCount,
    day: dayKey(s.startMs, timeZone),
    /** True when the session began before the queried range (contributions clipped). */
    clipped: s.clipped,
  };
}

/* -------------------------------------------------------------------------- */
/* Convenience                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Sort a group map into ranked rows with percentage shares.
 * `[{ key, ms, seconds, formatted, share }]`, descending, share in 0..1.
 */
export function rank(groupMap, totalMs) {
  const total = totalMs ?? Object.values(groupMap).reduce((a, b) => a + b, 0);
  return Object.entries(groupMap)
    .map(([key, ms]) => ({
      key,
      ms,
      seconds: toSeconds(ms),
      formatted: formatDuration(ms),
      share: total === 0 ? 0 : ms / total,
    }))
    .sort((a, b) => b.ms - a.ms || a.key.localeCompare(b.key));
}
