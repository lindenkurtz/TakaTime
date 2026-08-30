/*
 * TakaTime stats panel — rendering.
 *
 * Receives a summary object over postMessage and draws it. Never fetches anything:
 * the extension host owns the network, which is what lets the CSP here stay at
 * `default-src 'none'`.
 *
 * Charts are hand-built SVG. No library, partly because a strict CSP forbids loading
 * one, and mostly because the whole panel needs about six mark types.
 */

/* eslint-env browser */
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  /** Categorical slots, in the fixed order the palette validates in. Never cycled. */
  const SERIES = ["--series-1", "--series-2", "--series-3", "--series-4", "--series-5"];
  const OTHER = "--series-other";

  let state = { summary: null, error: null, tables: false };

  /* ------------------------------------------------------------------ util -- */

  function h(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      // `style` MUST go through the CSSOM, never setAttribute.
      //
      // The panel's CSP has no 'unsafe-inline' in style-src, which blocks the style
      // ATTRIBUTE outright — silently, so every bar came out unfilled and unwidthed
      // while the rest of the page looked perfect. CSSOM assignment is not covered by
      // that restriction. Pass an object: { width: "40%", background: "#2a78d6" }.
      else if (k === "style") Object.assign(node.style, v);
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children || [])) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }

  function s(tag, attrs, children) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      // `text` is content, not an attribute — SVG has no such attribute, so setting it
      // fails silently and every axis label comes out empty.
      if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children || [])) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }

  /* These mirror analytics/summary.mjs. Display only — see Plugin/format.js. */
  function compact(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const hh = Math.floor(total / 3600);
    const mm = Math.floor((total % 3600) / 60);
    if (hh === 0 && mm === 0) return total + "s";
    if (hh === 0) return mm + "m";
    return hh + "h" + String(mm).padStart(2, "0") + "m";
  }

  function ago(ms) {
    if (ms === null || ms === undefined) return "never";
    const sec = Math.round(ms / 1000);
    if (sec < 45) return "just now";
    if (sec < 5400) return Math.round(sec / 60) + "m ago";
    if (sec < 172800) return Math.round(sec / 3600) + "h ago";
    return Math.round(sec / 86400) + "d ago";
  }

  function hours(ms) {
    return (ms / 3600000).toFixed(1);
  }

  function shorten(key, max) {
    if (!key) return "unknown";
    return key.length <= max ? key : "…" + key.slice(-(max - 1));
  }

  function clockTime(msEpoch, timeZone) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(msEpoch));
  }

  /** A day key rendered without a timezone round-trip — it is already a local date. */
  function dayLabel(day, opts) {
    return new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: "UTC" }, opts)).format(
      new Date(day + "T12:00:00Z"),
    );
  }

  const cssVar = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();

  /* --------------------------------------------------------------- tooltip -- */

  const tip = h("div", { id: "tip", hidden: "" });
  document.body.appendChild(tip);

  function showTip(evt, title, rows) {
    tip.textContent = "";
    tip.appendChild(h("div", { class: "t-title", text: title }));
    for (const r of rows) {
      tip.appendChild(
        h("div", { class: "t-row" }, [
          r.color ? h("span", { class: "swatch", style: { background: r.color } }) : null,
          h("span", { text: r.label }),
          h("span", { class: "val", text: r.value }),
        ]),
      );
    }
    tip.hidden = false;
    const pad = 12;
    const box = tip.getBoundingClientRect();
    let x = evt.clientX + pad;
    let y = evt.clientY + pad;
    if (x + box.width > window.innerWidth - 8) x = evt.clientX - box.width - pad;
    if (y + box.height > window.innerHeight - 8) y = evt.clientY - box.height - pad;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, y) + "px";
  }

  const hideTip = () => {
    tip.hidden = true;
  };

  /* ------------------------------------------------------------ components -- */

  function tile(label, value, note) {
    return h("div", { class: "tile" }, [
      h("div", { class: "label", text: label }),
      h("div", { class: "value", text: value }),
      note ? h("div", { class: "note" }, note) : null,
    ]);
  }

  function card(title, caption, body, opts) {
    const o = opts || {};
    return h("div", { class: "card" + (o.wide ? " wide" : "") }, [
      h("h2", { text: title }),
      h("p", { class: "caption", text: caption }),
      o.legend || null,
      body,
      o.table ? h("div", { class: "table-wrap", hidden: state.tables ? null : "" }, o.table) : null,
    ]);
  }

  /** Ranked horizontal bars. Values are direct-labelled, so colour never carries a number. */
  function barRows(rows, colorFor, emptyText) {
    if (!rows || rows.length === 0) {
      return h("div", { class: "caption", text: emptyText || "Nothing yet." });
    }
    const max = Math.max.apply(null, rows.map((r) => r.ms));
    return h(
      "div",
      { class: "rows" },
      rows.map((r) =>
        h("div", { class: "row" }, [
          h("div", { class: "name", title: r.key, text: shorten(r.key, 46) }),
          h("div", { class: "val", text: compact(r.ms) + "  " + (r.share * 100).toFixed(0) + "%" }),
          h("div", { class: "track" }, [
            h("div", {
              class: "fill",
              style: { width: Math.max(1, (r.ms / max) * 100) + "%", background: colorFor(r.key) },
            }),
          ]),
        ]),
      ),
    );
  }

  function dataTable(headers, rows) {
    return h("table", {}, [
      h("thead", {}, [
        h(
          "tr",
          {},
          headers.map((x, i) => h("th", { class: i === 0 ? "" : "num", text: x })),
        ),
      ]),
      h(
        "tbody",
        {},
        rows.map((cells) =>
          h(
            "tr",
            {},
            cells.map((c, i) => h("td", { class: i === 0 ? "name" : "num", text: String(c) })),
          ),
        ),
      ),
    ]);
  }

  /* ------------------------------------------------------- human / AI split -- */

  /**
   * Colours for the split. Human and AI take the two most separable slots in the
   * palette; the overlap takes a third rather than a blend, because a blend reads as
   * "somewhere between" when what it means is "both at once".
   */
  function splitColors() {
    return {
      human: cssVar("--series-1"),
      both: cssVar("--series-4"),
      ai: cssVar("--series-2"),
    };
  }

  /** `mode` keys are wire values; these are what a person should read. */
  const MODE_LABEL = {
    "human-only": "Human only",
    concurrent: "Both at once",
    "ai-only": "AI only",
  };

  function modeColor(key) {
    const c = splitColors();
    return key === "ai-only" ? c.ai : key === "concurrent" ? c.both : c.human;
  }

  /**
   * One stacked bar over the union, plus a legend.
   *
   * DISJOINT bands, not two overlapping totals: `humanOnly + both + aiOnly` is exactly
   * `unionMs`, so the segments can be laid end to end and still add up. The
   * overlapping per-stream figures go in the caption underneath, next to the warning
   * not to add them — a chart cannot carry that caveat, so it must not imply it.
   */
  function splitBar(split) {
    const c = splitColors();
    const union = split.unionMs || 1;
    const bands = [
      { key: "Human only", ms: split.humanOnlyMs, color: c.human },
      { key: "Both at once", ms: split.overlapMs, color: c.both },
      { key: "AI only", ms: split.aiOnlyMs, color: c.ai },
    ];

    const bar = h(
      "div",
      { class: "split-bar" },
      bands
        .filter((b) => b.ms > 0)
        .map((b) =>
          h("div", {
            class: "split-seg",
            style: { width: (b.ms / union) * 100 + "%", background: b.color },
            title: b.key + " · " + compact(b.ms),
            onmousemove: (e) =>
              showTip(e, b.key, [
                { label: "Time", value: compact(b.ms), color: b.color },
                { label: "Share", value: ((b.ms / union) * 100).toFixed(1) + "%" },
              ]),
            onmouseleave: hideTip,
          }),
        ),
    );

    const legend = h(
      "ul",
      { class: "legend" },
      bands.map((b) =>
        h("li", {}, [
          h("span", { class: "swatch", style: { background: b.color } }),
          h("span", { text: b.key + " " + compact(b.ms) }),
        ]),
      ),
    );

    return { bar: bar, legend: legend };
  }

  /**
   * Per-project human vs AI.
   *
   * The bar's LENGTH is the project's total time, scaled against the largest row, and
   * the split WITHIN it is the human/AI proportion. Both facts, one mark — and the
   * same length encoding every other card uses, so a short bar means less time here
   * too. Normalising every row to full width would have made a 17-minute project look
   * the size of a three-hour one.
   */
  function splitRows(rows) {
    if (!rows || rows.length === 0) {
      return h("div", { class: "caption", text: "Nothing yet." });
    }
    const max = Math.max.apply(null, rows.map((r) => r.totalMs)) || 1;
    return h(
      "div",
      { class: "rows" },
      rows.map((r) => {
        const total = r.totalMs || 1;
        // The THREE DISJOINT bands, not humanMs against aiMs. Those two overlap, so
        // laying them end to end sums past 100% — the bar overflowed its track and
        // was silently clipped, drawing a project with concurrent time as pure AI.
        const bands = [
          { key: "human-only", ms: r.humanOnlyMs },
          { key: "concurrent", ms: r.overlapMs },
          { key: "ai-only", ms: r.aiOnlyMs },
        ];
        return h("div", { class: "row" }, [
          h("div", { class: "name", title: r.key, text: shorten(r.key, 46) }),
          h("div", {
            class: "val",
            text: compact(r.totalMs) + "  " + (r.aiShare * 100).toFixed(0) + "% AI",
          }),
          h("div", { class: "track" }, [
            h(
              "div",
              {
                class: "split-bar inline",
                style: { width: Math.max(1, (r.totalMs / max) * 100) + "%" },
              },
              bands
                .filter((b) => b.ms > 0)
                .map((b) =>
                  h("div", {
                    class: "split-seg",
                    style: { width: (b.ms / total) * 100 + "%", background: modeColor(b.key) },
                    title: MODE_LABEL[b.key] + " " + compact(b.ms),
                  }),
                ),
            ),
          ]),
        ]);
      }),
    );
  }

  /* ------------------------------------------------------------ bar geometry -- */

  /**
   * A bar with rounded corners at the DATA end only; the baseline end stays square so
   * the mark reads as anchored rather than floating.
   */
  function barPath(x, y, w, hgt, r, roundTop) {
    const rr = Math.min(r, w / 2, hgt);
    if (!roundTop || rr <= 0.5) return "M" + x + " " + y + "h" + w + "v" + hgt + "h" + -w + "Z";
    return (
      "M" + x + " " + (y + hgt) +
      "V" + (y + rr) +
      "a" + rr + " " + rr + " 0 0 1 " + rr + " " + -rr +
      "h" + (w - 2 * rr) +
      "a" + rr + " " + rr + " 0 0 1 " + rr + " " + rr +
      "V" + (y + hgt) +
      "Z"
    );
  }

  const HOUR = 3600000;

  /**
   * Round the axis out to a step a reader can do arithmetic with.
   *
   * Dividing the data maximum into equal parts gives ticks like "5.9h" and "3.9h",
   * which are true and useless — the point of a gridline is to be a landmark.
   */
  function niceScale(maxMs, target) {
    const ladder = [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 24].map((x) => x * HOUR);
    for (const step of ladder) {
      if (maxMs / step <= target) return { step: step, max: Math.ceil(maxMs / step) * step || step };
    }
    const step = Math.ceil(maxMs / target / (24 * HOUR)) * 24 * HOUR;
    return { step: step, max: Math.ceil(maxMs / step) * step };
  }

  /** Solid hairline gridlines plus left-hand tick labels. Never dashed. */
  function yAxis(g, plot, scale) {
    for (let v = 0; v <= scale.max + 1; v += scale.step) {
      const y = plot.y + plot.h - (v / scale.max) * plot.h;
      g.appendChild(
        s("line", {
          class: v === 0 ? "axisline" : "gridline",
          x1: plot.x,
          x2: plot.x + plot.w,
          y1: y,
          y2: y,
        }),
      );
      g.appendChild(
        s("text", {
          class: "tick num",
          x: plot.x - 8,
          y: y + 3,
          "text-anchor": "end",
          text: v === 0 ? "0" : scale.step % HOUR === 0 ? v / HOUR + "h" : Math.round(v / 60000) + "m",
        }),
      );
    }
  }

  /* ------------------------------------------------------------- the charts -- */

  /** Daily totals, stacked by project. The flagship time view. */
  /**
   * Stacked daily columns.
   *
   * Takes a trend object rather than reaching into `summary`, so the by-project and
   * by-human/AI views are the SAME chart with a different stacking — one set of
   * geometry, axis and tooltip behaviour to keep right, and the two read alike
   * because they are alike.
   */
  function trendChart(trend, opts, width) {
    const o = opts || {};
    const colorFor = o.colorFor || ((k, i) => cssVar(k === "Other" ? OTHER : SERIES[i] || OTHER));
    const labelFor = o.labelFor || ((k) => k);
    const keys = trend.keys;
    const colors = {};
    keys.forEach((k, i) => {
      colors[k] = colorFor(k, i);
    });

    const pad = { l: 42, r: 8, t: 10, b: 26 };
    const height = 220;
    const plot = {
      x: pad.l,
      y: pad.t,
      w: Math.max(120, width - pad.l - pad.r),
      h: height - pad.t - pad.b,
    };
    const cols = trend.series;
    const step = plot.w / cols.length;
    const barW = Math.max(3, Math.min(22, step - 3)); // the 2px+ gap between adjacent bars
    const scale = niceScale(Math.max.apply(null, cols.map((c) => c.total).concat([1])), 3);
    const maxMs = scale.max;

    const svg = s("svg", {
      width: width,
      height: height,
      viewBox: "0 0 " + width + " " + height,
      role: "img",
      "aria-label":
        "Daily coding time over the last " + trend.days + " days, " + (o.stackedBy || "stacked"),
    });
    yAxis(svg, plot, scale);

    cols.forEach((col, i) => {
      const cx = plot.x + step * i + (step - barW) / 2;
      const g = s("g", { class: "col" });

      // Segments are drawn from the baseline up, so the topmost non-zero one gets the
      // rounded data end.
      const present = keys.filter((k) => col.values[k] > 0);
      let cursor = plot.y + plot.h;
      present.forEach((k, idx) => {
        const raw = (col.values[k] / maxMs) * plot.h;
        const isTop = idx === present.length - 1;
        // A 2px surface gap separates stacked segments — never a stroke around them.
        const gap = idx === present.length - 1 ? 0 : 2;
        const hgt = Math.max(1, raw - gap);
        cursor -= raw;
        g.appendChild(
          s("path", {
            class: "band",
            d: barPath(cx, cursor, barW, hgt, 4, isTop),
            fill: colors[k],
          }),
        );
      });

      // One hit target per column, full height and full step width, so the pointer
      // never has to find a 3px bar.
      const hit = s("rect", {
        class: "hit",
        x: plot.x + step * i,
        y: plot.y,
        width: step,
        height: plot.h,
      });
      hit.addEventListener("mousemove", (e) =>
        showTip(
          e,
          dayLabel(col.day, { weekday: "short", month: "short", day: "numeric" }),
          present
            .slice()
            .reverse()
            .map((k) => ({ label: shorten(labelFor(k), 22), value: compact(col.values[k]), color: colors[k] }))
            .concat([{ label: "Total", value: compact(col.total) }]),
        ),
      );
      hit.addEventListener("mouseleave", hideTip);
      g.appendChild(hit);
      svg.appendChild(g);
    });

    // Label roughly every fifth column; a label per day collides at this width.
    const every = Math.max(1, Math.round(cols.length / 6));
    cols.forEach((col, i) => {
      if (i % every !== 0 && i !== cols.length - 1) return;
      svg.appendChild(
        s("text", {
          class: "tick",
          x: plot.x + step * i + step / 2,
          y: plot.y + plot.h + 15,
          "text-anchor": "middle",
          text: dayLabel(col.day, { month: "numeric", day: "numeric" }),
        }),
      );
    });

    const legend = h(
      "ul",
      { class: "legend" },
      keys.map((k) =>
        h("li", {}, [
          h("span", { class: "swatch", style: { background: colors[k] } }),
          h("span", { text: shorten(labelFor(k), 24), title: labelFor(k) }),
        ]),
      ),
    );

    const table = dataTable(
      ["Day"].concat(keys.map((k) => shorten(labelFor(k), 16))).concat(["Total"]),
      cols.map((c) => [c.day].concat(keys.map((k) => compact(c.values[k]))).concat([compact(c.total)])),
    );

    return { svg: svg, legend: legend, table: table, colors: colors };
  }

  /** Calendar heatmap. Sequential single hue; bins are quantiles of active days. */
  function heatmap(summary) {
    const days = summary.heatmap;
    const active = days.filter((d) => d.ms > 0).map((d) => d.ms).sort((a, b) => a - b);
    const q = (p) => (active.length ? active[Math.min(active.length - 1, Math.floor(active.length * p))] : 0);
    // Five bins plus zero: past ~7 classes adjacent bins stop being distinguishable.
    const cuts = [q(0.25), q(0.5), q(0.75), q(0.9)];
    const bins = ["--seq-1", "--seq-2", "--seq-3", "--seq-4", "--seq-5"].map(cssVar);
    const zero = cssVar("--seq-0");

    function colorOf(ms) {
      if (ms <= 0) return zero;
      for (let i = 0; i < cuts.length; i++) if (ms <= cuts[i]) return bins[i];
      return bins[4];
    }

    const cell = 11;
    const gap = 3;
    // Wide enough for "Wed" to sit right-anchored without running off the viewBox.
    const padL = 34;
    const padT = 16;
    // Columns are weeks; a column starts on Sunday, so the first one is short.
    const firstDow = new Date(days[0].day + "T12:00:00Z").getUTCDay();
    const weeks = Math.ceil((days.length + firstDow) / 7);
    const width = padL + weeks * (cell + gap);
    const height = padT + 7 * (cell + gap) + 4;

    const svg = s("svg", {
      width: width,
      height: height,
      viewBox: "0 0 " + width + " " + height,
      role: "img",
      "aria-label": "Coding activity per day over the last " + days.length + " days",
    });

    ["Mon", "Wed", "Fri"].forEach((label, i) => {
      const row = 1 + i * 2;
      svg.appendChild(
        s("text", {
          class: "tick",
          x: padL - 6,
          y: padT + row * (cell + gap) + cell - 1,
          "text-anchor": "end",
          text: label,
        }),
      );
    });

    let lastMonth = "";
    days.forEach((d, i) => {
      const idx = i + firstDow;
      const col = Math.floor(idx / 7);
      const row = idx % 7;
      const x = padL + col * (cell + gap);
      const y = padT + row * (cell + gap);

      const month = d.day.slice(0, 7);
      if (month !== lastMonth && row <= 1) {
        lastMonth = month;
        svg.appendChild(
          s("text", {
            class: "tick",
            x: x,
            y: padT - 5,
            text: dayLabel(d.day, { month: "short" }),
          }),
        );
      }

      const rect = s("rect", {
        x: x,
        y: y,
        width: cell,
        height: cell,
        rx: 2.5,
        fill: colorOf(d.ms),
      });
      rect.addEventListener("mousemove", (e) =>
        showTip(e, dayLabel(d.day, { weekday: "long", month: "long", day: "numeric" }), [
          { label: d.ms ? "Coded" : "No activity", value: d.ms ? compact(d.ms) : "—" },
        ]),
      );
      rect.addEventListener("mouseleave", hideTip);
      svg.appendChild(rect);
    });

    const scale = h("ul", { class: "legend" }, [
      h("li", { text: "Less" }),
      h("li", {}, [zero].concat(bins).map((c) => h("span", { class: "swatch", style: { background: c } }))),
      h("li", { text: "More" }),
    ]);

    const table = dataTable(
      ["Day", "Time"],
      days.filter((d) => d.ms > 0).reverse().map((d) => [d.day, compact(d.ms)]),
    );

    return { svg: svg, scale: scale, table: table };
  }

  /** Time-of-day distribution. One series, therefore one colour and no legend. */
  function hourChart(summary, width) {
    const data = summary.hourly;
    const pad = { l: 42, r: 8, t: 10, b: 24 };
    const height = 170;
    const plot = { x: pad.l, y: pad.t, w: Math.max(120, width - pad.l - pad.r), h: height - pad.t - pad.b };
    const step = plot.w / 24;
    const barW = Math.max(4, step - 3);
    const scale = niceScale(Math.max.apply(null, data.map((d) => d.ms).concat([1])), 2);
    const maxMs = scale.max;
    const fill = cssVar("--series-1");

    const svg = s("svg", {
      width: width,
      height: height,
      viewBox: "0 0 " + width + " " + height,
      role: "img",
      "aria-label": "Coding time by hour of day, all history",
    });
    yAxis(svg, plot, scale);

    data.forEach((d, i) => {
      const x = plot.x + step * i + (step - barW) / 2;
      const hgt = (d.ms / maxMs) * plot.h;
      if (hgt > 0.5) {
        svg.appendChild(
          s("path", { d: barPath(x, plot.y + plot.h - hgt, barW, hgt, 4, true), fill: fill }),
        );
      }
      const hit = s("rect", { class: "hit", x: plot.x + step * i, y: plot.y, width: step, height: plot.h });
      const label = String(d.hour).padStart(2, "0") + ":00–" + String(d.hour).padStart(2, "0") + ":59";
      hit.addEventListener("mousemove", (e) =>
        showTip(e, label, [{ label: "Coded", value: d.ms ? compact(d.ms) : "—" }]),
      );
      hit.addEventListener("mouseleave", hideTip);
      svg.appendChild(hit);
    });

    [0, 6, 12, 18, 23].forEach((hh) => {
      svg.appendChild(
        s("text", {
          class: "tick num",
          x: plot.x + step * hh + step / 2,
          y: plot.y + plot.h + 15,
          "text-anchor": "middle",
          text: String(hh).padStart(2, "0"),
        }),
      );
    });

    return {
      svg: svg,
      table: dataTable(
        ["Hour", "Time"],
        data.map((d) => [String(d.hour).padStart(2, "0") + ":00", compact(d.ms)]),
      ),
    };
  }

  /** Today's sessions laid on a 24-hour rule. */
  function sessionStrip(summary, width) {
    const sessions = summary.today.sessions;
    const pad = { l: 8, r: 8, t: 18, b: 22 };
    const height = 78;
    const plot = { x: pad.l, y: pad.t, w: Math.max(120, width - pad.l - pad.r), h: 26 };
    const fill = cssVar("--series-1");

    const svg = s("svg", {
      width: width,
      height: height,
      viewBox: "0 0 " + width + " " + height,
      role: "img",
      "aria-label": "Sessions today, positioned on a 24 hour axis",
    });

    // Midnight-to-midnight in the summary's zone, so a bar's position means the hour
    // it happened at.
    const dayStart = startOfLocalDay(summary);
    const DAY = 86400000;
    const xOf = (t) => plot.x + Math.max(0, Math.min(1, (t - dayStart) / DAY)) * plot.w;

    svg.appendChild(
      s("rect", { x: plot.x, y: plot.y, width: plot.w, height: plot.h, rx: 4, fill: cssVar("--grid") }),
    );

    for (const sess of sessions) {
      const x1 = xOf(sess.startMs);
      const x2 = Math.max(x1 + 2, xOf(sess.endMs));
      const rect = s("rect", { x: x1, y: plot.y, width: x2 - x1, height: plot.h, rx: 4, fill: fill });
      rect.addEventListener("mousemove", (e) =>
        showTip(
          e,
          clockTime(sess.startMs, summary.timeZone) + " → " + clockTime(sess.endMs, summary.timeZone),
          [
            { label: "Attributed", value: compact(sess.durationMs) },
            { label: "Heartbeats", value: String(sess.heartbeatCount) },
          ],
        ),
      );
      rect.addEventListener("mouseleave", hideTip);
      svg.appendChild(rect);
    }

    [0, 6, 12, 18, 24].forEach((hh) => {
      const x = plot.x + (hh / 24) * plot.w;
      svg.appendChild(
        s("text", {
          class: "tick num",
          x: Math.min(width - 12, Math.max(10, x)),
          y: plot.y + plot.h + 16,
          "text-anchor": "middle",
          text: hh === 24 ? "24" : String(hh).padStart(2, "0"),
        }),
      );
    });

    return {
      svg: svg,
      table: dataTable(
        ["Start", "End", "Attributed", "Heartbeats"],
        sessions.map((x) => [
          clockTime(x.startMs, summary.timeZone),
          clockTime(x.endMs, summary.timeZone),
          compact(x.durationMs),
          x.heartbeatCount,
        ]),
      ),
    };
  }

  /**
   * Midnight today as an epoch instant, recovered from a session boundary rather than
   * guessed: the panel does not know the zone's offset, only its name.
   */
  function startOfLocalDay(summary) {
    const probe = new Date(summary.generatedAtMs);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: summary.timeZone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(probe);
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    const sinceMidnight = get("hour") * 3600000 + get("minute") * 60000 + get("second") * 1000;
    return summary.generatedAtMs - sinceMidnight - (summary.generatedAtMs % 1000);
  }

  /* ------------------------------------------------------------------ view -- */

  function render() {
    const root = document.getElementById("root");
    root.textContent = "";
    root.className = "";

    const summary = state.summary;
    if (!summary) {
      root.appendChild(
        h("div", { class: "empty" }, [
          h("div", { class: "empty-title", text: "No stats yet" }),
          h("div", { class: "empty-body", text: state.error || "Waiting for the stats server." }),
        ]),
      );
      return;
    }

    const live = summary.currentSession;
    // Charts are sized in real pixels, so the arithmetic has to account for the
    // padding they sit inside: root padding (40), then card padding + border (34).
    const CARD_INSET = 34;
    const contentWidth = Math.min(1100, root.clientWidth) - 40;
    const width = Math.max(280, contentWidth - CARD_INSET);
    // The grid breaks to two columns once both can hold their 320px minimum.
    const columnWidth = contentWidth >= 664 ? Math.floor((contentWidth - 12) / 2) : contentWidth;
    const halfWidth = Math.max(240, columnWidth - CARD_INSET);

    /* header */
    root.appendChild(
      h("div", { class: "head" }, [
        h("h1", { text: "TakaTime" }),
        h("span", {
          class: "sub",
          text:
            dayLabel(summary.today.day, { weekday: "long", month: "long", day: "numeric" }) +
            " · last beat " +
            ago(summary.data.msSinceLastBeat),
        }),
        h("div", { class: "actions" }, [
          h("button", {
            type: "button",
            "aria-pressed": state.tables ? "true" : "false",
            text: "Data tables",
            onclick: () => {
              state.tables = !state.tables;
              render();
            },
          }),
          h("button", {
            type: "button",
            text: "Refresh",
            onclick: () => vscode.postMessage({ type: "refresh" }),
          }),
        ]),
      ]),
    );

    if (state.error) {
      root.appendChild(h("div", { class: "warn", text: state.error }));
    }

    /* tiles */
    root.appendChild(
      h("div", { class: "tiles" }, [
        tile("Today", compact(summary.today.ms), [
          summary.today.sessionCount +
            " session" +
            (summary.today.sessionCount === 1 ? "" : "s") +
            (summary.today.longestSessionMs
              ? " · longest " + compact(summary.today.longestSessionMs)
              : ""),
        ]),
        tile("Last " + summary.week.days + " days", compact(summary.week.ms), [
          compact(summary.week.averageMsPerDay) + "/day · " + summary.week.activeDays + " active",
        ]),
        tile(
          "Current session",
          live ? compact(live.durationMs) : "—",
          live
            ? [
                h("span", { class: "live-dot" }),
                "since " + clockTime(live.startMs, summary.timeZone) + " · " + ago(live.msSinceLastBeat),
              ]
            : [h("span", { class: "live-dot idle" }), "idle · last beat " + ago(summary.data.msSinceLastBeat)],
        ),
        tile("Streak", summary.streak.current + "d", ["best " + summary.streak.longest + "d · " + summary.allTime.formatted + " all time"]),
        tile(
          "AI share · " + summary.week.days + "d",
          (summary.week.split.aiShare * 100).toFixed(0) + "%",
          [
            compact(summary.week.split.aiMs) +
              " AI · " +
              compact(summary.week.split.humanMs) +
              " human" +
              (summary.week.split.overlapMs > 0 ? " · " + compact(summary.week.split.overlapMs) + " both" : ""),
          ],
        ),
      ]),
    );

    /* charts */
    const grid = h("div", { class: "grid" });

    const trend = trendChart(summary.trend, { stackedBy: "stacked by project" }, width);
    grid.appendChild(
      card(
        "Daily activity",
        "Last " + summary.trend.days + " days, stacked by project.",
        h("div", { class: "scroll-x" }, trend.svg),
        { wide: true, legend: trend.legend, table: trend.table },
      ),
    );

    // ---- human vs AI ---------------------------------------------------------
    // Two questions, two cards. "What is the mix" is a proportion of one window;
    // "is it changing" needs the time axis, and cramming both into one card made
    // neither legible.
    const wk = summary.week.split;
    const sb = splitBar(wk);
    // Its own copy: the grid reflows to one column on a narrow panel, and a legend
    // that only exists on the chart above can end up a screen away from these bars.
    const bandLegend = () =>
      h(
        "ul",
        { class: "legend" },
        ["human-only", "concurrent", "ai-only"].map((k) =>
          h("li", {}, [
            h("span", { class: "swatch", style: { background: modeColor(k) } }),
            h("span", { text: MODE_LABEL[k] }),
          ]),
        ),
      );
    const mixTrend = trendChart(
      summary.agentTrend,
      {
        colorFor: modeColor,
        labelFor: (k) => MODE_LABEL[k] || k,
        stackedBy: "stacked by human versus AI",
      },
      width,
    );

    const noWrites =
      summary.data.aiWrites === 0
        ? " No agent write records on this machine, so an agent editing an open file still reads as human."
        : "";

    grid.appendChild(
      card(
        "Human vs AI over time",
        "Last " +
          summary.agentTrend.days +
          " days. The three bands are disjoint, so each column adds to that day's total." +
          noWrites,
        h("div", {}, [
          h("div", { class: "scroll-x" }, mixTrend.svg),
          h("div", { class: "split-summary" }, [
            h("div", { class: "split-summary-label", text: "Last " + summary.week.days + " days" }),
            sb.bar,
            h("p", {
              class: "caption",
              text:
                "Union " +
                compact(wk.unionMs) +
                ". Human " +
                compact(wk.humanMs) +
                " and AI " +
                compact(wk.aiMs) +
                " overlap by " +
                compact(wk.overlapMs) +
                " — never add those two.",
            }),
          ]),
        ]),
        { wide: true, legend: mixTrend.legend, table: mixTrend.table },
      ),
    );

    grid.appendChild(
      card(
        "AI share by project",
        "Last " +
          summary.week.days +
          " days. Bar length is total time; the split within it is who wrote it.",
        splitRows(summary.week.projectSplit),
        {
          legend: bandLegend(),
          table: dataTable(
            ["Project", "Human", "AI", "AI share"],
            summary.week.projectSplit.map((r) => [
              r.key,
              compact(r.humanMs),
              compact(r.aiMs),
              (r.aiShare * 100).toFixed(0) + "%",
            ]),
          ),
        },
      ),
    );

    grid.appendChild(
      card(
        "Top projects",
        "Last " + summary.week.days + " days.",
        barRows(summary.week.projects, (k) => trend.colors[k] || cssVar(OTHER)),
        {
          table: dataTable(
            ["Project", "Time", "Share"],
            summary.week.projects.map((r) => [r.key, compact(r.ms), (r.share * 100).toFixed(1) + "%"]),
          ),
        },
      ),
    );

    grid.appendChild(
      card(
        "Top languages",
        "Last " + summary.week.days + " days. Nothing is filtered out — markdown and config files count.",
        barRows(summary.week.languages, () => cssVar("--series-2")),
        {
          table: dataTable(
            ["Language", "Time", "Share"],
            summary.week.languages.map((r) => [r.key, compact(r.ms), (r.share * 100).toFixed(1) + "%"]),
          ),
        },
      ),
    );

    const hm = heatmap(summary);
    grid.appendChild(
      card("Activity", summary.heatmap.length + " days.", h("div", { class: "scroll-x" }, hm.svg), {
        wide: true,
        legend: hm.scale,
        table: hm.table,
      }),
    );

    const strip = sessionStrip(summary, halfWidth);
    grid.appendChild(
      card(
        "Sessions today",
        summary.today.sessionCount
          ? "A session ends after " + Math.round(summary.idleTimeoutSeconds / 60) + " minutes idle."
          : "No sessions yet today.",
        strip.svg,
        { table: strip.table },
      ),
    );

    const hrs = hourChart(summary, halfWidth);
    grid.appendChild(
      card("Time of day", "All history, " + summary.timeZone + ".", hrs.svg, { table: hrs.table }),
    );

    grid.appendChild(
      card(
        "Top files",
        "Last " + summary.week.days + " days.",
        dataTable(
          ["File", "Time"],
          summary.week.files.map((r) => [shorten(r.key, 44), compact(r.ms)]),
        ),
      ),
    );

    grid.appendChild(
      card(
        "Top branches",
        "Last " + summary.week.days + " days.",
        dataTable(
          ["Branch", "Time"],
          summary.week.branches.map((r) => [shorten(r.key, 44), compact(r.ms)]),
        ),
      ),
    );

    if (live) {
      grid.appendChild(
        card(
          "This session",
          "Started " + clockTime(live.startMs, summary.timeZone) + " · " + live.heartbeatCount + " heartbeats.",
          barRows(live.languages, () => cssVar("--series-2"), "No attribution yet."),
          {
            table: dataTable(
              ["Language", "Time"],
              live.languages.map((r) => [r.key, compact(r.ms)]),
            ),
          },
        ),
      );
    }

    root.appendChild(grid);

    /* footer */
    const health =
      summary.data.unstampedHeartbeats === 0 && summary.data.inexactIntervalHeartbeats === 0
        ? "all heartbeats stamped"
        : summary.data.inexactIntervalHeartbeats + " session heads used an estimated interval";

    root.appendChild(
      h("div", { class: "footer" }, [
        h("span", {
          class: "caveat",
          text:
            "Tracked tool activity, not work. Reading, thinking past " +
            Math.round(summary.idleTimeoutSeconds / 60) +
            " minutes, and everything outside an editor or agent count as zero — this is a floor under the real figure, not the figure. Human and AI totals overlap; only the disjoint bands add up.",
        }),
        h("span", { text: "algorithm v" + summary.algorithmVersion }),
        h("span", { text: "config regime v" + summary.data.configVersionInForce + " · " + summary.data.intervalSecondsInForce + "s" }),
        h("span", { text: summary.data.heartbeats + " heartbeats · " + health }),
        h("span", {
          text:
            summary.data.aiWrites === 0
              ? "no agent write records — echo suppression off"
              : summary.data.echoHeartbeats +
                " echoes suppressed · " +
                compact(summary.data.echoRemovedMs) +
                " not counted as human",
        }),
        h("span", { text: "idle timeout " + summary.idleTimeoutSeconds + "s · " + summary.timeZone }),
      ]),
    );
  }

  /* ------------------------------------------------------------- lifecycle -- */

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "summary") {
      state.summary = msg.summary;
      state.error = null;
      vscode.setState({ summary: msg.summary });
      render();
    } else if (msg.type === "error") {
      // Hold the previous render rather than flashing an empty state.
      state.summary = state.summary || msg.stale;
      state.error = msg.message;
      render();
    }
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    // Charts are drawn at a measured pixel width so the type stays crisp, which means
    // a resize is a re-render rather than a CSS scale.
    resizeTimer = setTimeout(render, 150);
  });

  const restored = vscode.getState();
  if (restored && restored.summary) {
    state.summary = restored.summary;
    render();
  }

  vscode.postMessage({ type: "ready" });
})();
