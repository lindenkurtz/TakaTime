// Plugin/StatsClient.js
//
// Talks to the local stats server (analytics/server.mjs) and starts one if it is not
// already up.
//
// WHY NOT QUERY MONGO FROM HERE: the duration algorithm lives in analytics/duration.mjs
// and is deliberately the only implementation of it (see METHODOLOGY.md). Reaching for
// the database from the extension would mean either a second implementation or a
// copy of the module that silently drifts. The extension asks the server instead and
// stays free of both the algorithm and the `mongodb` dependency.

const vscode = require("vscode");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const DEFAULT_PORT = 47612;

/** Where build-binaries.sh installs the analytics bundle. */
function analyticsDir() {
  const configured = vscode.workspace.getConfiguration("takatime").get("stats.analyticsPath");
  if (configured) return configured;
  return path.join(os.homedir(), ".takatime", "analytics");
}

function settings() {
  const cfg = vscode.workspace.getConfiguration("takatime");
  return {
    port: cfg.get("stats.port") || DEFAULT_PORT,
    autoStart: cfg.get("stats.autoStartServer") !== false,
    weekDays: cfg.get("stats.weekDays") || 7,
    refreshSeconds: Math.max(15, cfg.get("stats.refreshSeconds") || 60),
  };
}

/**
 * GET a JSON endpoint on loopback.
 *
 * Uses node:http rather than global fetch because the extension declares support back
 * to VS Code 1.80, whose Electron ships a Node without a global fetch.
 */
function getJson(port, pathname, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: pathname, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} from ${pathname}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class StatsClient {
  constructor(outputChannel) {
    this.output = outputChannel;
    this.starting = null;
    this.lastSummary = null;
    this.lastError = null;
  }

  log(message) {
    this.output?.appendLine(`[stats] ${message}`);
  }

  serverPath() {
    return path.join(analyticsDir(), "server.mjs");
  }

  /**
   * Spawn a server if nothing answers on the port.
   *
   * Concurrent callers share one attempt — the status bar poll and a panel opening at
   * the same moment must not race into two servers. (The server itself also exits 0 on
   * EADDRINUSE, so losing that race is harmless, just noisy.)
   */
  async ensureServer() {
    const { port, autoStart } = settings();
    try {
      await getJson(port, "/api/health", 800);
      return true;
    } catch {
      /* nothing listening — fall through */
    }
    if (!autoStart) return false;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      try {
        const serverPath = this.serverPath();
        if (!fs.existsSync(serverPath)) {
          this.lastError = `Analytics bundle not installed at ${analyticsDir()}. Run ./scripts/build-binaries.sh from the repo.`;
          this.log(this.lastError);
          return false;
        }

        // process.execPath is VS Code's own Electron binary; ELECTRON_RUN_AS_NODE
        // makes it behave as plain Node. This guarantees a runtime exists without
        // depending on `node` being on a PATH the extension host inherited — which on
        // macOS it often is not, when VS Code was launched from the Dock.
        this.log(`starting server: ${serverPath}`);
        const child = spawn(process.execPath, [serverPath, "--port", String(port)], {
          detached: process.platform !== "win32",
          stdio: "ignore",
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          windowsHide: true,
        });
        child.unref();

        // Warm-up is a Mongo handshake, so give it a few seconds before giving up.
        for (let i = 0; i < 12; i++) {
          await sleep(500);
          try {
            await getJson(port, "/api/health", 800);
            this.log("server is up");
            this.lastError = null;
            return true;
          } catch {
            /* keep waiting */
          }
        }
        this.lastError = "Stats server did not come up within 6s.";
        this.log(this.lastError);
        return false;
      } finally {
        this.starting = null;
      }
    })();

    return this.starting;
  }

  /**
   * The summary object, or null if it could not be fetched.
   *
   * Never throws: every caller here is a background refresh or a repaint, and an
   * exception would be reported as a broken extension rather than as "the stats
   * server is not running yet".
   */
  async getSummary({ force = false } = {}) {
    const { port, weekDays } = settings();
    const query = `/api/summary?days=${weekDays}&topN=8&heatmapDays=182${force ? "&fresh=1" : ""}`;
    try {
      const summary = await getJson(port, query);
      this.lastSummary = summary;
      this.lastError = null;
      return summary;
    } catch {
      const up = await this.ensureServer();
      if (!up) return null;
      try {
        const summary = await getJson(port, query);
        this.lastSummary = summary;
        this.lastError = null;
        return summary;
      } catch (err) {
        this.lastError = err.message;
        this.log(`fetch failed: ${err.message}`);
        return null;
      }
    }
  }
}

module.exports = { StatsClient, analyticsDir, settings, DEFAULT_PORT };
