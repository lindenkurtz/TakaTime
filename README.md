# TakaTime

A self-hosted coding time tracker. VS Code sends heartbeats to MongoDB; durations
are computed at query time.

Personal fork of [Rtarun3606k/TakaTime](https://github.com/Rtarun3606k/TakaTime),
specialized down to the parts I actually use. The Neovim plugin, the README
stats-image pipeline, and the GitHub Actions that published them have been removed.

## How it works

```
VS Code extension  ──spawn──>  taka-upload  ──>  MongoDB (takatime.logs)
   (120s throttle)               (Go)                    │
                                                         ├──>  taka-dashboard  (Go TUI)
                                                         └──>  analytics/duration.mjs
                                                                (query-time durations)
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
| [`vscodePlugin/Takatime/`](vscodePlugin/Takatime/) | The VS Code extension |
| [`cmd/upload/`](cmd/upload/) | Writes a heartbeat; queues locally, syncs to Mongo |
| [`cmd/dashboard/`](cmd/dashboard/) | Terminal dashboard (Bubble Tea) |
| [`analytics/`](analytics/) | Query-time duration algorithm, tests, migrations, export |
| [`METHODOLOGY.md`](METHODOLOGY.md) | What the numbers mean and how they are derived |
| [`scripts/build-binaries.sh`](scripts/build-binaries.sh) | Build + install the Go binaries |

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

Reload VS Code. Click the status bar item to set your MongoDB URI (stored in
`~/.takatime.json`). It should read `TakaTime: Active (v2.3.0)`.

The version in `Plugin/Config.js` (`CURRENT_VERSION`) must match
`internal/types/version.go` (`Version`), or the extension looks for a binary that
isn't there and silently skips uploads.

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
```

## Trackers

| Tracker | Source | Writes via |
|---|---|---|
| VS Code | [`vscodePlugin/Takatime/`](vscodePlugin/Takatime/) | `taka-upload` (Go) |
| Mathematica | [`trackers/mathematica/`](trackers/mathematica/) | pymongo, direct |

Both share the same throttle regime timeline, which is why the config registry is a
single linear series. See [METHODOLOGY.md](METHODOLOGY.md#trackers).

## License

MIT — see [LICENSE](LICENSE). Original work by
[Rtarun3606k](https://github.com/Rtarun3606k).
