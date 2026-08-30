# TakaTime

A self-hosted coding time tracker. VS Code sends heartbeats to MongoDB; durations
are computed at query time.

Personal fork of [Rtarun3606k/TakaTime](https://github.com/Rtarun3606k/TakaTime),
specialized down to the parts I actually use. The Neovim plugin, the README
stats-image pipeline, and the GitHub Actions that published them have been removed.

## How it works

```
write   VS Code extension ──spawn──> taka-upload (Go) ──> MongoDB (takatime.logs)
        (120s throttle)                                          │
read    analytics/server.mjs  <──────────────────────────────────┘
        (localhost, in-memory)
              │  summary.mjs -> duration.mjs   (query-time durations)
              │
              ├──> VS Code status bar      session state, session length, today
              ├──> VS Code stats panel     charts, heatmap, leaderboards
              └──> `taka`                  the same numbers in any terminal
```

A heartbeat is an **observation** — "this file was being edited at this instant" —
not a duration. Nothing about elapsed time is stored. Durations are derived from the
pattern of timestamps whenever you ask for them, so changing the tracker's throttle
never invalidates historical data.

**If you are reading numbers out of this database, read
[METHODOLOGY.md](METHODOLOGY.md) first.** In particular: do not sum the legacy
`duration` field.

## Layout

| Path | What |
|---|---|
| [`vscodePlugin/Takatime/`](vscodePlugin/Takatime/) | The VS Code extension: tracker, status bar, stats panel |
| [`cmd/upload/`](cmd/upload/) | Writes a heartbeat; queues locally, syncs to Mongo |
| [`cmd/dashboard/`](cmd/dashboard/) | Terminal dashboard (Bubble Tea) — **deprecated**, see [TODO.md](TODO.md) |
| [`analytics/duration.mjs`](analytics/duration.mjs) | The algorithm. Pure, zero-dependency, the single source of truth |
| [`analytics/summary.mjs`](analytics/summary.mjs) | The object every display renders |
| [`analytics/server.mjs`](analytics/server.mjs) | Localhost stats server |
| [`analytics/cli.mjs`](analytics/cli.mjs) | The `taka` command |
| [`METHODOLOGY.md`](METHODOLOGY.md) | What the numbers mean and how they are derived |
| [`TODO.md`](TODO.md) | Deferred surfaces and known loose ends |
| [`scripts/build-binaries.sh`](scripts/build-binaries.sh) | Build + install binaries and the analytics bundle |

## Setup

Binaries are **built from source**, not downloaded — this fork's versions are never
published to upstream's releases page.

```sh
go build ./...
./scripts/build-binaries.sh        # installs to ~/.takatime/bin
```

Then package and install the extension:

```sh
cd vscodePlugin/Takatime
npx @vscode/vsce package
code --install-extension takatime-*.vsix --force
```

Reload VS Code. On first run a `TakaTime: Setup Needed` item appears — click it to set
your MongoDB URI (stored in `~/.takatime.json`). That item then **disappears**: it is an
exception report, and it shows itself only when setup is incomplete or the binaries for
`CURRENT_VERSION` are missing. The stats item is the one you keep.

The version in `Plugin/Config.js` (`CURRENT_VERSION`) must match
`internal/types/version.go` (`Version`), or the extension looks for a binary that
isn't there and silently skips uploads.

## Reading your stats

**In VS Code.** A status bar item reads `● 46m · 1h01m today` in green while a session
is live, and `○ idle · 1h01m today` in the default colour when it is not — session
state, session length, then the day. The state is carried by both fill and colour, so
it is legible peripherally and does not depend on colour alone. Hovering gives the
week, streak and what you are on; clicking
opens the full panel — charts, a 26-week heatmap, and leaderboards for projects,
languages, files and branches. Also on the command palette as
`TakaTime: Open Stats Panel`.

Session time advances one step per heartbeat rather than ticking, because the algorithm
credits the gap *between* heartbeats and the tail of a live session is uncredited by
design. A stationary number is not a stuck one; the hover shows how long ago the last
beat landed.

**In a terminal.** `scripts/build-binaries.sh` installs a `taka` shim:

```sh
alias taka="$HOME/.takatime/bin/taka"     # in ~/.zshrc

taka                 # today, week, current session, top projects and languages
taka today           # today in detail, every session
taka week --days 30  # daily, projects, languages, files, branches
taka now             # the current session only
taka hours           # time-of-day distribution
taka doctor          # algorithm parameters, config regime, data health
taka --oneline       # one line, for a prompt or tmux status
taka --json          # the whole summary object
```

Both read the same summary from a small localhost server that holds the collection in
memory. The extension starts it on demand; it exits after 30 minutes idle. Run it
yourself with `npm run serve`, or add `--direct` to any `taka` command to skip it.

## Analytics

```sh
cd analytics
npm install
npm test                # calibration against WakaTime + additivity invariants
npm run migrate         # dry run; --apply to commit
npm run export          # self-contained bundle for analysis
```

[`analytics/duration.mjs`](analytics/duration.mjs) is pure, zero-dependency ESM with
no database or editor imports, so it can be copied verbatim into a consuming repo.
It is the single source of truth for the config registry.
[`summary.mjs`](analytics/summary.mjs) sits directly on top of it and is what every
display renders — **no surface computes a duration of its own.**

## Data shape

```js
// takatime.logs
{
  name, project, timestamp, date, language, os, gitBranch, editor,
  configVersion,     // which throttle regime produced this heartbeat
  duration           // ⚠️ legacy, pre-v3 records only — do not sum
}

// takatime.configs — one document per throttle regime, with ISO-8601 boundaries
{ version, intervalSeconds, scope, from, to }

// takatime.aiWrites — instants an agent modified a file. NOT heartbeats: no duration,
// never reaches the algorithm. Used to tell an agent's edit apart from yours.
{ timestamp, file, editor, os }
```

## Trackers

| Tracker | Source | Writes via | Agent |
|---|---|---|---|
| VS Code | [`vscodePlugin/Takatime/`](vscodePlugin/Takatime/) | `taka-upload` (Go) | human |
| Mathematica | [`trackers/mathematica/`](trackers/mathematica/) | pymongo, direct | human |
| Claude Code | [`trackers/claude-code/`](trackers/claude-code/) | Node driver, direct | ai |

All three share the same throttle regime timeline, which is why the config registry is
a single linear series. See [METHODOLOGY.md](METHODOLOGY.md#trackers).

## Human and AI time

Agent sessions are tracked beside editor activity and stay separable.

```sh
taka split                              # human vs AI, overall and per project
taka --agent ai                         # the whole dashboard, agent time only
node trackers/claude-code/import-claude.mjs --apply
```

**The two overlap and are never added.** You at the keyboard while an agent works is
time that belongs to both, so the headline total is the *union* and the split is
reported as three disjoint bands — human only, both at once, AI only — that add up to
it exactly.

Two things this gets right that a naive version does not:

- **Echo.** VS Code cannot tell who edited an open file, so an agent's writes were
  being logged as your typing — 9.4% of the entire editor record. Editor heartbeats
  matching an agent write to the same file are dropped as duplicate observations.
- **Authorship, not presence.** A session where the agent only answered questions is
  advisory and counts as your time, not its.

See [METHODOLOGY.md](METHODOLOGY.md#human-and-ai-time) for how both rules were
calibrated, and [`trackers/claude-code/`](trackers/claude-code/) to set up live
capture.

## License

MIT — see [LICENSE](LICENSE). Original work by
[Rtarun3606k](https://github.com/Rtarun3606k).
