const vscode = require("vscode");
const path = require("path");
const statusHelper = require("./Plugin/StatusBarUpdate");
const setupHelper = require("./Plugin/Setup");
const heartbeat = require("./Plugin/HeartBeat");
const { showDashboard } = require("./Plugin/showDashboard");

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

  // Register the dashboard command
  const dashCommand = vscode.commands.registerCommand(
    "takatime.showDashboard",
    () => {
      showDashboard(context);
    },
  );

  // Don't forget to push it to subscriptions so VS Code can clean it up later!
  context.subscriptions.push(dashCommand);

  // --- Create Dashboard Button in Status Bar ---
  const dashStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    99, // This priority number keeps it right next to your main status item (100)
  );
  dashStatusBar.text = "$(graph)  TakaTime Dashboard";
  dashStatusBar.tooltip = "Open TakaTime Dashboard";
  dashStatusBar.command = "takatime.showDashboard";
  dashStatusBar.show();

  context.subscriptions.push(dashStatusBar);

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

  // 3e. Terminal Command Listener
  const terminalCommandListener = vscode.window.onDidStartTerminalShellExecution((event) => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const mockUri = workspaceFolder 
      ? vscode.Uri.joinPath(workspaceFolder.uri, ".takatime", "terminal")
      : vscode.Uri.parse("file:///.takatime/terminal");
    
    const mockDocument = {
      fileName: mockUri.fsPath,
      uri: mockUri,
      languageId: "zsh"
    };

    heartbeat.handleHeartbeat(mockDocument);
  });

  context.subscriptions.push(terminalCommandListener);

  // 4. Initial Check
  statusHelper.checkStatus(statusBar);
}

function deactivate() {}

module.exports = { activate, deactivate };
