import { useMemo, useState, useRef, useEffect, type ReactNode } from "react";
import { useTradeDetail, useCandles, useMeta, useTheme, useDrawings, usePutDrawings } from "../lib/hooks";
import type { Drawing, Candle } from "../lib/api";
import type { Res } from "../components/TradeChart";
import { money, price, pct, rMultiple, signClass, date, dateTime, holdTime, qty } from "../lib/format";
import { activePosition } from "../../src/core/active-position";
import { FlagEditor } from "../components/FlagEditor";
import { TradeChart } from "../components/TradeChart";
import { JournalEditor } from "../components/JournalEditor";

// Stable identities so the chart's data/hydrate effects (which dep on these props by reference) don't
// re-run on every render while the queries are unsettled.
const NO_DRAWINGS: Drawing[] = [];
const NO_CANDLES: Candle[] = [];

export function TradeDetail({ id }: { id: string }) {
  const { data, isLoading } = useTradeDetail(id);
  const { themeKey } = useTheme();
  const meta = useMeta();
  const t = data?.trade;
  const [reqRes, setReqRes] = useState<Res>("1d");
  const candles = useCandles(id, reqRes);
  const drawings = useDrawings(id);
  const putDrawings = usePutDrawings(id);

  // Debounce drawing saves, and SERIALIZE them — never two PUTs in flight at once. Each PUT replaces
  // the full drawing set, so the last edit wins only if requests reach the server in send-order;
  // overlapping requests could arrive out of order and durably persist a stale set. `saving` gates a
  // single in-flight save; a newer edit queued while one is in flight is sent on settle.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Drawing[] | null>(null);
  const saving = useRef(false);
  const doSave = () => {
    if (saving.current || pending.current === null) return;
    const body = pending.current;
    pending.current = null;
    saving.current = true;
    // mutateAsync returns a real promise; its .finally runs even after this component unmounts (unlike
    // mutate's per-call callbacks, which TanStack Query drops on unmount). So a queued edit is drained
    // and sent even when the user navigates away mid-save — and serialization (one in flight) keeps the
    // writes in send-order so the last edit wins.
    putDrawings
      .mutateAsync(body)
      .catch(() => {}) // a failed PUT shouldn't wedge the queue; the next edit re-sends the full set
      .finally(() => {
        saving.current = false;
        if (pending.current !== null) doSave(); // a newer edit arrived mid-save — send it next, in order
      });
  };
  const flush = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    doSave();
  };
  useEffect(() => () => flush(), []); // flush on unmount; an in-flight save's .finally drains the queue
  const onDrawingsChange = (d: Drawing[]) => {
    pending.current = d;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 500);
  };
  // Stable marks identity so background refetches don't rerun the chart's mark-drawing effect.
  // Keyed on the primitive fields the chart actually draws.
  const marks = useMemo(
    () => ({
      avgEntry: t?.avgEntry ?? 0,
      plannedStop: data?.journal?.manualStop ?? data?.stop?.initialStop ?? null, // the R basis
      // Solid red "active SL" line. For an OPEN trade show the stop that's actually working now (manual
      // override, else the newest resting stop) so the chart agrees with the Live position panel — a
      // cancelled stop doesn't leave a phantom SL. For a CLOSED trade keep the post-hoc effective stop.
      effectiveStop:
        t?.status === "open"
          ? data?.journal?.manualStop ?? data?.stop?.liveStop ?? null
          : t?.effectiveStop ?? null,
      effectiveTp: t?.effectiveTp ?? null,
      direction: t?.direction ?? "LONG",
    }),
    [
      t?.avgEntry,
      t?.status,
      data?.journal?.manualStop,
      data?.stop?.initialStop,
      data?.stop?.liveStop,
      t?.effectiveStop,
      t?.effectiveTp,
      t?.direction,
    ],
  );

  // Current signed holding comes from the server (latest positions snapshot — FUTU's ground truth),
  // which is reversal-safe. 0 when flat/closed.
  const currentQty = data?.currentQty ?? 0;
  // Latest mark = the last loaded candle's close (same series the chart shows). null until candles land.
  const lastBar = useMemo(() => {
    const cs = candles.data?.candles;
    return cs && cs.length > 0 ? cs[cs.length - 1]! : null;
  }, [candles.data?.candles]);
  // The stop to reason about NOW: a manual stop (the user's asserted risk basis) if set, else the
  // latest still-working protective order — never a cancelled/filled one, so we don't claim protection
  // that's gone. `liveStop`/`liveStopQty` come from stop-inference; the risk basis (t.risk) is separate.
  const manualStop = data?.journal?.manualStop ?? null;
  const stopIsManual = manualStop !== null;
  const liveStopPrice = stopIsManual ? manualStop : data?.stop?.liveStop ?? null;
  const liveStopQty = stopIsManual ? null : data?.stop?.liveStopQty ?? null;
  // Live R only for a genuinely-open, fully-covered position that we actually still hold per the snapshot,
  // with the holding's sign matching the trade direction (guards a rare sync race where the position query
  // caught a reversal the fills query hadn't). Seeded/corporate-action trades are excluded (they carry the
  // "possible corporate action" caveat and no reliable risk basis).
  const dirSign = t?.direction === "SHORT" ? -1 : 1;
  const live = useMemo(() => {
    if (!t || t.status !== "open" || !t.coverageOk || !lastBar) return null;
    if (currentQty === 0 || Math.sign(currentQty) !== dirSign) return null;
    return activePosition({
      direction: t.direction,
      avgEntry: t.avgEntry,
      currentQty,
      currentPrice: lastBar.close,
      maxQty: t.maxQty,
      risk: t.risk,
      effectiveStop: liveStopPrice,
    });
  }, [t, currentQty, lastBar, liveStopPrice, dirSign]);

  if (isLoading) return <div className="spinner">Loading…</div>;
  if (!data || !t) return <div className="empty card">Trade not found.</div>;
  const { fills, flags, stop, journal } = data;

  const stat = (label: string, value: ReactNode, cls = "") => (
    <div className="card kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value num ${cls}`} style={{ fontSize: 16 }}>
        {value}
      </div>
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
        <span className="mono" style={{ fontSize: 18, fontWeight: 650 }}>
          {t.symbol}
        </span>
        <span className={t.direction === "LONG" ? "pos" : "neg"} style={{ fontWeight: 600 }}>
          {t.direction}
        </span>
        <span className="muted">
          {date(t.openTime)} → {t.closeTime ? date(t.closeTime) : "open"} · {holdTime(t.holdSeconds)}
        </span>
        {!t.coverageOk && (
          <span
            className="ccy-badge"
            title="This position predates our data coverage or shows a share-count change without matching fills (possible split/corporate action). Excluded from stats; risk/R not computed and P&L may be approximate."
          >
            possible corporate action
          </span>
        )}
      </div>

      {live && lastBar && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <span className="section-title" style={{ margin: 0 }}>
              Live position
            </span>
            <span className="faint" style={{ fontSize: 12 }}>
              mark {price(lastBar.close, t.currency)} · {dateTime(lastBar.time)} · holding {qty(currentQty)}
              {data.positionAsOf > 0 && <> · position as of {dateTime(data.positionAsOf)}</>}
            </span>
          </div>
          <div className="kpi-row" style={{ marginTop: 0 }}>
            {stat("Open R (now)", rMultiple(live.openR), signClass(live.openR))}
            {stat("Unrealized P&L", money(live.openPnl, t.currency), signClass(live.openPnl))}
            {stat(
              stopIsManual ? "Stop (manual)" : "Stop (working)",
              liveStopPrice !== null ? price(liveStopPrice, t.currency) : "—",
            )}
            {stat("Stop in R", rMultiple(live.lockedR), signClass(live.lockedR))}
          </div>
          {!stopIsManual && liveStopPrice === null && (
            <div className="neg" style={{ fontSize: 12, marginTop: 6, fontWeight: 600 }}>
              No working stop at last sync — this position is unprotected.
            </div>
          )}
          {liveStopQty !== null && liveStopQty + 1e-9 < Math.abs(currentQty) && (
            <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
              Heads up: the working stop covers {qty(liveStopQty)} of {qty(Math.abs(currentQty))} shares — the rest is
              unprotected.
            </div>
          )}
          <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
            Open R is your unrealized P&L (gross of fees) on the shares held now, in R. Stop in R is where your{" "}
            {stopIsManual ? "manual" : "working"} stop sits, in R off entry — <em>not</em> a realized loss:{" "}
            <span className="mono">−1R</span> = the initial risk still fully on,{" "}
            <span className="mono">0R</span> = breakeven (no risk left), <span className="mono">+1R</span> = a full R
            secured. It reads off entry per share and ignores profit already banked from partial exits (so it
            can differ from the Positions card's <em>If stopped</em>). Holding &amp; stop are as of the last sync;
            the mark is the latest candle close.
          </div>
        </div>
      )}

      <TradeChart
        symbol={t.symbol}
        candles={candles.data?.candles ?? NO_CANDLES}
        res={candles.data?.res ?? "1d"}
        requestedRes={reqRes}
        onRes={setReqRes}
        focusFrom={candles.data?.focusFrom ?? 0}
        focusTo={candles.data?.focusTo ?? 0}
        fills={fills}
        marks={marks}
        themeKey={themeKey}
        savedDrawings={drawings.data?.drawings ?? NO_DRAWINGS}
        onDrawingsChange={onDrawingsChange}
        loading={candles.isFetching}
        drawingsReady={drawings.isSuccess}
      />

      <div className="kpi-row" style={{ marginTop: 12 }}>
        {stat("Realized P&L", t.realizedPnl !== null ? money(t.realizedPnl, t.currency) : "—", signClass(t.realizedPnl))}
        {stat("R-multiple", rMultiple(t.rMultiple), signClass(t.rMultiple))}
        {stat(
          "Planned risk",
          data.riskPct !== null ? (
            <>
              {data.equityBasis === "latest" ? "≈" : ""}
              {pct(data.riskPct)}
              <span className="faint" style={{ fontSize: 12 }}>
                {" of acct"}
                {t.risk !== null ? ` · ${price(t.risk, t.currency)}` : ""}
              </span>
            </>
          ) : t.risk !== null ? (
            price(t.risk, t.currency)
          ) : (
            "—"
          ),
        )}
        {stat(
          "Position size",
          data.sizePct !== null ? (
            <>
              {data.equityBasis === "latest" ? "≈" : ""}
              {pct(data.sizePct)}
              <span className="faint" style={{ fontSize: 12 }}>
                {" of acct · "}
                {price(data.positionSize, t.currency)}
              </span>
            </>
          ) : (
            price(data.positionSize, t.currency)
          ),
        )}
        {stat("Avg entry / exit", `${price(t.avgEntry, t.currency)} / ${t.avgExit !== null ? price(t.avgExit, t.currency) : "—"}`)}
        {stat("Max size", qty(t.maxQty))}
        {stat(
          "MAE / MFE (per share)",
          // MAE is the worst adverse excursion — show it negative so it doesn't read as a gain (both
          // are per-share price points from entry, not position dollars).
          `${t.mae !== null ? money(-t.mae, t.currency) : "—"} / ${t.mfe !== null ? money(t.mfe, t.currency) : "—"}`,
        )}
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.3fr) minmax(0, 1fr)", marginTop: 18, alignItems: "start" }}>
        <div>
          <div className="section-title" style={{ marginTop: 0 }}>
            Journal
          </div>
          <JournalEditor
            key={id}
            tradeId={id}
            journal={journal}
            setups={meta.data?.setups ?? []}
            emotions={meta.data?.emotions ?? []}
            allTags={meta.data?.tags ?? []}
            currency={t.currency}
          />
        </div>

        <div>
          <div className="section-title" style={{ marginTop: 0 }}>
            Flags
          </div>
          <FlagEditor tradeId={id} flags={flags} overrides={data.flagOverrides} />

          <div className="section-title">Stops &amp; risk basis</div>
          <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, fontSize: 12 }}>
            {(() => {
              // R/risk is computed from the PLANNED stop (manual override, else the initial inferred
              // stop) — NOT the effective/trailing stop shown below. Surface both so R is reconcilable.
              const plannedStop = journal?.manualStop ?? stop.initialStop;
              const profitSide =
                plannedStop != null &&
                (t.direction === "LONG" ? plannedStop > t.avgEntry : plannedStop < t.avgEntry);
              // The inferred stop was judged unreliable (price ran past it while the trade stayed open,
              // so it isn't the real initial risk). R stays shown, but flagged suspect + excluded from
              // the R averages — prompt a Manual stop rather than trusting this basis.
              const unreliable = t.stopUnreliable && journal?.manualStop == null;
              return (
                <>
                  <div>
                    <div className="kpi-label">Planned stop {journal?.manualStop != null ? "(manual)" : ""} · risk basis</div>
                    {plannedStop != null ? (
                      <span className="mono">{price(plannedStop, t.currency)}</span>
                    ) : (
                      <span className="muted">none — R not computed</span>
                    )}
                    {plannedStop != null && t.risk !== null && (
                      <div className="faint mono" style={{ marginTop: 2 }}>
                        |{price(t.avgEntry, t.currency)} − {price(plannedStop, t.currency)}| × {qty(t.maxQty)} = {price(t.risk, t.currency)}
                      </div>
                    )}
                    {unreliable && (
                      <div className="faint" style={{ marginTop: 2 }}>
                        ⚠ Price ran past this stop while the trade stayed open, so it isn't your initial
                        risk (likely trailed or moved). R is still shown but excluded from your R
                        averages — enter a Manual stop above to set the real risk basis.
                      </div>
                    )}
                    {plannedStop != null && t.risk === null && (
                      <div className="faint" style={{ marginTop: 2 }}>
                        {profitSide
                          ? "Risk not computed — this stop is on the profit side of entry (e.g. a split-affected or un-adjusted price)."
                          : "Risk not computed — seeded/corporate-action trade. Enter a Manual stop above to set the risk basis and get your R."}
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="kpi-label">Effective stop (last active)</div>
                    {stop.receipt ? (
                      <span className="mono">{stop.receipt}</span>
                    ) : (
                      <span className="muted">No protective stop found in orders.</span>
                    )}
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      </div>

      <div className="section-title">Fills ({fills.length})</div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Time</th>
              <th>Side</th>
              <th className="right">Qty</th>
              <th className="right">Price</th>
            </tr>
          </thead>
          <tbody>
            {fills.map((f) => (
              <tr key={f.id}>
                <td className="muted num">{dateTime(f.time)}</td>
                <td className={f.side === "BUY" ? "pos" : "neg"} style={{ fontWeight: 600 }}>
                  {f.side}
                </td>
                <td className="right num">{qty(f.qty)}</td>
                <td className="right num">{price(f.price, f.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
