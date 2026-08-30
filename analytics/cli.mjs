#!/usr/bin/env node
/**
 * `taka` — TakaTime from any terminal.
 *
 * Prints and exits. Deliberately not a TUI: no alt-screen, no keybindings, nothing to
 * quit out of. Output is plain enough to pipe, and `--json` gives the whole summary
 * for anything that wants to do its own thing with it.
 *
 * Every number comes from summary.mjs, which comes from duration.mjs. Nothing here
 * touches the legacy `duration` field — see METHODOLOGY.md.
 */

import {
  FOOTER,
  agentOf,
  buildSummary,
  formatAgo,
  formatCompact,
  formatDuration,
} from "./summary.mjs";
import { CONFIG_REGISTRY } from "./duration.mjs";
import { DEFAULT_PORT, fetchAll, fetchSummaryFromServer } from "./source.mjs";

/* -------------------------------------------------------------------------- */
/* Argument parsing                                                            */
/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2);

/** Flags that consume the following argument, so it is never mistaken for the command. */
const VALUED = new Set(["--days", "-n", "--top", "--tz", "--idle", "--uri", "--editor", "--agent", "--port"]);

function flag(...names) {
  return names.some((n) => argv.includes(n));
}

function value(name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1 || argv[i + 1] === undefined) return fallback;
  return argv[i + 1];
}

/** The first bare word that is not a flag's value. */
function readCommand() {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("-")) {
      if (VALUED.has(argv[i])) i++;
      continue;
    }
    return argv[i];
  }
  return "summary";
}

const command = readCommand();

const opts = {
  json: flag("--json"),
  oneline: flag("--oneline", "-1"),
  days: Number(value("--days", 7)),
  topN: Number(value("-n", value("--top", 5))),
  timeZone: value("--tz", undefined),
  idle: value("--idle", undefined),
  direct: flag("--direct"),
  color: !flag("--no-color") && !process.env.NO_COLOR && process.stdout.isTTY,
  editor: value("--editor", undefined),
  agent: value("--agent", undefined),
};

/* -------------------------------------------------------------------------- */
/* Presentation                                                                */
/* -------------------------------------------------------------------------- */

const C = new Proxy(
  {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
  },
  { get: (t, k) => (opts.color ? (t[k] ?? "") : "") },
);

const out = [];
const line = (s = "") => out.push(s);
const flush = () => process.stdout.write(out.join("\n") + "\n");

function heading(text) {
  line("");
  line(`${C.bold}${C.cyan}${text}${C.reset} ${C.dim}${"─".repeat(Math.max(0, 46 - text.length))}${C.reset}`);
}

/** Proportional bar. Width is fixed so columns line up across sections. */
function bar(share, width = 18) {
  const filled = Math.round(share * width);
  return `${C.blue}${"█".repeat(filled)}${C.reset}${C.dim}${"░".repeat(width - filled)}${C.reset}`;
}

function leaderboard(rows, { label = "" } = {}) {
  if (!rows || rows.length === 0) {
    line(`  ${C.dim}(nothing yet)${C.reset}`);
    return;
  }
  const width = Math.max(...rows.map((r) => display(r.key).length));
  for (const r of rows) {
    line(
      `  ${display(r.key).padEnd(width)}  ${bar(r.share)}  ${formatCompact(r.ms).padStart(7)}  ${C.dim}${(r.share * 100).toFixed(1).padStart(5)}%${C.reset}`,
    );
  }
  if (label) line(`  ${C.dim}${label}${C.reset}`);
}

/** Long file paths are noise in a terminal; keep the tail, which is the identifying part. */
function display(key) {
  if (key.length <= 34) return key;
  return "…" + key.slice(-33);
}

function clockTime(ms, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

/**
 * The human/AI split as a stacked bar over the union.
 *
 * Drawn as three DISJOINT bands rather than two overlapping totals, because
 * `humanOnly + both + aiOnly` is exactly the union and a reader can add the segments
 * up. The overlapping per-stream totals are printed underneath as text, where the
 * caveat that they must not be added can sit next to them.
 */
function splitBars(split) {
  const union = split.unionMs || 1;
  const rows = [
    ["human only", split.humanOnlyMs, C.blue],
    ["both", split.overlapMs, C.magenta],
    ["AI only", split.aiOnlyMs, C.cyan],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, ms, color] of rows) {
    const share = ms / union;
    const filled = Math.round(share * 22);
    line(
      `  ${label.padEnd(width)}  ${color}${"█".repeat(filled)}${C.reset}${C.dim}${"░".repeat(22 - filled)}${C.reset}` +
        `  ${formatCompact(ms).padStart(7)}  ${C.dim}${(share * 100).toFixed(1).padStart(5)}%${C.reset}`,
    );
  }
  line(
    `  ${C.dim}union ${formatCompact(split.unionMs)} · human ${formatCompact(split.humanMs)} · ` +
      `AI ${formatCompact(split.aiMs)} — the last two overlap by ${formatCompact(split.overlapMs)}, never add them${C.reset}`,
  );
}

/**
 * The daily human/AI mix, one row per day.
 *
 * Length is the day's total scaled against the busiest day; the split within it is
 * who wrote it. Three glyphs rather than three colours, so the mix survives
 * --no-color and a pipe into a file. Empty days are kept as a dash: a day you did not
 * code is part of the shape of a week, and dropping it would compress the time axis
 * into something that reads like continuous activity.
 */
function bandLegend() {
  line(
    `  ${C.blue}█${C.reset} ${C.dim}human only${C.reset}   ${C.magenta}▒${C.reset} ${C.dim}both at once${C.reset}` +
      `   ${C.cyan}▓${C.reset} ${C.dim}AI only${C.reset}`,
  );
}

function mixRows(series, timeZone) {
  const max = Math.max(...series.map((d) => d.total), 1);
  const WIDTH = 22;
  for (const d of series) {
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(
      new Date(Date.parse(d.day + "T12:00:00Z")),
    );
    const label = `${weekday} ${d.day.slice(5)}`;

    if (d.total === 0) {
      line(`  ${label}  ${C.dim}${"·".repeat(WIDTH)}${C.reset}  ${C.dim}      —${C.reset}`);
      continue;
    }
    const cells = Math.max(1, Math.round((d.total / max) * WIDTH));
    // Distribute cells across the three bands, then give any rounding remainder to
    // the largest band so the row is always exactly `cells` wide.
    const parts = [
      ["human-only", d.values["human-only"], "█", C.blue],
      ["concurrent", d.values.concurrent, "▒", C.magenta],
      ["ai-only", d.values["ai-only"], "▓", C.cyan],
    ].map((x) => ({ key: x[0], ms: x[1], glyph: x[2], color: x[3], n: Math.round((x[1] / d.total) * cells) }));
    const drift = cells - parts.reduce((a, x) => a + x.n, 0);
    if (drift !== 0) parts.sort((a, b) => b.ms - a.ms)[0].n += drift;

    const bar = ["human-only", "concurrent", "ai-only"]
      .map((k) => parts.find((x) => x.key === k))
      .map((x) => `${x.color}${x.glyph.repeat(Math.max(0, x.n))}${C.reset}`)
      .join("");

    line(
      `  ${label}  ${bar}${C.dim}${"·".repeat(WIDTH - cells)}${C.reset}  ${formatCompact(d.total).padStart(7)}` +
        `  ${C.dim}${d.aiShare === null ? "    —" : (d.aiShare * 100).toFixed(0).padStart(3) + "%"} AI${C.reset}`,
    );
  }
}

/**
 * Per-project human vs AI.
 *
 * The bar draws the THREE DISJOINT bands, not humanMs against aiMs. Those two
 * overlap, so a two-segment bar of them sums past 100% and mis-draws every project
 * with concurrent time — one project rendered as fully AI while the row beside it
 * reported 22 minutes of human work. Glyphs rather than colours alone, so the mix
 * survives --no-color.
 */
function splitTable(rows) {
  if (!rows || rows.length === 0) {
    line(`  ${C.dim}(nothing yet)${C.reset}`);
    return;
  }
  const WIDTH = 18;
  const width = Math.max(...rows.map((r) => display(r.key).length));
  for (const r of rows) {
    const total = r.totalMs || 1;
    const parts = [
      { ms: r.humanOnlyMs, glyph: "█", color: C.blue },
      { ms: r.overlapMs, glyph: "▒", color: C.magenta },
      { ms: r.aiOnlyMs, glyph: "▓", color: C.cyan },
    ].map((x) => ({ ...x, n: Math.round((x.ms / total) * WIDTH) }));
    const drift = WIDTH - parts.reduce((a, x) => a + x.n, 0);
    if (drift !== 0) {
      const biggest = parts.reduce((a, x) => (x.ms > a.ms ? x : a), parts[0]);
      biggest.n += drift;
    }
    const bar = parts.map((x) => `${x.color}${x.glyph.repeat(Math.max(0, x.n))}${C.reset}`).join("");

    line(
      `  ${display(r.key).padEnd(width)}  ${bar}` +
        `  ${formatCompact(r.humanMs).padStart(7)} ${C.dim}human${C.reset}` +
        `  ${formatCompact(r.aiMs).padStart(7)} ${C.dim}AI${C.reset}` +
        `  ${C.bold}${(r.aiShare * 100).toFixed(0).padStart(3)}%${C.reset}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Views                                                                       */
/* -------------------------------------------------------------------------- */

function viewSummary(s) {
  const live = s.currentSession;
  line("");
  line(
    `  ${C.bold}Today${C.reset}  ${C.green}${C.bold}${formatCompact(s.today.ms).padStart(7)}${C.reset}` +
      `      ${C.bold}${s.week.days}d${C.reset}  ${C.bold}${formatCompact(s.week.ms).padStart(7)}${C.reset}` +
      `      ${C.bold}Streak${C.reset}  ${s.streak.current}d`,
  );
  line(
    `  ${C.dim}${s.today.sessionCount} session${s.today.sessionCount === 1 ? "" : "s"}` +
      `        ${formatCompact(s.week.averageMsPerDay)}/day avg` +
      `        best ${s.streak.longest}d${C.reset}`,
  );

  heading("Now");
  if (live) {
    const top = live.projects[0];
    line(
      `  ${C.green}●${C.reset} ${C.bold}${formatCompact(live.durationMs)}${C.reset} in session` +
        `  ${C.dim}since ${clockTime(live.startMs, s.timeZone)}, ${live.heartbeatCount} beats, last ${formatAgo(live.msSinceLastBeat)}${C.reset}`,
    );
    if (top) {
      line(
        `    ${display(top.key)} ${C.dim}·${C.reset} ${live.languages.map((l) => l.key).slice(0, 3).join(", ")}`,
      );
    }
  } else {
    line(`  ${C.dim}○ no active session — last heartbeat ${formatAgo(s.data.msSinceLastBeat)}${C.reset}`);
  }

  heading(`Human vs AI · last ${s.week.days}d`);
  splitBars(s.week.split);

  heading(`Top projects · last ${s.week.days}d`);
  leaderboard(s.week.projects);

  heading(`Top languages · last ${s.week.days}d`);
  leaderboard(s.week.languages);

  heading(`Daily · last ${s.week.days}d`);
  sparkRows(s.week.series, s.timeZone);

  line("");
  line(`${C.dim}${FOOTER}${C.reset}`);
}

function sparkRows(series, timeZone) {
  const max = Math.max(...series.map((d) => d.ms), 1);
  for (const d of series) {
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(
      new Date(Date.parse(d.day + "T12:00:00Z")),
    );
    const isToday = d === series[series.length - 1];
    const label = `${weekday} ${d.day.slice(5)}`;
    line(
      `  ${isToday ? C.bold : ""}${label}${C.reset}  ${bar(d.ms / max, 24)}  ${
        d.ms ? formatCompact(d.ms).padStart(7) : `${C.dim}      —${C.reset}`
      }`,
    );
  }
}

function viewToday(s) {
  heading(`Today · ${s.today.day}`);
  line(`  ${C.bold}${C.green}${formatDuration(s.today.ms)}${C.reset} across ${s.today.sessionCount} session(s)`);
  if (s.today.longestSessionMs) {
    line(`  ${C.dim}longest session ${formatCompact(s.today.longestSessionMs)}${C.reset}`);
  }

  heading("Sessions today");
  if (s.today.sessions.length === 0) {
    line(`  ${C.dim}(none yet)${C.reset}`);
  } else {
    for (const sess of s.today.sessions) {
      line(
        `  ${clockTime(sess.startMs, s.timeZone).padStart(8)} → ${clockTime(sess.endMs, s.timeZone).padEnd(8)}` +
          `  ${C.bold}${formatCompact(sess.durationMs).padStart(7)}${C.reset}` +
          `  ${C.dim}${sess.heartbeatCount} beats${C.reset}`,
      );
    }
  }

  heading("Projects today");
  leaderboard(s.today.projects);
  heading("Languages today");
  leaderboard(s.today.languages);
  line("");
  line(`${C.dim}${FOOTER}${C.reset}`);
}

function viewWeek(s) {
  heading(`Last ${s.week.days} days · ${s.week.startDay} → ${s.week.endDay}`);
  line(
    `  ${C.bold}${C.green}${formatDuration(s.week.ms)}${C.reset}` +
      `  ${C.dim}${s.week.activeDays} active days · ${formatCompact(s.week.averageMsPerActiveDay)} per active day · ${s.week.sessionCount} sessions${C.reset}`,
  );
  heading("Daily");
  sparkRows(s.week.series, s.timeZone);
  heading("Projects");
  leaderboard(s.week.projects);
  heading("Languages");
  leaderboard(s.week.languages);
  heading("Files");
  leaderboard(s.week.files);
  heading("Branches");
  leaderboard(s.week.branches);
  heading("Human vs AI");
  splitBars(s.week.split);
  heading("Daily mix");
  mixRows(s.agentTrend.series.slice(-s.week.days), s.timeZone);
  heading("By project");
  splitTable(s.week.projectSplit);
  line("");
  line(`${C.dim}${FOOTER}${C.reset}`);
}

function viewNow(s) {
  const live = s.currentSession;
  if (!live) {
    line(`${C.dim}○ no active session — last heartbeat ${formatAgo(s.data.msSinceLastBeat)}${C.reset}`);
    return;
  }
  heading("Current session");
  line(
    `  ${C.bold}${C.green}${formatDuration(live.durationMs)}${C.reset}` +
      `  ${C.dim}started ${clockTime(live.startMs, s.timeZone)} · ${live.heartbeatCount} heartbeats · last ${formatAgo(live.msSinceLastBeat)}${C.reset}`,
  );
  line(
    `  ${C.dim}the tail after the last heartbeat is uncredited by design; see METHODOLOGY.md${C.reset}`,
  );
  heading("Projects this session");
  leaderboard(live.projects);
  heading("Languages this session");
  leaderboard(live.languages);
  heading("Files this session");
  leaderboard(live.files);
}

function viewSessions(s) {
  heading(`Sessions · today (${s.today.day})`);
  if (!s.today.sessions.length) {
    line(`  ${C.dim}(none yet)${C.reset}`);
    return;
  }
  const max = Math.max(...s.today.sessions.map((x) => x.durationMs));
  for (const sess of s.today.sessions) {
    line(
      `  ${clockTime(sess.startMs, s.timeZone).padStart(8)} → ${clockTime(sess.endMs, s.timeZone).padEnd(8)}` +
        `  ${bar(sess.durationMs / max, 20)}  ${formatCompact(sess.durationMs).padStart(7)}` +
        `  ${C.dim}${sess.heartbeatCount} beats${C.reset}`,
    );
  }
}

function viewHours(s) {
  heading("Time of day · all history");
  const max = Math.max(...s.hourly.map((h) => h.ms), 1);
  for (const h of s.hourly) {
    if (h.ms === 0 && (h.hour < 5 || h.hour > 23)) continue;
    const label = `${String(h.hour).padStart(2, "0")}:00`;
    line(`  ${label}  ${bar(h.ms / max, 28)}  ${h.ms ? formatCompact(h.ms).padStart(7) : `${C.dim}      —${C.reset}`}`);
  }
}

function viewAll(s) {
  heading("All time");
  line(
    `  ${C.bold}${C.green}${s.allTime.formatted}${C.reset}` +
      `  ${C.dim}over ${s.allTime.activeDays} active days since ${s.allTime.firstDay}${C.reset}`,
  );
  line(
    `  ${C.dim}${s.allTime.sessionCount} sessions · ${formatCompact(s.allTime.averageMsPerActiveDay)} per active day · longest streak ${s.streak.longest}d${C.reset}`,
  );
  heading("Projects");
  leaderboard(s.allTime.projects);
  heading("Languages");
  leaderboard(s.allTime.languages);
  heading("Human vs AI");
  splitBars(s.allTime.split);
  heading("By project");
  splitTable(s.allTime.projectSplit);
}

function viewSplit(s) {
  heading(`Human vs AI · last ${s.week.days}d`);
  splitBars(s.week.split);

  heading(`Daily mix · last ${s.week.days}d`);
  mixRows(s.agentTrend.series.slice(-s.week.days), s.timeZone);
  bandLegend();

  heading(`By project · last ${s.week.days}d`);
  splitTable(s.week.projectSplit);
  bandLegend();

  heading("Human vs AI · all time");
  splitBars(s.allTime.split);

  heading("By project · all time");
  splitTable(s.allTime.projectSplit);
  bandLegend();

  if (s.data.aiWrites === 0) {
    line("");
    line(
      `  ${C.yellow}No agent write records on this machine.${C.reset} ${C.dim}Editor heartbeats caused by an` +
        ` agent editing an open file are still counted as human. Run the Claude Code importer.${C.reset}`,
    );
  }
  line("");
  line(`${C.dim}${FOOTER}${C.reset}`);
}

/** Everything you would want before believing any of the above. */
function viewDoctor(s) {
  const ok = (b) => (b ? `${C.green}ok${C.reset}` : `${C.red}CHECK${C.reset}`);
  heading("Algorithm");
  line(`  algorithm version      ${s.algorithmVersion}`);
  line(`  summary version        ${s.summaryVersion}`);
  line(`  idle timeout           ${s.idleTimeoutSeconds}s`);
  line(`  time zone              ${s.timeZone}`);

  heading("Config regime in force");
  const regime = CONFIG_REGISTRY.find((c) => c.version === s.data.configVersionInForce);
  line(`  version                v${s.data.configVersionInForce}`);
  line(`  interval               ${s.data.intervalSecondsInForce}s (${regime?.scope ?? "?"})`);
  line(`  since                  ${regime?.from ?? "?"}`);

  heading("Data health");
  line(`  heartbeats             ${s.data.heartbeats}`);
  line(`  last heartbeat         ${formatAgo(s.data.msSinceLastBeat)}`);
  line(`  unstamped              ${s.data.unstampedHeartbeats}  ${ok(s.data.unstampedHeartbeats === 0)}`);
  line(`  inexact intervals      ${s.data.inexactIntervalHeartbeats}  ${ok(s.data.inexactIntervalHeartbeats === 0)}`);
  line(`  editors                ${s.week.editors.map((e) => `${e.key} ${(e.share * 100).toFixed(0)}%`).join(", ") || "—"}`);

  heading("Human / AI split");
  line(`  agent writes indexed   ${s.data.aiWrites}  ${ok(s.data.aiWrites > 0)}`);
  line(`  echo heartbeats        ${s.data.echoHeartbeats} suppressed`);
  line(`  human time they added  ${s.data.echoRemovedFormatted}  ${C.dim}(before suppression)${C.reset}`);
  line(`  all-time human         ${s.allTime.split.humanFormatted}`);
  line(`  all-time AI            ${s.allTime.split.aiFormatted}`);
  line(`  all-time overlap       ${s.allTime.split.overlapFormatted}  ${C.dim}(in both)${C.reset}`);
  line(`  all-time union         ${s.allTime.split.unionFormatted}`);
  if (s.data.aiWrites === 0) {
    line(`  ${C.dim}no agent writes — echo suppression is OFF and human time reads high${C.reset}`);
  }

  heading("Regime timeline");
  for (const c of CONFIG_REGISTRY) {
    line(
      `  v${c.version}  ${String(c.intervalSeconds).padStart(4)}s  ${c.scope.padEnd(9)}  ${c.from}  →  ${c.to ?? "(current)"}`,
    );
  }
  line("");
  line(`${C.dim}Never sum the legacy 'duration' field. See METHODOLOGY.md.${C.reset}`);
}

function viewOneline(s) {
  const live = s.currentSession ? ` ●${formatCompact(s.currentSession.durationMs)}` : "";
  // Only when there is agent time to report. A constant "0% AI" on a machine that
  // has never run the importer is noise in a shell prompt, and worse, it reads as a
  // measurement rather than an absence of one.
  const ai = s.week.split.aiMs > 0 ? ` · ${Math.round(s.week.split.aiShare * 100)}% ai` : "";
  process.stdout.write(
    `${formatCompact(s.today.ms)} today · ${formatCompact(s.week.ms)} wk${ai}${live}\n`,
  );
}

const HELP = `taka — TakaTime coding stats

Usage: taka [command] [options]

Commands:
  summary        Today, week, current session, top projects/languages   (default)
  today          Today in detail, with every session
  week           The trailing window in detail: daily, projects, languages,
                 files, branches
  now            The current session only
  sessions       Today's sessions as a timeline
  hours          Time-of-day distribution across all history
  all            All-time totals and leaderboards
  split          Human vs AI coding time, overall and per project
  doctor         Algorithm parameters, config regime, and data health
  help           This

Options:
  --days N       Length of the trailing window            (default 7)
  -n N           Rows per leaderboard                     (default 5)
  --editor NAME  Only heartbeats from this editor, e.g. VsCode, ClaudeCode
  --agent WHICH  Only one side of the split: human | ai
  --tz ZONE      IANA zone for daily bucketing            (default America/Denver)
  --idle N       Idle timeout in seconds                  (default 900)
  --json         The full summary object, unformatted
  --oneline, -1  One line, for a shell prompt or tmux status
  --direct       Skip the local server and query MongoDB directly
  --uri URI      MongoDB URI (else $TAKATIME_MONGO_URI, else ~/.takatime.json)
  --no-color     Disable ANSI colour

Human and AI totals OVERLAP — you at the keyboard while an agent works is time
that belongs to both — so 'split' reports them beside a union that does not
double-count. Numbers are derived at query time by analytics/duration.mjs. The
legacy 'duration' field is never read. See METHODOLOGY.md.`;

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

const VIEWS = {
  summary: viewSummary,
  today: viewToday,
  week: viewWeek,
  now: viewNow,
  sessions: viewSessions,
  hours: viewHours,
  all: viewAll,
  split: viewSplit,
  doctor: viewDoctor,
};

async function main() {
  if (command === "help" || flag("--help", "-h")) {
    process.stdout.write(HELP + "\n");
    return;
  }

  const view = VIEWS[command];
  if (!view) {
    process.stderr.write(`taka: unknown command '${command}'\n\n${HELP}\n`);
    process.exitCode = 2;
    return;
  }

  // `--editor` and `--agent` are both plain heartbeat filters, so the whole summary
  // is recomputed for the subset rather than sliced afterwards. Given together they
  // mean the intersection.
  const filters = [];
  if (opts.editor) filters.push((hb) => hb.editor === opts.editor);
  if (opts.agent) filters.push((hb) => agentOf(hb) === opts.agent);

  const summaryOptions = {
    weekDays: opts.days,
    topN: opts.topN,
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
    ...(opts.idle ? { idleTimeoutSeconds: Number(opts.idle) } : {}),
    ...(filters.length ? { filter: (hb) => filters.every((f) => f(hb)) } : {}),
  };

  // Prefer a running server: it holds the heartbeats in memory, so this is ~5ms
  // instead of the ~1s an Atlas handshake costs. Falling back keeps the CLI usable
  // on its own, which matters more than the speed.
  let summary = null;
  const serverUsable = !opts.direct && !opts.editor && !opts.timeZone && !opts.idle;
  if (serverUsable) {
    summary = await fetchSummaryFromServer({
      query:
        `?days=${opts.days}&topN=${opts.topN}` + (opts.agent ? `&agent=${encodeURIComponent(opts.agent)}` : ""),
    });
  }
  if (!summary) {
    const { heartbeats, aiWrites } = await fetchAll(argv);
    summary = buildSummary(heartbeats, { ...summaryOptions, aiWrites });
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return;
  }
  if (opts.oneline) {
    viewOneline(summary);
    return;
  }

  view(summary);
  flush();
}

main().catch((err) => {
  process.stderr.write(`taka: ${err.message}\n`);
  if (/No MongoDB URI/.test(err.message)) {
    process.stderr.write(
      `\nSet one with:\n  export TAKATIME_MONGO_URI='mongodb+srv://…'\nor put MONGO_URI in ~/.takatime.json (what the extension uses).\n`,
    );
  }
  process.exitCode = 1;
});
