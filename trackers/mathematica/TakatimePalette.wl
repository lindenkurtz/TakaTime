(* TakaTime heartbeat tracker for Mathematica.

   Fires at most one heartbeat per $TakatimeInterval seconds, attributed to the
   notebook that most recently evaluated. A heartbeat is an OBSERVATION, not a
   duration -- see METHODOLOGY.md at the repository root.

   Install: see README.md in this directory. *)

(* ── Configuration ─────────────────────────────────────────────── *)
$TakatimeRepo     = "/Users/lindenkurtz/Code/Personal/likutime/TakaTime";
$TakatimePython   = "/Users/lindenkurtz/Code/Personal/likutime/.venv/bin/python";
$TakatimeScript   = FileNameJoin[{$TakatimeRepo, "trackers", "mathematica", "takatime_mathematica.py"}];

(* Throttle, in seconds. Config regime v3.

   MUST match CONFIG_VERSION in takatime_mathematica.py and the open-ended entry
   in CONFIG_REGISTRY (analytics/duration.mjs). If you change this, add a new
   regime to the registry and bump both constants -- otherwise every heartbeat
   after the change is interpreted with the wrong interval. *)
$TakatimeInterval = 120;
(* ──────────────────────────────────────────────────────────────── *)

$TakatimeRunning  = False;
$TakatimeLastSent = 0;

TakatimeSendHeartbeatNow[] := Module[{nbPath, proc},
  nbPath = Quiet[NotebookFileName[]];
  If[!StringQ[nbPath], nbPath = "unknown"];

  proc = RunProcess[{$TakatimePython, $TakatimeScript, nbPath}];

  If[proc["ExitCode"] === 0, $TakatimeLastSent = AbsoluteTime[]];
  proc
];

TakatimeMaybeFire[] := If[
  AbsoluteTime[] - $TakatimeLastSent >= $TakatimeInterval,
  TakatimeSendHeartbeatNow[]
];

TakatimeStart[] := (
  If[TrueQ[$TakatimeRunning], Return[]];
  $Pre = Function[expr, TakatimeMaybeFire[]; expr];
  $TakatimeRunning = True;
);

TakatimeStop[] := (
  If[!TrueQ[$TakatimeRunning], Return[]];
  $Pre =.;
  $TakatimeRunning = False;
);

TakatimeStart[];
