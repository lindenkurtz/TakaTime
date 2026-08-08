# Change Log

All notable changes to the "Takatime" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.2.1] — 2026-08-08

### Removed

- **`Plugin/BinaryDownload.js`.** It fetched release binaries from the *upstream*
  repository (`Rtarun3606k/TakaTime`), which never publishes this fork's versions —
  so it could only ever install a binary older than the extension asking for it,
  which is exactly how the v2.3.0 upgrade got stuck.

  Binaries are now built from source with `./scripts/build-binaries.sh`. Setup and
  the status bar point at that command instead of offering a download.

## [0.2.0] — 2026-08-08

Heartbeats are now observations only. `duration` is retired.

### Removed

- **`duration` is no longer written to new heartbeats.** It was never a
  measurement. It only ever held the tracker's throttle interval, copied into
  every record at write time — so it recorded an *interpretation*, not an
  observation, and that interpretation was frozen in the raw log forever.

  That made it wrong in two ways. Summing it undercounted real time by ~18%
  against WakaTime run in parallel (6h50m vs 8h17m over 2026-08-02..08),
  because a heartbeat's throttle interval is a floor on elapsed time, not the
  elapsed time itself. And because the throttle changed on 2026-04-23 (120s
  per-file → 300s global), every sum silently mixed two incompatible regimes:
  the old per-file throttle emitted one heartbeat *per open file* per interval,
  which inflated the apparent share of projects that keep many files open.
  JavaScript read as ~24% of heartbeats but only ~12% of attributed time.

  Durations are now derived at **query time** from timestamps, so a future
  throttle change can never corrupt historical data again. The canonical
  implementation is `analytics/duration.mjs` at the repo root, and the full
  rationale is in `METHODOLOGY.md`.

  Existing records keep their `duration` field — the raw log is an observation
  record and is not ours to edit. **Do not sum it.** It exists only on
  pre-v3 heartbeats.

### Added

- **`configVersion: 3` is stamped on every new heartbeat**, identifying the
  tracker config regime that produced it. The query-time algorithm resolves the
  throttle interval from this rather than guessing from the date. Heartbeats
  without it fall back to date resolution against the `configs` collection.
- **`configs` collection** describing every throttle regime the tracker has run
  under, with exact ISO-8601 boundaries.
- `scripts/build-binaries.sh` to build and install the Go binaries locally.

### Changed

- **Throttle is now 120 seconds** (was 300), scope unchanged (global — one
  heartbeat per interval across all files, attributed to the most recently
  edited file). Finer resolution costs nothing now that durations are derived
  from gaps rather than from the interval constant.
- Requires binary **v2.3.0**. The binary now requires `-configVersion` and
  ignores `-duration`.

### Upgrading

The v2.3.0 binary is **not** on upstream's releases page — this fork's versions
never are. Build it before or alongside this extension update:

```sh
./scripts/build-binaries.sh
```

Until that binary exists at `~/.takatime/bin/taka-upload-v2.3.0`, the extension
skips uploads and the status bar reads "Binaries Missing". This is deliberate:
the v2.2.x binary rejects the `-configVersion` flag, so failing closed loses
less than failing open would.

## [0.1.3]

- Initial release
