const vscode = require("vscode");
const env = require("./Config");

function checkStatus(statusBar) {
  try {
    const config = env.getConfig();

    if (!config || !config.MONGO_URI) {
      statusBar.text = "$(alert) TakaTime: Setup Needed";
      statusBar.tooltip = "Click to configure MongoDB URI";
      // Highlight with a warning color
      statusBar.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground",
      );
      return;
    }

    //  Updated to checkBinaries (plural)
    const areBinariesReady = env.checkBinaries(env.CURRENT_VERSION);
    if (!areBinariesReady) {
      statusBar.text = "$(tools) TakaTime: Binaries Missing";
      statusBar.tooltip = `Binaries for ${env.CURRENT_VERSION} are not installed. Build them from the repo: ./scripts/build-binaries.sh`;
      statusBar.backgroundColor = undefined; // Reset color
      return;
    }

    // Success State
    statusBar.text = `$(check) TakaTime: Active (${env.CURRENT_VERSION})`;
    statusBar.tooltip = `Tracking to: ${config.MONGO_URI.substring(0, 15)}...`;
    statusBar.backgroundColor = undefined;
  } catch (err) {
    console.error(err);
    statusBar.text = "$(error) TakaTime: Error";
    statusBar.tooltip = err.message;
  }
}

module.exports = {
  checkStatus,
};
