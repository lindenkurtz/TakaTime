# Mathematica tracker

Emits TakaTime heartbeats from Mathematica notebooks.

Unlike the VS Code extension, this writes to MongoDB directly rather than going
through `taka-upload` — Mathematica already has a Python bridge, so the Go binary
would only add a process spawn.

## Files

| File | Role |
|---|---|
| `TakatimePalette.wl` | Hooks `$Pre` to fire on evaluation, throttled |
| `takatime_mathematica.py` | Writes one heartbeat document to MongoDB |

## Install

The palette runs on Mathematica startup via `init.m`:

```wolfram
(* ~/Library/Mathematica/Kernel/init.m  — or $UserBaseDirectory/Kernel/init.m *)
Get["/Users/lindenkurtz/Code/Personal/likutime/TakaTime/trackers/mathematica/TakatimePalette.wl"]
```

Adjust `$TakatimeRepo` and `$TakatimePython` at the top of the `.wl` if either path
moves. The Python side needs `pymongo` and `certifi`:

```sh
/Users/lindenkurtz/Code/Personal/likutime/.venv/bin/pip install pymongo certifi
```

Control it with `TakatimeStart[]` and `TakatimeStop[]`. Writes are logged to
`/tmp/takatime_python.log`.

## Credentials

The connection string is **never** stored in this directory. It is read from
`$TAKATIME_MONGO_URI`, `$MONGO_URI`, or `MONGO_URI` in `~/.takatime.json` — the same
file the VS Code extension writes, so both trackers share one config.

## Config regime

This tracker shares the VS Code regime timeline and always has: 120s under v1, 300s
under v2, flipping on the same boundaries, now 120s under v3. That alignment is why
`CONFIG_REGISTRY` in `analytics/duration.mjs` can stay a single linear series instead
of becoming per-tracker.

**Keep it aligned.** Three constants must agree, or heartbeats get interpreted with
the wrong interval:

| Constant | Where |
|---|---|
| `$TakatimeInterval = 120` | `TakatimePalette.wl` |
| `CONFIG_VERSION = 3` | `takatime_mathematica.py` |
| `intervalSeconds` on the open regime | `analytics/duration.mjs` |

Changing the throttle means adding a new regime to the registry and bumping both
constants here. See the "Changing the throttle in future" section of
[METHODOLOGY.md](../../METHODOLOGY.md).

## Known quirk

Nine heartbeats on 2026-05-21 were written with a 30-second throttle during a brief
experiment, inside the v2 (300s) window. They are stamped `configVersion: 2` with
everything else in that window. Worst case this overcredits a single session head by
270 seconds, once, in the whole history — not worth a fourth regime.
