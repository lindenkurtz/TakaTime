# Claude Code tracker

Turns Claude Code sessions into TakaTime heartbeats, so AI-written time is tracked
beside hand-written time and the two stay separable.

Unlike the other two trackers, this one is an **importer** rather than an emitter. It
reads the transcripts Claude Code already writes to `~/.claude/projects/**/*.jsonl` and
converts them into heartbeats after the fact.

## Why an importer and not hooks

Hooks would give live events and no history. They are also stateless shell
invocations, so the 120s throttle would need its own state file on disk, and a hook
that is misconfigured or never fires is silent data loss.

The transcripts are a complete record that is already on disk, so one idempotent
importer covers **both** backfill and live capture — a `Stop` hook just re-runs it.
Every document gets a deterministic `_id` and the only write is `$setOnInsert`, so
re-running never duplicates or modifies anything.

The cost is that the JSONL layout is Claude Code's internal format and can change
without notice. All of the parsing is therefore in one file, `transcript.mjs`, behind
a fixture test.

## Files

| File | Role |
|---|---|
| `transcript.mjs` | **Pure.** Records → heartbeats + write observations. No fs, no DB. |
| `import-claude.mjs` | Walks `~/.claude/projects`, resolves git roots, writes to MongoDB |

Tests live in [`analytics/test/claude-code.test.mjs`](../../analytics/test/claude-code.test.mjs)
and run with the rest of the suite (`cd analytics && npm test`). They need no
database and no Claude Code.

## Install

`./scripts/build-binaries.sh` copies both files to `~/.takatime/trackers/claude-code/`
and installs a shim at `~/.takatime/bin/taka-claude-import`.

The install mirrors the repo layout on purpose: `import-claude.mjs` imports
`../../analytics/duration.mjs` to read `CONFIG_REGISTRY`, so the tracker and the
algorithm cannot drift apart on what the throttle interval is.

### Backfill

```sh
node trackers/claude-code/import-claude.mjs           # dry run, prints what it would do
node trackers/claude-code/import-claude.mjs --apply   # commit
```

### Live capture

Add a `Stop` hook to `~/.claude/settings.json` so every finished turn triggers an
import:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "$HOME/.takatime/bin/taka-claude-import" }
        ]
      }
    ]
  }
}
```

The shim already passes `--apply --quiet`. The hook fires on every finished turn,
while the 120s throttle means most turns produce no new heartbeat, so the importer
fingerprints its last successful run in `~/.takatime/claude-import-state.json` and
skips the database entirely when nothing has changed — about 0.3s instead of 1.6s.
`--force` writes anyway.

The fingerprint is heartbeat count, write count and latest instant together, not just
the latest instant: resuming an old session adds records without moving the maximum.

A `launchd` timer works equally well if you would rather not add a hook — the
importer does not care what invokes it.

**Per machine.** Transcripts are local, so the importer must run on every machine you
use Claude Code on. Sessions on another machine are invisible here until it runs
there; the heartbeats all land in the same database.

## What counts as AI time

Two rules, both derived by checking measured AI share per project against the
author's own recollection of which projects were AI-written. Both were wrong on the
first attempt, and both are pinned by tests.

**Authorship, not presence.** A session in which Claude never modified a file is
*advisory* — you asked questions while doing the work yourself — and contributes no
heartbeats at all. Counting an open session as AI time marked two projects the author
knew to be hand-written as 15% and 24% AI.

**Shell writes count; shell redirects do not.** Claude authors code through
`cat > file << 'EOF'` heredocs as readily as through the Edit tool — one project was
93 Bash calls and zero Edit calls. But a bare `> file` redirect is usually compiler or
test output, and treating those as authorship is what made a hand-written project read
13% AI.

## Throttling

The raw transcript is roughly 50× denser than an editor heartbeat stream (median gap
2.2s against 120s). Feeding that to the algorithm unchanged would not be wrong so much
as **incomparable** — a dense stream has almost no unobserved gaps, so it measures a
different thing than the editor stream beside it.

The importer therefore downsamples to the interval in force at each instant, read from
`CONFIG_REGISTRY`. That keeps the two streams commensurable *and* keeps the registry a
single linear series, which is the assumption `duration.mjs` rests on. Measured cost of
the downsample over the whole corpus: 11h53m unthrottled against 11h24m throttled, 4% —
the same order as the config-invariance drift the algorithm already tolerates.

This tracker introduces **no new config regime**. It does not choose an interval; it
reads the one already in force, so there is nothing to keep in sync. See
[METHODOLOGY.md](../../METHODOLOGY.md).

## The `aiWrites` collection

Alongside heartbeats, the importer records every instant Claude modified a file, in a
separate `aiWrites` collection:

```js
{ _id: "cw:<hash>", timestamp: ISODate(…), file: "/abs/path", editor: "ClaudeCode", os: "darwin" }
```

These are **not** heartbeats — they carry no duration and never reach the algorithm.
`summary.mjs` uses them for exactly one thing: deciding whether an editor heartbeat is
an *echo* of an agent's write. VS Code fires `onDidChangeTextDocument` when Claude
edits an open file and cannot tell who made the edit, so without this join those
heartbeats read as you typing. Over the measured corpus that inflated human time by
9.4%.

## Credentials

The connection string is **never** stored in this directory. It is read from
`$TAKATIME_MONGO_URI`, `$MONGO_URI`, or `MONGO_URI` in `~/.takatime.json` — the same
file the VS Code extension writes, so every tracker shares one config.

## Undo

Everything this tracker writes is prefixed and additive, so it can be removed without
touching a single pre-existing record:

```js
db.logs.deleteMany({ editor: "ClaudeCode" })
db.aiWrites.drop()
```
