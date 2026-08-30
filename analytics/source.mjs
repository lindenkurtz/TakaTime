/**
 * Heartbeat retrieval — the impure half of the stats layer.
 *
 * summary.mjs and duration.mjs stay portable; everything that touches MongoDB or the
 * filesystem lives here so those two can be copied into a browser bundle untouched.
 */

import { connect } from "./scripts/_mongo.mjs";
import { SUMMARY_VERSION } from "./summary.mjs";

/**
 * Port server.mjs binds and every client probes. Fixed rather than negotiated
 * through a file: a stats daemon that moves is a stats daemon nothing can find.
 * Loopback only — see server.mjs for why that is the whole security model.
 */
export const DEFAULT_PORT = Number(process.env.TAKATIME_PORT) || 47612;

/**
 * Ask a running server for a prebuilt summary.
 *
 * Returns null on any failure — server down, wrong thing on the port, slow — so
 * callers can fall through to a direct query instead of surfacing an error for what
 * is only a missed optimisation.
 */
export async function fetchSummaryFromServer({ port = DEFAULT_PORT, timeoutMs = 3000, query = "" } = {}) {
  // The timeout is generous on purpose. Nothing listening fails instantly with
  // ECONNREFUSED, so this only ever elapses when the server is up but busy — and in
  // that case waiting beats abandoning it for a direct query that will take longer.
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/summary${query}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body?.summaryVersion) return null;

    // A server started before an upgrade keeps running the OLD summary.mjs — it is a
    // long-lived process the extension spawns and then leaves alone. Serving its
    // response to a newer surface means missing fields at best and silently different
    // MEANINGS at worst (1.x totals are editor time; 2.x totals are the union).
    // Falling back to a direct query is slower and correct.
    if (majorOf(body.summaryVersion) !== majorOf(SUMMARY_VERSION)) return null;

    return body;
  } catch {
    return null;
  }
}

const majorOf = (v) => String(v).split(".")[0];

/**
 * Only the fields the algorithm and the summary actually read.
 *
 * `duration` is deliberately NOT projected. It is legacy, it is wrong to sum, and
 * leaving it out of every read path means no future surface can accidentally reach
 * for it. See METHODOLOGY.md.
 */
export const PROJECTION = {
  _id: 0,
  timestamp: 1,
  project: 1,
  language: 1,
  name: 1,
  gitBranch: 1,
  editor: 1,
  os: 1,
  configVersion: 1,
};

/**
 * Instants at which a coding agent modified a file, written by
 * trackers/claude-code/import-claude.mjs.
 *
 * NOT heartbeats, and deliberately in their own collection: they carry no duration
 * and must never reach the algorithm. summary.mjs uses them for one thing — deciding
 * whether an editor heartbeat is the echo of an agent's write. See summary.mjs.
 */
export const AI_WRITES = "aiWrites";

export const AI_WRITE_PROJECTION = { _id: 0, timestamp: 1, file: 1 };

/**
 * Every agent write, ascending.
 *
 * Returns [] if the collection does not exist, which is the normal state on a
 * machine that has never run the importer. Echo suppression then does nothing, and
 * the summary reports `aiWrites: 0` so the surfaces can say so.
 */
export async function fetchAiWritesFrom(db) {
  try {
    return await db
      .collection(AI_WRITES)
      .find({}, { projection: AI_WRITE_PROJECTION })
      .sort({ timestamp: 1 })
      .toArray();
  } catch {
    return [];
  }
}

/**
 * Every heartbeat, ascending.
 *
 * Fetching the whole collection looks profligate and is not: it is ~2k documents and
 * a few hundred kilobytes, which is cheaper than the round trips a paged design would
 * cost, and it makes streaks and all-time totals fall out for free. Revisit if this
 * passes a few hundred thousand records.
 */
export async function fetchHeartbeats(argv) {
  const { client, db } = await connect(argv);
  try {
    return await db
      .collection("logs")
      .find({}, { projection: PROJECTION })
      .sort({ timestamp: 1 })
      .toArray();
  } finally {
    await client.close();
  }
}

/**
 * Heartbeats and agent writes together, on one connection.
 *
 * Two round trips on one handshake rather than two handshakes: the Atlas connection
 * is the expensive part, and every caller that wants one wants the other.
 */
export async function fetchAll(argv) {
  const { client, db } = await connect(argv);
  try {
    const [heartbeats, aiWrites] = await Promise.all([
      db.collection("logs").find({}, { projection: PROJECTION }).sort({ timestamp: 1 }).toArray(),
      fetchAiWritesFrom(db),
    ]);
    return { heartbeats, aiWrites };
  } finally {
    await client.close();
  }
}

/**
 * A long-lived Mongo connection with an in-memory heartbeat cache.
 *
 * Used by server.mjs. Refreshes on a timer and coalesces concurrent refreshes, so a
 * burst of requests cannot stampede the database.
 */
export class HeartbeatCache {
  constructor({ argv, ttlMs = 60_000 } = {}) {
    this.argv = argv;
    this.ttlMs = ttlMs;
    this.client = null;
    this.db = null;
    this.heartbeats = [];
    this.aiWrites = [];
    this.fetchedAtMs = 0;
    this.inFlight = null;
  }

  async open() {
    if (!this.client) {
      const { client, db } = await connect(this.argv);
      this.client = client;
      this.db = db;
    }
    return this;
  }

  /**
   * Cached heartbeats. `force` waits for a fresh read; otherwise this is
   * stale-while-revalidate.
   *
   * Serving the stale set and refreshing behind it matters more than it looks: a
   * blocking refresh turns every TTL expiry into a request that pays a full Atlas
   * round trip, which is long enough that clients time out and fall back to their own
   * direct query — so the server ends up making things slower exactly when it is
   * doing its job. Heartbeats are throttled to 120s anyway, so a cache up to a minute
   * behind is showing the same number a fresh read would.
   */
  async get({ force = false } = {}) {
    const primed = this.fetchedAtMs !== 0;
    const stale = Date.now() - this.fetchedAtMs > this.ttlMs;

    if (primed && !force) {
      if (stale && !this.inFlight) this.refresh().catch(() => {});
      return { heartbeats: this.heartbeats, aiWrites: this.aiWrites };
    }
    return this.refresh();
  }

  /** Fetch everything, coalescing concurrent callers onto one query. */
  refresh() {
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      try {
        await this.open();
        // Both, together. They are joined at read time, so a refresh that updated
        // one and not the other would suppress echoes against a stale write list.
        const [heartbeats, aiWrites] = await Promise.all([
          this.db.collection("logs").find({}, { projection: PROJECTION }).sort({ timestamp: 1 }).toArray(),
          fetchAiWritesFrom(this.db),
        ]);
        this.heartbeats = heartbeats;
        this.aiWrites = aiWrites;
        this.fetchedAtMs = Date.now();
        return { heartbeats, aiWrites };
      } finally {
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }

  async close() {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
    }
  }
}
