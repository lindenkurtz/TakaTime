#!/usr/bin/env node
/**
 * TakaTime — import Claude Code sessions as heartbeats.
 *
 * Reads the transcripts Claude Code already writes to ~/.claude/projects, converts
 * them into throttled heartbeats with `editor: "ClaudeCode"`, and inserts them
 * alongside the editor heartbeats in `takatime.logs`. All of the parsing and every
 * detection rule lives in the pure half, transcript.mjs; this file only does the
 * things that touch the world.
 *
 * Idempotent by construction: every document gets a deterministic `_id`, and the only
 * write is `$setOnInsert`. Re-running never modifies or duplicates anything, which is
 * what lets the same command serve as both a one-time backfill and a live hook.
 *
 *   node import-claude.mjs                 # dry run — says what it would write
 *   node import-claude.mjs --apply         # commit
 *   node import-claude.mjs --apply --quiet # what the Claude Code Stop hook runs
 *   node import-claude.mjs --apply --force # ignore the unchanged-since cache
 *
 * ---------------------------------------------------------------------------
 * WHY THIS WRITES DIRECTLY RATHER THAN THROUGH taka-upload
 * ---------------------------------------------------------------------------
 * `taka-upload` stamps `timestamp: time.Now()`, so it physically cannot express a
 * backfilled observation. The Mathematica tracker set the precedent for a tracker
 * that writes its own documents; this one follows it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE THROTTLE IS RESOLVED FROM CONFIG_REGISTRY
 * ---------------------------------------------------------------------------
 * The raw transcript is ~50x denser than an editor heartbeat stream (median gap 2.2s
 * against 120s). Feeding that to the query-time algorithm unchanged would not be
 * wrong so much as INCOMPARABLE: a dense stream has almost no unobserved gaps, so it
 * measures a different thing than the editor stream it sits next to.
 *
 * Downsampling to the interval in force at each instant makes the two commensurable
 * AND keeps CONFIG_REGISTRY a single linear series, which METHODOLOGY.md relies on.
 * The registry is imported rather than copied so the two cannot drift.
 *
 * Cost of the downsample, measured over the whole corpus: 11h53m unthrottled against
 * 11h24m throttled, 4% — the same order as the config-invariance drift the algorithm
 * already tolerates between regimes.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { CONFIG_REGISTRY, formatDuration, computeDurations, resolveInterval } from "../../analytics/duration.mjs";
import { connect, safeUri, resolveUri, DB_NAME, LOGS } from "../../analytics/scripts/_mongo.mjs";
import { EDITOR, TRANSCRIPT_VERSION, buildHeartbeats } from "./transcript.mjs";

/** Where Claude Code keeps its session transcripts. */
export const TRANSCRIPT_ROOT = path.join(os.homedir(), ".claude", "projects");

/**
 * File-write observations, used at read time to suppress echo heartbeats.
 * A separate collection because these are NOT heartbeats: they carry no duration and
 * must never reach the algorithm. `logs` stays exactly what it has always been.
 */
export const AI_WRITES = "aiWrites";

/* -------------------------------------------------------------------------- */
/* Arguments                                                                   */
/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 || argv[i + 1] === undefined ? fallback : argv[i + 1];
};

const opts = {
  apply: has("--apply"),
  quiet: has("--quiet"),
  json: has("--json"),
  force: has("--force"),
  root: value("--root", TRANSCRIPT_ROOT),
  since: value("--since", null),
};

/**
 * Fingerprint of the last successful import, so an unchanged run can skip the
 * database entirely.
 *
 * This matters because the Stop hook fires on EVERY finished turn, while the 120s
 * throttle means most turns produce no new heartbeat at all. Parsing the transcripts
 * costs ~0.4s; the Atlas round trip costs another ~1.3s, and paying it to write
 * nothing is most of the hook's cost.
 *
 * Counts as well as the latest instant: resuming an old session, or a transcript
 * arriving from elsewhere, adds records WITHOUT moving the maximum timestamp. Any of
 * the three changing forces a real write.
 */
const STATE_PATH = path.join(os.homedir(), ".takatime", "claude-import-state.json");

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  } catch {
    // A state file we cannot write costs a round trip next time. Never fatal:
    // failing the import over a cache would turn an optimisation into data loss.
  }
}

const log = (...a) => {
  if (!opts.quiet && !opts.json) process.stdout.write(a.join(" ") + "\n");
};

/* -------------------------------------------------------------------------- */
/* The world                                                                   */
/* -------------------------------------------------------------------------- */

/** Every *.jsonl under a directory, including the subagent transcripts. */
function transcriptFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...transcriptFiles(p));
    else if (entry.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/**
 * Parse a JSONL file, skipping malformed lines.
 *
 * A truncated last line is normal — Claude Code may be mid-write in the session that
 * is invoking this very hook. Throwing there would make the importer fail exactly
 * when it is most useful.
 */
function readTranscript(file) {
  const records = [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return records;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* truncated or corrupt line; the rest of the file is still good */
    }
  }
  return records;
}

/**
 * Project name for a working directory: the basename of its git root.
 *
 * NOT the basename of the cwd. A session started in `TakaTime/analytics` would
 * otherwise be filed under a project called `analytics`, which no editor heartbeat
 * ever uses — the VS Code tracker reports the workspace folder, which is the repo.
 */
const projectCache = new Map();
function projectOf(cwd) {
  if (!cwd) return "unknown";
  if (projectCache.has(cwd)) return projectCache.get(cwd);
  let name;
  try {
    name = path.basename(
      execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      }).trim(),
    );
  } catch {
    // Not a repository, or the directory is gone. Its own name is the best guess.
    name = path.basename(cwd) || "unknown";
  }
  if (!name) name = "unknown";
  projectCache.set(cwd, name);
  return name;
}

/** The `os` value the Go writer would report for this machine. */
function osName() {
  const p = process.platform;
  return p === "darwin" ? "darwin" : p === "win32" ? "win32" : "linux";
}

/**
 * Config regime in force at an instant, straight from CONFIG_REGISTRY.
 *
 * `resolveInterval` reports `exact: false` for a bare timestamp because no
 * `configVersion` was stamped on it — which is precisely the question being asked
 * here, so the flag is irrelevant. The resolved version IS then stamped on the
 * heartbeat, so what lands in the database resolves exactly.
 */
function regimeAt(ms) {
  const r = resolveInterval({ timestamp: ms }, CONFIG_REGISTRY);
  return { intervalSeconds: r.intervalSeconds, version: r.version };
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic `_id` for a heartbeat.
 *
 * Session plus instant is unique because the throttle admits at most one heartbeat
 * per instant, and it is stable across re-runs — which is the whole idempotency
 * story. Readable on purpose: `cc:<session>:<epochMs>` can be traced back to the
 * transcript line that produced it.
 */
function heartbeatId(hb) {
  return `cc:${hb.sessionId}:${hb.timestamp.getTime()}`;
}

/** Deterministic `_id` for a write observation. Hashed because paths are long. */
function writeId(w) {
  const h = crypto.createHash("sha1").update(`${w.ms}␟${w.file}`).digest("hex");
  return `cw:${h.slice(0, 24)}`;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  const files = transcriptFiles(opts.root);
  if (files.length === 0) {
    log(`No transcripts under ${opts.root} — nothing to import.`);
    if (opts.json) process.stdout.write(JSON.stringify({ ok: true, files: 0, inserted: 0 }) + "\n");
    return;
  }

  const records = [];
  for (const f of files) records.push(...readTranscript(f));

  const sinceMs = opts.since ? Date.parse(opts.since) : null;

  const { heartbeats, writes, stats } = buildHeartbeats(records, {
    regimeAt,
    projectOf,
    os: osName(),
  });

  const keptBeats = sinceMs ? heartbeats.filter((h) => h.timestamp.getTime() >= sinceMs) : heartbeats;
  const keptWrites = sinceMs ? writes.filter((w) => w.ms >= sinceMs) : writes;

  log(`TakaTime — Claude Code import (transcript v${TRANSCRIPT_VERSION})`);
  log(`  transcripts        ${files.length} files, ${stats.records} records`);
  log(`  sessions           ${stats.authoringSessions} authoring, ${stats.advisorySessions} advisory (skipped)`);
  log(`  file writes        ${stats.writes}`);
  log(`  heartbeats         ${keptBeats.length}`);

  if (keptBeats.length) {
    const d = computeDurations(keptBeats, { groupBy: ["project"] });
    log(`  attributed         ${formatDuration(d.totalMs)} over ${d.sessionCount} sessions`);
    const top = Object.entries(d.groups.project)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    for (const [p, ms] of top) log(`      ${p.padEnd(28)} ${formatDuration(ms)}`);
  }

  if (!opts.apply) {
    log("");
    log("Dry run. Nothing written. Re-run with --apply to commit.");
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: true, dryRun: true, ...stats }) + "\n");
    }
    return;
  }

  // Nothing new since the last successful import? Then there is nothing to write,
  // because the output is a pure function of the transcripts. Skip the connection.
  const fingerprint = {
    transcriptVersion: TRANSCRIPT_VERSION,
    heartbeats: keptBeats.length,
    writes: keptWrites.length,
    lastMs: Math.max(
      0,
      ...keptBeats.map((h) => h.timestamp.getTime()),
      ...keptWrites.map((w) => w.ms),
    ),
  };
  const previous = readState();
  const unchanged =
    previous &&
    previous.transcriptVersion === fingerprint.transcriptVersion &&
    previous.heartbeats === fingerprint.heartbeats &&
    previous.writes === fingerprint.writes &&
    previous.lastMs === fingerprint.lastMs;

  if (unchanged && !opts.force) {
    log("");
    log("Unchanged since the last import; skipping the database. Use --force to write anyway.");
    if (opts.json) process.stdout.write(JSON.stringify({ ok: true, skipped: true, ...stats }) + "\n");
    return;
  }

  const uri = resolveUri(argv);
  const { client, db } = await connect(argv);
  let insertedBeats = 0;
  let insertedWrites = 0;
  try {
    if (keptBeats.length) {
      const ops = keptBeats.map((hb) => {
        const { sessionId, ...doc } = hb;
        return {
          updateOne: {
            filter: { _id: heartbeatId(hb) },
            // $setOnInsert only. An existing heartbeat is an observation already on
            // the record, and this repository never rewrites those.
            update: { $setOnInsert: { ...doc, sessionId } },
            upsert: true,
          },
        };
      });
      const res = await db.collection(LOGS).bulkWrite(ops, { ordered: false });
      insertedBeats = res.upsertedCount;
    }

    if (keptWrites.length) {
      const ops = keptWrites.map((w) => ({
        updateOne: {
          filter: { _id: writeId(w) },
          update: { $setOnInsert: { timestamp: new Date(w.ms), file: w.file, editor: EDITOR, os: osName() } },
          upsert: true,
        },
      }));
      const res = await db.collection(AI_WRITES).bulkWrite(ops, { ordered: false });
      insertedWrites = res.upsertedCount;
      await db.collection(AI_WRITES).createIndex({ timestamp: 1 });
    }
  } finally {
    await client.close();
  }

  // Only after the writes actually landed. Recording it earlier would let a failed
  // run convince the next one there was nothing to do.
  writeState(fingerprint);

  log("");
  log(`Wrote to ${DB_NAME} at ${safeUri(uri)}`);
  log(`  ${LOGS.padEnd(10)} ${insertedBeats} new heartbeats (${keptBeats.length - insertedBeats} already present)`);
  log(`  ${AI_WRITES.padEnd(10)} ${insertedWrites} new write records (${keptWrites.length - insertedWrites} already present)`);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ ok: true, dryRun: false, insertedBeats, insertedWrites, ...stats }) + "\n",
    );
  }
}

main().catch((err) => {
  process.stderr.write(`import-claude: ${err.message}\n`);
  if (/No MongoDB URI/.test(err.message)) {
    process.stderr.write(
      "\nSet one with:\n  export TAKATIME_MONGO_URI='mongodb+srv://…'\nor put MONGO_URI in ~/.takatime.json (what the extension uses).\n",
    );
  }
  process.exitCode = 1;
});
