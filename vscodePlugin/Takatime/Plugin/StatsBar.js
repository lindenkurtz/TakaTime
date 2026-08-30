// Plugin/StatsBar.js
//
// The always-visible surface: am I in a session, how long has it been, and how much is
// that today.
//
// This is the one that gets read fifty times a day, so it carries session state first
// — it is the only number that changes while you watch it — then today's total.
// The trailing week, streak and leaderboards live in the hover; everything else is in
// the panel behind a click.

const vscode = require("vscode");
const { formatCompact, formatAgo, shorten, FOOTER } = require("./format");
const { settings } = require("./StatsClient");

class StatsBar {
  constructor(client) {
    this.client = client;
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    this.item.command = "takatime.showStats";
    this.item.text = "$(watch) TakaTime";
    this.item.tooltip = "Loading coding stats…";
    this.timer = null;
  }

  show() {
    const mode = vscode.workspace.getConfiguration("takatime").get("stats.statusBar");
    if (mode === "hidden") {
      this.item.hide();
      return;
    }
    this.item.show();
  }

  start() {
    this.show();
    this.refresh();
    const { refreshSeconds } = settings();
    this.timer = setInterval(() => this.refresh(), refreshSeconds * 1000);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.item.dispose();
  }

  async refresh() {
    const summary = await this.client.getSummary();
    if (!summary) {
      this.item.color = undefined;
      this.item.text = "$(watch) TakaTime $(warning)";
      this.item.tooltip = new vscode.MarkdownString(
        `**TakaTime stats unavailable**\n\n${this.client.lastError ?? "The stats server is not responding."}\n\nClick to retry.`,
      );
      return;
    }
    this.render(summary);
  }

  render(summary) {
    const mode =
      vscode.workspace.getConfiguration("takatime").get("stats.statusBar") || "session-and-today";
    const live = summary.currentSession;
    const today = formatCompact(summary.today.ms);

    // The session indicator is carried TWICE, by fill and by colour.
    //
    // `$(pulse)` was the first attempt and is unreadable in place: a hairline waveform
    // among the hairline glyphs VS Code already puts in the status bar. A filled disc
    // against a hollow ring differs in mass, which survives peripheral vision, and the
    // green foreground makes the whole item the signal rather than one 12px character.
    // Shape carries it on its own, so the meaning does not rest on colour alone.
    const session = live
      ? `$(circle-filled) ${formatCompact(live.durationMs)}`
      : `$(circle-outline) idle`;

    this.item.color = live ? new vscode.ThemeColor("charts.green") : undefined;
    this.item.text = mode === "session" ? session : `${session} · ${today} today`;

    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    md.appendMarkdown(`### TakaTime\n\n`);

    if (live) {
      const what = [live.projects[0]?.key, live.languages[0]?.key].filter(Boolean).join(" · ");
      md.appendMarkdown(
        `|  |  |\n|---|---|\n` +
          `| **Session** | ${live.formatted}, ${live.heartbeatCount} beats |\n` +
          (what ? `| **On** | ${shorten(what, 40)} |\n` : "") +
          `| **Last beat** | ${formatAgo(live.msSinceLastBeat)} |\n`,
      );
    } else {
      md.appendMarkdown(
        `|  |  |\n|---|---|\n` +
          `| **Session** | none — last beat ${formatAgo(summary.data.msSinceLastBeat)} |\n`,
      );
    }

    // The split is stated as three DISJOINT bands. The overlapping human and AI
    // totals do not belong in a tooltip: there is no room for the caveat that they
    // must not be added, and a number without its caveat gets added.
    const split = summary.week.split;
    const splitRow = split && split.unionMs > 0
      ? `| **Human / AI** | ${formatCompact(split.humanOnlyMs)} you · ` +
        (split.overlapMs > 0 ? `${formatCompact(split.overlapMs)} both · ` : "") +
        `${formatCompact(split.aiOnlyMs)} AI (${Math.round(split.aiShare * 100)}%) |\n`
      : "";

    md.appendMarkdown(
      `| **Today** | ${summary.today.formatted} · ${summary.today.sessionCount} session${summary.today.sessionCount === 1 ? "" : "s"} |\n` +
        `| **Last ${summary.week.days}d** | ${summary.week.formatted} · ${formatCompact(summary.week.averageMsPerDay)}/day |\n` +
        splitRow +
        `| **Streak** | ${summary.streak.current} day${summary.streak.current === 1 ? "" : "s"} (best ${summary.streak.longest}) |\n\n`,
    );

    const topProject = summary.week.projects[0];
    const topLanguage = summary.week.languages[0];
    if (topProject) {
      md.appendMarkdown(
        `**Top this week** — ${shorten(topProject.key)} ${formatCompact(topProject.ms)}` +
          (topLanguage ? ` · ${topLanguage.key} ${formatCompact(topLanguage.ms)}` : "") +
          `\n\n`,
      );
    }

    // Session time is credited BETWEEN heartbeats, so it advances in throttle-sized
    // steps rather than ticking. Saying so here stops a stationary number from reading
    // as a broken one — and inventing the tail instead would be the exact mistake
    // METHODOLOGY.md exists to prevent.
    if (live) {
      md.appendMarkdown(`_Session time advances a step per heartbeat, not continuously._\n\n`);
    }

    // The caveat belongs wherever the number is glanced at, which is exactly here.
    md.appendMarkdown(`_${FOOTER}_\n\n`);
    md.appendMarkdown(`Click for the full panel.`);
    this.item.tooltip = md;
  }
}

module.exports = { StatsBar };
