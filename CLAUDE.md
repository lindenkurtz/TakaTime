# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

A self-hosted coding time tracker. Personal fork of `Rtarun3606k/TakaTime`,
specialized down to: VS Code extension → Go writer → MongoDB, plus a Go terminal
dashboard and a JS analytics layer.

```
WRITE   VS Code extension ──spawn──> taka-upload (Go) ──> MongoDB (takatime.logs)
        (120s throttle)                                        │
        Mathematica tracker ──pymongo──────────────────────────┤
                                                               │
        ~/.claude/projects/*.jsonl ──> import-claude.mjs ───────┤
        (Claude Code transcripts)     (idempotent importer)     └─> takatime.aiWrites

READ    MongoDB ──> analytics/server.mjs ──> summary.mjs ──> duration.mjs
                    (localhost:47612)             │
                                                  ├── VS Code status bar
                                                  ├── VS Code webview panel
                                                  └── `taka` CLI

                    taka-dashboard (Go TUI) ──> its own aggregations  ⚠️ WRONG
```

One git repo, root at `TakaTime/`. The VS Code extension is nested inside it at
`vscodePlugin/Takatime/` — work from the repo root, not from inside the extension,
or the Go half is invisible.

## The two rules that matter

**A heartbeat is an observation, not a duration.** Nothing about elapsed time is
stored. Durations are derived at query time from the pattern of timestamps.

**Human and AI time overlap; never add them.** You at the keyboard while an agent
works is time that belongs to both. `summary.mjs` publishes the union as the total and
`split` as the decomposition — `humanOnlyMs + overlapMs + aiOnlyMs === unionMs`
exactly, while `humanMs + aiMs` deliberately exceeds it.

The three bands are a **grouping dimension** (`mode`) over the merged stream, never
arithmetic on two separate totals. `overlap = human + ai − union` looks equivalent and
goes NEGATIVE when the streams interleave instead of co-occurring, because merging
them closes a gap neither could see alone. Anything drawing a stacked bar must use the
bands; anything drawing two side-by-side totals must say they overlap.

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
never the reverse. Changing a boundary means re-running `npm run migrate:apply`, or the
collection keeps saying the old thing.

**Every display reads `analytics/summary.mjs`; none of them queries.** `summary.mjs` is
pure (imports `duration.mjs` and nothing else) and produces the one object the status
bar, the CLI and the webview all render. `server.mjs` holds a Mongo connection and the
whole collection in memory — ~2k documents, so recomputation is single-digit
milliseconds and there is no reason to page or cache derived numbers. **Adding a
display means adding a consumer of that object, never a new aggregation.**

`internal/DBQueryV2/` is the counter-example and is deprecated: it sums `duration`, so
it is wrong for v1/v2 and reads *zero* for v3 records, which do not carry the field at
all. It is no longer wired to a status bar button. See [TODO.md](TODO.md).

**The extension never talks to MongoDB and has no npm dependencies.** It spawns the
server with `process.execPath` + `ELECTRON_RUN_AS_NODE=1` — VS Code's own Electron
behaving as Node — because a spawned `node` is not reliably on the extension host's
PATH when VS Code is launched from the Dock. The webview never talks to the network
either; the extension host fetches and `postMessage`s the summary in, which is what
lets the panel's CSP stay at `default-src 'none'`.

**In the panel, styles go through the CSSOM, never `setAttribute("style", …)`.**
`style-src` carries no `'unsafe-inline'`, so the style *attribute* is blocked — silently,
with no console error in a webview. It killed every bar fill while the rest of the page
looked perfect, because SVG `fill` is a presentation attribute and was unaffected. `h()`
takes `style` as an object and `Object.assign`s it onto `node.style`. **A headless
render without the CSP meta tag will not reproduce this** — copy the real
`Content-Security-Policy` into the harness when design-reviewing.

**The `agent` dimension is derived at read time, never stored.** `summary.mjs` maps
`editor` to human/ai through `AI_EDITORS`. There is no `agent` field in the database
and no migration created one — adding a tracker means adding its editor value to that
set, not a schema change.

**Echo is a measurement artifact, not a grey zone.** VS Code fires
`onDidChangeTextDocument` when an agent edits an open file and cannot tell who typed,
so agent work was landing in human time — 9.4% of the whole editor record. Editor
heartbeats matching an `aiWrites` record for the *same file* within `[-2s, +20s]` are
dropped from attribution entirely. Not reassigned: the agent's own heartbeats already
cover that span, so reassigning would double-count. Without the `aiWrites` collection
the join is a no-op and totals revert to pre-agent behaviour — that fail-safe is
deliberate and is tested.

**AI time requires authorship, not presence.** A Claude Code session that never
modified a file is advisory and contributes nothing. Getting this wrong marked two
hand-written projects as 15% and 24% AI. Shell heredocs (`cat > f << EOF`, `sed -i`)
count as authorship; bare `>` redirects do not, because they are usually compiler
output. Both directions are pinned by tests — do not loosen either without new
ground truth.

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
*snapshot* in `~/.vscode/extensions/`. Reloading reloads the snapshot. The same is true
of the analytics bundle: the extension runs the copy in `~/.takatime/analytics`, so
editing `analytics/*.mjs` in the repo changes nothing until `./scripts/build-binaries.sh`
reinstalls it. To see an extension change you must repackage and reinstall:

```sh
cd vscodePlugin/Takatime && npx @vscode/vsce package
code --install-extension takatime-*.vsix --force
```

Then reload. Verify with `code --list-extensions --show-versions | grep taka`.

## Commands

```sh
go build ./...                       # from repo root
./scripts/build-binaries.sh          # Go binaries -> ~/.takatime/bin
                                     # analytics bundle -> ~/.takatime/analytics
                                     # `taka` shim -> ~/.takatime/bin/taka

cd analytics
npm test                             # calibration + invariants + summary (no DB needed)
npm run migrate                      # dry run; --apply to commit
npm run export                       # self-contained analysis bundle (folder + .zip)
npm run build-fixture                # regenerate fixture from live data (moves calibration)
npm run serve                        # stats server on 127.0.0.1:47612
npm run taka -- doctor               # CLI; --direct skips the server

cd ..                                # Claude Code importer, from the repo root
node trackers/claude-code/import-claude.mjs           # dry run
node trackers/claude-code/import-claude.mjs --apply   # commit (idempotent)
```

`taka` subcommands: `summary` (default) `today` `week` `now` `sessions` `hours` `all`
`split` `doctor`. `--oneline` is the shell-prompt form; `--json` dumps the whole
summary. `--agent human|ai` narrows to one side of the split.

**The panel can be rendered without VS Code.** Inline `media/panel.css` and
`media/panel.js` into one HTML file, stub `acquireVsCodeApi()`, and
`window.postMessage({type:"summary", summary})` — then screenshot it headless. That is
the only practical way to design-review the charts; see [TODO.md](TODO.md).

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
- **The Claude Code importer is additive and idempotent.** Deterministic `_id`s
  (`cc:` / `cw:` prefixes) and `$setOnInsert` only. Re-running is free; it is meant to
  be driven by a hook. Undo is `db.logs.deleteMany({editor: "ClaudeCode"})` plus
  `db.aiWrites.drop()`, and touches nothing that was there before.
- **`aiWrites` is not a heartbeat collection.** Those records carry no duration and
  must never reach `duration.mjs`. They exist for the echo join and nothing else.

## Three trackers, one regime timeline

| Tracker | Source | Writes via | Editor field | Agent |
|---|---|---|---|---|
| VS Code | `vscodePlugin/Takatime/` | `taka-upload` (Go) | `VsCode` | human |
| Mathematica | `trackers/mathematica/` | pymongo, direct | `Mathematica` | human |
| Claude Code | `trackers/claude-code/` | Node driver, direct | `ClaudeCode` | ai |

All three share the same config regimes on the same boundaries — verified against the
data, and asserted by the tests `Mathematica shares the VS Code regime timeline` and
`Claude Code shares the VS Code regime timeline`. **That alignment is load-bearing:**
it is the only reason `CONFIG_REGISTRY` can be a single linear series. If the trackers
ever diverge, the registry must become per-tracker, which is a schema change — ask
first.

Changing the Mathematica throttle means updating three constants together:
`$TakatimeInterval` (`TakatimePalette.wl`), `CONFIG_VERSION`
(`takatime_mathematica.py`), and the open regime in `CONFIG_REGISTRY`.

Every heartbeat currently carries a `configVersion`. The date fallback is still
supported and tested, because `-configVersion` is deliberately **optional** on
`taka-upload` — callers spawn it fire-and-forget with stdio discarded, so requiring it
would turn a misconfigured caller into silent data loss.

WakaTime never observed Mathematica, so calibration must filter to
`editor === "VsCode"` regardless of stamping.

**Never hardcode the Mongo URI.** `trackers/mathematica/takatime_mathematica.py` used
to carry the connection string — password included — as a literal. It now resolves
from `$TAKATIME_MONGO_URI` / `$MONGO_URI` / `~/.takatime.json`, matching
`analytics/scripts/_mongo.mjs`. Keep it that way; this repo is pushed to GitHub.

## Style

Match the surrounding code. The Go is a fork with its own conventions (including some
upstream typos in identifiers like `Persnalization`, `aggration`, `cancle` — leave
them; renaming is churn that breaks nothing but git history). Comments in this
codebase explain *why*, especially where a decision looks arbitrary but is load-bearing.
