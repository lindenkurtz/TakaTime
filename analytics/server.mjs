#!/usr/bin/env node
/**
 * TakaTime stats server — one Mongo connection, many surfaces.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The VS Code status bar polls every minute and the webview repaints on demand.
 * Doing that through a fresh Atlas handshake each time costs about a second a go, for
 * a dataset that fits comfortably in memory. This holds the heartbeats, recomputes on
 * request (single-digit milliseconds over ~2k documents), and hands back the same
 * summary object every surface consumes.
 *
 * ---------------------------------------------------------------------------
 * SECURITY MODEL
 * ---------------------------------------------------------------------------
 * Bound to 127.0.0.1 and nothing else. There is no auth, so the entire model is that
 * loopback is only reachable by processes already running as this user — which could
 * read ~/.takatime.json directly anyway. Do NOT change the bind address to 0.0.0.0;
 * that would publish an unauthenticated feed of the Mongo URI's contents to the LAN.
 * The URI itself is never included in a response.
 */

import http from "node:http";
import { buildSummary } from "./summary.mjs";
import { DEFAULT_PORT, HeartbeatCache } from "./source.mjs";

const argv = process.argv.slice(2);

function value(name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1 || argv[i + 1] === undefined) return fallback;
  return argv[i + 1];
}

const PORT = Number(value("--port", DEFAULT_PORT));
const TTL_MS = Number(value("--ttl", 60)) * 1000;
/**
 * Exit after this long with no requests. The extension spawns this server and polls
 * it once a minute, so the timer only ever fires once VS Code is gone and nothing is
 * asking — which keeps an auto-started process from outliving its usefulness.
 * `--exit-after 0` disables it, for running under launchd.
 */
const EXIT_AFTER_MS = Number(value("--exit-after", 1800)) * 1000;

const cache = new HeartbeatCache({ argv, ttlMs: TTL_MS });
const startedAtMs = Date.now();
let lastRequestMs = Date.now();
let requestCount = 0;

/* -------------------------------------------------------------------------- */
/* Routes                                                                      */
/* -------------------------------------------------------------------------- */

function send(res, status, body, contentType = "application/json") {
  const payload = contentType === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(status, {
    "Content-Type": `${contentType}; charset=utf-8`,
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

async function handleSummary(url, res) {
  const q = url.searchParams;
  const heartbeats = await cache.get({ force: q.get("fresh") === "1" });
  const editor = q.get("editor");

  const summary = buildSummary(heartbeats, {
    weekDays: q.has("days") ? Number(q.get("days")) : undefined,
    topN: q.has("topN") ? Number(q.get("topN")) : undefined,
    heatmapDays: q.has("heatmapDays") ? Number(q.get("heatmapDays")) : undefined,
    timeZone: q.get("tz") ?? undefined,
    idleTimeoutSeconds: q.has("idle") ? Number(q.get("idle")) : undefined,
    ...(editor ? { filter: (hb) => hb.editor === editor } : {}),
  });

  send(res, 200, summary);
}

const ROOT = `TakaTime stats server

  GET /api/summary   the summary object every surface renders
                     ?days= ?topN= ?heatmapDays= ?editor= ?tz= ?idle= ?fresh=1
  GET /api/health    liveness, cache age, heartbeat count

Numbers are derived at query time by duration.mjs. The legacy 'duration' field is
never read. See METHODOLOGY.md.

An HTML page belongs at this route — see TODO.md.
`;

const server = http.createServer(async (req, res) => {
  lastRequestMs = Date.now();
  requestCount++;

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === "/api/summary") return await handleSummary(url, res);

    if (url.pathname === "/api/health") {
      // Deliberately does NOT touch the cache: this has to answer while a refresh is
      // in flight, or a client probing for liveness would block on the database.
      return send(res, 200, {
        ok: true,
        pid: process.pid,
        port: PORT,
        uptimeMs: Date.now() - startedAtMs,
        requestCount,
        heartbeats: cache.heartbeats.length,
        cacheAgeMs: cache.fetchedAtMs ? Date.now() - cache.fetchedAtMs : null,
        ttlMs: TTL_MS,
      });
    }

    if (url.pathname === "/") return send(res, 200, ROOT, "text/plain");

    send(res, 404, { error: "not found", see: "/" });
  } catch (err) {
    // The URI can appear in driver error messages; never let it reach a response body.
    send(res, 500, { error: err.message.replace(/mongodb(\+srv)?:\/\/\S+/g, "<uri>") });
  }
});

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

server.listen(PORT, "127.0.0.1", async () => {
  process.stdout.write(`takatime stats server on http://127.0.0.1:${PORT} (pid ${process.pid})\n`);
  try {
    await cache.get({ force: true });
    process.stdout.write(`cached ${cache.heartbeats.length} heartbeats\n`);
  } catch (err) {
    // Warm-up failure is not fatal: Mongo may just be slow or briefly unreachable, and
    // the next request retries. Exiting here would make the extension respawn in a loop.
    process.stderr.write(`warm-up failed, will retry on demand: ${err.message}\n`);
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    // Almost always another copy of this server, which is a success condition for
    // whoever spawned us. Exit 0 so a supervisor does not treat it as a crash.
    process.stderr.write(`port ${PORT} already in use — assuming another server is up\n`);
    process.exit(0);
  }
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});

if (EXIT_AFTER_MS > 0) {
  const timer = setInterval(() => {
    if (Date.now() - lastRequestMs > EXIT_AFTER_MS) {
      process.stdout.write(`idle for ${Math.round(EXIT_AFTER_MS / 1000)}s, exiting\n`);
      shutdown(0);
    }
  }, 60_000);
  timer.unref();
}

async function shutdown(code) {
  server.close();
  await cache.close().catch(() => {});
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
