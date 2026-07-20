import { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import { useWeek, usePutWeek } from "../lib/hooks";
import { isoWeekKey, weekLabel } from "../lib/week";
import { money, rMultiple, signClass, date } from "../lib/format";

/** Watchlist row while editing — keyLevel stays a STRING so typing "12.5" isn't round-tripped through
 * Number() on each keystroke (which eats the decimal point). Parsed to number|null only at submit. */
interface WatchRow {
  symbol: string;
  note: string;
  keyLevel: string;
}

export function WeeklyJournal() {
  const [ref, setRef] = useState(() => new Date());
  const key = isoWeekKey(ref);
  const shift = (days: number) => setRef((d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <button className="btn" onClick={() => shift(-7)}>
          ← Prev
        </button>
        <div style={{ fontWeight: 600, minWidth: 180, textAlign: "center" }}>
          {weekLabel(ref)} <span className="faint">· {key}</span>
        </div>
        <button className="btn" onClick={() => shift(7)}>
          Next →
        </button>
      </div>
      <WeekBody key={key} isoWeek={key} />
    </div>
  );
}

function WeekBody({ isoWeek }: { isoWeek: string }) {
  const { data, isLoading } = useWeek(isoWeek);
  const [, navigate] = useLocation();
  const save = usePutWeek(isoWeek);
  const [marketRead, setMarketRead] = useState("");
  const [tradedVsPlan, setTradedVsPlan] = useState("");
  const [watch, setWatch] = useState<WatchRow[]>([]);

  // Seed the form from server state ONCE per mounted week (WeekBody remounts via key={key} on week change).
  // Re-seeding on every `data` change would clobber unsaved typing when a background sync refetches ["week"].
  const seeded = useRef(false);
  useEffect(() => {
    if (!data || seeded.current) return;
    seeded.current = true;
    setMarketRead(data.marketRead ?? "");
    setTradedVsPlan(data.tradedVsPlan ?? "");
    setWatch((data.watchlist ?? []).map((w) => ({ symbol: w.symbol, note: w.note ?? "", keyLevel: w.keyLevel != null ? String(w.keyLevel) : "" })));
  }, [data]);

  if (isLoading) return <div className="spinner">Loading…</div>;

  const submit = () =>
    save.mutate({
      marketRead: marketRead || null,
      tradedVsPlan: tradedVsPlan || null,
      watchlist: watch
        .filter((w) => w.symbol.trim())
        .map((w) => {
          const lvl = w.keyLevel.trim();
          const n = Number(lvl);
          return { symbol: w.symbol.trim(), note: w.note.trim() || null, keyLevel: lvl !== "" && Number.isFinite(n) ? n : null };
        }),
    });

  const setRow = (i: number, patch: Partial<WatchRow>) =>
    setWatch((ws) => ws.map((w, j) => (j === i ? { ...w, ...patch } : w)));

  // A non-empty, non-finite key level would be silently dropped to null on save — block instead.
  const levelBad = (w: WatchRow) => w.keyLevel.trim() !== "" && !Number.isFinite(Number(w.keyLevel.trim()));
  const watchInvalid = watch.some(levelBad);

  return (
    <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1fr)", alignItems: "start" }}>
      <div className="card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label className="kpi-label">Market read</label>
          <textarea className="input" style={{ width: "100%", minHeight: 90, marginTop: 3, resize: "vertical" }}
            value={marketRead} onChange={(e) => setMarketRead(e.target.value)} placeholder="How do you read the market this week?" />
        </div>
        <div>
          <label className="kpi-label">Traded vs plan</label>
          <textarea className="input" style={{ width: "100%", minHeight: 70, marginTop: 3, resize: "vertical" }}
            value={tradedVsPlan} onChange={(e) => setTradedVsPlan(e.target.value)} placeholder="Did you follow your plan?" />
        </div>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <label className="kpi-label">Watchlist</label>
            <button className="btn" style={{ padding: "2px 8px" }} onClick={() => setWatch((w) => [...w, { symbol: "", note: "", keyLevel: "" }])}>
              + Add
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
            {watch.map((w, i) => (
              <div key={i} style={{ display: "flex", gap: 6 }}>
                <input className="input" style={{ minWidth: 0, flex: "0 0 110px" }} placeholder="US.NVDA" value={w.symbol}
                  onChange={(e) => setRow(i, { symbol: e.target.value })} />
                <input className="input" style={{ minWidth: 0, flex: 1 }} placeholder="note" value={w.note}
                  onChange={(e) => setRow(i, { note: e.target.value })} />
                <input className="input" style={{ minWidth: 0, flex: "0 0 90px", borderColor: levelBad(w) ? "var(--neg)" : undefined }} placeholder="level" inputMode="decimal"
                  value={w.keyLevel} onChange={(e) => setRow(i, { keyLevel: e.target.value })} />
                <button className="btn btn-icon" onClick={() => setWatch((ws) => ws.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
            ))}
            {watch.length === 0 && <span className="faint">No tickers yet.</span>}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button className="btn btn-primary" disabled={save.isPending || watchInvalid} onClick={submit}>
            {save.isPending ? "Saving…" : "Save week"}
          </button>
          {save.isSuccess && !save.isPending && <span className="pos" style={{ fontSize: 12 }}>Saved ✓</span>}
          {save.isError && <span className="neg" style={{ fontSize: 12 }}>Save failed</span>}
          {watchInvalid && <span className="neg" style={{ fontSize: 12 }}>Key level must be a number</span>}
        </div>
      </div>

      <div>
        <div className="section-title" style={{ marginTop: 0 }}>
          Trades this week ({data?.trades.length ?? 0})
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Closed</th>
                <th
                  className="right"
                  title="The trade's full realized P&L at close — not P&L earned in this week. The list includes trades opened OR closed this week, so a trade closed this week may have run over prior weeks; open trades show —."
                >
                  Realized P&L
                </th>
                <th className="right">R</th>
              </tr>
            </thead>
            <tbody>
              {(data?.trades ?? []).length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    No trades opened or closed this week.
                  </td>
                </tr>
              )}
              {(data?.trades ?? []).map((t) => (
                // Whole row navigates (same pattern as TradesTable) — the symbol keeps its real <Link>
                // for middle-click/open-in-new-tab; a plain click on it bubbles to the row's navigate,
                // which goes to the same URL, so the two never fight.
                <tr key={t.id} className="clickable" onClick={() => navigate(`/trades/${encodeURIComponent(t.id)}`)}>
                  <td className="mono">
                    <Link href={`/trades/${encodeURIComponent(t.id)}`}>{t.symbol}</Link>
                  </td>
                  <td className="muted num">{t.closeTime ? date(t.closeTime) : <span className="faint">open</span>}</td>
                  <td className={`right num ${signClass(t.realizedPnl)}`}>
                    {t.realizedPnl !== null ? money(t.realizedPnl, t.currency) : "—"}
                  </td>
                  <td className={`right num ${signClass(t.rMultiple)}`}>{rMultiple(t.rMultiple)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
