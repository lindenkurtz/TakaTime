#!/usr/bin/env node
/**
 * Regenerate the calibration fixture from live MongoDB data.
 *
 * The fixture is CHECKED IN so the test suite (and the website repo) can run
 * without database access. Re-run this only if you need to refresh the snapshot;
 * doing so will move the calibration numbers, so re-verify the test afterwards.
 *
 * Usage: node scripts/build-fixture.mjs [--apply]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, LOGS } from "./_mongo.mjs";
import { ALGORITHM_VERSION, DEFAULT_IDLE_TIMEOUT_SECONDS, DEFAULT_TIME_ZONE } from "../duration.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "fixtures", "calibration-2026-08.json");

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
} finally {
  await client.close();
}
