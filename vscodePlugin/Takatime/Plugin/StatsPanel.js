// Plugin/StatsPanel.js
//
// The full dashboard, as a webview panel.
//
// The extension host fetches the summary and posts it in; the webview never talks to
// the network itself. That keeps the content security policy strict — no connect-src
// hole for a loopback port — and means the panel renders identically whether the data
// came from the server or from a cached last-known-good.

const vscode = require("vscode");

/** Only one panel; a second invocation reveals the existing one. */
let current = null;

function nonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function html(webview, extensionUri) {
  const asset = (...parts) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...parts));
  const n = nonce();
  const css = asset("media", "panel.css");
  const js = asset("media", "panel.js");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${n}';">
<link href="${css}" rel="stylesheet">
<title>TakaTime</title>
</head>
<body>
<div id="root" class="loading">
  <div class="empty">
    <div class="empty-title">Loading…</div>
    <div class="empty-body">Asking the stats server for your heartbeats.</div>
  </div>
</div>
<script nonce="${n}" src="${js}"></script>
</body>
</html>`;
}

class StatsPanel {
  constructor(panel, extensionUri, client) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.client = client;
    this.disposables = [];

    this.panel.webview.html = html(this.panel.webview, extensionUri);

    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg?.type === "refresh") this.refresh({ force: true });
        if (msg?.type === "ready") this.refresh();
      },
      null,
      this.disposables,
    );

    // Repaint when the panel comes back into view — the numbers are stale by then.
    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.visible) this.refresh();
      },
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Only poll while the panel is actually on screen.
    this.timer = setInterval(() => {
      if (this.panel.visible) this.refresh();
    }, 60_000);
  }

  async refresh({ force = false } = {}) {
    const summary = await this.client.getSummary({ force });
    if (summary) {
      this.panel.webview.postMessage({ type: "summary", summary });
      return;
    }
    this.panel.webview.postMessage({
      type: "error",
      message:
        this.client.lastError ??
        "Could not reach the stats server. Run ./scripts/build-binaries.sh from the repo to install it.",
      // Holding the last good render beats flashing an empty state — see the
      // "skeleton flash on refetch" anti-pattern.
      stale: this.client.lastSummary ?? null,
    });
  }

  dispose() {
    current = null;
    clearInterval(this.timer);
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}

function showStatsPanel(context, client) {
  const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

  if (current) {
    current.panel.reveal(column);
    current.refresh({ force: true });
    return current;
  }

  const panel = vscode.window.createWebviewPanel("takatime.stats", "TakaTime", column, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
  });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "public", "TakatimeLogo.png");

  current = new StatsPanel(panel, context.extensionUri, client);
  return current;
}

module.exports = { showStatsPanel };
