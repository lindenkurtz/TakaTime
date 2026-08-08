// Plugin/Heartbeat.js
const uploader = require("./Uploader");
const vscode = require("vscode");

/**
 * THE THROTTLE — config regime v3.
 *
 * SCOPE IS GLOBAL: one timer for the whole editor, not one per file. Whichever
 * document triggers the first event after the cooldown expires is the one that
 * gets attributed, so a heartbeat always names the most recently edited file.
 *
 * Per-file throttling (regime v1, retired 2026-04-23) emitted a heartbeat per file
 * per interval, which over-weighted projects that happen to keep many files open.
 *
 * If you change this value you MUST add a new entry to the config registry in
 * analytics/duration.mjs and bump CONFIG_VERSION below. Historical data stays
 * correct across the change because durations are derived at query time from
 * timestamps — but only if the registry knows the change happened.
 */
const COOLDOWN_MS = 120 * 1000;

/**
 * Stamped onto every heartbeat so the query-time algorithm never has to guess
 * which throttle produced it. Must match the open-ended entry in CONFIG_REGISTRY.
 */
const CONFIG_VERSION = 3;

let lastHeartbeatTime = 0;

// Logging when Heartbeats are sent
let _outputChannel = null;

function setOutputChannel(channel) {
  _outputChannel = channel;
}

/**
 * Handles the "Heartbeat" logic.
 * Decides if we should actually call the binary or just ignore the event.
 * @param {vscode.TextDocument} document
 */
function handleHeartbeat(document) {
  const filePath = document.fileName;
  const now = Date.now();

  if (now - lastHeartbeatTime < COOLDOWN_MS) return;

  // Logging
  if (_outputChannel) {
    _outputChannel.appendLine(`TakaTime: Heartbeat sent — ${filePath}`);
  }

  // 2. Fire the Upload
  uploader.spawnProcess(document, CONFIG_VERSION);

  // 3. Reset the global timer
  lastHeartbeatTime = now;
}

module.exports = { handleHeartbeat, setOutputChannel, COOLDOWN_MS, CONFIG_VERSION };
