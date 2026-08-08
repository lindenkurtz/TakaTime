import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALGORITHM_VERSION,
  CONFIG_REGISTRY,
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  computeDurations,
  dayKey,
  formatDuration,
  lookbackStart,
  rank,
  resolveInterval,
} from "../duration.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(path.join(HERE, "..", "fixtures", "calibration-2026-08.json"), "utf8"),
);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const S = 1000; // one second in ms
const pct = (actual, expected) => (actual / expected - 1) * 100;

/** Build a synthetic heartbeat. */
function hb(isoOrMs, extra = {}) {
  return {
    name: "/tmp/a.js",
    project: "proj",
    language: "javascript",
    gitBranch: "main",
    editor: "VsCode",
    os: "darwin",
    timestamp: typeof isoOrMs === "number" ? new Date(isoOrMs).toISOString() : isoOrMs,
    ...extra,
  };
}

/** Evenly spaced heartbeats across `spanSeconds`, one every `everySeconds`. */
function evenly(startIso, spanSeconds, everySeconds, extra = {}) {
  const t0 = Date.parse(startIso);
  const out = [];
  for (let s = 0; s <= spanSeconds; s += everySeconds) out.push(hb(t0 + s * S, extra));
  return out;
}

/* -------------------------------------------------------------------------- */
/* 1. Calibration against WakaTime ground truth                                */
/* -------------------------------------------------------------------------- */

test("calibration: 7-day total tracks WakaTime within 10%", () => {
  const truth = fixture.groundTruth.rangeTotalSeconds;

  const result = computeDurations(fixture.heartbeats, {
    range: fixture.range,
    timeZone: fixture.timeZone,
    // WakaTime never saw the Mathematica tracker, so comparing against it
    // requires restricting to the editor WakaTime actually observed.
    filter: (h) => fixture.groundTruth.coversEditors.includes(h.editor),
  });

  const actual = result.totalSeconds;
  const drift = pct(actual, truth);
  console.log(
    `    7-day total: ${formatDuration(result.totalMs)} vs WakaTime ${formatDuration(truth * S)}  (${drift.toFixed(2)}%)`,
  );

  assert.ok(
    Math.abs(drift) <= 10,
    `7-day total drifted ${drift.toFixed(2)}% from WakaTime ground truth (limit ±10%). ` +
      `Got ${formatDuration(result.totalMs)}, expected ~${formatDuration(truth * S)}.`,
  );
});

test("calibration: each ground-truth day lands within 20%", () => {
  const result = computeDurations(fixture.heartbeats, {
    range: fixture.range,
    timeZone: fixture.timeZone,
    filter: (h) => fixture.groundTruth.coversEditors.includes(h.editor),
  });

  for (const [day, truthSeconds] of Object.entries(fixture.groundTruth.daySeconds)) {
    const actualMs = result.groups.day[day] ?? 0;
    const drift = pct(actualMs / S, truthSeconds);
    console.log(
      `    ${day}: ${formatDuration(actualMs)} vs WakaTime ${formatDuration(truthSeconds * S)}  (${drift >= 0 ? "+" : ""}${drift.toFixed(1)}%)`,
    );
    assert.ok(
      Math.abs(drift) <= 20,
      `${day} drifted ${drift.toFixed(1)}% (limit ±20%). Got ${formatDuration(actualMs)}, expected ~${formatDuration(truthSeconds * S)}.`,
    );
  }
});

test("calibration: summing the legacy `duration` field undercounts badly", () => {
  // This is the whole reason the project exists. If this test ever starts passing
  // with a small drift, something has changed about what `duration` means.
  const inRange = fixture.heartbeats.filter((h) => {
    const t = Date.parse(h.timestamp);
    return (
      t >= Date.parse(fixture.range.start) &&
      t < Date.parse(fixture.range.end) &&
      fixture.groundTruth.coversEditors.includes(h.editor)
    );
  });

  const legacy = inRange.reduce((a, h) => a + (h.duration ?? 0), 0);
  const truth = fixture.groundTruth.rangeTotalSeconds;
  const drift = pct(legacy, truth);
  console.log(
    `    sum(duration): ${formatDuration(legacy * S)} vs WakaTime ${formatDuration(truth * S)}  (${drift.toFixed(1)}%)`,
  );

  assert.ok(legacy < truth, "legacy duration sum is expected to undercount");
  assert.ok(
    Math.abs(drift) > 10,
    `legacy duration sum drifted only ${drift.toFixed(1)}% — it is supposed to be materially wrong`,
  );
});

/* -------------------------------------------------------------------------- */
/* 2. The additivity invariant                                                 */
/* -------------------------------------------------------------------------- */

test("invariant: every grouping dimension sums to exactly the grand total", () => {
  const dims = ["language", "project", "gitBranch", "file", "editor", "os", "configVersion", "day"];
  const result = computeDurations(fixture.heartbeats, {
    range: fixture.range,
    timeZone: fixture.timeZone,
    groupBy: dims,
  });

  for (const dim of dims) {
    const sum = Object.values(result.groups[dim]).reduce((a, b) => a + b, 0);
    // Integer milliseconds — this is exact equality, not a tolerance.
    assert.equal(sum, result.totalMs, `group "${dim}" summed to ${sum}, expected ${result.totalMs}`);
  }
});

test("invariant: holds over the full fixture with no range, and over each single day", () => {
  const full = computeDurations(fixture.heartbeats, { groupBy: ["language", "project", "day"] });
  for (const dim of ["language", "project", "day"]) {
    const sum = Object.values(full.groups[dim]).reduce((a, b) => a + b, 0);
    assert.equal(sum, full.totalMs, `full-range group "${dim}" broke additivity`);
  }

  // Days partition the range: summing per-day range queries must reproduce the
  // per-day buckets of one whole-range query.
  const whole = computeDurations(fixture.heartbeats, { range: fixture.range, timeZone: fixture.timeZone });
  for (const [day, ms] of Object.entries(whole.groups.day)) {
    const single = computeDurations(fixture.heartbeats, {
      range: { start: `${day}T00:00:00-06:00`, end: `${day}T24:00:00-06:00` },
      timeZone: fixture.timeZone,
    });
    assert.equal(single.totalMs, ms, `day ${day} disagreed between whole-range and single-day queries`);
  }
});

test("invariant: sessions sum to the grand total when nothing is clipped", () => {
  const result = computeDurations(fixture.heartbeats);
  const sum = result.sessions.reduce((a, s) => a + s.durationMs, 0);
  assert.equal(sum, result.totalMs);
});

/* -------------------------------------------------------------------------- */
/* 3. Session semantics                                                        */
/* -------------------------------------------------------------------------- */

test("a single-heartbeat session is worth exactly one interval", () => {
  const r = computeDurations([hb("2026-05-01T10:00:00Z", { configVersion: 2 })]);
  assert.equal(r.sessionCount, 1);
  assert.equal(r.totalMs, 300 * S);
});

test("session duration = span + interval of the first heartbeat", () => {
  const hbs = evenly("2026-05-01T10:00:00Z", 1200, 300, { configVersion: 2 });
  const r = computeDurations(hbs);
  assert.equal(r.sessionCount, 1);
  assert.equal(r.sessions[0].spanMs, 1200 * S);
  assert.equal(r.sessions[0].headCreditMs, 300 * S);
  assert.equal(r.totalMs, (1200 + 300) * S);
});

test("a gap longer than IDLE_TIMEOUT starts a new session; a gap equal to it does not", () => {
  const t0 = Date.parse("2026-05-01T10:00:00Z");
  const idle = DEFAULT_IDLE_TIMEOUT_SECONDS;

  const exactly = computeDurations([
    hb(t0, { configVersion: 2 }),
    hb(t0 + idle * S, { configVersion: 2 }),
  ]);
  assert.equal(exactly.sessionCount, 1, "a gap of exactly IDLE_TIMEOUT stays in one session");
  assert.equal(exactly.totalMs, (idle + 300) * S);

  const overBy1 = computeDurations([
    hb(t0, { configVersion: 2 }),
    hb(t0 + (idle + 1) * S, { configVersion: 2 }),
  ]);
  assert.equal(overBy1.sessionCount, 2, "one second more splits the session");
  assert.equal(overBy1.totalMs, 2 * 300 * S, "the idle gap itself is never credited");
});

test("IDLE_TIMEOUT is configurable", () => {
  const t0 = Date.parse("2026-05-01T10:00:00Z");
  const hbs = [hb(t0, { configVersion: 2 }), hb(t0 + 600 * S, { configVersion: 2 })];

  assert.equal(computeDurations(hbs, { idleTimeoutSeconds: 900 }).sessionCount, 1);
  assert.equal(computeDurations(hbs, { idleTimeoutSeconds: 300 }).sessionCount, 2);
});

test("a gap is credited to the earlier heartbeat, not the later one", () => {
  const t0 = Date.parse("2026-05-01T10:00:00Z");
  const r = computeDurations(
    [
      hb(t0, { language: "python", configVersion: 2 }),
      hb(t0 + 240 * S, { language: "rust", configVersion: 2 }),
    ],
    { groupBy: ["language"] },
  );

  // python: 300s head credit + the 240s gap it owns. rust: nothing, it is last.
  assert.equal(r.groups.language.python, (300 + 240) * S);
  assert.equal(r.groups.language.rust, undefined);
  assert.equal(r.totalMs, 540 * S);
});

/* -------------------------------------------------------------------------- */
/* 4. Config invariance — the point of the head credit                         */
/* -------------------------------------------------------------------------- */

test("config invariance: the same activity measured at 120s and 300s agrees closely", () => {
  // Four hours of continuous work, observed by two different throttle regimes.
  const spanSeconds = 4 * 3600;

  const fast = computeDurations(evenly("2026-09-01T09:00:00Z", spanSeconds, 120, { configVersion: 3 }));
  const slow = computeDurations(evenly("2026-09-01T09:00:00Z", spanSeconds, 300, { configVersion: 2 }));

  const drift = pct(fast.totalSeconds, slow.totalSeconds);
  console.log(
    `    120s regime: ${formatDuration(fast.totalMs)}   300s regime: ${formatDuration(slow.totalMs)}   (${drift.toFixed(2)}%)`,
  );

  // Both should land near span + interval; the only difference is the head credit.
  assert.equal(fast.totalMs, (spanSeconds + 120) * S);
  assert.equal(slow.totalMs, (spanSeconds + 300) * S);
  assert.ok(Math.abs(drift) < 2, `regimes disagreed by ${drift.toFixed(2)}%`);
});

test("config invariance: summing raw `duration` would NOT be invariant", () => {
  // The contrast case. Under the old scheme the same 4h of work reads as wildly
  // different totals depending on the throttle, which is the bug being retired.
  const spanSeconds = 4 * 3600;
  const fastSum = evenly("2026-09-01T09:00:00Z", spanSeconds, 120).length * 120;
  const slowSum = evenly("2026-09-01T09:00:00Z", spanSeconds, 300).length * 300;
  assert.notEqual(fastSum, slowSum);
});

/* -------------------------------------------------------------------------- */
/* 5. Config resolution and the Mathematica fallback                           */
/* -------------------------------------------------------------------------- */

test("a stamped configVersion wins over the date", () => {
  // Timestamp sits in the v2 window, but the record claims v1.
  const r = resolveInterval({ timestamp: "2026-06-01T12:00:00Z", configVersion: 1 });
  assert.equal(r.intervalSeconds, 120);
  assert.equal(r.version, 1);
  assert.equal(r.exact, true);
  assert.equal(r.reason, "configVersion");
});

test("a missing configVersion falls back to the date, and says so", () => {
  const r = resolveInterval({ timestamp: "2026-06-01T12:00:00Z" });
  assert.equal(r.intervalSeconds, 300);
  assert.equal(r.version, 2);
  assert.equal(r.exact, false);
  assert.equal(r.reason, "date-fallback");
});

test("an unknown configVersion falls back rather than throwing", () => {
  const r = resolveInterval({ timestamp: "2026-06-01T12:00:00Z", configVersion: 99 });
  assert.equal(r.intervalSeconds, 300);
  assert.equal(r.exact, false);
  assert.equal(r.reason, "unknown-version-date-fallback");
});

test("a heartbeat predating the registry is clamped, never thrown on", () => {
  const r = resolveInterval({ timestamp: "2019-01-01T00:00:00Z" });
  assert.equal(r.exact, false);
  assert.equal(r.reason, "out-of-range-clamp");
  assert.ok(Number.isFinite(r.intervalSeconds));
});

test("unstamped Mathematica heartbeats are counted but reported as inexact", () => {
  const mathematica = fixture.heartbeats.filter((h) => h.editor === "Mathematica");
  assert.ok(mathematica.length > 0, "fixture should contain the un-migrated tracker");
  assert.ok(
    mathematica.every((h) => h.configVersion === undefined),
    "Mathematica heartbeats must stay unstamped — that is the documented gap",
  );

  const r = computeDurations(fixture.heartbeats, { range: fixture.range, timeZone: fixture.timeZone });
  assert.ok(r.totalMs > 0);
  assert.ok(
    r.unstampedHeartbeats >= mathematica.length,
    "unstamped heartbeats must be visible in the result, not silently folded in",
  );

  // In this fixture the Mathematica heartbeats land mid-session behind a stamped
  // VS Code head, so no interval is actually estimated — the fallback costs nothing
  // here. That is the normal case, and it is why the two counters are separate.
  assert.equal(r.inexactIntervalHeartbeats, 0);

  // Force the other case: the same heartbeats alone must still compute, using the
  // date fallback for their head, and must report the estimate.
  const alone = computeDurations(mathematica);
  assert.ok(alone.totalMs > 0, "the fallback must produce a number, not throw");
  assert.ok(alone.inexactIntervalHeartbeats > 0, "an estimated session head must be reported");
});

test("the config registry is contiguous, ordered, and open-ended at the tail", () => {
  for (let i = 1; i < CONFIG_REGISTRY.length; i++) {
    assert.equal(
      CONFIG_REGISTRY[i].from,
      CONFIG_REGISTRY[i - 1].to,
      `gap or overlap between config v${CONFIG_REGISTRY[i - 1].version} and v${CONFIG_REGISTRY[i].version}`,
    );
    assert.equal(CONFIG_REGISTRY[i].version, CONFIG_REGISTRY[i - 1].version + 1);
  }
  assert.equal(CONFIG_REGISTRY.at(-1).to, null, "the current regime must be open-ended");
});

/* -------------------------------------------------------------------------- */
/* 6. Range mode, lookback, and clipping                                       */
/* -------------------------------------------------------------------------- */

test("lookback stops a straddling session from being split", () => {
  const rangeStart = "2026-05-02T00:00:00Z";
  const t0 = Date.parse(rangeStart);

  // One heartbeat 200s before the boundary, one 100s after: a single session.
  const hbs = [hb(t0 - 200 * S, { configVersion: 2 }), hb(t0 + 100 * S, { configVersion: 2 })];

  const withContext = computeDurations(hbs, {
    range: { start: rangeStart, end: "2026-05-03T00:00:00Z" },
  });

  // The in-range heartbeat is NOT a session head, so it earns no interval credit,
  // and the gap belongs to the earlier (out-of-range) heartbeat. Nothing is counted.
  assert.equal(withContext.sessionCount, 1);
  assert.equal(withContext.contextHeartbeats, 1);
  assert.equal(withContext.totalMs, 0);

  // Without the earlier heartbeat, the same instant is misread as a fresh session.
  const withoutContext = computeDurations([hbs[1]], {
    range: { start: rangeStart, end: "2026-05-03T00:00:00Z" },
  });
  assert.equal(withoutContext.totalMs, 300 * S);
});

test("lookbackStart() offsets the query window by the idle timeout", () => {
  const start = "2026-08-02T00:00:00Z";
  assert.equal(lookbackStart(start), Date.parse(start) - DEFAULT_IDLE_TIMEOUT_SECONDS * S);
  assert.equal(lookbackStart(start, { lookbackSeconds: 60 }), Date.parse(start) - 60 * S);
});

test("heartbeats outside the range never inflate the total", () => {
  const inRangeOnly = fixture.heartbeats.filter((h) => {
    const t = Date.parse(h.timestamp);
    return t >= Date.parse(fixture.range.start) && t < Date.parse(fixture.range.end);
  });
  const preRange = fixture.heartbeats.length - inRangeOnly.length;
  assert.ok(preRange > 0, "fixture should carry heartbeats from before the range");

  const clipped = computeDurations(fixture.heartbeats, { range: fixture.range, timeZone: fixture.timeZone });
  const bare = computeDurations(inRangeOnly, { range: fixture.range, timeZone: fixture.timeZone });

  // Context can only ever REMOVE a spurious head credit, never add time.
  assert.ok(clipped.totalMs <= bare.totalMs);
  assert.equal(clipped.groups.day["2026-08-01"], undefined, "a clipped day must not appear in the buckets");

  // Those 8 pre-range heartbeats sit ~13h before the range start — far outside the
  // lookback window — so they are dropped entirely rather than used as context.
  // The lookback path itself is exercised by the straddling-session test above.
  assert.equal(clipped.contextHeartbeats, 0);
  assert.equal(clipped.totalMs, bare.totalMs);
});

/* -------------------------------------------------------------------------- */
/* 7. Daily bucketing and timezone                                             */
/* -------------------------------------------------------------------------- */

test("days are cut at midnight in the configured zone, not UTC", () => {
  // 05:30Z on 2026-08-07 is still 23:30 on 2026-08-06 in Denver.
  const instant = "2026-08-07T05:30:00Z";
  assert.equal(dayKey(Date.parse(instant), "America/Denver"), "2026-08-06");
  assert.equal(dayKey(Date.parse(instant), "UTC"), "2026-08-07");

  const r = computeDurations([hb(instant, { configVersion: 2 })], {
    groupBy: ["day"],
    timeZone: "America/Denver",
  });
  assert.equal(r.groups.day["2026-08-06"], 300 * S);
});

test("the stored `date` field is ignored in favour of the timestamp", () => {
  const r = computeDurations(
    [hb("2026-08-07T05:30:00Z", { date: "1999-12-31", configVersion: 2 })],
    { groupBy: ["day"], timeZone: "America/Denver" },
  );
  assert.equal(r.groups.day["1999-12-31"], undefined);
  assert.equal(r.groups.day["2026-08-06"], 300 * S);
});

test("a gap straddling midnight is credited wholly to the earlier heartbeat's day", () => {
  // 23:58 and 00:05 Denver, 420s apart — one session, gap owned by the 6th.
  const a = "2026-08-07T05:58:00Z"; // 2026-08-06 23:58 Denver
  const b = "2026-08-07T06:05:00Z"; // 2026-08-07 00:05 Denver
  const r = computeDurations([hb(a, { configVersion: 2 }), hb(b, { configVersion: 2 })], {
    groupBy: ["day"],
    timeZone: "America/Denver",
  });
  assert.equal(r.groups.day["2026-08-06"], (300 + 420) * S);
  assert.equal(r.groups.day["2026-08-07"], undefined);
});

/* -------------------------------------------------------------------------- */
/* 8. Robustness                                                               */
/* -------------------------------------------------------------------------- */

test("input order does not matter and the input is not mutated", () => {
  const hbs = evenly("2026-05-01T10:00:00Z", 900, 300, { configVersion: 2 });
  const snapshot = JSON.parse(JSON.stringify(hbs));

  const sorted = computeDurations(hbs);
  const shuffled = computeDurations([...hbs].reverse());

  assert.equal(sorted.totalMs, shuffled.totalMs);
  assert.deepEqual(hbs, snapshot, "computeDurations must not mutate its input");
});

test("Date, ISO string, and epoch-millisecond timestamps are interchangeable", () => {
  const iso = "2026-05-01T10:00:00.000Z";
  const ms = Date.parse(iso);
  const totals = [iso, new Date(ms), ms].map(
    (t) => computeDurations([{ ...hb(iso), timestamp: t, configVersion: 2 }]).totalMs,
  );
  assert.deepEqual(totals, [300 * S, 300 * S, 300 * S]);
});

test("empty input yields zeroes, not a crash", () => {
  const r = computeDurations([]);
  assert.equal(r.totalMs, 0);
  assert.equal(r.sessionCount, 0);
  assert.equal(Object.keys(r.groups.language).length, 0);
});

test("missing attribution fields collapse to `unknown` rather than throwing", () => {
  const r = computeDurations([{ timestamp: "2026-05-01T10:00:00Z", configVersion: 2 }], {
    groupBy: ["language", "project"],
  });
  assert.equal(r.groups.language.unknown, 300 * S);
  assert.equal(r.groups.project.unknown, 300 * S);
});

test("rank() produces ordered shares that add up to 1", () => {
  const r = computeDurations(fixture.heartbeats, { range: fixture.range });
  const rows = rank(r.groups.language, r.totalMs);
  assert.ok(rows.length > 0);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].ms >= rows[i].ms, "rank() must be descending");
  const shareSum = rows.reduce((a, x) => a + x.share, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9);
});

test("ALGORITHM_VERSION is exported and reported in results", () => {
  assert.match(ALGORITHM_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(computeDurations([]).algorithmVersion, ALGORITHM_VERSION);
});
