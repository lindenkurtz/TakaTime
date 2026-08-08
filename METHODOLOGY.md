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

1. **Under global throttling it undercounts.** A throttle interval is a floor on the
   time a heartbeat represents, not the time itself. Validated against WakaTime
   running in parallel over 2026-08-02..08: WakaTime measured **8h17m**, summing
   `duration` gave **6h50m** — a **17.5% undercount**.

2. **It mixes incompatible regimes.** The throttle changed on 2026-04-23, from
   *120s per-file* to *300s global*. Under per-file throttling the tracker emitted a
   heartbeat for **every open file** every interval, so projects that keep many files
   open accumulated heartbeats far faster than projects that don't — without any
   more time actually passing. Language shares inherited that distortion:
   JavaScript reads as **24.6%** of all heartbeats but only **12.8%** of attributed
   time.

These compound rather than cancel, and the direction of the error depends on which
era you are looking at — which is why the 17.5% above and the −9.4% all-time figure
in [Current totals](#current-totals) are both correct.

### It errs in opposite directions in different eras

The two failures above do not point the same way, and the headline numbers in this
document look contradictory until you see why.

| Regime | Attributed | Sum of `duration` | Legacy field is |
|---|---|---|---|
| v1 — 120s **per-file** | 36h49m48s | 43h46m00s | **+18.8%** (over) |
| v2 — 300s global | 86h00m57s | 67h34m30s | **−21.4%** (under) |
| All time | 122h50m46s | 111h20m30s | −9.4% |

Under per-file throttling every open file ran its own timer, so April's legacy sum
is *inflated* — a file you were not touching still pinged every 120s. Under global
throttling one timer covers the whole editor, and the interval is a floor, so the sum
*undercounts*. A total spanning both eras nets a 40-point swing down to −9.4%, which
is why the all-time undercount looks so much milder than the 17.5% measured on a
v2-only week.

**So the field is not merely wrong, it is wrong inconsistently.** Comparing April to
August on `duration` is wrong twice over: both numbers are distorted, in opposite
directions, and the comparison manufactures a drop that is entirely an artifact of
the throttle change. Asserted by the test
`the legacy duration field errs in OPPOSITE directions per regime`.

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

More importantly, **the credit is what makes the algorithm approximately
config-invariant.** When the throttle shortens, the first heartbeat of a session
arrives *earlier* (so `span` grows) while the credit shrinks by roughly the same
amount. The two effects largely cancel.

**How well they cancel is measured, and it is not as good as the algebra suggests.**

Take real April heartbeats — the v1 per-file era, median gap ~53s — and thin them
into a 120s stream and a 300s stream, two regimes observing the same underlying work.
Thinning only runs downward; a stream can be coarsened, never refined, which is why
this uses the dense v1 era rather than the v2 calibration data.

| Observed at | Heartbeats | Sessions | Attributed | vs 120s |
|---|---|---|---|---|
| 120s | 578 | 67 | 33h37m10s | — |
| 180s | 426 | 67 | 34h13m26s | +1.80% |
| 240s | 371 | 67 | 35h02m25s | +4.23% |
| **300s** | 319 | 69 | **35h12m02s** | **+4.70%** |
| 420s | 259 | 71 | 36h25m59s | +8.37% |
| 600s | 210 | 81 | 38h12m11s | +13.63% |

So **≈5%, not 1.2%**, between the two regimes the tracker actually runs — and
directional: a coarser throttle reads *high*. The decomposition shows why the
cancellation is only partial:

```
120s:  span 31h23m10s  +  head credit 2h14m00s (67 × 120s)  =  33h37m10s
300s:  span 29h27m02s  +  head credit 5h45m00s (69 × 300s)  =  35h12m02s
       span −1h56m08s     head credit +3h31m00s             =    +1h34m52s
```

Two things the idealised argument omits. First, a real session rarely begins one
full interval before its first heartbeat — it begins whenever it begins — so a 300s
head credit overshoots more often than a 120s one. Second, **session count is itself
a function of the throttle**: coarsening pushes some gaps past `IDLE_TIMEOUT`, and
each newly split session buys another whole head credit (67 → 69 → 71 → 81 as the
interval grows).

The 1.2% figure previously quoted here came from a synthetic test over perfectly
evenly spaced heartbeats. That construction collapses to exactly one session of
`span + interval`, so its drift is `(span+120)/(span+300)−1` regardless of the input
— algebra, not evidence. It is retained as
`config invariance (SYNTHETIC, weak)` to pin the arithmetic, and explicitly labelled
weak. The claim you should trust is
`config invariance (REAL DATA): downsampled bursty activity agrees within 6%`,
with `the synthetic invariance figure is optimistic about real data` guarding against
the weaker number being quoted again.

**What this buys.** ≈5% across a 2.5× throttle change, against the legacy field's
40-point swing across the same change. Config-invariance is a strong property here,
just not an exact one — and it degrades as regimes grow further apart, so the
registry should not be allowed to span wildly different intervals without re-testing.

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

Precisely: **each individual gap** is never split, but a **session** that straddles
midnight is. A session running 23:50 → 00:30 stays one session — `IDLE_TIMEOUT` does
not care about dates — but its *time* lands on both days, because heartbeats after
midnight are themselves attribution points on the next day. Only the one gap that
crosses the boundary is assigned whole, to the earlier heartbeat's day.

That is what keeps days a clean partition: every contribution belongs to exactly one
day, so per-day totals sum to the range total even when sessions span the cut. What
is *not* guaranteed is that a session appears in a single day's bucket, and
`session.day` reports where a session **started**, not everywhere it contributed.

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
`inexactIntervalHeartbeats` is the number that actually bounds the error, and it is
always much smaller than `unstampedHeartbeats`.

**Both are currently zero, across all history.** Every heartbeat in the database
carries a `configVersion`; nothing is resolved by date fallback. Before the
Mathematica tracker was brought in-repo and backfilled, they stood at 112 and 22
respectively — those were the only unstamped records, and they are the numbers an
earlier draft of this document quoted. Verified against the live collection:
`db.logs.countDocuments({ configVersion: { $exists: false } })` returns 0 of 2142,
and the test `every heartbeat in the fixture is stamped` asserts both counters are
zero.

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

Backfilling those records is what took `unstampedHeartbeats` and
`inexactIntervalHeartbeats` to zero — see
[Resolving a heartbeat's interval](#resolving-a-heartbeats-interval) for the current
counts and what they bound.

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
— real heartbeats, checked in so the test needs no database access. (The second
fixture, [`invariance-2026-04.json`](analytics/fixtures/invariance-2026-04.json),
carries the dense v1 era used by the downsampling test above; it has no WakaTime
ground truth and is not part of calibration.)

Regenerate either with `npm run build-fixture -- --only calibration|invariance`.
Refresh them **separately**: `groundTruth` is transcribed by hand from WakaTime's
dashboard, so rebuilding calibration heartbeats on a day that is still accumulating
compares fresh heartbeats against stale ground truth and manufactures drift that is
not in the algorithm.

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
checked at ±20%; single days are inherently noisier because TakaTime and WakaTime
divide a midnight-straddling session by different idle heuristics.

Run it:

```sh
cd analytics && npm test
```

### How settled these numbers actually are

Not very. The calibration is the best evidence available, and it is thin. Read the
+0.27% as *"nothing is badly wrong"*, not as *"the parameters are correct to a third
of a percent."* Four specific weaknesses:

**One day carries the week.** 2026-08-07 is 5h46m of the 8h17m ground truth — **70%
of it**. `IDLE_TIMEOUT = 900` is fitted mostly against a single heavy session day, and
a day that heavy is exactly the shape that constrains an idle timeout least.

**A range of timeouts passes.** 900s is not identified by the data; it is the
WakaTime-compatible default, and it happens to land best:

| `IDLE_TIMEOUT` | 7-day total | Drift | ±10% gate |
|---|---|---|---|
| 600s | 7h31m55s | −9.07% | passes |
| 720s | 7h37m56s | −7.86% | passes |
| **900s** | **8h18m20s** | **+0.27%** | passes |
| 1200s | 8h43m17s | +5.29% | passes |
| 1500s | 9h15m41s | +11.81% | fails |

Anything from roughly 600s to 1200s survives the gate. **Treat 900s as provisional** —
a defensible default that one week of data failed to rule out, not a fitted constant.

**The headline agreement is partly cancellation.** The +0.27% total is the residue of
errors that happen to offset: −864s on 08-06, +317s on 08-07, +8s on 08-08, and
+620s on days with no ground truth at all. Day-level agreement is meaningfully worse
than the total implies.

**Ground truth covers 3 of the 5 active days.** WakaTime's `daySeconds` enumerates
08-06, 08-07 and 08-08 (27656s), but its range total is 29820s — the missing 2164s
fell on 08-04 and 08-05, where TakaTime attributes 2784s. Those days are inside the
±10% total check but escape the ±20% per-day check entirely.

Fresh WakaTime data covering more days — especially several moderate ones rather than
one heavy one — is the single highest-value thing that could firm this up.

### Nothing has validated v3 yet

**All calibration above is v2 (300s) data.** As of this writing the database contains
**zero v3 heartbeats** — the regime opens at `2026-08-09T06:00:00Z`, which has not
arrived. Everything this document says about the 120s regime is therefore a
*prediction*, resting on the real-data invariance measurement rather than on
observation.

The concrete prediction: because coarser throttles read high, **v3 totals should run
a few percent below comparable v2 totals for identical work** — around 4–5% by the
downsampling result, and the discontinuity will sit at the regime boundary. If a
step change of roughly that size and direction appears there, it is expected. A much
larger one, or one in the other direction, is not.

**Outstanding:** once a week of v3 data exists, re-run calibration against WakaTime on
v3-only data and record the result here. Until that happens, config invariance is the
algorithm's central claim *and* its least-tested one.

---

## What this does not measure

**This is a measure of editor activity, not of work.** The tracker's only sense organ
is a VS Code (or Mathematica) event. Everything below is real work that TakaTime
records as zero, by design:

- **Thinking longer than 15 minutes.** Staring at a problem is indistinguishable from
  being at lunch. Any pause past `IDLE_TIMEOUT` ends the session, and the design
  prefers that over inventing time.
- **Reading.** Documentation, Stack Overflow, API references, a PR diff on GitHub — a
  browser is invisible.
- **Anything outside the editor.** Debugging in a terminal, `git` work from the
  command line, database consoles, log tailing, a running app under manual test.
- **Whiteboarding, notebooks, and conversation.** Design work on paper, and every
  meeting or code review.
- **Compiling and waiting.** Long builds, CI runs, and test suites credit nothing
  unless you are editing while they run.
- **Other editors.** Only the two trackers in the table above write to this database.

Two consequences worth internalising. A week of hard design work can look like a light
week, and **a low number is not evidence of a lazy week** — it may be a week spent
reading and thinking rather than typing. And because idle time is cut rather than
estimated, this measure is **biased low against wall-clock effort**, deliberately:
`IDLE_TIMEOUT` truncates any real pause over 15 minutes, and the only offsetting term
is one throttle interval per session head.

The right reading of these numbers is *"time with hands on the keyboard in a tracked
editor"* — a consistent, comparable floor under the real figure, not the real figure.

---

## Current totals

Full history, 2026-04-04 through 2026-08-08 — 2142 heartbeats, 287 sessions,
65 active days. **Snapshot taken 2026-08-08T21:25Z**; these drift as data lands, and
are reproducible with `npm run export`.

| | |
|---|---|
| Attributed time (this algorithm) | **122h50m46s** |
| Sum of legacy `duration` field | 111h20m30s (**wrong**, −9.4%) |

Language shares, showing why heartbeat counts are not a proxy for time:

| Language | Share of heartbeats | Share of time | Time |
|---|---|---|---|
| python | 21.3% | **28.5%** | 35h03m10s |
| javascript | 24.6% | **12.8%** | 15h39m53s |
| wolframlanguage | 5.2% | 6.5% | 7h59m30s |
| astro | 13.4% | **6.5%** | 7h57m55s |
| c | 3.4% | 6.2% | 7h39m44s |
| javascriptreact | 4.4% | 4.8% | 5h52m49s |
| markdown | 3.3% | 4.5% | 5h29m15s |
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
npm test                        # calibration + invariants + real-data invariance
npm run export                  # full bundle: heartbeats + configs + algorithm + this doc
```

`npm test` needs no database and reproduces the calibration table, the invariance
tables, and the legacy-field comparisons — every one of those numbers is printed as
the suite runs. The whole-history figures under [Current totals](#current-totals) and
the per-regime table need the live collection, and `npm run export` is the way to get
them.

The export bundle is self-contained — hand the folder to any analysis tool and it has
everything needed to interpret the data, including this document, both fixtures, and
a runnable copy of the algorithm.

---

## Changing the throttle in future

1. Change the interval in `vscodePlugin/Takatime/Plugin/HeartBeat.js`.
2. Bump `CONFIG_VERSION` there to the next integer.
3. Add the new regime to `CONFIG_REGISTRY` in `analytics/duration.mjs`, closing the
   previous entry's `to` at the same instant. Use a real ISO-8601 instant — the
   moment the new build is actually **installed**, not the moment you commit.
4. Run `npm run migrate:apply` to publish the registry to the `configs` collection.
5. Rebuild the binary: `./scripts/build-binaries.sh`.
6. Re-run `npm test`. The calibration runs on a **fixed historical fixture**, so it
   will not move at all — that is a regression check on the algorithm, not evidence
   about the new regime. Passing it says nothing about whether the new throttle is
   config-invariant in practice.
7. **Re-calibrate against fresh ground truth on the new regime.** Run WakaTime in
   parallel for a week of new-regime data, then compare. Expect a step of a few
   percent at the boundary — coarsening reads high, so shortening the throttle
   should read slightly *low* — and treat anything much larger as a real problem.
   Record the result under "Calibration".

Steps 6 and 7 are different claims and neither substitutes for the other. Step 6 asks
*"did I break the algorithm?"*; step 7 asks *"does the algorithm still track reality
under this throttle?"* The current registry has never had step 7 performed for v3.

Historical data stays correct across the change, which is the whole point. But only
if step 3 happens.
