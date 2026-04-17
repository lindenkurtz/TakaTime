// Plugin/Heartbeat.js
const uploader = require("./Uploader");
const vscode = require("vscode");

// Key: File Path, Value: Last Timestamp (ms)
const fileTimestamps = new Map();

// ⏳ THE COOLDOWN (Standard is 2 minutes)
const COOLDOWN_MS = 120 * 1000;

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
  const lastSaved = fileTimestamps.get(filePath) || 0;

  // 1. Check Debounce/Throttle
  // If it hasn't been 2 mins since the last ping for THIS file...
  if (now - lastSaved < COOLDOWN_MS) {
    // ... We skip it. (Optional: Log it for debugging)
    // console.log("TakaTime: Debounced (Skipped)");
    return;
  }

  // Logging
  if (_outputChannel) {
    _outputChannel.appendLine(`TakaTime: Heartbeat sent — ${filePath}`);
  }

  // 2. Fire the Upload
  uploader.spawnProcess(document);

  // 3. Reset the Timer for this file
  fileTimestamps.set(filePath, now);
}

module.exports = { handleHeartbeat, setOutputChannel };
