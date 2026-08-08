# TakaTime Methodology

How TakaTime turns raw heartbeats into hours, and why it does it that way.

This document is the contract between the tracker and anything that reads its data.
If you are writing a query, a dashboard, or a stats page against the `takatime`
database, read this first.

---

## ⚠️ Do not sum the `duration` field

`duration` is a **retired** field. It exists only on heartbeats written before
2026-08-09 (config regime v3), and summing it is wrong.

It never held measured time. It held the tracker's *throttle interval*, copied into
every record at write time. That made it an interpretation baked into the raw log,
and it is wrong in two independent ways:

1. **It undercounts.** A throttle interval is a floor on the time a heartbeat
   represents, not the time itself. Validated against WakaTime running in parallel
   over 2026-08-02..08: WakaTime measured **8h17m**, summing `duration` gave
   **6h50m** — a **17.5% undercount**.

2. **It mixes incompatible regimes.** The throttle changed on 2026-04-23, from
   *120s per-file* to *300s global*. Under per-file throttling the tracker emitted a
   heartbeat for **every open file** every interval, so projects that keep many files
   open accumulated heartbeats far faster than projects that don't — without any
   more time actually passing. Language shares inherited that distortion:
   JavaScript reads as **24.4%** of all heartbeats but only **12.5%** of attributed
   time.

The field is still present on historical records, and it is intentionally never
edited or deleted. **The raw log is an observation record.** Rewriting it would
destroy the only ground truth there is. It is preserved, not endorsed.

**Use `analytics/duration.mjs`.**

---

## What a heartbeat is

A heartbeat is an **observation**:

> "This file, in this project, in this language, on this branch, was being edited at
> this instant."

That is all. It carries no claim about how long anything took. Duration is a
*derived* quantity, computed at query time from the pattern of timestamps.

```js
{
  name: "/Users/…/main.c",   // file path
  project: "playground",
  timestamp: ISODate("2026-08-07T14:05:30.123Z"),  // ← the actual record
  date: "2026-08-07",        // convenience string; see "The `date` field" below
  language: "c",
  os: "darwin",
  gitBranch: "main",
  editor: "VsCode",
  configVersion: 2,          // which throttle regime produced this heartbeat
  duration: 300              // ⚠️ legacy, pre-v3 records only. Do not sum.
}
```

### Why derive at query time

Because the tracker's config *will* change again, and the last time it changed it
silently corrupted every historical total. Storing observations and deriving
interpretations means a future throttle change re-interprets old data correctly
instead of poisoning it. That is the entire point of this redesign.

---

## The canonical algorithm

Implemented in [`analytics/duration.mjs`](analytics/duration.mjs) — pure,
zero-dependency ESM, no database and no editor imports, so it can be copied verbatim
into consuming repos. It exports `ALGORITHM_VERSION`; record that alongside any
derived statistic you persist.

### Parameters

| Parameter | Current value | Meaning |
|---|---|---|
| `IDLE_TIMEOUT` | **900s** (15 min) | A gap longer than this ends the session |
| `timeZone` | **America/Denver** | Zone whose midnight cuts daily buckets |
| `intervalSeconds` | resolved per heartbeat | The throttle in force when it was written |

`IDLE_TIMEOUT` is configurable via `options.idleTimeoutSeconds`. 900s is the
WakaTime-compatible default and is what the calibration below was fitted against.

### The rules

Given heartbeats sorted ascending by timestamp:

1. Start a new session whenever `gap(prev, current) > IDLE_TIMEOUT`.
2. For each consecutive pair **within** a session, credit `gap(prev, current)` to the
   language / project / branch / file of the **earlier** heartbeat.
3. Credit the first heartbeat of each session with `intervalSeconds` resolved from
   its own `configVersion`.

Therefore:

```
session duration = span(first, last) + intervalSeconds(first)
single-heartbeat session = intervalSeconds
```

### Why the interval credit exists

Without it, a session's duration would be `span(first, last)` — which silently drops
the head of every session. The throttle had already been running for up to one full
interval before the first heartbeat fired, and that time was real work.

More importantly, **the credit is what makes the algorithm config-invariant.** When
the throttle shortens, the first heartbeat of a session arrives *earlier* (so `span`
grows) while the credit shrinks by roughly the same amount. The two effects cancel.
The same four hours of work measured under a 120s throttle and a 300s throttle differ
by 180 seconds — 1.2% — instead of by a factor of 2.5.

This is verified directly by the test
`config invariance: the same activity measured at 120s and 300s agrees closely`.

### Attribution

Every credit goes to the **earlier** heartbeat of the pair. If you were editing
`main.c` at 14:05 and `config.json` at 14:10, the five minutes between belong to
`main.c` — the work happened *before* the observation that ended it, not after.

The same rule drives every grouping dimension: language, project, git branch, file,
editor, OS, and day are all read off that same earlier heartbeat. This is what makes
the additivity invariant hold.

### The additivity invariant

> Summing over any grouping dimension equals the grand total, exactly.

Not approximately — exactly. All accounting is done in **integer milliseconds**, so
there is no floating-point drift to accumulate. `computeDurations()` returns integer
ms everywhere; `toSeconds()` and `formatDuration()` are display helpers.

This is asserted in the test suite over the real fixture across all eight grouping
dimensions, and again per-day.

### Daily bucketing and timezone

Each gap is attributed to the day of its **earlier** heartbeat, in an explicit IANA
timezone — **America/Denver**, not UTC and not the viewer's local zone.

A session that runs from 23:50 to 00:30 is therefore not split across two days: the
gap belongs wholly to the day the earlier heartbeat fell in. Days remain a clean
partition, which is what keeps per-day totals summing to the range total.

**Why an explicit zone:** UTC bucketing would cut the day at 18:00 local, splitting
almost every evening session and making "hours per day" meaningless. The zone is a
parameter (`options.timeZone`) rather than a constant, but every published TakaTime
statistic uses America/Denver, and mixing zones across a comparison invalidates it.

#### The `date` field

The stored `date` string is **not** used by the algorithm and should not be trusted.
It was written with `time.Now().Format("2006-01-02")` in whatever timezone the
machine happened to be in at the time — 84 historical records disagree with their
own timestamp's Denver date, because the machine was running in UTC during early
April 2026. The `timestamp` is the record; `date` is a convenience string that
predates anyone thinking carefully about this.

### Range queries and the lookback buffer

Querying a bounded range naively splits any session straddling the start boundary,
inventing a spurious session head (and an extra interval credit) at the edge.

To avoid it, fetch a **lookback buffer** of `IDLE_TIMEOUT` before the range start,
pass the whole set, and let the algorithm clip:

```js
import { computeDurations, lookbackStart } from "./duration.mjs";

const range = { start: "2026-08-02T00:00:00-06:00", end: "2026-08-09T00:00:00-06:00" };

const heartbeats = await logs
  .find({ timestamp: { $gte: new Date(lookbackStart(range.start)), $lt: new Date(range.end) } })
  .sort({ timestamp: 1 })
  .toArray();

const result = computeDurations(heartbeats, { range });
```

Heartbeats before `range.start` are used as **session context** but contribute
nothing to the totals. Clipping is by *attribution point*: a contribution belongs
wholly to the heartbeat it is credited to, so it is either fully in the range or
fully out. This is the same rule that assigns a gap to a day, which is why per-day
buckets sum exactly to range totals.

---

## Config history

Every regime the tracker has run under. Stored in the `configs` collection, and
mirrored in `CONFIG_REGISTRY` in `analytics/duration.mjs` — **the module is the
source of truth**; the collection is published from it by the migration, never the
reverse.

| Version | Interval | Scope | From (inclusive) | To (exclusive) |
|---|---|---|---|---|
| 1 | 120s | per-file | `2026-04-03T00:00:00.000Z` | `2026-04-23T20:57:09.808Z` |
| 2 | 300s | global | `2026-04-23T20:57:09.808Z` | `2026-08-09T06:00:00.000Z` |
| 3 | 120s | global | `2026-08-09T06:00:00.000Z` | *(current)* |

**Scope** is the part that is easy to miss. `per-file` means one independent throttle
timer *per open file*, so N files being edited produced roughly N× the heartbeats for
the same elapsed time. `global` means a single timer for the whole editor: one
heartbeat per interval, attributed to the most recently edited file.

### Boundaries are empirical, not from the git log

The v1→v2 boundary is `2026-04-23T20:57:09.808Z` — the observed instant the written
`duration` flips from 120 to 300. The commits that made the change landed on
2026-04-21, but the rebuilt binary was not actually installed until two days later.
**The heartbeats describe the heartbeats.** Using the commit dates would have
mis-stamped every record in that two-day window.

The boundary is corroborated independently by heartbeat density: before it, 51.7% of
consecutive gaps are under 60 seconds (the signature of per-file throttling); after
it, 0.1% are.

Boundaries are full ISO-8601 instants, not dates, because the v1→v2 cutover happened
mid-afternoon. A date-granular registry cannot express it.

### Resolving a heartbeat's interval

1. **Preferred:** the heartbeat's own `configVersion`, stamped at write time.
2. **Fallback:** match the heartbeat's `timestamp` against the config registry.

The fallback never throws. `resolveInterval()` reports which path it took via
`.exact` and `.reason`, and `computeDurations()` surfaces the totals as
`unstampedHeartbeats` and `inexactIntervalHeartbeats`. A non-zero count means part of
the result rests on an assumption.

Note the difference between those two counters. An unstamped heartbeat *in the middle
of a session* costs nothing — only session heads consume an interval. So
`inexactIntervalHeartbeats` (currently 22 across all history) is the number that
actually bounds the error, and it is much smaller than `unstampedHeartbeats` (112).

---

## Trackers

Two trackers write to this database. **Both share the config regime timeline above** —
that alignment is why `CONFIG_REGISTRY` is a single linear series rather than being
keyed per tracker.

| Tracker | Source | Writes via | Editor field |
|---|---|---|---|
| VS Code | [`vscodePlugin/Takatime/`](vscodePlugin/Takatime/) | `taka-upload` (Go) | `VsCode` |
| Mathematica | [`trackers/mathematica/`](trackers/mathematica/) | pymongo, direct | `Mathematica` |

The Mathematica tracker was previously undocumented and excluded from the migration,
because its throttle history was unknown. Its source now lives in this repository, and
the data confirms it followed the same regimes on the same boundaries:

| Duration written | Regime window | Heartbeats | Range |
|---|---|---|---|
| 120s | v1 | 51 | 2026-04-13 .. 04-23 |
| 300s | v2 | 51 | 2026-04-23 .. 08-08 |
| 30s | v2 | 9 | 2026-05-21 (experiment) |

Every heartbeat in the database now carries a `configVersion`. Nothing is resolved by
date fallback, and `unstampedHeartbeats` / `inexactIntervalHeartbeats` are both zero.

**Keeping them aligned is a maintenance obligation.** Three constants must agree:
`$TakatimeInterval` in `TakatimePalette.wl`, `CONFIG_VERSION` in
`takatime_mathematica.py`, and the open-ended regime in `CONFIG_REGISTRY`. If the two
trackers ever diverge, the registry has to become per-tracker — a schema change. The
test `Mathematica shares the VS Code regime timeline` fails if that assumption breaks.

### Remaining caveats

**The 30-second experiment.** Nine heartbeats on 2026-05-21 ran at a 30s throttle
inside the v2 (300s) window and are stamped v2 with everything else there. They fall
in a single session, so the worst case is one session head credited 300s instead of
30s — 270 seconds, once, across the whole history. A fourth regime would cost more
clarity than it buys accuracy.

**WakaTime never observed Mathematica.** Calibration must still filter to
`editor === "VsCode"`, regardless of stamping. Including Mathematica inflates
2026-08-08 by 47%, which is an artifact of the comparison, not an algorithm error.

**`-configVersion` remains optional on `taka-upload`.** Callers spawn it
fire-and-forget with stdio discarded, so a hard requirement would turn any
misconfigured caller into silent data loss. The date fallback stays supported and
tested for exactly that reason.

### The write-side deployment window

The extension stamps `configVersion: 3` itself, but only once the **v2.3.0 Go
binary** is installed (`scripts/build-binaries.sh`). Until then the extension skips
uploads rather than writing unstamped records — it fails closed on purpose, because
a v2.2.x binary rejects the `-configVersion` flag outright.

The migration deliberately does **not** backfill the open-ended current regime. A
heartbeat landing in that window without a stamp means an old binary is still
running, and guessing its interval would hide a real deployment problem.

---

## Calibration

Regression-tested against WakaTime, run in parallel on the same machine over the same
week. Fixture: [`analytics/fixtures/calibration-2026-08.json`](analytics/fixtures/calibration-2026-08.json)
— real heartbeats, checked in so the test needs no database access.

WakaTime only ever observed VS Code, so the comparison filters to
`editor === "VsCode"`. Comparing WakaTime against a total that includes Mathematica
time inflates 2026-08-08 by 47%, which is an artifact of the comparison, not an error
in the algorithm.

With `IDLE_TIMEOUT = 900s` and the interval credit:

| Day (America/Denver) | TakaTime | WakaTime | Drift |
|---|---|---|---|
| 2026-08-06 | 1h13m32s | 1h27m56s | −16.4% |
| 2026-08-07 | 5h51m17s | 5h46m00s | +1.5% |
| 2026-08-08 | 0h27m08s | 0h27m00s | +0.5% |
| **2026-08-02 .. 08 total** | **8h18m20s** | **8h17m00s** | **+0.27%** |

For contrast, summing the legacy `duration` field over the same window gives
**6h50m00s** — a **17.5%** undercount.

**The test fails if the 7-day total drifts outside ±10%.** Individual days are
checked at ±20%; single days are inherently noisier because a session that straddles
midnight lands wholly in one day for TakaTime and may be split differently by
WakaTime's own idle heuristics.

Run it:

```sh
cd analytics && npm test
```

---

## Current totals

Full history, 2026-04-03 through 2026-08-08 — 2130 heartbeats, 284 sessions,
65 active days.

| | |
|---|---|
| Attributed time (this algorithm) | **122h11m37s** |
| Sum of legacy `duration` field | 111h10m30s (**wrong**, −9.0%) |

Language shares, showing why heartbeat counts are not a proxy for time:

| Language | Share of heartbeats | Share of time | Time |
|---|---|---|---|
| python | 21.4% | **28.7%** | 35h00m44s |
| javascript | 24.4% | **12.5%** | 15h16m59s |
| wolframlanguage | 5.2% | 6.5% | 7h59m30s |
| astro | 13.5% | **6.5%** | 7h57m55s |
| c | 3.4% | 6.3% | 7h39m44s |
| javascriptreact | 4.5% | 4.8% | 5h52m49s |
| markdown | 3.1% | 4.3% | 5h15m26s |
| csharp | 1.8% | 3.9% | 4h46m47s |

JavaScript and Astro are the per-file-throttle artifact in the raw data: both are
web projects with many files open simultaneously, and both roughly halve when time is
attributed properly rather than counted.

No language is filtered out. Markdown, JSON, and config files are all tracked and
reported; filtering is a downstream decision, not a collection-time one.

---

## Reproducing any number here

```sh
cd analytics
npm install
npm test                        # calibration + invariants
npm run export                  # full bundle: heartbeats + configs + algorithm + this doc
```

The export bundle is self-contained — hand the folder to any analysis tool and it has
everything needed to interpret the data, including this document and a runnable copy
of the algorithm.

---

## Changing the throttle in future

1. Change the interval in `vscodePlugin/Takatime/Plugin/HeartBeat.js`.
2. Bump `CONFIG_VERSION` there to the next integer.
3. Add the new regime to `CONFIG_REGISTRY` in `analytics/duration.mjs`, closing the
   previous entry's `to` at the same instant. Use a real ISO-8601 instant — the
   moment the new build is actually **installed**, not the moment you commit.
4. Run `npm run migrate:apply` to publish the registry to the `configs` collection.
5. Rebuild the binary: `./scripts/build-binaries.sh`.
6. Re-run `npm test`. The calibration should not move — if it does, the change was
   not config-invariant and needs investigating before it is trusted.

Historical data stays correct across the change, which is the whole point. But only
if step 3 happens.
