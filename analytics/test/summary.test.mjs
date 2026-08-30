/**
 * Tests for the shared summary shape.
 *
 * Runs against the checked-in calibration fixture with an injected `now`, so it needs
 * no database and cannot drift as new heartbeats land.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  addDays,
  agentOf,
  buildSummary,
  daysBetween,
  formatAgo,
  formatCompact,
  startOfDayMs,
} from "../summary.mjs";
import { dayKey } from "../duration.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(path.join(HERE, "..", "fixtures", "calibration-2026-08.json"), "utf8"),
);

const TZ = "America/Denver";
/** End of the calibration week, Denver. Fixed so the assertions below never move. */
const NOW = Date.parse("2026-08-08T23:00:00-06:00");

const summary = buildSummary(fixture.heartbeats, { now: NOW, timeZone: TZ });

/* -------------------------------------------------------------------------- */
/* Calendar arithmetic                                                         */
/* -------------------------------------------------------------------------- */

test("addDays does calendar arithmetic, not 86400-second arithmetic", () => {
  assert.equal(addDays("2026-08-09", 1), "2026-08-10");
  assert.equal(addDays("2026-08-01", -1), "2026-07-31");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29", "leap year");
  assert.equal(addDays("2026-03-08", 1), "2026-03-09", "spring-forward day still advances by one");
});

test("startOfDayMs lands on local midnight across a DST transition", () => {
  // US DST 2026: forward 2026-03-08, back 2026-11-01. A day is 23h and 25h long
  // respectively; stepping by a fixed 86_400_000 would drift into the wrong day.
  for (const day of ["2026-03-07", "2026-03-08", "2026-03-09", "2026-10-31", "2026-11-01", "2026-11-02"]) {
    const ms = startOfDayMs(day, TZ);
    assert.equal(dayKey(ms, TZ), day, `${day} did not map to its own midnight`);
    assert.equal(
      dayKey(ms - 1, TZ),
      addDays(day, -1),
      `the instant before ${day} midnight is not the previous day`,
    );
  }
});

test("a spring-forward day is 23 hours and a fall-back day is 25", () => {
  assert.equal(startOfDayMs("2026-03-09", TZ) - startOfDayMs("2026-03-08", TZ), 23 * 3600 * 1000);
  assert.equal(startOfDayMs("2026-11-02", TZ) - startOfDayMs("2026-11-01", TZ), 25 * 3600 * 1000);
});

test("daysBetween is inclusive at both ends", () => {
  assert.deepEqual(daysBetween("2026-08-07", "2026-08-09"), ["2026-08-07", "2026-08-08", "2026-08-09"]);
  assert.deepEqual(daysBetween("2026-08-09", "2026-08-09"), ["2026-08-09"]);
});

/* -------------------------------------------------------------------------- */
/* Additivity carries through the summary                                      */
/* -------------------------------------------------------------------------- */

test("the daily series sums exactly to the window total", () => {
  // The series is read off an UNRANGED pass and the total off a RANGED one. They are
  // two different journeys through the algorithm, and they must land on the same
  // integer — that is the additivity invariant surviving the summary layer.
  const summed = summary.week.series.reduce((a, d) => a + d.ms, 0);
  assert.equal(summed, summary.week.ms);
});

test("the hourly distribution sums exactly to the all-time total", () => {
  const summed = summary.hourly.reduce((a, h) => a + h.ms, 0);
  assert.equal(summed, summary.allTime.ms);
});

test("today's total is the last point of the daily series", () => {
  const last = summary.week.series[summary.week.series.length - 1];
  assert.equal(last.day, summary.today.day);
  assert.equal(last.ms, summary.today.ms);
});

test("the window covers exactly `days` days, ending today", () => {
  assert.equal(summary.week.series.length, 7);
  assert.equal(summary.week.series[0].day, summary.week.startDay);
  assert.equal(summary.week.endDay, summary.today.day);
  assert.equal(addDays(summary.week.startDay, 6), summary.week.endDay);
});

test("a longer window is a superset of a shorter one, day for day", () => {
  const wide = buildSummary(fixture.heartbeats, { now: NOW, timeZone: TZ, weekDays: 30 });
  const byDay = new Map(wide.week.series.map((d) => [d.day, d.ms]));
  for (const d of summary.week.series) {
    assert.equal(byDay.get(d.day), d.ms, `${d.day} disagreed between a 7d and a 30d window`);
  }
  assert.ok(wide.week.ms >= summary.week.ms);
});

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

test("today's sessions sum to at most today's total", () => {
  // At most, not exactly: a session straddling midnight contributes to two days but
  // is listed under the day it STARTED. See METHODOLOGY.md on daily bucketing.
  const summed = summary.today.sessions.reduce((a, s) => a + s.durationMs, 0);
  assert.ok(summed <= summary.today.ms + 1, `${summed} > ${summary.today.ms}`);
  assert.equal(summary.today.sessionCount, summary.today.sessions.length);
});

test("a session is current only while it is inside the idle timeout", () => {
  const lastBeat = Math.max(...fixture.heartbeats.map((h) => Date.parse(h.timestamp)));

  const live = buildSummary(fixture.heartbeats, { now: lastBeat + 60_000, timeZone: TZ });
  assert.ok(live.currentSession, "a heartbeat one minute ago should read as a live session");
  assert.equal(live.currentSession.msSinceLastBeat, 60_000);

  const dead = buildSummary(fixture.heartbeats, { now: lastBeat + 901_000, timeZone: TZ });
  assert.equal(dead.currentSession, null, "one second past the idle timeout should end it");
});

test("a live session never credits the tail after its last heartbeat", () => {
  // Inventing the tail is the "duration is an interpretation" mistake the whole
  // redesign exists to prevent. The reported duration must not move as `now` does.
  const lastBeat = Math.max(...fixture.heartbeats.map((h) => Date.parse(h.timestamp)));
  const early = buildSummary(fixture.heartbeats, { now: lastBeat + 10_000, timeZone: TZ });
  const later = buildSummary(fixture.heartbeats, { now: lastBeat + 600_000, timeZone: TZ });
  assert.equal(early.currentSession.durationMs, later.currentSession.durationMs);
  assert.ok(later.currentSession.msSinceLastBeat > early.currentSession.msSinceLastBeat);
});

test("current-session breakdowns sum to no more than the session", () => {
  const lastBeat = Math.max(...fixture.heartbeats.map((h) => Date.parse(h.timestamp)));
  const live = buildSummary(fixture.heartbeats, { now: lastBeat + 60_000, timeZone: TZ, topN: 50 });
  const byLanguage = live.currentSession.languages.reduce((a, l) => a + l.ms, 0);
  assert.ok(byLanguage <= live.currentSession.durationMs);
});

/* -------------------------------------------------------------------------- */
/* Streaks                                                                     */
/* -------------------------------------------------------------------------- */

test("a streak survives a today that has not started yet", () => {
  // At 09:00 with no heartbeats, yesterday still anchors the count — otherwise the
  // number flickers to zero every morning.
  const active = summary.streak.current;
  assert.ok(active > 0);
  const tomorrow = buildSummary(fixture.heartbeats, {
    now: NOW + 86_400_000,
    timeZone: TZ,
  });
  assert.equal(tomorrow.streak.current, active, "an empty tomorrow should not reset the streak");

  const dayAfter = buildSummary(fixture.heartbeats, { now: NOW + 2 * 86_400_000, timeZone: TZ });
  assert.equal(dayAfter.streak.current, 0, "two empty days should");
});

test("the longest streak is at least the current one", () => {
  assert.ok(summary.streak.longest >= summary.streak.current);
});

/* -------------------------------------------------------------------------- */
/* Filtering and shape                                                         */
/* -------------------------------------------------------------------------- */

test("filtering to one editor never exceeds the unfiltered total", () => {
  const vscode = buildSummary(fixture.heartbeats, {
    now: NOW,
    timeZone: TZ,
    filter: (hb) => hb.editor === "VsCode",
  });
  assert.ok(vscode.allTime.ms <= summary.allTime.ms);
  assert.ok(vscode.allTime.ms > 0);
});

test("leaderboards are ranked, capped, and share-normalised", () => {
  const s = buildSummary(fixture.heartbeats, { now: NOW, timeZone: TZ, topN: 3 });
  for (const rows of [s.week.projects, s.week.languages, s.week.files, s.week.branches]) {
    assert.ok(rows.length <= 3);
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].ms >= rows[i].ms, "not descending");
    for (const r of rows) assert.ok(r.share >= 0 && r.share <= 1);
  }
});

test("empty input yields a zeroed summary rather than a crash", () => {
  const s = buildSummary([], { now: NOW, timeZone: TZ });
  assert.equal(s.today.ms, 0);
  assert.equal(s.week.ms, 0);
  assert.equal(s.allTime.ms, 0);
  assert.equal(s.currentSession, null);
  assert.equal(s.streak.current, 0);
  assert.equal(s.data.lastBeatMs, null);
  assert.equal(s.data.msSinceLastBeat, null);
  assert.equal(s.week.series.length, 7);
  assert.equal(s.hourly.length, 24);
});

test("every stacked column sums to that day's total", () => {
  // The bands come from a joint day×project grouping and the total from the plain
  // day grouping. If these ever disagreed the chart would be drawing a lie.
  const s = buildSummary(fixture.heartbeats, { now: NOW, timeZone: TZ, trendDays: 30 });
  assert.equal(s.trend.series.length, 30);
  for (const col of s.trend.series) {
    const summed = Object.values(col.values).reduce((a, b) => a + b, 0);
    assert.equal(summed, col.total, `${col.day} bands summed to ${summed}, total is ${col.total}`);
  }
});

test("stack bands are chosen once for the window, not per day", () => {
  const s = buildSummary(fixture.heartbeats, { now: NOW, timeZone: TZ, trendDays: 30, stackSlots: 2 });
  assert.ok(s.trend.keys.length <= 3, "two named slots plus Other at most");
  for (const col of s.trend.series) {
    assert.deepEqual(Object.keys(col.values), s.trend.keys, `${col.day} used different bands`);
  }
});

test("the trend total agrees with the daily series over the same days", () => {
  const s = buildSummary(fixture.heartbeats, { now: NOW, timeZone: TZ, trendDays: 7 });
  for (let i = 0; i < 7; i++) {
    assert.equal(s.trend.series[i].day, s.week.series[i].day);
    assert.equal(s.trend.series[i].total, s.week.series[i].ms);
  }
});

test("the heatmap ends today and has one entry per day", () => {
  const s = buildSummary(fixture.heartbeats, { now: NOW, timeZone: TZ, heatmapDays: 30 });
  assert.equal(s.heatmap.length, 30);
  assert.equal(s.heatmap[s.heatmap.length - 1].day, s.today.day);
  assert.equal(s.heatmap[0].day, addDays(s.today.day, -29));
});

test("data health reports the stamped-heartbeat invariant", () => {
  assert.equal(summary.data.unstampedHeartbeats, 0);
  assert.equal(summary.data.inexactIntervalHeartbeats, 0);
  assert.equal(summary.data.heartbeats, fixture.heartbeats.length);
});

test("the config regime in force is resolved from `now`", () => {
  const v1 = buildSummary([], { now: Date.parse("2026-04-10T12:00:00Z") });
  assert.equal(v1.data.configVersionInForce, 1);
  assert.equal(v1.data.intervalSecondsInForce, 120);

  const v2 = buildSummary([], { now: Date.parse("2026-06-01T12:00:00Z") });
  assert.equal(v2.data.configVersionInForce, 2);
  assert.equal(v2.data.intervalSecondsInForce, 300);

  const v3 = buildSummary([], { now: Date.parse("2026-08-09T12:00:00Z") });
  assert.equal(v3.data.configVersionInForce, 3);
  assert.equal(v3.data.intervalSecondsInForce, 120);
});

test("the v3 regime opens at the empirical boundary, not a rounded one", () => {
  // 2026-08-08T20:36:00.000Z is the observed instant, read off the data. A rounded
  // 06:00Z would mis-resolve nine hours of heartbeats to the 300s interval.
  const before = buildSummary([], { now: Date.parse("2026-08-08T20:35:59.999Z") });
  const after = buildSummary([], { now: Date.parse("2026-08-08T20:36:00.000Z") });
  assert.equal(before.data.configVersionInForce, 2);
  assert.equal(after.data.configVersionInForce, 3);
});

/* -------------------------------------------------------------------------- */
/* Display helpers                                                             */
/* -------------------------------------------------------------------------- */

test("formatCompact stays short enough for a status bar", () => {
  assert.equal(formatCompact(0), "0s");
  assert.equal(formatCompact(45_000), "45s");
  assert.equal(formatCompact(90_000), "1m");
  assert.equal(formatCompact(3_600_000), "1h00m");
  assert.equal(formatCompact(11_520_000), "3h12m");
  assert.ok(formatCompact(360_000_000).length <= 7);
});

test("formatAgo makes a stalled tracker legible", () => {
  assert.equal(formatAgo(null), "never");
  assert.equal(formatAgo(10_000), "just now");
  assert.equal(formatAgo(240_000), "4m ago");
  assert.equal(formatAgo(7_200_000), "2h ago");
  assert.equal(formatAgo(3 * 86_400_000), "3d ago");
});

/* -------------------------------------------------------------------------- */
/* The human / AI split                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The calibration fixture predates agents, so the agent side is synthesised here:
 * a run of ClaudeCode heartbeats laid over a slice of the fixture's own busiest day,
 * plus the write records that make some of the editor heartbeats echoes of them.
 * Synthetic on purpose — these tests pin the ARITHMETIC of the split, and a fixture
 * that has to be regenerated from live data cannot pin arithmetic.
 */
function withAgent() {
  const vs = fixture.heartbeats.filter((h) => h.editor === "VsCode");
  const day = summary.week.series.reduce((a, b) => (b.ms > a.ms ? b : a)).day;
  const onDay = vs.filter((h) => dayKey(Date.parse(h.timestamp), TZ) === day).slice(0, 12);

  const agent = onDay.map((h, i) => ({
    ...h,
    editor: "ClaudeCode",
    // Offset so the agent stream overlaps the editor stream rather than duplicating
    // its instants exactly, which is what real concurrency looks like.
    timestamp: new Date(Date.parse(h.timestamp) + 30_000 + i).toISOString(),
    configVersion: 2,
  }));

  // Half of the editor heartbeats on that day become echoes: an agent wrote the same
  // file a few seconds earlier.
  const aiWrites = onDay.slice(0, 6).map((h) => ({
    timestamp: new Date(Date.parse(h.timestamp) - 5_000).toISOString(),
    file: h.name,
  }));

  return { heartbeats: [...fixture.heartbeats, ...agent], aiWrites, echoCandidates: onDay.slice(0, 6) };
}

const mixed = withAgent();
const split = buildSummary(mixed.heartbeats, { now: NOW, timeZone: TZ, aiWrites: mixed.aiWrites });

test("the three split bands partition the union exactly", () => {
  // Integer milliseconds, so this is an equality and not an approximation — the same
  // property the grouping dimensions have in duration.mjs.
  for (const block of [split.today, split.week, split.allTime]) {
    const s = block.split;
    assert.equal(
      s.humanOnlyMs + s.overlapMs + s.aiOnlyMs,
      s.unionMs,
      "humanOnly + overlap + aiOnly must equal the union",
    );
  }
});

test("human and AI overlap rather than partition, and are never additive", () => {
  const s = split.allTime.split;
  assert.ok(s.overlapMs > 0, "the synthetic agent stream overlaps the editor stream");
  assert.equal(s.humanMs + s.aiMs - s.overlapMs, s.unionMs);
  assert.ok(s.humanMs + s.aiMs > s.unionMs, "adding the two overcounts, which is why we do not");
});

test("the bands survive two streams that interleave without co-occurring", () => {
  // The case that broke the first implementation. Defining overlap arithmetically as
  // `human + ai - union` looks equivalent to measuring it, and is not: merging two
  // sparse streams CLOSES a gap neither could see alone, so the union exceeds the sum
  // and the "overlap" goes negative. Clamping it to zero then quietly broke the
  // partition the stacked bar is drawn from.
  const hbs = [
    { timestamp: "2026-08-20T16:00:00.000Z", editor: "VsCode", name: "a.c", project: "p", language: "c", configVersion: 3 },
    { timestamp: "2026-08-20T16:05:00.000Z", editor: "ClaudeCode", name: "b.c", project: "p", language: "c", configVersion: 3 },
  ];
  const s = buildSummary(hbs, { now: Date.parse("2026-08-20T18:00:00Z"), timeZone: TZ }).allTime.split;

  // 300s apart is further than the 120s throttle can resolve, so this is interleaving
  // and NOT concurrency — the distinction the arithmetic definition could not make.
  assert.equal(s.overlapMs, 0, "no concurrency should be claimed at this spacing");
  assert.equal(s.humanOnlyMs + s.overlapMs + s.aiOnlyMs, s.unionMs, "the partition must still hold");
  assert.equal(s.humanMs + s.aiMs - s.overlapMs, s.unionMs, "and must reconcile with the totals");
  for (const k of ["humanOnlyMs", "overlapMs", "aiOnlyMs"]) {
    assert.ok(s[k] >= 0, `${k} went negative — the old arithmetic definition is back`);
  }
});

test("every band is non-negative on the real fixture, in every window", () => {
  for (const block of [split.today, split.week, split.allTime]) {
    for (const k of ["humanOnlyMs", "overlapMs", "aiOnlyMs", "humanMs", "aiMs", "unionMs"]) {
      assert.ok(block.split[k] >= 0, `${k} went negative`);
    }
  }
});

test("the union is the top-level total, not the editor's own", () => {
  assert.equal(split.allTime.split.unionMs, split.allTime.ms);
  assert.equal(split.week.split.unionMs, split.week.ms);
  assert.equal(split.today.split.unionMs, split.today.ms);
});

test("agent time is attributed to the agent, not to the human", () => {
  assert.ok(split.allTime.split.aiMs > 0);
  const human = buildSummary(mixed.heartbeats, {
    now: NOW,
    timeZone: TZ,
    aiWrites: mixed.aiWrites,
    filter: (hb) => hb.editor !== "ClaudeCode",
  });
  assert.equal(human.allTime.split.aiMs, 0);
  assert.ok(human.allTime.ms <= split.allTime.ms, "removing a stream cannot add time");
});

test("echo suppression drops duplicate observations and lowers human time", () => {
  const unsuppressed = buildSummary(mixed.heartbeats, { now: NOW, timeZone: TZ });
  assert.equal(unsuppressed.data.echoHeartbeats, 0, "no write records means no suppression");
  assert.ok(split.data.echoHeartbeats > 0, "the synthetic writes should catch some heartbeats");
  assert.ok(
    split.allTime.split.humanMs < unsuppressed.allTime.split.humanMs,
    "suppressing an agent's echo must reduce HUMAN time",
  );
  assert.equal(
    split.data.echoRemovedMs,
    unsuppressed.allTime.split.humanMs - split.allTime.split.humanMs,
    "the reported cost of suppression is the actual difference it makes",
  );
});

test("without write records nothing is suppressed and 1.x numbers are reproduced", () => {
  // The fail-safe. A machine that has never run the importer must under-report the
  // split, never invent one — and must not silently change the editor's own totals.
  const none = buildSummary(fixture.heartbeats, { now: NOW, timeZone: TZ });
  assert.equal(none.data.aiWrites, 0);
  assert.equal(none.data.echoHeartbeats, 0);
  assert.equal(none.data.echoRemovedMs, 0);
  assert.equal(none.allTime.ms, summary.allTime.ms);
  assert.equal(none.allTime.split.aiMs, 0);
  assert.equal(none.allTime.split.humanMs, none.allTime.ms, "all of it is human when nothing else writes");
});

test("an agent's echo is only suppressed for the file the agent actually wrote", () => {
  // A blanket time-window rule would swallow genuine parallel work. The join is on
  // the PATH as well as the instant.
  const wrongFile = mixed.aiWrites.map((w) => ({ ...w, file: w.file + ".not-this-one" }));
  const s = buildSummary(mixed.heartbeats, { now: NOW, timeZone: TZ, aiWrites: wrongFile });
  assert.equal(s.data.echoHeartbeats, 0);
});

test("per-project split rows are themselves exact partitions", () => {
  for (const block of [split.week, split.allTime]) {
    for (const row of block.projectSplit) {
      assert.equal(row.totalMs, row.humanOnlyMs + row.overlapMs + row.aiOnlyMs);
      // NOT humanMs + aiMs — those double-count the overlap, by design.
      assert.equal(row.humanMs + row.aiMs - row.overlapMs, row.totalMs);
      assert.ok(row.aiShare >= 0 && row.aiShare <= 1);
    }
    const rowsSum = block.projectSplit.reduce((a, r) => a + r.totalMs, 0);
    assert.ok(rowsSum <= block.split.unionMs, "a capped leaderboard cannot exceed the union");
  }
});

test("the daily split series partitions each day, and the window", () => {
  // What the daily chart is drawn from. If a column does not add to its day's total,
  // the chart is lying about a number the reader can check against the tile above it.
  let sum = 0;
  for (const d of split.agentTrend.series) {
    assert.equal(d.values["human-only"] + d.values.concurrent + d.values["ai-only"], d.total);
    sum += d.total;
  }
  const daily = Object.fromEntries(split.heatmap.map((d) => [d.day, d.ms]));
  for (const d of split.agentTrend.series) {
    assert.equal(d.total, daily[d.day] ?? 0, `${d.day} disagrees with the daily series`);
  }
  assert.ok(sum <= split.allTime.ms);
});

test("the agent dimension is derived, never read off the heartbeat", () => {
  // There is no `agent` field in the database and no migration created one. If this
  // ever starts reading a stored field, the derivation has quietly become a schema.
  assert.equal(agentOf({ editor: "ClaudeCode" }), "ai");
  assert.equal(agentOf({ editor: "VsCode" }), "human");
  assert.equal(agentOf({ editor: "Mathematica" }), "human");
  assert.equal(agentOf({ editor: "VsCode", agent: "ai" }), "human", "a stored field must not win");
  assert.equal(agentOf({}), "human", "an unknown tracker is a human one until declared");
});
