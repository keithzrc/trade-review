import { useEffect, useRef, type ReactNode } from "react";
import { init, dispose, registerOverlay, type Chart, type KLineData } from "klinecharts";
import type { Candle, RawFill, Drawing, Res } from "../lib/api";

// FUTU-style fill marker: a filled B (buy) / S (sell) pill pinned at the EXACT fill price+time.
// Registered once, globally. It's a single `text` figure — klinecharts' text figure already draws a
// rounded, padded background behind the glyph (its default backgroundColor is klinecharts blue, which
// is why the old markers looked blue). We recolor that background green/red per fill via the overlay's
// `text` styles at create time (the channel klinecharts reliably honors). extendData.side picks the
// letter. Each fill is its own pill at its own price, so two same-day exits (a partial + an overnight
// sell) render as distinct markers instead of colliding the way the old bar-anchored annotation did.
const FILL_OVERLAY = "tradeFill";
let fillOverlayRegistered = false;
function registerFillOverlay() {
  if (fillOverlayRegistered) return;
  fillOverlayRegistered = true;
  registerOverlay({
    name: FILL_OVERLAY,
    totalStep: 2, // matches built-in single-point overlays (points + 1)
    needDefaultPointFigure: false, // no draggable anchor dots — this is a locked, read-only mark
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ overlay, coordinates }) => {
      const pt = coordinates[0];
      if (!pt) return [];
      const isBuy = (overlay.extendData as { side?: string } | undefined)?.side === "BUY";
      return [
        {
          type: "text",
          attrs: { x: pt.x, y: pt.y, text: isBuy ? "B" : "S", align: "center", baseline: "middle" },
          ignoreEvent: true,
        },
      ];
    },
  });
}
registerFillOverlay();

// Our theme colors are declared with CSS `light-dark(lightHex, darkHex)`. Reading the custom property
// directly (getPropertyValue) returns that literal UNRESOLVED string — klinecharts can't parse it and
// silently falls back to its own default palette (why the chart looked "off", esp. in light mode).
// Resolve each var through a throwaway element instead: assigning it to a real color property and
// reading the *computed* value forces light-dark() to collapse to a concrete rgb() for the active scheme.
function themeColors() {
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  document.body.appendChild(probe);
  const v = (n: string, fallback: string) => {
    probe.style.color = "";
    probe.style.color = `var(${n})`;
    return getComputedStyle(probe).color || fallback;
  };
  const out = {
    text: v("--text-muted", "#888"),
    grid: v("--border", "#333"),
    up: v("--pos", "#26a69a"),
    down: v("--neg", "#ef5350"),
    accent: v("--accent", "#4c8dff"),
    warn: v("--warn", "#e0a341"),
    axis: v("--text-faint", "#777"),
  };
  probe.remove();
  return out;
}

export type { Res }; // re-exported for existing consumers (TradeDetail); canonical def in src/core/candle-res

// Resolution toggle order (finest → coarsest) + button labels. Kept in sync with the server's
// RESOLUTIONS list in src/api/routes.ts and the Res union in src/core/candle-res.ts.
export const RES_OPTIONS: Array<{ res: Res; label: string }> = [
  { res: "15m", label: "15m" },
  { res: "1h", label: "1H" },
  { res: "1d", label: "1D" },
  { res: "1wk", label: "1W" },
  { res: "1mo", label: "1M" },
  { res: "3mo", label: "1Q" },
];

function periodFor(res: Res) {
  if (res === "1h") return { type: "hour" as const, span: 1 };
  if (res === "15m") return { type: "minute" as const, span: 15 };
  if (res === "1wk") return { type: "week" as const, span: 1 };
  if (res === "1mo") return { type: "month" as const, span: 1 };
  if (res === "3mo") return { type: "month" as const, span: 3 }; // quarter = 3 months (no 'quarter' type)
  return { type: "day" as const, span: 1 };
}

/** klinecharts style overrides sampled from our CSS theme, so the chart re-themes with the app. */
function chartStyles(c: ReturnType<typeof themeColors>) {
  return {
    grid: { horizontal: { color: c.grid, style: "dashed" as const }, vertical: { show: false } },
    candle: {
      bar: {
        upColor: c.up, downColor: c.down,
        upBorderColor: c.up, downBorderColor: c.down,
        upWickColor: c.up, downWickColor: c.down,
      },
      priceMark: { high: { color: c.text }, low: { color: c.text }, last: { text: { color: "#fff" } } },
      tooltip: { legend: { color: c.text } },
    },
    indicator: { tooltip: { legend: { color: c.text } } },
    xAxis: { axisLine: { color: c.grid }, tickLine: { color: c.grid }, tickText: { color: c.axis } },
    yAxis: { axisLine: { color: c.grid }, tickLine: { color: c.grid }, tickText: { color: c.axis } },
    crosshair: {
      horizontal: { text: { backgroundColor: c.accent } },
      vertical: { text: { backgroundColor: c.accent } },
    },
  };
}

export interface ChartMarks {
  avgEntry: number;
  plannedStop: number | null; // manual ?? initial — the R basis (drawn dashed when it differs from the effective stop)
  effectiveStop: number | null; // last active/trailing stop — the primary SL, drawn solid red
  effectiveTp: number | null;
  direction: "LONG" | "SHORT";
}

function toKline(c: Candle): KLineData {
  return { timestamp: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
}

const MARKS = "marks"; // our locked trade marks
const USER = "user"; // user drawings (persisted)

// klinecharts v10 built-in OVERLAYS only (its `rect` is a FIGURE, not an overlay — createOverlay
// would no-op). segment/horizontalStraightLine/fibonacciLine/brush are real overlay templates
// (`brush` is a continuous freehand overlay: totalStep 2, drawingMode 'continuous').
const TOOLS: Array<{ name: string; label: string }> = [
  { name: "segment", label: "Line" },
  { name: "horizontalStraightLine", label: "H-line" },
  { name: "fibonacciLine", label: "Fib" },
  { name: "brush", label: "Brush" },
];

/** What each locked mark on the chart means. An entry appears only when its line/marker is actually
 * drawn (no TP line → no TP row), so the legend never promises a mark that isn't there. Colors are
 * the same CSS vars the overlays sample — the legend re-themes with the chart for free (this is DOM,
 * so `light-dark()` vars resolve natively; no themeColors() probe needed). */
function Legend({ marks, hasFills }: { marks: ChartMarks; hasFills: boolean }) {
  const swatch = (color: string, dashed: boolean) => (
    <span
      aria-hidden
      style={{ display: "inline-block", width: 18, borderTop: `2px ${dashed ? "dashed" : "solid"} ${color}` }}
    />
  );
  const pill = (color: string, letter: string) => (
    <span
      aria-hidden
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: 15, height: 15, borderRadius: 8, background: color,
        color: "#fff", fontSize: 9, fontWeight: 700, lineHeight: 1,
      }}
    >
      {letter}
    </span>
  );
  const item = (key: string, mark: ReactNode, label: string) => (
    <span key={key} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      {mark}
      {label}
    </span>
  );
  const items = [item("entry", swatch("var(--accent)", true), "Avg entry")];
  if (marks.effectiveStop !== null) items.push(item("sl", swatch("var(--neg)", false), "Stop (active)"));
  // Same visibility rule as the overlay: the planned/R-basis stop only exists as a separate line when
  // it differs from the active stop.
  if (marks.plannedStop !== null && marks.plannedStop !== marks.effectiveStop)
    items.push(item("plan", swatch("var(--neg)", true), "Planned stop (R basis)"));
  if (marks.effectiveTp !== null) items.push(item("tp", swatch("var(--pos)", true), "Take profit"));
  if (hasFills)
    items.push(
      item(
        "fills",
        <span style={{ display: "inline-flex", gap: 3 }}>
          {pill("var(--pos)", "B")}
          {pill("var(--neg)", "S")}
        </span>,
        "Buy / sell fills",
      ),
    );
  return (
    <div className="faint" style={{ display: "flex", flexWrap: "wrap", gap: 14, fontSize: 11, marginTop: 6 }}>
      {items}
    </div>
  );
}

/** Marked-up candlestick chart on klinecharts: candles + volume, fill markers, entry/stop/TP lines,
 * a 1D/1H/15m resolution toggle, and drawing tools whose annotations persist per trade. */
export function TradeChart({
  symbol,
  candles,
  res,
  requestedRes,
  onRes,
  focusFrom,
  focusTo,
  fills,
  marks,
  themeKey,
  savedDrawings,
  onDrawingsChange,
  loading,
  drawingsReady,
}: {
  symbol: string;
  candles: Candle[];
  res: Res;
  requestedRes: Res;
  onRes: (r: Res) => void;
  focusFrom: number;
  focusTo: number;
  fills: RawFill[];
  marks: ChartMarks;
  themeKey: string;
  savedDrawings: Drawing[];
  onDrawingsChange: (d: Drawing[]) => void;
  loading: boolean; // a res-switch refetch is in flight (keepPreviousData still shows the old res)
  drawingsReady: boolean; // saved-drawings query SUCCEEDED (not just settled): if it errored we don't
  // know the server's set, so tools stay disabled — a draw against the empty fallback would let the
  // replace-set PUT wipe saved annotations. A refetch (retry/remount) re-enables.
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<Chart | null>(null);
  const bars = useRef<KLineData[]>([]);
  const hydrating = useRef(false); // suppress persistence while we recreate saved overlays
  const hydrated = useRef(false); // hydrate saved drawings ONCE per mount (keyed by trade → per trade)
  const lastView = useRef<{ symbol: string; res: Res } | null>(null); // only re-fit on symbol/res change
  const onChange = useRef(onDrawingsChange);
  onChange.current = onDrawingsChange;

  // Init once. dispose() the INSTANCE in cleanup (dispose(element) can't find it — our div has no id).
  useEffect(() => {
    if (!el.current) return;
    const c = init(el.current);
    if (!c) return;
    chart.current = c;
    c.setStyles(chartStyles(themeColors()));
    c.setDataLoader({ getBars: ({ type, callback }) => callback(type === "init" ? bars.current : [], false) });
    c.createIndicator("VOL", false);
    return () => {
      dispose(c);
      chart.current = null;
    };
  }, []);

  // Fit [from, to] into the viewport (shrink bar spacing so the whole trade shows on first paint),
  // then pin the right edge. Guard the empty case — scrollToTimestamp indexes the bar list and
  // throws on [] (unsupported market / Yahoo outage → ladder exhausts → candles []).
  const fitAndScroll = (c: Chart, from: number, to: number) => {
    if (bars.current.length === 0 || to <= 0) return;
    // getSize needs the pane id ('candle_pane' — klinecharts doesn't export the constant); 'main' is
    // the candle drawing area width, excluding the y-axis, which is what bar-space is measured against.
    const width = c.getSize("candle_pane", "main")?.width ?? 0;
    const barSpace = c.getBarSpace().bar;
    const inFocus = bars.current.filter((b) => b.timestamp >= from && b.timestamp <= to).length;
    // Only ZOOM OUT — and only when the trade (entry→exit + pad) wouldn't otherwise fit. Never zoom in
    // past the default spacing: that would throw away the run-up context needed to judge the entry
    // (the whole point of loading ~1yr of bars). A short trade keeps the wide default view; a long
    // hold shrinks bar spacing just enough to keep its entry/initial-stop on screen.
    if (inFocus > 1 && width > 0 && barSpace > 0 && inFocus > (width / barSpace) * 0.9) {
      c.setBarSpace(Math.max(1, (width * 0.9) / inFocus)); // <1px is a silent no-op in klinecharts
    }
    c.scrollToTimestamp(to, 0);
  };

  // Reload the series on ANY candle change. We depend on the `candles` array by REFERENCE: React
  // Query's structural sharing hands back a new array iff some OHLCV field actually changed (today's
  // bar after a sync, a whole-series split back-adjust, a corrected interior bar, a volume-only
  // revision) and the same reference otherwise — so this reruns exactly when the data changed, never
  // on an incidental re-render. Only re-fit the view when symbol/res changed, so a background refetch
  // refreshes prices without yanking the user's pan/zoom. (TradeDetail passes a stable NO_CANDLES
  // fallback so an unsettled query doesn't churn this effect.)
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    bars.current = candles.map(toKline).sort((a, b) => a.timestamp - b.timestamp);
    const precision = marks.avgEntry > 0 && marks.avgEntry < 1 ? 4 : 2; // sub-$1 tickers tick finer
    c.setSymbol({ ticker: symbol, pricePrecision: precision, volumePrecision: 0 });
    c.setPeriod(periodFor(res));
    c.resetData(); // forces a data-loader reload even when symbol+period are unchanged (value-only refetch)
    // Fit only after real data has arrived, and only latch lastView once we actually fit — otherwise the
    // empty first mount (candles fetch is slower than the trade query) would latch the view without
    // fitting, and the fit would then be skipped when the candles land (cold-load entry off-screen).
    const viewChanged = !lastView.current || lastView.current.symbol !== symbol || lastView.current.res !== res;
    if (viewChanged && bars.current.length > 0 && focusTo > 0) {
      lastView.current = { symbol, res };
      fitAndScroll(c, focusFrom, focusTo);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, res, candles]);

  // Serialize the user's drawings to our persistence shape (timestamp+value only; strip dataIndex).
  const persist = () => {
    const c = chart.current;
    if (!c || hydrating.current) return;
    const drawings: Drawing[] = c.getOverlays({ groupId: USER }).map((o) => ({
      name: o.name,
      points: (o.points ?? []).map((p) => ({ timestamp: p.timestamp, value: p.value })),
      ...(o.extendData !== undefined ? { extendData: o.extendData } : {}), // labels/metadata round-trip
    }));
    onChange.current(drawings);
  };

  // Overlay lifecycle → persist. onDrawEnd/onPressedMoveEnd fire with the overlay already in
  // getOverlays(), so persist synchronously. onRemoved, however, fires BEFORE klinecharts splices the
  // overlay out of the store (verified in the lib), so a synchronous persist would re-serialize the
  // just-removed drawing and it would reappear on the next save/remount — defer it a microtask so the
  // splice completes first. (Our own clearDrawings persists explicitly after removeOverlay too.)
  const overlayHooks = {
    onDrawEnd: () => persist(),
    onPressedMoveEnd: () => persist(),
    onRemoved: () => queueMicrotask(persist),
  };

  const startDraw = (name: string) => {
    chart.current?.createOverlay({ name, groupId: USER, ...overlayHooks });
  };

  const clearDrawings = () => {
    chart.current?.removeOverlay({ groupId: USER });
    persist();
  };

  // Draw/redraw the locked marks; also re-theme (both depend on resolved CSS colors via themeKey).
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    c.setStyles(chartStyles(themeColors()));
    c.removeOverlay({ groupId: MARKS });
    if (bars.current.length === 0) return;
    const col = themeColors();
    const line = (value: number, color: string, dashed: boolean) =>
      c.createOverlay({
        name: "horizontalStraightLine",
        groupId: MARKS,
        lock: true,
        points: [{ value }],
        styles: { line: { color, style: dashed ? "dashed" : "solid", size: 1 } },
      });
    line(marks.avgEntry, col.accent, true); // entry — blue dashed
    // Stop loss — always RED and easy to spot. The active/protective stop is a SOLID red line (the SL
    // that was actually working); the planned stop (R basis), when it differs, is a fainter red dash.
    if (marks.effectiveStop !== null) line(marks.effectiveStop, col.down, false); // active SL — solid red
    if (marks.plannedStop !== null && marks.plannedStop !== marks.effectiveStop)
      line(marks.plannedStop, col.down, true); // planned/risk-basis stop — red dashed
    if (marks.effectiveTp !== null) line(marks.effectiveTp, col.up, true); // tp — green dashed
    // Keep every mark on screen: widen the price axis so a stop below the candle range (or a TP above
    // it) can't sit off the edge. createRange runs on every auto-scale, so the SL stays visible through
    // pan/zoom. Linear (non-log) axis → realValue == value == displayValue, so mirror all fields.
    const rangeMarks = [marks.avgEntry, marks.effectiveStop, marks.plannedStop, marks.effectiveTp].filter(
      (v): v is number => v !== null && Number.isFinite(v) && v > 0,
    );
    c.overrideYAxis({
      paneId: "candle_pane", // the price axis specifically — NOT the volume pane
      createRange: ({ defaultRange }) => {
        const dFrom = defaultRange.from;
        const dTo = defaultRange.to;
        // Only pull a mark into view if it's within ~one screenful of the visible candles. On the trade
        // view the stop/entry are right there, so they show; but after scrolling deep into post-trade
        // data where price ran far from the stop, we don't squash the candles into a sliver to reach it.
        const slack = dTo - dFrom || 1;
        let from = dFrom;
        let to = dTo;
        for (const v of rangeMarks) {
          if (v < dFrom - slack || v > dTo + slack) continue;
          from = Math.min(from, v);
          to = Math.max(to, v);
        }
        if (from === dFrom && to === dTo) return defaultRange;
        const pad = (to - from) * 0.04 || 1; // a little breathing room around a mark at the extreme
        from -= pad;
        to += pad;
        const range = to - from;
        // klinecharts scales the axis off the real* fields — set those, not just from/to.
        return {
          from,
          to,
          realFrom: from,
          realTo: to,
          range,
          realRange: range,
          displayFrom: from,
          displayTo: to,
          displayRange: range,
        };
      },
    });
    // FUTU-style B/S pills at the exact fill price+time (see registerFillOverlay). Green for buys, red
    // for sells — so partial exits and overnight sells each show as their own distinct marker. The pill
    // is the text figure's rounded background; recolor it (and its border) per fill.
    for (const f of fills) {
      const fillColor = f.side === "BUY" ? col.up : col.down;
      c.createOverlay({
        name: FILL_OVERLAY,
        groupId: MARKS,
        lock: true,
        points: [{ timestamp: f.time, value: f.price }],
        extendData: { side: f.side },
        styles: {
          text: {
            color: "#ffffff",
            size: 11,
            weight: "bold",
            backgroundColor: fillColor,
            borderColor: fillColor,
            borderRadius: 20, // large radius + tight padding ≈ a round pill
            paddingLeft: 5,
            paddingRight: 5,
            paddingTop: 3,
            paddingBottom: 3,
          },
        },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marks, fills, themeKey, candles.length]);

  // Recreate saved user drawings ONCE, when the drawings query first succeeds (gated on drawingsReady
  // so we never hydrate the pre-load placeholder). Each in its own try/catch so one bad row can't
  // poison the chart; `hydrating` blocks the load→save echo. NOT re-run on later savedDrawings changes:
  // after mount the chart is the source of truth, and every successful save updates the cache — a
  // re-hydrate would tear down the USER group and could wipe a drawing made during the debounce window.
  // (Trade change remounts this component via the id key, resetting `hydrated` for the next trade.)
  useEffect(() => {
    const c = chart.current;
    if (!c || hydrated.current || !drawingsReady) return;
    hydrated.current = true;
    hydrating.current = true;
    c.removeOverlay({ groupId: USER });
    for (const d of savedDrawings) {
      try {
        c.createOverlay({ name: d.name, groupId: USER, points: d.points, extendData: d.extendData, ...overlayHooks });
      } catch {
        /* skip a malformed saved overlay */
      }
    }
    hydrating.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedDrawings, drawingsReady]);

  const toggle = ({ res: r, label }: { res: Res; label: string }) => (
    <button
      key={r}
      className={`btn${requestedRes === r ? " btn-primary" : ""}`}
      style={{ padding: "2px 9px" }}
      onClick={() => onRes(r)}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 6, gap: 6 }}>
        {RES_OPTIONS.map(toggle)}
        <div style={{ width: 1, alignSelf: "stretch", background: "var(--border)", margin: "0 4px" }} />
        {TOOLS.map((t) => (
          <button
            key={t.name}
            className="btn"
            style={{ padding: "2px 9px" }}
            disabled={!drawingsReady}
            title={drawingsReady ? undefined : "loading saved drawings…"}
            onClick={() => startDraw(t.name)}
          >
            {t.label}
          </button>
        ))}
        <button className="btn" style={{ padding: "2px 9px" }} disabled={!drawingsReady} onClick={clearDrawings}>
          Clear
        </button>
        {res !== requestedRes && !loading && (
          <span className="faint" style={{ fontSize: 11, alignSelf: "center" }}>
            no {requestedRes} data — showing {res}
          </span>
        )}
      </div>
      {/* Big, tall chart — the primary surface for reviewing a trade. Responsive to viewport height
          (klinecharts observes the container and re-lays out), clamped so it stays usable on small and
          huge screens alike. */}
      <div className="card" style={{ position: "relative", width: "100%", height: "clamp(460px, 70vh, 860px)" }}>
        <div ref={el} style={{ width: "100%", height: "100%" }} />
        {candles.length === 0 && (
          <div
            className="empty"
            style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}
          >
            No candles for this window (source unavailable or unsupported market).
          </div>
        )}
      </div>
      {candles.length > 0 && <Legend marks={marks} hasFills={fills.length > 0} />}
    </div>
  );
}
