const vscode = require("vscode");
const path = require("path");
const statusHelper = require("./Plugin/StatusBarUpdate");
const setupHelper = require("./Plugin/Setup");
const heartbeat = require("./Plugin/HeartBeat");
const { showDashboard } = require("./Plugin/showDashboard");
const { StatsClient } = require("./Plugin/StatsClient");
const { StatsBar } = require("./Plugin/StatsBar");
const { showStatsPanel } = require("./Plugin/StatsPanel");

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
  const outputChannel = vscode.window.createOutputChannel("TakaTime");
  context.subscriptions.push(outputChannel);
  heartbeat.setOutputChannel(outputChannel);

  // 1. Status Bar
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusBar.text = "$(sync~spin) TakaTime: Checking...";
  statusBar.command = "takatime.setup";
  statusBar.show();
  context.subscriptions.push(statusBar);

  // 2. Setup Command
  const setupCommand = vscode.commands.registerCommand("takatime.setup", () => {
    setupHelper.runSetup(statusBar);
  });
  context.subscriptions.push(setupCommand);

  // ... your other existing setup code ...

  // 2b. Stats surfaces.
  //
  // Both read the same summary object from the local stats server, which is the only
  // thing that runs analytics/duration.mjs. Nothing here computes a duration.
  const statsClient = new StatsClient(outputChannel);

  const statsCommand = vscode.commands.registerCommand("takatime.showStats", () => {
    showStatsPanel(context, statsClient);
  });
  context.subscriptions.push(statsCommand);

  const statsBar = new StatsBar(statsClient);
  statsBar.start();
  context.subscriptions.push({ dispose: () => statsBar.dispose() });

  // Picking up a changed port or refresh interval should not need a window reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("takatime.stats")) {
        statsBar.show();
        statsBar.refresh();
      }
    }),
  );

  // The legacy Go TUI. Kept reachable from the command palette, but no longer given a
  // status bar button: its aggregations sum the legacy `duration` field, which is
  // wrong (METHODOLOGY.md) and reads as zero for v3 records that have no such field.
  const dashCommand = vscode.commands.registerCommand(
    "takatime.showDashboard",
    () => {
      showDashboard(context);
    },
  );
  context.subscriptions.push(dashCommand);

  // 3a. Text-document Save Listener
  const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
    // Filter out junk
    if (document.uri.scheme !== "file") return;
    if (document.fileName.includes(path.sep + ".git" + path.sep)) return;

    // 👇 CALL THE HEARTBEAT MANAGER
    heartbeat.handleHeartbeat(document);
  });

  context.subscriptions.push(saveListener);

  // 3b. Text-document typing Listener
  const typingListener = vscode.workspace.onDidChangeTextDocument((event) => {
    const document = event.document;

    // Filter out junk
    if (document.uri.scheme !== "file") return;
    if (document.fileName.includes(path.sep + ".git" + path.sep)) return;
    if (event.contentChanges.length === 0) return; // ignore no-op changes

    heartbeat.handleHeartbeat(document); 
  });

  context.subscriptions.push(typingListener);

  // 3c. Notebook Save Listener
  const notebookSaveListener = vscode.workspace.onDidSaveNotebookDocument((notebook) => {
    // Filter out junk
    if (notebook.uri.scheme !== "file") return;
    if (notebook.uri.fsPath.includes(path.sep + ".git" + path.sep)) return;
    
    // Construct a minimal document-like object so handleHeartbeat works unchanged
    const mockDocument = {
      fileName: notebook.uri.fsPath,
      uri: notebook.uri,
      languageId: notebook.notebookType || "unknown-notebook"
    };
    heartbeat.handleHeartbeat(mockDocument);
  });

  context.subscriptions.push(notebookSaveListener);

  // 3d. Notebook Typing Listener
  const notebookTypingListener = vscode.workspace.onDidChangeNotebookDocument((event) => {
    const notebook = event.notebook;

    // Filter out junk
    if (notebook.uri.scheme !== "file") return;
    if (notebook.uri.fsPath.includes(path.sep + ".git" + path.sep)) return;
    if (event.contentChanges.length === 0 && event.cellChanges.length === 0) return;

    const mockDocument = {
      fileName: notebook.uri.fsPath,
      uri: notebook.uri,
      languageId: notebook.notebookType || "unknown-notebook"
    };
    heartbeat.handleHeartbeat(mockDocument);
  });

  context.subscriptions.push(notebookTypingListener);

  // 4. Initial Check
  statusHelper.checkStatus(statusBar);
}

function deactivate() {}

module.exports = { activate, deactivate };
