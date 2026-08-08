# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

A self-hosted coding time tracker. Personal fork of `Rtarun3606k/TakaTime`,
specialized down to: VS Code extension → Go writer → MongoDB, plus a Go terminal
dashboard and a JS analytics layer.

```
VS Code extension  ──spawn──>  taka-upload  ──>  MongoDB (takatime.logs)
   (120s throttle)               (Go)                    │
                                                         ├──>  taka-dashboard (Go TUI)
                                                         └──>  analytics/duration.mjs
```

One git repo, root at `TakaTime/`. The VS Code extension is nested inside it at
`vscodePlugin/Takatime/` — work from the repo root, not from inside the extension,
or the Go half is invisible.

## The one rule that matters

**A heartbeat is an observation, not a duration.** Nothing about elapsed time is
stored. Durations are derived at query time from the pattern of timestamps.

**Never sum the `duration` field.** It is legacy, exists only on pre-v3 records, and
holds the tracker's throttle interval rather than measured time. Summing it
undercounts by ~18% and distorts per-language shares. It is retained because the raw
log is an observation record that does not get rewritten — preserved, not endorsed.

Read [METHODOLOGY.md](METHODOLOGY.md) before touching anything that produces numbers.

## Architecture notes that are easy to get wrong

**`analytics/duration.mjs` is copied verbatim into a separate website repo.** It must
stay pure, zero-dependency ESM with no database, editor, or Node built-in imports. Do
not add imports. Changing behaviour means bumping `ALGORITHM_VERSION` *and* re-copying
it downstream — the website will silently keep the old copy otherwise.

**`CONFIG_REGISTRY` in `duration.mjs` is the single source of truth** for throttle
regimes. The `configs` collection in MongoDB is published *from* it by the migration,
never the reverse.

**Config boundaries are empirical, read off the data, not the git log.** Commits
landed 2026-04-21 but the rebuilt binary was not installed until 2026-04-23. The
heartbeats describe the heartbeats. Boundaries are full ISO-8601 instants because the
v1→v2 cutover happened mid-afternoon; date granularity cannot express it.

**All duration accounting is in integer milliseconds.** That is what makes the
additivity invariant exact rather than approximate. `toSeconds()` and
`formatDuration()` are display-only.

**Two versions must match or tracking silently stops:** `CURRENT_VERSION` in
`vscodePlugin/Takatime/Plugin/Config.js` and `Version` in
`internal/types/version.go`. The extension looks for
`~/.takatime/bin/taka-upload-<CURRENT_VERSION>` and skips uploads if it is missing.
`scripts/build-binaries.sh` reads the Go constant so the built filename cannot drift.

**Binaries are built from source, never downloaded.** This fork's versions are never
published to upstream's releases page. The old `BinaryDownload.js` fetched from
upstream and could only ever install a binary older than the extension asking for it.

**Editing the extension source does nothing on its own.** VS Code runs an installed
*snapshot* in `~/.vscode/extensions/`. Reloading reloads the snapshot. To see a
change you must repackage and reinstall:

```sh
cd vscodePlugin/Takatime && npx @vscode/vsce package
code --install-extension takatime-*.vsix --force
```

Then reload. Verify with `code --list-extensions --show-versions | grep taka`.

## Commands

```sh
go build ./...                       # from repo root
./scripts/build-binaries.sh          # build + install to ~/.takatime/bin

cd analytics
npm test                             # calibration + invariants (no DB needed)
npm run migrate                      # dry run; --apply to commit
npm run export                       # self-contained analysis bundle
npm run build-fixture                # regenerate fixture from live data (moves calibration)
```

Mongo URI resolution order: `--uri` flag, `$TAKATIME_MONGO_URI` / `$MONGO_URI`, then
`MONGO_URI` in `~/.takatime.json`.

## Constraints

- **Migrations are additive only.** The only write to `logs` is
  `$set: { configVersion }`. Never modify or delete an existing field, including
  `duration`. Ask before any schema change beyond that.
- **Keep all languages** — markdown, json, config files included. Filtering is a
  downstream decision, never a collection-time one.
- **Daily bucketing is America/Denver**, explicitly. The stored `date` field is
  unreliable (84 historical records disagree with their own timestamp, from a period
  when the machine ran in UTC) and is ignored in favour of `timestamp`.
- Calibration must stay within ±10% on the 7-day total. The test fails otherwise.

## Known gap: the Mathematica tracker

A separate setup writes heartbeats with `editor: "Mathematica"` from **outside this
repo**. Those records carry no `configVersion` and are deliberately left unstamped by
the migration — stamping them with a VS Code regime would assert something not known
to be true.

Consequences:

- `-configVersion` is **optional** on `taka-upload` on purpose. Callers spawn it
  fire-and-forget with stdio discarded, so requiring it would be silent data loss.
- Mathematica durations are estimated via the date fallback, and surface in
  `unstampedHeartbeats` / `inexactIntervalHeartbeats` rather than being folded in
  silently.
- WakaTime never saw Mathematica, so any calibration against it must filter to
  `editor === "VsCode"`.

Closing this gap requires making `CONFIG_REGISTRY` per-tracker rather than a single
linear series — a schema change, so ask first.

## Style

Match the surrounding code. The Go is a fork with its own conventions (including some
upstream typos in identifiers like `Persnalization`, `aggration`, `cancle` — leave
them; renaming is churn that breaks nothing but git history). Comments in this
codebase explain *why*, especially where a decision looks arbitrary but is load-bearing.
