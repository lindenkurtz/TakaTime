// Plugin/Config.js
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");

// CHANGE THIS TO v2.0.4
const CURRENT_VERSION = "v2.4.0";

function getConfig() {
  const homeDir = os.homedir();
  const configPath = path.join(homeDir, ".takatime.json");

  // 1. Create if missing
  if (!fs.existsSync(configPath)) {
    // For brevity, assuming you kept the creation code same as before
    const defaultConfig = { MONGO_URI: "", VERSION: CURRENT_VERSION };
    try {
      fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 4));
      return null;
    } catch (e) {
      return null;
    }
  }

  // 2. Read Config
  try {
    const rawConfig = fs.readFileSync(configPath, "utf8");
    let config = JSON.parse(rawConfig);

    // AUTO-UPDATE LOGIC
    // If the file version (e.g., v2.0.3) doesn't match Code version (v2.0.4)
    if (config.VERSION !== CURRENT_VERSION) {
      console.log(
        `TakaTime: Upgrading config from ${config.VERSION} to ${CURRENT_VERSION}`,
      );

      config.VERSION = CURRENT_VERSION; // Update the object

      // Save it back to the file immediately
      fs.writeFileSync(configPath, JSON.stringify(config, null, 4));

      vscode.window.showInformationMessage(
        `TakaTime: Updated to ${CURRENT_VERSION}. Click status bar to download new binary.`,
      );
    }

    if (!config.MONGO_URI) {
      // ... warning logic ...
      return null;
    }

    return config;
  } catch (err) {
    return null;
  }
}

// ... checkBinary logic stays the same ...
// ... module.exports ...

// We accept 'version' here now, which we will use later for downloading
function checkBinaries(version) {
  const homeDir = os.homedir();
  const binDir = path.join(homeDir, ".takatime", "bin");
  const ext = process.platform === "win32" ? ".exe" : "";

  // The exact names we used in the download script!
  const uploadBinary = path.join(binDir, `taka-upload-${version}${ext}`);
  const dashBinary = path.join(binDir, `taka-dashboard-${version}${ext}`);

  // Return true ONLY if both files exist on the user's computer
  return fs.existsSync(uploadBinary) && fs.existsSync(dashBinary);
}

module.exports = {
  getConfig,
  checkBinaries,
  CURRENT_VERSION,
};
