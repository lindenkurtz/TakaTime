const vscode = require("vscode");
const path = require("path");
const os = require("os");
const fs = require("fs");
const env = require("./Config");

function showDashboard(context) {
  try {
    // 1. Grab the MongoDB URI from your existing config
    const config = env.getConfig();

    if (!config || !config.MONGO_URI) {
      vscode.window.showErrorMessage(
        "TakaTime: Missing MongoDB URI. Please run setup first!",
      );
      return;
    }

    // 2. Locate the Dashboard Binary
    const homeDir = os.homedir();
    const isWin = process.platform === "win32";
    const ext = isWin ? ".exe" : "";

    // Using the exact naming convention from your download script
    const binName = `taka-dashboard-${env.CURRENT_VERSION}${ext}`;
    const binaryPath = path.join(homeDir, ".takatime", "bin", binName);

    if (!fs.existsSync(binaryPath)) {
      vscode.window.showErrorMessage(
        `TakaTime: Dashboard binary ${binName} not found. Build it from the repo: ./scripts/build-binaries.sh`,
      );
      return;
    }

    // 3. Create a dedicated VS Code Terminal
    const terminal = vscode.window.createTerminal({
      name: "TakaTime Dashboard",
      // Gives the terminal tab a nice little graph icon!
      iconPath: new vscode.ThemeIcon("graph"),
      //   location: vscode.TerminalLocation.Editor,
    });

    // 4. Bring the terminal to the front
    terminal.show();

    // 5. Send the command to execute the Go binary
    // We wrap the path and URI in quotes just in case there are spaces in the user's folder names
    terminal.sendText(`"${binaryPath}" --MongoDBString "${config.MONGO_URI}"`);
  } catch (err) {
    console.error("TakaTime Dashboard Error:", err);
    vscode.window.showErrorMessage("Failed to open TakaTime Dashboard.");
  }
}

module.exports = { showDashboard };
