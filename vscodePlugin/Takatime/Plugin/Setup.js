// Plugin/Setup.js
const vscode = require("vscode");
const env = require("./Config");
const statusHelper = require("./StatusBarUpdate"); // Renamed file
const fs = require("fs");
const path = require("path");
const os = require("os");

// Binaries are built from source in this repo, not downloaded.
// This fork's versions are never published to upstream's releases page, which is
// what the old BinaryDownload.js fetched from — it could only ever install a
// version older than the extension asking for it.
const BUILD_COMMAND = "./scripts/build-binaries.sh";

async function runSetup(statusBar) {
  const config = env.getConfig() || {};
  const currentUri = config.MONGO_URI || "";

  const uri = await vscode.window.showInputBox({
    placeHolder: "mongodb+srv://admin:password@...",
    prompt: "Enter (or update) your MongoDB Connection String",
    value: currentUri,
    ignoreFocusOut: true,
    password: true,
  });

  if (uri === undefined) return;

  const homeDir = os.homedir();
  const configPath = path.join(homeDir, ".takatime.json");

  let newConfig = {
    MONGO_URI: uri,
    VERSION: config.VERSION || env.CURRENT_VERSION,
  };

  try {
    fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 4));
    vscode.window.showInformationMessage("Configuration Saved!");
  } catch (e) {
    vscode.window.showErrorMessage("Failed to save config");
    return;
  }

  // Check binaries. We do not download them — they are built from source.
  const isBinaryReady = env.checkBinaries(newConfig.VERSION);
  if (!isBinaryReady) {
    const choice = await vscode.window.showWarningMessage(
      `TakaTime ${newConfig.VERSION} binaries are not installed. Build them from the repo with "${BUILD_COMMAND}".`,
      "Copy Command",
    );
    if (choice === "Copy Command") {
      await vscode.env.clipboard.writeText(BUILD_COMMAND);
      vscode.window.showInformationMessage(`Copied: ${BUILD_COMMAND}`);
    }
  }

  // Update Status Bar
  statusHelper.checkStatus(statusBar);
}

module.exports = { runSetup };
