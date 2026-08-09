const vscode = require("vscode");
const env = require("./Config");

// This item is an EXCEPTION REPORT, not a status display.
//
// It used to sit there reading "TakaTime: Active (v2.3.0)" whenever things were fine,
// which is the state you are in essentially always — so it spent its life as a second
// "TakaTime:" label immediately beside the stats item, competing with the session
// indicator that actually changes. It now shows itself only when something needs doing,
// and the stats item carries the healthy case.
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
      statusBar.show();
      return;
    }

    //  Updated to checkBinaries (plural)
    const areBinariesReady = env.checkBinaries(env.CURRENT_VERSION);
    if (!areBinariesReady) {
      statusBar.text = "$(tools) TakaTime: Binaries Missing";
      statusBar.tooltip = `Binaries for ${env.CURRENT_VERSION} are not installed. Build them from the repo: ./scripts/build-binaries.sh`;
      statusBar.backgroundColor = undefined; // Reset color
      statusBar.show();
      return;
    }

    // Healthy: say nothing. The stats item is the visible surface.
    statusBar.backgroundColor = undefined;
    statusBar.hide();
  } catch (err) {
    console.error(err);
    statusBar.text = "$(error) TakaTime: Error";
    statusBar.tooltip = err.message;
    statusBar.show();
  }
}

module.exports = {
  checkStatus,
};
