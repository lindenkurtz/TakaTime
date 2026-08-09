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
  buildSummary,
  formatAgo,
  formatCompact,
  formatDuration,
} from "./summary.mjs";
import { CONFIG_REGISTRY } from "./duration.mjs";
import { DEFAULT_PORT, fetchHeartbeats, fetchSummaryFromServer } from "./source.mjs";

/* -------------------------------------------------------------------------- */
/* Argument parsing                                                            */
/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2);

/** Flags that consume the following argument, so it is never mistaken for the command. */
const VALUED = new Set(["--days", "-n", "--top", "--tz", "--idle", "--uri", "--editor", "--port"]);

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
  process.stdout.write(`${formatCompact(s.today.ms)} today · ${formatCompact(s.week.ms)} wk${live}\n`);
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
  doctor         Algorithm parameters, config regime, and data health
  help           This

Options:
  --days N       Length of the trailing window            (default 7)
  -n N           Rows per leaderboard                     (default 5)
  --editor NAME  Only heartbeats from this editor, e.g. VsCode
  --tz ZONE      IANA zone for daily bucketing            (default America/Denver)
  --idle N       Idle timeout in seconds                  (default 900)
  --json         The full summary object, unformatted
  --oneline, -1  One line, for a shell prompt or tmux status
  --direct       Skip the local server and query MongoDB directly
  --uri URI      MongoDB URI (else $TAKATIME_MONGO_URI, else ~/.takatime.json)
  --no-color     Disable ANSI colour

Numbers are derived at query time by analytics/duration.mjs. The legacy
'duration' field is never read. See METHODOLOGY.md.`;

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

  const summaryOptions = {
    weekDays: opts.days,
    topN: opts.topN,
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
    ...(opts.idle ? { idleTimeoutSeconds: Number(opts.idle) } : {}),
    ...(opts.editor ? { filter: (hb) => hb.editor === opts.editor } : {}),
  };

  // Prefer a running server: it holds the heartbeats in memory, so this is ~5ms
  // instead of the ~1s an Atlas handshake costs. Falling back keeps the CLI usable
  // on its own, which matters more than the speed.
  let summary = null;
  const serverUsable = !opts.direct && !opts.editor && !opts.timeZone && !opts.idle;
  if (serverUsable) {
    summary = await fetchSummaryFromServer({
      query: `?days=${opts.days}&topN=${opts.topN}`,
    });
  }
  if (!summary) {
    const heartbeats = await fetchHeartbeats(argv);
    summary = buildSummary(heartbeats, summaryOptions);
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
