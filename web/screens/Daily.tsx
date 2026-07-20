import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useDay, useHeatmap, usePutDay, usePutHeatmapGroups, usePutThematic, useResetHeatmapGroups } from "../lib/hooks";
import type { HeatmapGroupRows, HeatmapRow, MarketRegime } from "../lib/api";
import { date, dateTime, money, rMultiple, signClass } from "../lib/format";
import { dayKeyOf } from "../../src/domain/time";

// Per-column heat scale: the |value| at which the cell tint saturates. Tuned per horizon so a ±1%
// day reads as loud as a ±10% YTD (their natural magnitudes differ by an order of magnitude).
const SCALE = { day: 0.03, p5d: 0.06, p1m: 0.1, rs20: 0.05, ma20: 0.05, ma50: 0.08, off52w: 0.25, ytd: 0.3 };
const SYMBOL_RE = /^[A-Z]{2,6}\.[A-Z0-9.\-]{1,15}$/; // mirrors the server's validation
const REGIMES: MarketRegime[] = ["UPTREND", "CHOP", "DOWNTREND"];

/** Signed percent, 2dp — the sheet-style reading ("+1.38%", "−4.03%"). Tolerates undefined so a
 * snapshot frozen before a column existed renders "—", not NaN. */
function spct(v: number | null | undefined): string {
  if (v == null) return "—";
  const s = (v * 100).toFixed(2);
  return v > 0 ? `+${s}%` : `${s}%`;
}

/** Volume ratio ("1.8×"). 1 = a normal day. */
function xratio(v: number | null | undefined): string {
  return v == null ? "—" : `${v.toFixed(1)}×`;
}

/** Cell tint: green/red by sign, opacity by |value| against the column's scale. DOM styles resolve
 * our light-dark() CSS vars natively, so the tint re-themes for free. */
function heat(v: number | null | undefined, scale: number): CSSProperties {
  if (v == null) return {};
  const mag = Math.min(Math.abs(v) / scale, 1);
  const color = v >= 0 ? "var(--pos)" : "var(--neg)";
  return { background: `color-mix(in srgb, ${color} ${Math.round(mag * 40)}%, transparent)` };
}

/** Volume tint: deviation from 1× (a normal day). Elevated volume = attention (green), dried-up =
 * gray-red. Saturates at ±1.5× away from normal. */
function heatVol(v: number | null | undefined): CSSProperties {
  if (v == null) return {};
  const mag = Math.min(Math.abs(v - 1) / 1.5, 1);
  const color = v >= 1 ? "var(--pos)" : "var(--neg)";
  return { background: `color-mix(in srgb, ${color} ${Math.round(mag * 35)}%, transparent)` };
}

/** "US.XLK" renders as "XLK" (the US prefix is noise in an all-ETF table); other markets keep it. */
function displaySymbol(s: string): string {
  return s.startsWith("US.") ? s.slice(3) : s;
}

/** Free-typed ticker → domain symbol: uppercase, default to the US market when no prefix given. */
function normalizeSymbol(raw: string): string {
  const s = raw.trim().toUpperCase();
  return s.includes(".") && /^[A-Z]{2,6}\./.test(s) ? s : `US.${s}`;
}

/** The label cell: plain text normally; in edit mode an input that commits on Enter/blur, so the
 * industry beside a ticker can be renamed in place (keyed by symbol+label to reset after a save). */
function LabelCell({ row, editing, onLabel }: { row: HeatmapRow; editing: boolean; onLabel: (label: string) => void }) {
  if (!editing)
    return (
      // Ellipsized so a long industry name can't force the table into horizontal scroll; full text on hover.
      <td
        className="muted"
        title={row.label ?? undefined}
        style={{ maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {row.label ?? ""}
      </td>
    );
  return (
    <td>
      <input
        key={`${row.symbol}|${row.label ?? ""}`}
        className="input"
        style={{ fontSize: 12, padding: "1px 6px", width: "100%", minWidth: 90 }}
        defaultValue={row.label ?? ""}
        placeholder="industry…"
        onBlur={(e) => {
          if (e.target.value.trim() !== (row.label ?? "")) onLabel(e.target.value.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </td>
  );
}

function GroupTable({
  name,
  rows,
  editing,
  onRemove,
  onAdd,
  onLabel,
  onMove,
  extraHeader,
  showRank,
  metrics = "basic",
}: {
  name: string;
  rows: HeatmapRow[];
  editing: boolean; // false for a frozen snapshot (read-only) and while not in Edit lists
  onRemove?: (symbol: string) => void;
  onAdd?: (symbol: string, label: string | null) => void;
  onLabel?: (symbol: string, label: string) => void;
  onMove?: (symbol: string, dir: -1 | 1) => void; // ↑/↓ a ticker within its list while editing
  extraHeader?: ReactNode; // e.g. the ↑/↓ group-reorder buttons while editing
  showRank?: boolean; // "#" column for ranked lists (the thematic top-10)
  metrics?: "basic" | "full"; // basic (index/sector groups): Day/5D/52w/YTD. full (thematic): + momentum set
}) {
  const [draftSym, setDraftSym] = useState("");
  const [draftLabel, setDraftLabel] = useState("");
  const draftBad = draftSym.trim() !== "" && !SYMBOL_RE.test(normalizeSymbol(draftSym));
  const commit = () => {
    if (draftSym.trim() === "" || draftBad || !onAdd) return;
    onAdd(normalizeSymbol(draftSym), draftLabel.trim() || null);
    setDraftSym("");
    setDraftLabel("");
  };
  return (
    <div>
      <div className="section-title" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {name}
        {extraHeader}
        {editing && onAdd && (
          <>
            <input
              className="input"
              style={{ fontSize: 12, padding: "2px 8px", width: 90, borderColor: draftBad ? "var(--neg)" : undefined }}
              placeholder="ticker"
              value={draftSym}
              onChange={(e) => setDraftSym(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
              }}
            />
            <input
              className="input"
              style={{ fontSize: 12, padding: "2px 8px", width: 140 }}
              placeholder="industry (optional)"
              value={draftLabel}
              onChange={(e) => setDraftLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
              }}
            />
            <button className="btn" style={{ padding: "2px 8px", fontSize: 11 }} disabled={draftSym.trim() === "" || draftBad} onClick={commit}>
              + Add
            </button>
          </>
        )}
      </div>
      <div className="table-wrap">
        <table className="data dense">
          <thead>
            <tr>
              {showRank && <th className="right">#</th>}
              <th>Symbol</th>
              <th>Industry</th>
              <th className="right" title="Latest close vs the previous session's close">% Day</th>
              <th className="right" title="Latest close vs the close 5 sessions earlier">% 5D</th>
              {metrics === "full" && (
                <>
                  <th className="right" title="Latest close vs the close 21 sessions (~1 calendar month) earlier">% 1M</th>
                  <th className="right" title="20-session return relative to SPY ((1+r)÷(1+rSPY)−1). Positive = outperforming the index — the emerging-leadership tell">
                    vs SPY
                  </th>
                  <th className="right" title="Latest close vs its 20-session moving average — short-term trend position">20DMA</th>
                  <th className="right" title="Latest close vs its 50-session moving average — intermediate trend position">50DMA</th>
                  <th className="right" title="Latest session's volume vs the average of the prior 20 sessions. >1× = elevated participation">
                    Vol×
                  </th>
                </>
              )}
              <th className="right" title="Latest close vs the highest intraday high of the trailing 52 weeks (0% = at highs)">
                % 52w
              </th>
              <th className="right" title="Latest close vs the final close of the previous calendar year">% YTD</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={(showRank ? 1 : 0) + (metrics === "full" ? 11 : 6)} className="empty">
                  No symbols — use Edit lists to add some.
                </td>
              </tr>
            )}
            {rows.map((r, i) => (
              <tr key={r.symbol}>
                {showRank && <td className="right muted num">{i + 1}</td>}
                <td className="mono">
                  {displaySymbol(r.symbol)}
                  {r.last === null && (
                    <span className="ccy-badge" title="No daily candles for this symbol (unsupported market or bad ticker)">
                      no data
                    </span>
                  )}
                  {editing && onMove && (
                    <span style={{ display: "inline-flex", gap: 2, marginLeft: 6 }}>
                      <button type="button" className="btn btn-icon" title="Move up" disabled={i === 0}
                        style={{ padding: "0 5px", fontSize: 10 }} onClick={() => onMove(r.symbol, -1)}>
                        ▲
                      </button>
                      <button type="button" className="btn btn-icon" title="Move down" disabled={i === rows.length - 1}
                        style={{ padding: "0 5px", fontSize: 10 }} onClick={() => onMove(r.symbol, 1)}>
                        ▼
                      </button>
                    </span>
                  )}
                  {editing && onRemove && (
                    <button
                      type="button"
                      className="btn btn-icon"
                      aria-label={`remove ${r.symbol}`}
                      style={{ marginLeft: 4, padding: "0 6px", fontSize: 11 }}
                      onClick={() => onRemove(r.symbol)}
                    >
                      ✕
                    </button>
                  )}
                </td>
                <LabelCell row={r} editing={editing && !!onLabel} onLabel={(l) => onLabel?.(r.symbol, l)} />
                <td className="right num" style={heat(r.dayPct, SCALE.day)}>{spct(r.dayPct)}</td>
                <td className="right num" style={heat(r.p5dPct, SCALE.p5d)}>{spct(r.p5dPct)}</td>
                {metrics === "full" && (
                  <>
                    <td className="right num" style={heat(r.p1mPct, SCALE.p1m)}>{spct(r.p1mPct)}</td>
                    <td className="right num" style={heat(r.rs20Pct, SCALE.rs20)}>{spct(r.rs20Pct)}</td>
                    <td className="right num" style={heat(r.ma20Pct, SCALE.ma20)}>{spct(r.ma20Pct)}</td>
                    <td className="right num" style={heat(r.ma50Pct, SCALE.ma50)}>{spct(r.ma50Pct)}</td>
                    <td className="right num" style={heatVol(r.volVs20d)}>{xratio(r.volVs20d)}</td>
                  </>
                )}
                <td className="right num" style={heat(r.off52wPct, SCALE.off52w)}>{spct(r.off52wPct)}</td>
                <td className="right num" style={heat(r.ytdPct, SCALE.ytd)}>{spct(r.ytdPct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Daily page: pick a day (← / →, like the weekly journal), write your market view for it, and see
 * that day's sector/index heatmap — LIVE for today (editable lists), FROZEN from the saved snapshot
 * for any past day ("Save day" on the day is what freezes it). */
export function Daily() {
  const [ref, setRef] = useState(() => new Date());
  const key = dayKeyOf(ref.getTime());
  const isToday = key === dayKeyOf(Date.now());
  const shift = (days: number) => setRef((d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
  const label = ref.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 14 }}>
        <button className="btn" onClick={() => shift(-1)}>
          ← Prev
        </button>
        <div style={{ fontWeight: 600, minWidth: 190, textAlign: "center" }}>
          {label} {isToday && <span className="faint">· today</span>}
        </div>
        <button className="btn" onClick={() => shift(1)}>
          Next →
        </button>
        {!isToday && (
          <button className="btn" onClick={() => setRef(new Date())}>
            Today
          </button>
        )}
      </div>
      <DayBody key={key} dayKey={key} isToday={isToday} />
    </div>
  );
}

function DayBody({ dayKey, isToday }: { dayKey: string; isToday: boolean }) {
  const day = useDay(dayKey);
  const save = usePutDay(dayKey);
  // Live market data only matters for TODAY — a past day renders its frozen snapshot, so don't spend
  // ~30 candle fetches on it.
  const [, navigate] = useLocation();
  const heatQ = useHeatmap(isToday);
  const putGroups = usePutHeatmapGroups();
  const putThematic = usePutThematic();
  const resetGroups = useResetHeatmapGroups();
  const [editing, setEditing] = useState(false);
  const [newGroup, setNewGroup] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [regime, setRegime] = useState<MarketRegime | null>(null);
  const [marketRead, setMarketRead] = useState("");
  const [notes, setNotes] = useState("");

  // Seed the form ONCE per mounted day (DayBody remounts via key={dayKey}) — same pattern as the
  // weekly journal, so a background refetch can't clobber unsaved typing.
  const seeded = useRef(false);
  useEffect(() => {
    if (!day.data || seeded.current) return;
    seeded.current = true;
    setRegime(day.data.regime);
    setMarketRead(day.data.marketRead ?? "");
    setNotes(day.data.notes ?? "");
  }, [day.data]);

  if (day.isLoading) return <div className="spinner">Loading…</div>;

  const submit = () =>
    save.mutate({
      regime,
      marketRead: marketRead || null,
      notes: notes || null,
      // Today's save freezes the market picture as it's shown right now; past days never send one
      // (and the server would refuse it anyway — history stays history).
      ...(isToday && heatQ.data ? { snapshot: heatQ.data } : {}),
    });

  // Live-mode edits derive the next groups payload straight from what's on screen.
  const liveGroups = (heatQ.data?.groups ?? []).map((g) => ({
    name: g.name,
    symbols: g.rows.map((r) => ({ symbol: r.symbol, label: r.label })),
  }));
  const removeSymbol = (gi: number, symbol: string) =>
    putGroups.mutate(liveGroups.map((g, i) => (i === gi ? { ...g, symbols: g.symbols.filter((s) => s.symbol !== symbol) } : g)));
  const addSymbol = (gi: number, symbol: string, lbl: string | null) =>
    putGroups.mutate(
      liveGroups.map((g, i) =>
        i === gi && !g.symbols.some((s) => s.symbol === symbol) ? { ...g, symbols: [...g.symbols, { symbol, label: lbl }] } : g,
      ),
    );
  const setLabel = (gi: number, symbol: string, lbl: string) =>
    putGroups.mutate(
      liveGroups.map((g, i) =>
        i === gi ? { ...g, symbols: g.symbols.map((s) => (s.symbol === symbol ? { ...s, label: lbl || null } : s)) } : g,
      ),
    );
  /** Swap a symbol with its neighbor inside `list`; null when it can't move further. */
  const swapped = <T extends { symbol: string }>(list: T[], symbol: string, dir: -1 | 1): T[] | null => {
    const i = list.findIndex((s) => s.symbol === symbol);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return null;
    const next = list.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    return next;
  };
  const moveSymbol = (gi: number, symbol: string, dir: -1 | 1) => {
    const next = swapped(liveGroups[gi]!.symbols, symbol, dir);
    if (next) putGroups.mutate(liveGroups.map((g, i) => (i === gi ? { ...g, symbols: next } : g)));
  };
  const addGroup = () => {
    const name = newGroup.trim();
    if (!name || liveGroups.some((g) => g.name === name)) return;
    setNewGroup("");
    putGroups.mutate([...liveGroups, { name, symbols: [] }]);
  };
  // Deleting a whole list of tickers by mis-click would be painful — only an EMPTY group is removable.
  const removeGroup = (gi: number) => {
    if (liveGroups[gi]!.symbols.length > 0) return;
    putGroups.mutate(liveGroups.filter((_, i) => i !== gi));
  };
  const moveGroup = (gi: number, dir: -1 | 1) => {
    const j = gi + dir;
    if (j < 0 || j >= liveGroups.length) return;
    const next = liveGroups.slice();
    [next[gi], next[j]] = [next[j]!, next[gi]!];
    putGroups.mutate(next);
  };

  const snapshotGroups: HeatmapGroupRows[] | null = day.data?.snapshot?.groups ?? null;

  return (
    <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.7fr)", alignItems: "start" }}>
      <div>
      <div className="card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label className="kpi-label">Market regime</label>
          <div style={{ display: "flex", gap: 4, marginTop: 3 }}>
            {REGIMES.map((r) => (
              <button
                key={r}
                type="button"
                className={`btn${regime === r ? " btn-primary" : ""}`}
                style={{ padding: "3px 10px", fontSize: 12 }}
                onClick={() => setRegime(regime === r ? null : r)}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="kpi-label">Market view</label>
          <textarea className="input" style={{ width: "100%", minHeight: 120, marginTop: 3, resize: "vertical" }}
            value={marketRead} onChange={(e) => setMarketRead(e.target.value)}
            placeholder="How do you read the market today? Trend, leaders, what would change your mind…" />
        </div>
        <div>
          <label className="kpi-label">Session notes</label>
          <textarea className="input" style={{ width: "100%", minHeight: 90, marginTop: 3, resize: "vertical" }}
            value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="Execution, emotions, what to do differently tomorrow…" />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button className="btn btn-primary" disabled={save.isPending} onClick={submit}>
            {save.isPending ? "Saving…" : "Save day"}
          </button>
          {save.isSuccess && !save.isPending && <span className="pos" style={{ fontSize: 12 }}>Saved ✓</span>}
          {save.isError && <span className="neg" style={{ fontSize: 12 }}>Save failed</span>}
          {isToday && (
            <span className="faint" style={{ fontSize: 11 }}>
              Saving also freezes today's sector tables for later review.
            </span>
          )}
        </div>
      </div>

      {/* The day's trading, right under the day's thinking — thesis vs action on one screen. Same
          columns + whole-row click as the weekly journal. */}
      <div className="section-title">Trades this day ({day.data?.trades.length ?? 0})</div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Closed</th>
              <th className="right" title="The trade's full realized P&L at close — a trade closed today may have run over prior days; open trades show —.">
                Realized P&L
              </th>
              <th className="right">R</th>
            </tr>
          </thead>
          <tbody>
            {(day.data?.trades ?? []).length === 0 && (
              <tr>
                <td colSpan={4} className="empty">
                  No trades opened or closed this day.
                </td>
              </tr>
            )}
            {(day.data?.trades ?? []).map((t) => (
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

      <div>
        {isToday ? (
          <>
            <div className="toolbar" style={{ marginBottom: 4, gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button className="btn" disabled={heatQ.isFetching} onClick={() => heatQ.refetch()}>
                {heatQ.isFetching ? "Refreshing…" : "Refresh"}
              </button>
              <button className={`btn${editing ? " btn-primary" : ""}`} onClick={() => { setEditing((e) => !e); setConfirmReset(false); }}>
                {editing ? "Done editing" : "Edit lists"}
              </button>
              {editing && (
                // Two-step reset: restores the built-in lists (industry labels, EW sector group,
                // default ordering) and discards custom groups/tickers — hence the confirm.
                <button
                  className={`btn${confirmReset ? " btn-primary" : ""}`}
                  disabled={resetGroups.isPending}
                  onClick={() => {
                    if (!confirmReset) setConfirmReset(true);
                    else {
                      setConfirmReset(false);
                      resetGroups.mutate();
                    }
                  }}
                >
                  {confirmReset ? "Really reset? (discards your lists)" : "Reset to defaults"}
                </button>
              )}
              {heatQ.data && (
                <span className="faint" style={{ fontSize: 12 }}>
                  as of {dateTime(heatQ.data.asOf)} · daily closes from the public candle source
                </span>
              )}
              {putGroups.isError && <span className="neg" style={{ fontSize: 12 }}>Save failed</span>}
            </div>
            {heatQ.isLoading && <div className="spinner">Loading market data…</div>}
            {heatQ.isError && <div className="empty card">Couldn't load market data — check your connection and retry.</div>}
            {(heatQ.data?.groups ?? []).map((g, gi, all) => (
              <div key={g.name}>
                <GroupTable
                  name={g.name}
                  rows={g.rows}
                  editing={editing}
                  onRemove={(s) => removeSymbol(gi, s)}
                  onAdd={(s, l) => addSymbol(gi, s, l)}
                  onLabel={(s, l) => setLabel(gi, s, l)}
                  onMove={(s, d) => moveSymbol(gi, s, d)}
                  extraHeader={
                    editing ? (
                      <span style={{ display: "inline-flex", gap: 2 }}>
                        <button className="btn btn-icon" title="Move group up" disabled={gi === 0}
                          style={{ padding: "0 6px", fontSize: 11 }} onClick={() => moveGroup(gi, -1)}>
                          ↑
                        </button>
                        <button className="btn btn-icon" title="Move group down" disabled={gi === all.length - 1}
                          style={{ padding: "0 6px", fontSize: 11 }} onClick={() => moveGroup(gi, 1)}>
                          ↓
                        </button>
                      </span>
                    ) : null
                  }
                />
                {editing && g.rows.length === 0 && (
                  <button className="btn" style={{ marginTop: 6, fontSize: 11 }} onClick={() => removeGroup(gi)}>
                    Remove empty group
                  </button>
                )}
              </div>
            ))}
            {editing && (
              <div style={{ display: "flex", gap: 6, marginTop: 16, alignItems: "center" }}>
                <input
                  className="input"
                  style={{ fontSize: 12, padding: "3px 8px", width: 180 }}
                  placeholder="new group name"
                  value={newGroup}
                  onChange={(e) => setNewGroup(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addGroup();
                  }}
                />
                <button className="btn" onClick={addGroup} disabled={!newGroup.trim()}>
                  + Add group
                </button>
              </div>
            )}
            {heatQ.data?.thematic &&
              (() => {
                const th = heatQ.data.thematic;
                // Display: the top N, RANKED by 5-day change. Edit mode: the whole universe in the
                // user's CONFIG order (related narratives adjacent) — reorder there with ▲▼; press
                // Done editing and the view snaps back to the ranking.
                const entries = th.universe ?? th.rows.map((r) => ({ symbol: r.symbol, label: r.label }));
                const bySym = new Map(th.rows.map((r) => [r.symbol, r]));
                const rows = editing
                  ? entries.map((e) => bySym.get(e.symbol)).filter((r): r is HeatmapRow => r !== undefined)
                  : th.rows.slice(0, th.topN);
                return (
                  <GroupTable
                    name={editing ? `Thematic universe (${th.universeSize} tracked)` : `Top ${th.topN} thematic`}
                    rows={rows}
                    editing={editing}
                    showRank={!editing}
                    metrics="full"
                    onRemove={(s) => putThematic.mutate(entries.filter((e) => e.symbol !== s))}
                    onAdd={(s, l) => {
                      if (!entries.some((e) => e.symbol === s)) putThematic.mutate([...entries, { symbol: s, label: l }]);
                    }}
                    onLabel={(s, l) =>
                      putThematic.mutate(entries.map((e) => (e.symbol === s ? { ...e, label: l || null } : e)))
                    }
                    onMove={(s, d) => {
                      const next = swapped(entries, s, d);
                      if (next) putThematic.mutate(next);
                    }}
                    extraHeader={
                      <span className="faint" style={{ fontSize: 11, fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                        {editing
                          ? "your order (group related themes) · display re-ranks by 5-day % on Done"
                          : `ranked by 5-day % change · re-sorts itself daily · tracking ${th.universeSize}`}
                      </span>
                    }
                  />
                );
              })()}
          </>
        ) : snapshotGroups ? (
          <>
            <div className="faint" style={{ fontSize: 12, marginBottom: 4 }}>
              Frozen snapshot · saved {day.data?.snapshotAt ? dateTime(day.data.snapshotAt) : "—"}
            </div>
            {snapshotGroups.map((g) => (
              <GroupTable key={g.name} name={g.name} rows={g.rows} editing={false} />
            ))}
            {day.data?.snapshot?.thematic && (
              <GroupTable
                name={`Top ${day.data.snapshot.thematic.topN} thematic`}
                rows={day.data.snapshot.thematic.rows.slice(0, day.data.snapshot.thematic.topN)}
                editing={false}
                showRank
                metrics="full"
              />
            )}
          </>
        ) : (
          <div className="empty card">
            No market snapshot was saved for this day. Open the Daily page on the day and press "Save
            day" to freeze that day's sector table.
          </div>
        )}
      </div>
    </div>
  );
}
