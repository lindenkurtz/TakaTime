#!/usr/bin/env node
/**
 * Export a self-contained analysis bundle: every heartbeat, the config registry,
 * the algorithm, and the methodology — in one folder, with nothing implied and
 * nothing missing.
 *
 * The point is that you can hand the folder to an analysis tool (or a person, or a
 * model) and it has everything needed to interpret the data correctly, WITHOUT
 * needing to know that `duration` is a trap.
 *
 * Usage:
 *   node scripts/export-bundle.mjs                        # -> ./exports/takatime-<date>/
 *   node scripts/export-bundle.mjs --out ~/somewhere
 *   node scripts/export-bundle.mjs --from 2026-05-01 --to 2026-08-09
 *   node scripts/export-bundle.mjs --format ndjson        # json (default) | ndjson | both
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, LOGS, CONFIGS, MIGRATIONS, safeUri, resolveUri } from "./_mongo.mjs";
import {
  ALGORITHM_VERSION,
  CONFIG_REGISTRY,
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  DEFAULT_TIME_ZONE,
  computeDurations,
  formatDuration,
  rank,
} from "../duration.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..");

function arg(name, fallback = null) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}

const stamp = new Date().toISOString().slice(0, 10);
const outRoot = arg("out", path.join(REPO_ROOT, "exports"));
const outDir = path.join(outRoot, `takatime-${stamp}`);
const from = arg("from");
const to = arg("to");
const format = arg("format", "json");

const { client, db } = await connect();
try {
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`TakaTime export bundle`);
  console.log(`  source : ${safeUri(resolveUri())}`);
  console.log(`  target : ${outDir}`);
  console.log("");

  /* ---- 1. heartbeats ---------------------------------------------------- */
  const query = {};
  if (from || to) {
    query.timestamp = {};
    if (from) query.timestamp.$gte = new Date(from);
    if (to) query.timestamp.$lt = new Date(to);
  }

  const docs = await db.collection(LOGS).find(query).sort({ timestamp: 1 }).toArray();
  const heartbeats = docs.map((d) => ({ ...d, _id: String(d._id), timestamp: d.timestamp.toISOString() }));

  if (format === "json" || format === "both") {
    fs.writeFileSync(path.join(outDir, "heartbeats.json"), JSON.stringify(heartbeats, null, 2) + "\n");
    console.log(`  heartbeats.json      ${heartbeats.length} records`);
  }
  if (format === "ndjson" || format === "both") {
    fs.writeFileSync(path.join(outDir, "heartbeats.ndjson"), heartbeats.map((h) => JSON.stringify(h)).join("\n") + "\n");
    console.log(`  heartbeats.ndjson    ${heartbeats.length} records`);
  }

  /* ---- 2. config registry ----------------------------------------------- */
  const configs = await db.collection(CONFIGS).find({}).sort({ version: 1 }).toArray();
  const configsOut = configs.length > 0 ? configs.map((c) => ({ ...c, _id: undefined })) : CONFIG_REGISTRY;
  if (configs.length === 0) {
    console.log(`  (configs collection empty — falling back to the in-code registry; run the migration)`);
  }
  fs.writeFileSync(path.join(outDir, "configs.json"), JSON.stringify(configsOut, null, 2) + "\n");
  console.log(`  configs.json         ${configsOut.length} regimes`);

  /* ---- 3. the algorithm itself ------------------------------------------ */
  fs.copyFileSync(path.join(REPO_ROOT, "analytics", "duration.mjs"), path.join(outDir, "duration.mjs"));
  console.log(`  duration.mjs         algorithm v${ALGORITHM_VERSION}`);

  /* ---- 4. methodology ---------------------------------------------------- */
  const methodology = path.join(REPO_ROOT, "METHODOLOGY.md");
  if (fs.existsSync(methodology)) {
    fs.copyFileSync(methodology, path.join(outDir, "METHODOLOGY.md"));
    console.log(`  METHODOLOGY.md`);
  } else {
    console.log(`  WARNING: METHODOLOGY.md not found at repo root — bundle is incomplete`);
  }

  /* ---- 5. fixtures --------------------------------------------------------- */
  // Both, not just calibration: METHODOLOGY.md ships in this bundle, and its
  // config-invariance section is reproducible only from the v1 downsampling fixture.
  for (const name of ["calibration-2026-08.json", "invariance-2026-04.json"]) {
    const fixture = path.join(REPO_ROOT, "analytics", "fixtures", name);
    if (fs.existsSync(fixture)) {
      fs.copyFileSync(fixture, path.join(outDir, name));
      console.log(`  ${name}`);
    }
  }

  /* ---- 6. precomputed summary -------------------------------------------- */
  // Not a substitute for running the algorithm yourself — a cross-check, so a
  // consumer can tell immediately whether their own numbers are in the right place.
  const result = computeDurations(heartbeats, {
    groupBy: ["language", "project", "gitBranch", "editor", "os", "day"],
  });
  const summary = {
    algorithmVersion: ALGORITHM_VERSION,
    idleTimeoutSeconds: DEFAULT_IDLE_TIMEOUT_SECONDS,
    timeZone: DEFAULT_TIME_ZONE,
    heartbeatCount: heartbeats.length,
    sessionCount: result.sessionCount,
    unstampedHeartbeats: result.unstampedHeartbeats,
    inexactIntervalHeartbeats: result.inexactIntervalHeartbeats,
    totalMs: result.totalMs,
    totalFormatted: formatDuration(result.totalMs),
    legacyDurationSumFormatted: formatDuration(heartbeats.reduce((a, h) => a + (h.duration ?? 0), 0) * 1000),
    byLanguage: rank(result.groups.language, result.totalMs),
    byProject: rank(result.groups.project, result.totalMs),
    byEditor: rank(result.groups.editor, result.totalMs),
    byDay: Object.fromEntries(
      Object.entries(result.groups.day)
        .sort()
        .map(([d, ms]) => [d, { ms, formatted: formatDuration(ms) }]),
    ),
  };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`  summary.json         ${summary.totalFormatted} across ${summary.sessionCount} sessions`);

  /* ---- 7. manifest ------------------------------------------------------- */
  const migrations = await db.collection(MIGRATIONS).find({}).toArray();
  const readme = `# TakaTime export — ${stamp}

Self-contained snapshot. Everything needed to interpret this data is in this folder.

## READ THIS FIRST

A heartbeat is an **observation** ("this file was being edited at this instant"),
not a duration.

**Do not sum the \`duration\` field.** It exists only on heartbeats written before
config regime v3, it holds the tracker's throttle interval rather than measured
time, and it spans two incompatible throttle regimes. Summing it undercounts real
time by roughly 18% and distorts per-language shares. It is retained in this export
only because the raw log is an observation record and is not edited after the fact.

To get durations, run \`duration.mjs\` over \`heartbeats.json\`:

\`\`\`js
import { computeDurations, rank, formatDuration } from "./duration.mjs";
import heartbeats from "./heartbeats.json" with { type: "json" };

const r = computeDurations(heartbeats);
console.log(formatDuration(r.totalMs));
console.log(rank(r.groups.language, r.totalMs));
\`\`\`

\`duration.mjs\` is pure, zero-dependency ESM. It needs no database and no install.

## Contents

| File | What it is |
|---|---|
| \`heartbeats.json\` | ${heartbeats.length} raw heartbeats${from || to ? ` (${from ?? "start"} .. ${to ?? "now"})` : " (full history)"} |
| \`configs.json\` | Throttle regimes, with exact ISO-8601 boundaries |
| \`duration.mjs\` | The canonical algorithm, v${ALGORITHM_VERSION} |
| \`METHODOLOGY.md\` | What the numbers mean and how they are derived |
| \`calibration-2026-08.json\` | Fixture validating the algorithm against WakaTime |
| \`invariance-2026-04.json\` | Dense v1 heartbeats, downsampled to test config invariance |
| \`summary.json\` | Precomputed totals, as a cross-check |

## Provenance

- Exported: ${new Date().toISOString()}
- Algorithm version: ${ALGORITHM_VERSION}
- Idle timeout: ${DEFAULT_IDLE_TIMEOUT_SECONDS}s
- Daily bucketing timezone: ${DEFAULT_TIME_ZONE}
- Heartbeats without \`configVersion\`: ${result.unstampedHeartbeats} (interval estimated from date — see METHODOLOGY.md)
- Migrations applied: ${migrations.map((m) => m._id).join(", ") || "none"}
`;
  fs.writeFileSync(path.join(outDir, "README.md"), readme);
  console.log(`  README.md`);

  console.log("");
  console.log(`Bundle complete: ${outDir}`);
} finally {
  await client.close();
}
