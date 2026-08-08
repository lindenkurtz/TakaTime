const vscode = require("vscode");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");
const env = require("./Config");

/**
 * Prepares the arguments for the Go binary
 * @param {vscode.TextDocument} document
 * @param {string} mongoUri - We need to pass this explicitly now
 * @param {number} configVersion - Tracker config regime in force for this heartbeat
 */
function getGoArgs(document, mongoUri, configVersion) {
  const filePath = document.fileName;
  const language = document.languageId || "unknown"; // VS Code knows the language!

  // Detect Project Name
  let projectName = "Unknown";
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (workspaceFolder) {
    projectName = workspaceFolder.name;
  }

  // NOTE: `-duration` is deliberately NOT passed any more.
  //
  // A heartbeat is an observation, not a duration. The old flag wrote the throttle
  // interval into every record as if it were measured time, which silently broke
  // when the throttle changed. Durations are now derived at query time from
  // timestamps (see analytics/duration.mjs), and `-configVersion` is what lets that
  // computation know which throttle produced this record.
  return [
    "-file",
    filePath,
    "-project",
    projectName,
    "-language",
    language,
    "-uri",
    mongoUri, // Passing URI as flag (required by your binary)
    "-configVersion",
    String(configVersion),
    "-editor",
    "VsCode",
    // "Antigravity",
  ];
}

/**
 * Spawns the binary in the background
 * @param {vscode.TextDocument} document
 * @param {number} configVersion
 */
function spawnProcess(document, configVersion) {
  const config = env.getConfig();
  if (!config || !config.MONGO_URI) return;

  // 👉 1. Locate Binary (UPDATED to match the new 'taka-upload' naming convention)
  const homeDir = os.homedir();
  const isWin = process.platform === "win32";
  const ext = isWin ? ".exe" : "";

  // Notice: 'taka-upload', not 'taka-uploader'!
  const binName = `taka-upload-${env.CURRENT_VERSION}${ext}`;

  const binaryPath = path.join(homeDir, ".takatime", "bin", binName);

  if (!fs.existsSync(binaryPath)) {
    // Expected right after a version bump, until the matching binary is installed.
    // Failing closed is deliberate: a v2.2.x binary does not understand
    // -configVersion and would reject the whole invocation anyway.
    console.warn(
      `TakaTime: Binary not found at ${binaryPath}, skipping upload.`,
    );
    return;
  }

  // 2. Spawn (Fire & Forget)
  try {
    // We pass 'config.MONGO_URI' to our helper now
    const args = getGoArgs(document, config.MONGO_URI, configVersion);

    const child = spawn(binaryPath, args, {
      detached: !isWin,
      stdio: "ignore", // Change to "inherit" if you want to see logs in Debug Console
      env: {
        ...process.env,
      },
      windowsHide: true,
    });
    child.unref();
    console.log(`TakaTime: Uploading ${path.basename(document.fileName)}...`);
  } catch (err) {
    console.error("TakaTime: Failed to spawn process", err);
  }
}

module.exports = { spawnProcess };
