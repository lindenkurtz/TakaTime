#!/usr/bin/env node
/**
 * Regenerate the checked-in fixtures from live MongoDB data.
 *
 * Two fixtures, answering two different questions:
 *
 *   calibration-2026-08.json — is the algorithm RIGHT? Compared against WakaTime
 *     running in parallel. v2 (300s) data only.
 *   invariance-2026-04.json — is the algorithm STABLE across a throttle change?
 *     The dense v1 per-file era, which is the only real data fine-grained enough
 *     to downsample into a coarser regime. See the real-data invariance tests.
 *
 * Both are CHECKED IN so the test suite (and the website repo) can run without
 * database access. Re-run this only if you need to refresh the snapshots; doing so
 * will move the calibration numbers, so re-verify the tests afterwards.
 *
 * `--only <calibration|invariance>` refreshes one and leaves the other alone. That
 * matters more than it looks: `groundTruth` below is transcribed by hand from
 * WakaTime's dashboard, so rebuilding the calibration heartbeats on a day that is
 * still accumulating compares fresh heartbeats against a stale ground truth and
 * manufactures drift that is not in the algorithm.
 *
 * Usage: node scripts/build-fixture.mjs [--only calibration|invariance]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, LOGS } from "./_mongo.mjs";
import { ALGORITHM_VERSION, DEFAULT_IDLE_TIMEOUT_SECONDS, DEFAULT_TIME_ZONE } from "../duration.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "fixtures", "calibration-2026-08.json");
const INVARIANCE_OUT = path.join(HERE, "..", "fixtures", "invariance-2026-04.json");

const argv = process.argv.slice(2);
const onlyIndex = argv.indexOf("--only");
const only = onlyIndex === -1 ? null : argv[onlyIndex + 1];
if (only && only !== "calibration" && only !== "invariance") {
  console.error(`Unknown --only target ${JSON.stringify(only)}. Use "calibration" or "invariance".`);
  process.exit(1);
}
const wants = (name) => only === null || only === name;

// The v1 per-file era, whose upper bound is the empirical v1 -> v2 boundary.
// Per-file throttling emitted one heartbeat per open file per interval, giving a
// median gap of ~53s — fine-grained enough that thinning it to a 300s global
// stream is a genuine downsample rather than a no-op. v2 data cannot support this
// test: you cannot refine a stream below the resolution it was recorded at.
const INVARIANCE_START = "2026-04-03T00:00:00.000Z";
const INVARIANCE_END = "2026-04-23T20:57:09.808Z";

// One extra day of real heartbeats before the range, so the fixture exercises
// both the lookback buffer and range clipping rather than starting conveniently
// at a session boundary.
const SNAPSHOT_START = "2026-08-01T00:00:00-06:00";
const RANGE_START = "2026-08-02T00:00:00-06:00";
const RANGE_END = "2026-08-09T00:00:00-06:00";

const fixture = {
  description:
    "Real TakaTime heartbeats for 2026-08-01 .. 2026-08-08 (America/Denver), snapshotted for regression testing the query-time duration algorithm against WakaTime ground truth.",
  generatedAt: new Date().toISOString(),
  generatedByAlgorithmVersion: ALGORITHM_VERSION,
  source: "mongodb://takatime.logs",
  timeZone: DEFAULT_TIME_ZONE,
  idleTimeoutSeconds: DEFAULT_IDLE_TIMEOUT_SECONDS,

  snapshotStart: SNAPSHOT_START,
  range: { start: RANGE_START, end: RANGE_END },

  groundTruth: {
    source: "WakaTime, run in parallel on the same machine over the same week",
    timeZone: DEFAULT_TIME_ZONE,
    // WakaTime only ever saw the VS Code editor. It has no visibility into the
    // Mathematica tracker, so any comparison against these numbers MUST filter
    // heartbeats to editor === "VsCode". See METHODOLOGY.md.
    coversEditors: ["VsCode"],
    daySeconds: {
      "2026-08-06": 5276, // 1h27m56s
      "2026-08-07": 20760, // 5h46m
      "2026-08-08": 1620, // 27m
    },
    rangeTotalSeconds: 29820, // 8h17m across 2026-08-02 .. 2026-08-08
  },

  heartbeats: [],
};

const { client, db } = await connect();
try {
  if (wants("calibration")) {
    const docs = await db
      .collection(LOGS)
      .find({
        timestamp: { $gte: new Date(SNAPSHOT_START), $lt: new Date(RANGE_END) },
      })
      .sort({ timestamp: 1 })
      .toArray();

    fixture.heartbeats = docs.map((d) => {
      const out = {
        _id: String(d._id),
        name: d.name,
        project: d.project,
        timestamp: d.timestamp.toISOString(),
        date: d.date,
        language: d.language,
        os: d.os,
        gitBranch: d.gitBranch,
        editor: d.editor,
      };
      // Preserve exactly what the record carries — including the legacy `duration`
      // field, so the test can demonstrate that summing it is wrong.
      if (d.duration !== undefined) out.duration = d.duration;
      if (d.configVersion !== undefined) out.configVersion = d.configVersion;
      return out;
    });

    fixture.heartbeatCount = fixture.heartbeats.length;

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(fixture, null, 2) + "\n");
    console.log(`Wrote ${fixture.heartbeatCount} heartbeats to ${OUT}`);

    const byEditor = {};
    for (const h of fixture.heartbeats) byEditor[h.editor] = (byEditor[h.editor] ?? 0) + 1;
    console.log("  by editor:", byEditor);
    const stamped = fixture.heartbeats.filter((h) => h.configVersion !== undefined).length;
    console.log(`  ${stamped} stamped with configVersion, ${fixture.heartbeatCount - stamped} unstamped (date fallback)`);
  }

  // ---- invariance fixture --------------------------------------------------
  if (wants("invariance")) {
    // WakaTime never observed Mathematica, and the two trackers emit on independent
    // timers, so interleaving them would make a downsampled stream describe activity
    // no single tracker ever saw. VS Code only, for the same reason calibration is.
    const v1 = await db
      .collection(LOGS)
      .find({
        editor: "VsCode",
        timestamp: { $gte: new Date(INVARIANCE_START), $lt: new Date(INVARIANCE_END) },
      })
      .sort({ timestamp: 1 })
      .toArray();

    const invariance = {
      description:
        "Real VS Code heartbeats from the v1 per-file throttle era (2026-04), snapshotted so the config-invariance claim can be tested by downsampling REAL bursty activity rather than synthetic evenly-spaced heartbeats.",
      generatedAt: new Date().toISOString(),
      generatedByAlgorithmVersion: ALGORITHM_VERSION,
      source: "mongodb://takatime.logs",
      timeZone: DEFAULT_TIME_ZONE,
      idleTimeoutSeconds: DEFAULT_IDLE_TIMEOUT_SECONDS,
      window: { start: INVARIANCE_START, end: INVARIANCE_END },
      configVersion: 1,
      note:
        "The file path (`name`) and `os` are omitted: they are irrelevant to a total-duration " +
        "test and dominate the file size. `duration` is kept so the era-dependent direction of " +
        "the legacy field's error stays testable offline.",
      // Field set is deliberately narrow — see `note`.
      heartbeats: v1.map((d) => ({
        timestamp: d.timestamp.toISOString(),
        language: d.language,
        project: d.project,
        gitBranch: d.gitBranch,
        editor: d.editor,
        duration: d.duration,
        configVersion: d.configVersion,
      })),
    };
    invariance.heartbeatCount = invariance.heartbeats.length;

    fs.mkdirSync(path.dirname(INVARIANCE_OUT), { recursive: true });
    fs.writeFileSync(INVARIANCE_OUT, JSON.stringify(invariance, null, 2) + "\n");
    console.log(`Wrote ${invariance.heartbeatCount} heartbeats to ${INVARIANCE_OUT}`);
  }
} finally {
  await client.close();
}
