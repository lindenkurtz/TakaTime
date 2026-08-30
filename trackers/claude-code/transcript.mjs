/**
 * TakaTime — Claude Code transcript → heartbeats.
 *
 * PURE. No filesystem, no database, no process. Takes already-parsed JSONL records
 * and returns the heartbeats and file-write observations they imply, so every
 * detection rule below can be tested against a fixture with no Claude Code, no Mongo
 * and no machine state. The impure half (walking ~/.claude/projects, resolving git
 * roots, writing to Mongo) lives in import-claude.mjs.
 *
 * ---------------------------------------------------------------------------
 * WHY A TRANSCRIPT IMPORTER RATHER THAN HOOKS
 * ---------------------------------------------------------------------------
 * Claude Code hooks would give live events but no history, and each hook invocation
 * is a stateless shell process — so the 120s throttle would need its own state file,
 * and a missed or misconfigured hook is silent data loss. The transcripts under
 * ~/.claude/projects are a complete record that is already on disk, so one idempotent
 * importer covers backfill AND live capture: a `Stop` hook simply re-runs it.
 *
 * The cost is that the JSONL layout is Claude Code's internal format and can change.
 * That is why all of the parsing is here, in one place, behind a fixture test.
 *
 * ---------------------------------------------------------------------------
 * THE TWO RULES THAT MAKE THE NUMBERS RIGHT
 * ---------------------------------------------------------------------------
 * Both were derived by checking measured AI share per project against the author's
 * own recollection of which projects were AI-written. See METHODOLOGY.md.
 *
 * 1. AUTHORSHIP, NOT PRESENCE. A session in which Claude never modified a file is
 *    ADVISORY — you asked questions while doing the work yourself — and contributes
 *    no AI time at all. Counting "a session was open" instead marked two projects the
 *    author knew to be hand-written as 15% and 24% AI.
 *
 * 2. SHELL WRITES COUNT, SHELL REDIRECTS DO NOT. Claude authors code through
 *    `cat > file << 'EOF'` heredocs as readily as through the Edit tool; one project
 *    was 93 Bash calls and zero Edit calls. But a bare `> file` redirect is usually
 *    compiler or test output, so it is deliberately NOT treated as authorship.
 */

/**
 * Bump when a change here would move numbers — the same contract
 * ALGORITHM_VERSION has in duration.mjs.
 */
export const TRANSCRIPT_VERSION = "1.0.0";

/** Marks heartbeats this tracker writes. Joins the `editor` dimension. */
export const EDITOR = "ClaudeCode";

/**
 * Extension → VS Code languageId.
 *
 * Deliberately mirrors the ids the VS Code extension reports (`document.languageId`)
 * rather than inventing a parallel vocabulary: the `language` dimension has to be
 * comparable across trackers or per-language shares silently split in two.
 */
export const LANGUAGE_BY_EXTENSION = {
  as: "astro", astro: "astro",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp",
  css: "css", scss: "css", sass: "css",
  csv: "csv",
  go: "go",
  html: "html", htm: "html",
  java: "java",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "javascriptreact",
  json: "json", jsonc: "jsonc", jsonl: "jsonl",
  ipynb: "jupyter-notebook",
  tex: "latex",
  log: "log",
  md: "markdown", markdown: "markdown", mdx: "mdx",
  py: "python", pyi: "python",
  rb: "ruby",
  rs: "rust",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript",
  sql: "sql",
  swift: "swift",
  ts: "typescript",
  tsx: "typescriptreact",
  toml: "toml",
  wl: "wolframlanguage", wls: "wolframlanguage", nb: "wolframlanguage",
  xml: "xml", csproj: "xml",
  yaml: "yaml", yml: "yaml",
};

/** Filenames with no extension that still have a well-known languageId. */
const LANGUAGE_BY_BASENAME = {
  Dockerfile: "dockerfile",
  Makefile: "makefile",
  ".env": "dotenv",
  ".gitignore": "ignore",
};

/** VS Code languageId for a path, matching what the editor tracker would report. */
export function languageOf(filePath) {
  if (!filePath) return "unknown";
  const base = filePath.split(/[/\\]/).pop() ?? "";
  if (LANGUAGE_BY_BASENAME[base]) return LANGUAGE_BY_BASENAME[base];
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "plaintext";
  return LANGUAGE_BY_EXTENSION[base.slice(dot + 1).toLowerCase()] ?? "plaintext";
}

/* -------------------------------------------------------------------------- */
/* Authorship detection                                                        */
/* -------------------------------------------------------------------------- */

/** Tool calls that modify a file directly and report the path they wrote. */
const WRITING_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

/**
 * A shell command that AUTHORS a file, and the path it authors.
 *
 * Matches the heredoc and in-place-edit forms Claude uses to write source when it is
 * not using the Edit tool:
 *
 *     cat > chudnovsky_hp.c << 'EOF'      cat >> file.c << EOF
 *     tee src/main.rs <<'EOF'             sed -i '' 's/x/y/' Plugin/Config.js
 *
 * A BARE redirect (`gcc … > out`, `./btest > results.txt`) is deliberately NOT a
 * match. One project in the calibration set issued twelve of those for compiler and
 * test output while the human wrote every line of code; treating them as authorship
 * is what made it read 13% AI.
 *
 * Returns the target path (relative to cwd, or absolute) or null.
 */
export function authoringTarget(command) {
  if (typeof command !== "string" || command === "") return null;

  const patterns = [
    // cat|tee > path <<HEREDOC   (the redirect and the heredoc must BOTH be present)
    /(?:^|[\s;&|(])(?:cat|tee)\s+(?:-a\s+)?(?:>>?\s*)?(?:"([^"]+)"|'([^']+)'|([^\s"'<>|;&]+))\s*<<-?\s*['"]?\w+/,
    // sed -i [''] <script> path
    /(?:^|[\s;&|(])sed\s+-i(?:\s+(?:''|""|\S+))?\s+(?:-e\s+)?(?:"[^"]*"|'[^']*'|\S+)\s+(?:"([^"]+)"|'([^']+)'|([^\s"'<>|;&]+))/,
  ];

  for (const re of patterns) {
    const m = re.exec(command);
    if (!m) continue;
    const target = m[1] ?? m[2] ?? m[3];
    if (!target) continue;
    // Scratch space is not the project. Claude writes probes and reference output to
    // /tmp constantly; none of it is code the repository keeps.
    if (/^(\/tmp|\/dev|\/var\/folders)\//.test(target)) continue;
    // A path with no extension is far more likely to be a binary or a stream target
    // than a source file, and guessing wrong here inflates AI share.
    if (!/\.[A-Za-z0-9]{1,6}$/.test(target)) continue;
    return target;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

/** Absolute-ish join that works for POSIX paths without importing node:path. */
function joinPath(dir, rel) {
  if (!dir) return rel;
  if (rel.startsWith("/")) return rel;
  return `${dir.replace(/\/+$/, "")}/${rel.replace(/^\.\//, "")}`;
}

function basename(p) {
  return (p ?? "").split(/[/\\]/).filter(Boolean).pop() ?? "";
}

/**
 * Pull the events, file writes and per-session facts out of raw transcript records.
 *
 * @param {Array<object>} records  Parsed JSONL objects from any number of transcript
 *   files. Order does not matter; they are sorted here.
 * @returns {{events: Array, writes: Array, sessions: Map}}
 */
export function parseRecords(records) {
  const events = [];
  const writes = [];
  const sessions = new Map();

  const session = (id) => {
    if (!sessions.has(id)) {
      sessions.set(id, { id, cwd: null, authored: false, events: 0, writeCount: 0, firstMs: null, lastMs: null });
    }
    return sessions.get(id);
  };

  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    const sid = rec.sessionId;

    // file-history-delta is Claude Code's own record that it changed a tracked file.
    // It carries no sessionId, so it can only ever be a WRITE observation (used for
    // echo suppression), never evidence that a particular session authored anything.
    if (rec.type === "file-history-delta" && rec.backup?.backupTime) {
      const dir = rec.backup.realParentDir;
      const name = basename(rec.trackingPath);
      if (dir && name) writes.push({ ms: Date.parse(rec.backup.backupTime), file: joinPath(dir, name) });
      continue;
    }

    if (!sid || !rec.timestamp) continue;
    if (rec.type !== "user" && rec.type !== "assistant") continue;

    const ms = Date.parse(rec.timestamp);
    if (Number.isNaN(ms)) continue;

    const s = session(sid);
    if (!s.cwd && rec.cwd) s.cwd = rec.cwd;
    s.events++;
    if (s.firstMs === null || ms < s.firstMs) s.firstMs = ms;
    if (s.lastMs === null || ms > s.lastMs) s.lastMs = ms;

    const event = {
      ms,
      sessionId: sid,
      cwd: rec.cwd ?? s.cwd ?? null,
      gitBranch: rec.gitBranch ?? "",
      role: rec.type,
      /** The file Claude touched at this instant, if any. Drives `name`/`language`. */
      file: null,
    };
    events.push(event);

    if (rec.type !== "assistant") continue;
    for (const block of rec.message?.content ?? []) {
      if (block?.type !== "tool_use") continue;

      if (WRITING_TOOLS.has(block.name) && block.input?.file_path) {
        const file = block.input.file_path;
        event.file = file;
        s.authored = true;
        s.writeCount++;
        writes.push({ ms, file });
        continue;
      }

      if (block.name === "Bash") {
        const target = authoringTarget(block.input?.command);
        if (!target) continue;
        const file = joinPath(event.cwd, target);
        event.file = file;
        s.authored = true;
        s.writeCount++;
        writes.push({ ms, file });
      }
    }
  }

  events.sort((a, b) => a.ms - b.ms || (a.role === "user" ? -1 : 1));
  writes.sort((a, b) => a.ms - b.ms);
  return { events, writes, sessions };
}

/* -------------------------------------------------------------------------- */
/* Heartbeats                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Turn transcript events into throttled heartbeats.
 *
 * @param {Array<object>} records  Raw parsed JSONL records.
 * @param {object} options
 * @param {(ms: number) => {intervalSeconds: number, version: number}} options.regimeAt
 *   Resolves the config regime in force at an instant. Injected rather than imported
 *   so this module stays pure and the caller can prove it uses CONFIG_REGISTRY.
 * @param {(cwd: string) => string} [options.projectOf]  Resolve a working directory
 *   to a project name. Defaults to its basename; the importer passes a git-root
 *   resolver, because a session started in a subdirectory would otherwise invent a
 *   project (`analytics` instead of `TakaTime`).
 * @param {string} [options.os]  Value for the `os` dimension.
 * @param {string} [options.machine]  Optional host tag, recorded on writes so echo
 *   suppression can tell same-machine observations apart.
 * @returns {{heartbeats: Array, writes: Array, stats: object}}
 */
export function buildHeartbeats(records, options) {
  const { regimeAt } = options;
  const projectOf = options.projectOf ?? ((cwd) => basename(cwd) || "unknown");
  const osName = options.os ?? "unknown";

  const { events, writes, sessions } = parseRecords(records);

  // RULE 1: advisory sessions contribute nothing. Claude was consulted, not writing.
  const authoring = new Set([...sessions.values()].filter((s) => s.authored).map((s) => s.id));

  const heartbeats = [];
  const lastFileBySession = new Map();
  // The throttle is GLOBAL, exactly as it is in the VS Code tracker: one timer, not
  // one per session. Two Claude sessions running at once are one person's attention,
  // and per-session timers would double-count them the way regime v1's per-file
  // timers double-counted open editors.
  let lastBeatMs = -Infinity;

  for (const e of events) {
    if (!authoring.has(e.sessionId)) continue;

    // Remember the most recent file even for events the throttle drops, so a
    // heartbeat names the file that was actually being worked on.
    if (e.file) lastFileBySession.set(e.sessionId, e.file);

    const regime = regimeAt(e.ms);
    if (e.ms - lastBeatMs < regime.intervalSeconds * 1000) continue;
    lastBeatMs = e.ms;

    // A heartbeat names the file most recently touched, mirroring how a global
    // throttle attributes in the editor. Before Claude's first write in a session
    // there is no such file, and the working directory is not one — guessing a
    // language from a directory name would put fictional entries in the leaderboard.
    const known = lastFileBySession.get(e.sessionId) ?? null;
    const file = known ?? e.cwd ?? "unknown";
    heartbeats.push({
      name: file,
      project: projectOf(e.cwd),
      timestamp: new Date(e.ms),
      date: new Date(e.ms).toISOString().slice(0, 10),
      language: known ? languageOf(known) : "unknown",
      os: osName,
      gitBranch: e.gitBranch,
      editor: EDITOR,
      configVersion: regime.version,
      sessionId: e.sessionId,
    });
  }

  return {
    heartbeats,
    writes,
    stats: {
      transcriptVersion: TRANSCRIPT_VERSION,
      records: records.length,
      events: events.length,
      sessions: sessions.size,
      authoringSessions: authoring.size,
      advisorySessions: sessions.size - authoring.size,
      writes: writes.length,
      heartbeats: heartbeats.length,
    },
  };
}
