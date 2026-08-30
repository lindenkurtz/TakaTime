/**
 * Tests for the Claude Code tracker's pure half.
 *
 * The detection rules here decide how much of your time reads as AI-written, so they
 * are pinned against synthetic transcripts rather than live data: a rule that is
 * wrong in a way the corpus happens not to exercise is still wrong.
 *
 * Several cases below are transcribed from real sessions whose authorship the author
 * confirmed by hand — those are marked, and they are the ones that caught the two
 * rules that were wrong on the first pass. See METHODOLOGY.md.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  EDITOR,
  authoringTarget,
  buildHeartbeats,
  languageOf,
  parseRecords,
} from "../../trackers/claude-code/transcript.mjs";
import { CONFIG_REGISTRY, computeDurations, resolveInterval } from "../duration.mjs";

const regimeAt = (ms) => {
  const r = resolveInterval({ timestamp: ms }, CONFIG_REGISTRY);
  return { intervalSeconds: r.intervalSeconds, version: r.version };
};

/** Build one transcript record. */
const at = (iso, extra) => ({
  type: "assistant",
  sessionId: "s1",
  cwd: "/repo",
  gitBranch: "main",
  timestamp: iso,
  ...extra,
});

const userAt = (iso, sessionId = "s1") => ({
  type: "user",
  sessionId,
  cwd: "/repo",
  gitBranch: "main",
  timestamp: iso,
  message: { content: [{ type: "text", text: "go" }] },
});

const toolUse = (name, input) => ({ message: { content: [{ type: "tool_use", name, input }] } });

/* -------------------------------------------------------------------------- */
/* Authorship: the shell rules                                                 */
/* -------------------------------------------------------------------------- */

test("a heredoc write is authorship", () => {
  // Verbatim from the pi_estimation session, which the author confirmed was ~70% AI
  // and which contains ZERO Edit/Write tool calls — all 93 writes went through Bash.
  assert.equal(authoringTarget("cat > chudnovsky_hp.c << 'EOF'"), "chudnovsky_hp.c");
  assert.equal(authoringTarget("cat >> chudnovsky_hp.c << 'EOF'"), "chudnovsky_hp.c");
  assert.equal(authoringTarget("cat > ref_pi.py << 'PYEOF'"), "ref_pi.py");
  assert.equal(authoringTarget("tee src/main.rs <<'EOF'"), "src/main.rs");
});

test("an in-place edit is authorship", () => {
  assert.equal(authoringTarget("sed -i '' 's/a/b/' Plugin/Config.js"), "Plugin/Config.js");
});

test("a bare redirect is NOT authorship", () => {
  // The rule that mattered: the datalab session issued twelve of these for compiler
  // and test output while the human wrote every line, and counting them as authorship
  // is what made a hand-written project read 13% AI.
  assert.equal(authoringTarget("gcc -o btest btest.c > /dev/null"), null);
  assert.equal(authoringTarget("./btest > results.txt"), null);
  assert.equal(authoringTarget("python3 ref_pi.py 1010 > /tmp/ref1010.txt 2>&1"), null);
  assert.equal(authoringTarget("ls -la && echo hi"), null);
});

test("scratch space is not the project", () => {
  assert.equal(authoringTarget("cat > /tmp/tntt.c << 'EOF'"), null);
  assert.equal(authoringTarget("cat > /dev/null << 'EOF'"), null);
});

test("a target with no extension is not treated as source", () => {
  // Far more likely a binary or a stream target than a file anyone keeps.
  assert.equal(authoringTarget("cat > output << 'EOF'"), null);
});

/* -------------------------------------------------------------------------- */
/* Authorship: presence is not authorship                                      */
/* -------------------------------------------------------------------------- */

test("an advisory session contributes no heartbeats at all", () => {
  // Claude read and ran things but never wrote a file: you were coding, it was
  // answering. Counting the session as AI time marked two hand-written projects
  // as 15% and 24% AI before this rule existed.
  const records = [
    userAt("2026-08-20T10:00:00.000Z"),
    at("2026-08-20T10:00:10.000Z", toolUse("Read", { file_path: "/repo/main.c" })),
    at("2026-08-20T10:05:00.000Z", toolUse("Bash", { command: "gcc -o btest btest.c" })),
    at("2026-08-20T10:10:00.000Z", { message: { content: [{ type: "text", text: "here is why" }] } }),
  ];
  const { heartbeats, stats } = buildHeartbeats(records, { regimeAt });
  assert.equal(stats.authoringSessions, 0);
  assert.equal(stats.advisorySessions, 1);
  assert.equal(heartbeats.length, 0);
});

test("one write makes the whole session count, including the part before it", () => {
  // Authorship is a property of the session, not of the individual event: the
  // reading and planning that preceded the edit is part of producing it.
  const records = [
    userAt("2026-08-20T10:00:00.000Z"),
    at("2026-08-20T10:00:10.000Z", toolUse("Read", { file_path: "/repo/main.c" })),
    at("2026-08-20T10:20:00.000Z", toolUse("Edit", { file_path: "/repo/main.c" })),
  ];
  const { heartbeats, stats } = buildHeartbeats(records, { regimeAt });
  assert.equal(stats.authoringSessions, 1);
  assert.ok(heartbeats.length >= 2, "the pre-write events are heartbeats too");
  assert.equal(heartbeats[0].timestamp.toISOString(), "2026-08-20T10:00:00.000Z");
});

test("advisory and authoring sessions are judged independently", () => {
  const records = [
    userAt("2026-08-20T10:00:00.000Z", "advisory"),
    { ...at("2026-08-20T10:01:00.000Z", toolUse("Read", { file_path: "/repo/a.c" })), sessionId: "advisory" },
    userAt("2026-08-20T12:00:00.000Z", "authoring"),
    { ...at("2026-08-20T12:01:00.000Z", toolUse("Write", { file_path: "/repo/b.c" })), sessionId: "authoring" },
  ];
  const { heartbeats, stats } = buildHeartbeats(records, { regimeAt });
  assert.equal(stats.authoringSessions, 1);
  assert.equal(stats.advisorySessions, 1);
  assert.ok(heartbeats.every((h) => h.sessionId === "authoring"));
});

/* -------------------------------------------------------------------------- */
/* Throttling and the shared regime timeline                                   */
/* -------------------------------------------------------------------------- */

test("Claude Code shares the VS Code regime timeline", () => {
  // The load-bearing assumption behind CONFIG_REGISTRY being a single linear series
  // rather than one series per tracker. This tracker does not choose an interval; it
  // reads the one in force, so the two cannot drift. The companion assertion for the
  // Mathematica tracker lives in duration.test.mjs.
  for (const regime of CONFIG_REGISTRY) {
    const mid = Date.parse(regime.from) + 1000;
    assert.equal(
      regimeAt(mid).intervalSeconds,
      regime.intervalSeconds,
      `v${regime.version} interval must come from the registry`,
    );
    assert.equal(regimeAt(mid).version, regime.version);
  }
});

test("events are throttled to the interval in force, not a fixed one", () => {
  // v2 ran at 300s and v3 at 120s. A dense burst inside each window must thin to the
  // regime's own interval, or the two eras stop being comparable.
  const burst = (startIso, n, stepSeconds, sessionId) => {
    const t0 = Date.parse(startIso);
    const recs = [userAt(new Date(t0).toISOString(), sessionId)];
    for (let i = 1; i <= n; i++) {
      recs.push({
        ...at(new Date(t0 + i * stepSeconds * 1000).toISOString(), toolUse("Edit", { file_path: "/repo/x.c" })),
        sessionId,
      });
    }
    return recs;
  };

  // 20 minutes of activity every 10s, inside v2 (300s) — expect ~1 beat per 300s.
  const v2 = buildHeartbeats(burst("2026-06-01T10:00:00.000Z", 120, 10, "v2"), { regimeAt }).heartbeats;
  // The same burst inside v3 (120s) — expect ~1 beat per 120s, so ~2.5x as many.
  const v3 = buildHeartbeats(burst("2026-08-20T10:00:00.000Z", 120, 10, "v3"), { regimeAt }).heartbeats;

  assert.ok(v2.every((h) => h.configVersion === 2));
  assert.ok(v3.every((h) => h.configVersion === 3));
  assert.equal(v2.length, 5, "1200s of activity at a 300s throttle");
  assert.equal(v3.length, 11, "1200s of activity at a 120s throttle");
});

test("the throttle is global, not per session", () => {
  // Two agent sessions running at once are one person's attention. Per-session timers
  // would double-count them exactly the way regime v1's per-file timers double-counted
  // open editors — the mistake the whole redesign exists to avoid.
  const t0 = Date.parse("2026-08-20T10:00:00.000Z");
  const records = [];
  for (let i = 0; i < 10; i++) {
    for (const sid of ["a", "b"]) {
      records.push({
        ...at(new Date(t0 + i * 30_000).toISOString(), toolUse("Edit", { file_path: `/repo/${sid}.c` })),
        sessionId: sid,
      });
    }
  }
  const { heartbeats } = buildHeartbeats(records, { regimeAt });
  // 270s of wall clock at a 120s global throttle is 3 beats, not 6.
  assert.equal(heartbeats.length, 3);
});

/* -------------------------------------------------------------------------- */
/* Heartbeat shape                                                             */
/* -------------------------------------------------------------------------- */

test("a heartbeat names the most recently touched file, and its language", () => {
  const records = [
    userAt("2026-08-20T10:00:00.000Z"),
    at("2026-08-20T10:00:05.000Z", toolUse("Write", { file_path: "/repo/src/app.ts" })),
    at("2026-08-20T10:03:00.000Z", toolUse("Edit", { file_path: "/repo/README.md" })),
  ];
  const { heartbeats } = buildHeartbeats(records, { regimeAt });
  const last = heartbeats.at(-1);
  assert.equal(last.name, "/repo/README.md");
  assert.equal(last.language, "markdown");
  assert.equal(last.editor, EDITOR);
  assert.equal(last.project, "repo");
  assert.equal(last.gitBranch, "main");
});

test("before the first write there is no file, and no invented language", () => {
  // A working directory is not a file. Guessing a language from a directory name
  // would put entries in the language leaderboard that never existed.
  const records = [
    userAt("2026-08-20T10:00:00.000Z"),
    at("2026-08-20T10:04:00.000Z", toolUse("Edit", { file_path: "/repo/a.py" })),
  ];
  const { heartbeats } = buildHeartbeats(records, { regimeAt });
  assert.equal(heartbeats[0].language, "unknown");
  assert.equal(heartbeats.at(-1).language, "python");
});

test("the project is resolved through the injected resolver, not the cwd basename", () => {
  // A session started in TakaTime/analytics must file under TakaTime — the editor
  // tracker reports the workspace folder, and a mismatch splits one project in two.
  const records = [
    userAt("2026-08-20T10:00:00.000Z"),
    at("2026-08-20T10:00:05.000Z", toolUse("Edit", { file_path: "/repo/analytics/x.mjs" })),
  ];
  const { heartbeats } = buildHeartbeats(records, {
    regimeAt,
    projectOf: (cwd) => (cwd === "/repo" ? "TakaTime" : "wrong"),
  });
  assert.ok(heartbeats.every((h) => h.project === "TakaTime"));
});

/* -------------------------------------------------------------------------- */
/* Write observations, for echo suppression                                    */
/* -------------------------------------------------------------------------- */

test("every authored file yields a write observation with its instant", () => {
  const records = [
    userAt("2026-08-20T10:00:00.000Z"),
    at("2026-08-20T10:00:05.000Z", toolUse("Edit", { file_path: "/repo/a.c" })),
    at("2026-08-20T10:00:09.000Z", toolUse("Bash", { command: "cat > b.py << 'EOF'\nprint(1)\nEOF" })),
  ];
  const { writes } = buildHeartbeats(records, { regimeAt });
  assert.deepEqual(
    writes.map((w) => w.file),
    ["/repo/a.c", "/repo/b.py"],
  );
  assert.equal(writes[0].ms, Date.parse("2026-08-20T10:00:05.000Z"));
});

test("file-history-delta yields a write even though it carries no session", () => {
  // It is evidence that a file changed, not evidence about who was in which session,
  // so it can inform echo suppression but must never make a session look authoring.
  const records = [
    {
      type: "file-history-delta",
      trackingPath: "src/lib/duration.mjs",
      backup: { backupTime: "2026-08-20T10:00:00.000Z", realParentDir: "/repo/src/lib" },
    },
  ];
  const { writes, stats } = buildHeartbeats(records, { regimeAt });
  assert.deepEqual(writes, [{ ms: Date.parse("2026-08-20T10:00:00.000Z"), file: "/repo/src/lib/duration.mjs" }]);
  assert.equal(stats.authoringSessions, 0, "a delta alone does not make a session authoring");
});

/* -------------------------------------------------------------------------- */
/* Robustness                                                                  */
/* -------------------------------------------------------------------------- */

test("malformed and foreign records are skipped rather than fatal", () => {
  const records = [
    null,
    "not an object",
    { type: "assistant" },
    { type: "summary", summary: "x" },
    { type: "user", sessionId: "s1", timestamp: "not a date" },
    userAt("2026-08-20T10:00:00.000Z"),
    at("2026-08-20T10:00:05.000Z", toolUse("Edit", { file_path: "/repo/a.c" })),
  ];
  const { heartbeats } = buildHeartbeats(records, { regimeAt });
  assert.equal(heartbeats.length, 1);
});

test("heartbeats carry no `duration`, ever", () => {
  const records = [
    userAt("2026-08-20T10:00:00.000Z"),
    at("2026-08-20T10:00:05.000Z", toolUse("Edit", { file_path: "/repo/a.c" })),
  ];
  const { heartbeats } = buildHeartbeats(records, { regimeAt });
  for (const hb of heartbeats) {
    assert.ok(!("duration" in hb), "the retired field must never be written again");
  }
});

test("the emitted stream runs through computeDurations unchanged", () => {
  // The point of the tracker: what it writes is a heartbeat like any other, and the
  // canonical algorithm needs no special case for it.
  const t0 = Date.parse("2026-08-20T10:00:00.000Z");
  const records = [userAt(new Date(t0).toISOString())];
  for (let i = 1; i <= 10; i++) {
    records.push(at(new Date(t0 + i * 130_000).toISOString(), toolUse("Edit", { file_path: "/repo/a.c" })));
  }
  const { heartbeats } = buildHeartbeats(records, { regimeAt });
  const d = computeDurations(heartbeats, { groupBy: ["editor", "language"] });
  assert.equal(d.sessionCount, 1);
  assert.equal(d.unstampedHeartbeats, 0, "every heartbeat is stamped at write time");
  assert.equal(d.inexactIntervalHeartbeats, 0);
  assert.equal(d.groups.editor[EDITOR], d.totalMs, "additivity holds over the editor dimension");
});

/* -------------------------------------------------------------------------- */
/* Language mapping                                                            */
/* -------------------------------------------------------------------------- */

test("languages use VS Code languageIds so the dimension stays comparable", () => {
  // A parallel vocabulary would silently split every per-language share in two.
  assert.equal(languageOf("/x/a.c"), "c");
  assert.equal(languageOf("/x/a.mjs"), "javascript");
  assert.equal(languageOf("/x/a.tsx"), "typescriptreact");
  assert.equal(languageOf("/x/a.ipynb"), "jupyter-notebook");
  assert.equal(languageOf("/x/Dockerfile"), "dockerfile");
  assert.equal(languageOf("/x/.gitignore"), "ignore");
  assert.equal(languageOf("/x/a.wl"), "wolframlanguage");
  assert.equal(languageOf(null), "unknown");
});

test("parseRecords does not mutate its input", () => {
  const records = [userAt("2026-08-20T10:00:00.000Z")];
  const before = JSON.stringify(records);
  parseRecords(records);
  assert.equal(JSON.stringify(records), before);
});
