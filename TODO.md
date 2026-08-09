# TODO

Deferred work, with enough context to pick it up cold.

---

## Surfaces not built yet

The stats core (`analytics/summary.mjs`) and the local server (`analytics/server.mjs`)
already exist and are surface-agnostic. Both items below are thin clients over
`GET http://127.0.0.1:47612/api/summary` and need no new computation — do not
recompute durations in either one.

### Browser tab

Serve an HTML page at `/` from `analytics/server.mjs`. The route is already stubbed
and currently returns a plain-text description of the endpoints.

The webview panel (`vscodePlugin/Takatime/media/panel.js` + `panel.css`) is a complete,
dependency-free renderer that takes a summary object and draws the whole dashboard. It
needs exactly two things to run in a browser instead of a webview:

- a replacement for `acquireVsCodeApi()` (a stub with `postMessage` / `getState` /
  `setState` is enough — see the harness described below),
- the theme class it reads off `<body>` (`vscode-light` / `vscode-dark`) supplied from
  `prefers-color-scheme` instead.

So the cheapest version is: `server.mjs` inlines `panel.css`, `panel.js`, and a `fetch`
of `/api/summary` into one self-contained page. Keeping the two renderers as one file
matters more than keeping the page tidy — two dashboards that drift is the failure mode.

There is a working standalone harness pattern in the git history of this change: write
`panel.css` and `panel.js` into a single HTML file, stub `acquireVsCodeApi`, and
`window.postMessage({type:"summary", summary})`. That is also how the panel gets
screenshotted for design review without launching VS Code.

### macOS menu bar

Once the browser page or the CLI is in place this is a SwiftBar/xbar plugin of about
five lines:

```sh
#!/usr/bin/env sh
# ~/Library/Application Support/SwiftBar/takatime.60s.sh
exec "$HOME/.takatime/bin/taka" --oneline
```

`taka --oneline` already prints `32m today · 11h39m wk ●17m`, and hits the local server
when it is up (~100ms) rather than opening its own Mongo connection.

Two things to decide when building it:

- **Server liveness.** The server exits after 30 minutes idle by default, and is
  auto-started by the VS Code extension. A menu bar plugin polling every 60s would keep
  it alive forever. Either accept that, or run the server under launchd with
  `--exit-after 0` and turn the extension's `takatime.stats.autoStartServer` off.
- **PATH.** SwiftBar plugins do not inherit a login shell's PATH, so `node` may not be
  found. The shim at `~/.takatime/bin/taka` calls `node` directly; give it an absolute
  path or set PATH in the plugin.

---

## Loose ends

### The Go TUI still sums the retired `duration` field

`internal/DBQueryV2/dashboardAggreations.go` and `aggration.go` compute every statistic
with `{"$sum", "$duration"}`. That is wrong three ways, in increasing order of severity:

1. `duration` is the retired field METHODOLOGY.md says never to sum.
2. It mixes v1 and v2 regimes, which err in opposite directions.
3. **v3 heartbeats carry no `duration` field at all**, so `$sum` reads them as zero.
   As v3 data accumulates the TUI's "today" trends toward 0h and stays there.

It also buckets days with `time.Now().Location()` and falls back to `Asia/Kolkata`
(an upstream leftover) rather than the explicit `America/Denver` everything else uses.

The dashboard is no longer wired to a status bar button; it is reachable only from the
command palette, retitled as deprecated. Three options, in order of preference:

- **Delete the stats screens.** Keep `cmd/dashboard` for settings/persona if it is worth
  keeping at all.
- **Have it shell out** to `taka --json` and render that. No second implementation.
- **Port the algorithm to Go.** Only with its own test suite run against
  `analytics/fixtures/*.json`, asserting the same numbers. This is the option that
  creates a second source of truth, which is the thing the redesign exists to avoid.

### v3 has still never been calibrated

METHODOLOGY.md § "Nothing has validated v3 yet" is still true. The database now holds
v3 heartbeats (the regime opened 2026-08-08T20:36:00Z), so the blocker is no longer
missing data — it is that no WakaTime ground truth has been collected in parallel on the
new regime. Run WakaTime alongside for a week, then re-run calibration on v3-only data
and record the result.

Prediction to check against: v3 totals should read ~4–5% *below* comparable v2 totals
for identical work, with the discontinuity at the regime boundary.

### Two spellings of the same project

The data contains both `Takatime` and `TakaTime` as project names, and they are
accumulating time separately (44m and 26m over one week). Project names come from the
VS Code workspace folder name, so this is two checkouts, or one that was renamed.

Deliberately not "fixed" by the migration: rewriting `project` on historical heartbeats
would edit the observation record, which is the one thing migrations here never do. If
it needs solving, solve it at read time with an alias map in `summary.mjs`.

Same category: `Unknown` (capital U) is what `Uploader.js` writes when a file has no
workspace folder, and it ranks as a real project.
