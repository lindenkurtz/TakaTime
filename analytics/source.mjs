/**
 * Heartbeat retrieval — the impure half of the stats layer.
 *
 * summary.mjs and duration.mjs stay portable; everything that touches MongoDB or the
 * filesystem lives here so those two can be copied into a browser bundle untouched.
 */

import { connect } from "./scripts/_mongo.mjs";

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
    return body?.summaryVersion ? body : null;
  } catch {
    return null;
  }
}

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
      return this.heartbeats;
    }
    return this.refresh();
  }

  /** Fetch everything, coalescing concurrent callers onto one query. */
  refresh() {
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      try {
        await this.open();
        this.heartbeats = await this.db
          .collection("logs")
          .find({}, { projection: PROJECTION })
          .sort({ timestamp: 1 })
          .toArray();
        this.fetchedAtMs = Date.now();
        return this.heartbeats;
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
