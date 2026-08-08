/**
 * Shared connection helper for the maintenance scripts.
 * NOT part of the portable algorithm — duration.mjs must never import this.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MongoClient } from "mongodb";

export const DB_NAME = "takatime";
export const LOGS = "logs";
export const CONFIGS = "configs";
export const MIGRATIONS = "migrations";

/**
 * Resolve the MongoDB URI. Precedence:
 *   1. --uri <value> on the command line
 *   2. $TAKATIME_MONGO_URI / $MONGO_URI
 *   3. MONGO_URI in ~/.takatime.json (what the extension itself uses)
 */
export function resolveUri(argv = process.argv.slice(2)) {
  const flagIndex = argv.indexOf("--uri");
  if (flagIndex !== -1 && argv[flagIndex + 1]) return argv[flagIndex + 1];

  if (process.env.TAKATIME_MONGO_URI) return process.env.TAKATIME_MONGO_URI;
  if (process.env.MONGO_URI) return process.env.MONGO_URI;

  const configPath = path.join(os.homedir(), ".takatime.json");
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (cfg.MONGO_URI) return cfg.MONGO_URI;
    } catch {
      /* fall through to the error below */
    }
  }

  throw new Error(
    "No MongoDB URI found. Pass --uri <uri>, set $TAKATIME_MONGO_URI, or put MONGO_URI in ~/.takatime.json",
  );
}

export async function connect(argv) {
  const client = new MongoClient(resolveUri(argv));
  await client.connect();
  return { client, db: client.db(DB_NAME) };
}

/** Redact credentials so a URI can be printed in logs. */
export function safeUri(uri) {
  return uri.replace(/\/\/[^@]+@/, "//<redacted>@");
}
