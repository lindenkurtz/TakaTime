// Plugin/format.js
//
// DISPLAY ONLY. These mirror the helpers at the bottom of analytics/summary.mjs.
//
// They are duplicated rather than imported because summary.mjs is ESM and the
// extension is CommonJS, and because the webview is a third JS context that cannot
// require anything at all. That is an acceptable duplication in a way the duration
// algorithm never would be: nothing here computes a number, it only renders one that
// arrived already computed. If a formatter drifts, a label looks slightly different.
// If the algorithm drifted, the stats would be wrong.

/** `3h12m` — compact form for a status bar, where every character costs space. */
function formatCompact(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h === 0 && m === 0) return `${total}s`;
  if (h === 0) return `${m}m`;
  return `${h}h${String(m).padStart(2, "0")}m`;
}

/** `4m ago` / `just now` — freshness, so a stalled tracker is visible at a glance. */
function formatAgo(ms) {
  if (ms === null || ms === undefined) return "never";
  const s = Math.round(ms / 1000);
  if (s < 45) return "just now";
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Long file paths are noise in a narrow column; the tail is the identifying part. */
function shorten(key, max = 30) {
  if (!key) return "unknown";
  if (key.length <= max) return key;
  return "…" + key.slice(-(max - 1));
}

const FOOTER =
  "Editor activity, not work. Reading, thinking past 15m, and everything outside VS Code count as zero.";

module.exports = { formatCompact, formatAgo, shorten, FOOTER };
