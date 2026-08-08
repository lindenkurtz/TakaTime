#!/usr/bin/env node
/**
 * Migration: publish the `configs` registry and backfill `configVersion` onto
 * existing heartbeats.
 *
 * ADDITIVE ONLY. This script performs exactly one kind of write to `logs`:
 *
 *     { $set: { configVersion: <int> } }
 *
 * It never deletes, never renames, and never touches `duration` or any other
 * existing field. The raw log is an observation record; it is not ours to edit.
 *
 * Idempotent: only heartbeats that are MISSING `configVersion` are considered,
 * so re-running is a no-op once everything is stamped.
 *
 * Usage:
 *   node scripts/migrate-config-version.mjs             # dry run (default)
 *   node scripts/migrate-config-version.mjs --apply     # actually write
 *   node scripts/migrate-config-version.mjs --apply --uri "mongodb+srv://..."
 */
import { CONFIG_REGISTRY, ALGORITHM_VERSION } from "../duration.mjs";
import { connect, resolveUri, safeUri, LOGS, CONFIGS, MIGRATIONS } from "./_mongo.mjs";

const MIGRATION_ID = "v3_config_version_backfill";

/**
 * Every editor is stamped by regime window.
 *
 * The Mathematica tracker was previously excluded, because its throttle history was
 * unknown and stamping it with a VS Code config version would have asserted something
 * not known to be true. Its source now lives in trackers/mathematica/, and the data
 * confirms it shared the VS Code regime timeline exactly:
 *
 *   duration=120  in the v1 window  (51 heartbeats, 2026-04-13 .. 04-23)
 *   duration=300  in the v2 window  (51 heartbeats, 2026-04-23 .. 08-08)
 *   duration=30   on 2026-05-21     ( 9 heartbeats, a brief experiment)
 *
 * So one linear registry covers both trackers, and no per-tracker keying is needed.
 *
 * The nine 30-second heartbeats are stamped v2 along with the rest of their window.
 * They sit inside a single session, so the worst case is one session head credited
 * 300s instead of 30s — 270 seconds, once, across the entire history. A fourth
 * regime for a one-off experiment would cost more clarity than it buys accuracy.
 */
const UNMIGRATED_EDITORS = [];

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const uri = resolveUri(argv);

  console.log(`TakaTime configVersion migration  (${MIGRATION_ID})`);
  console.log(`  target : ${safeUri(uri)}`);
  console.log(`  mode   : ${apply ? "APPLY (writes enabled)" : "DRY RUN (no writes — pass --apply to commit)"}`);
  console.log("");

  const { client, db } = await connect(argv);
  try {
    const logs = db.collection(LOGS);

    /* ---------------------------------------------------------------- */
    /* 1. Publish the config registry                                     */
    /* ---------------------------------------------------------------- */
    console.log("1. configs collection");
    for (const cfg of CONFIG_REGISTRY) {
      const doc = { ...cfg, updatedAt: new Date(), sourceAlgorithmVersion: ALGORITHM_VERSION };
      console.log(
        `   v${cfg.version}  ${String(cfg.intervalSeconds).padStart(3)}s  ${cfg.scope.padEnd(8)}  ${cfg.from} -> ${cfg.to ?? "(open)"}`,
      );
      if (apply) {
        await db.collection(CONFIGS).updateOne({ version: cfg.version }, { $set: doc }, { upsert: true });
      }
    }
    console.log(`   ${apply ? "upserted" : "would upsert"} ${CONFIG_REGISTRY.length} config documents`);
    console.log("");

    /* ---------------------------------------------------------------- */
    /* 2. Backfill configVersion                                          */
    /* ---------------------------------------------------------------- */
    console.log("2. logs backfill");

    const total = await logs.countDocuments({});
    const alreadyStamped = await logs.countDocuments({ configVersion: { $exists: true } });
    console.log(`   ${total} heartbeats total, ${alreadyStamped} already stamped`);

    let stamped = 0;
    for (const cfg of CONFIG_REGISTRY) {
      // Only CLOSED regimes are backfilled. The open-ended current regime (to: null)
      // is the extension's job to stamp at write time — a heartbeat landing in that
      // window without a stamp came from an old binary, and guessing its interval
      // would hide a real deployment problem.
      if (cfg.to === null) {
        const open = await logs.countDocuments({
          configVersion: { $exists: false },
          timestamp: { $gte: new Date(cfg.from) },
          editor: { $nin: UNMIGRATED_EDITORS },
        });
        console.log(
          `   v${cfg.version}  skipped (open-ended regime; stamped at write time) — ${open} unstamped heartbeat(s) in window`,
        );
        continue;
      }

      const filter = {
        configVersion: { $exists: false },
        editor: { $nin: UNMIGRATED_EDITORS },
        timestamp: { $gte: new Date(cfg.from), $lt: new Date(cfg.to) },
      };

      const n = await logs.countDocuments(filter);
      if (apply && n > 0) {
        const res = await logs.updateMany(filter, { $set: { configVersion: cfg.version } });
        console.log(`   v${cfg.version}  ${res.modifiedCount} heartbeats stamped`);
        stamped += res.modifiedCount;
      } else {
        console.log(`   v${cfg.version}  ${n} heartbeats ${apply ? "stamped" : "would be stamped"}`);
        stamped += n;
      }
    }

    if (UNMIGRATED_EDITORS.length > 0) {
      const skipped = await logs.countDocuments({
        configVersion: { $exists: false },
        editor: { $in: UNMIGRATED_EDITORS },
      });
      console.log(`   ${skipped} heartbeats intentionally left unstamped (editor in ${UNMIGRATED_EDITORS.join(", ")})`);
    }

    const orphans = await logs.countDocuments({
      configVersion: { $exists: false },
      editor: { $nin: UNMIGRATED_EDITORS },
      timestamp: { $lt: new Date(CONFIG_REGISTRY[0].from) },
    });
    if (orphans > 0) {
      console.log(`   WARNING: ${orphans} heartbeats predate the config registry and were not stamped`);
    }
    console.log("");

    /* ---------------------------------------------------------------- */
    /* 3. Record the run                                                  */
    /* ---------------------------------------------------------------- */
    if (apply) {
      await db.collection(MIGRATIONS).updateOne(
        { _id: MIGRATION_ID },
        {
          $set: {
            ranAt: new Date(),
            stampedCount: stamped,
            skippedEditors: UNMIGRATED_EDITORS,
            algorithmVersion: ALGORITHM_VERSION,
          },
        },
        { upsert: true },
      );
      console.log(`3. recorded run in "${MIGRATIONS}" as ${MIGRATION_ID}`);
    } else {
      console.log(`3. would record run in "${MIGRATIONS}" as ${MIGRATION_ID}`);
    }

    /* ---------------------------------------------------------------- */
    /* 4. Verify nothing else moved                                       */
    /* ---------------------------------------------------------------- */
    const durationStillPresent = await logs.countDocuments({ duration: { $exists: true } });
    console.log("");
    console.log(`   sanity: ${total} heartbeats, ${durationStillPresent} still carry the legacy \`duration\` field (expected: unchanged)`);
    console.log(apply ? "\nDone." : "\nDry run complete. Re-run with --apply to commit.");
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exitCode = 1;
});
