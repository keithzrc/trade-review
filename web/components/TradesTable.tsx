import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import type { TradeRow } from "../lib/api";
import { money, price, rMultiple, signClass, date, holdTime, pct, pctSigned } from "../lib/format";
import { FlagChips } from "./FlagChips";

type SortKey = "symbol" | "openTime" | "closeTime" | "realizedPnl" | "returnPct" | "rMultiple" | "holdSeconds" | "sizePct";

const COLS: Array<{ key: SortKey | null; label: string; right?: boolean }> = [
  { key: "symbol", label: "Symbol" },
  { key: null, label: "Dir" },
  { key: "openTime", label: "Opened" },
  { key: "closeTime", label: "Closed" },
  { key: "holdSeconds", label: "Hold", right: true },
  { key: null, label: "Entry → Exit", right: true },
  { key: "sizePct", label: "Size %", right: true },
  { key: "realizedPnl", label: "Realized P&L", right: true },
  { key: "returnPct", label: "Return %", right: true },
  { key: "rMultiple", label: "R", right: true },
  { key: null, label: "Flags" },
];

function val(t: TradeRow, k: SortKey): number | string {
  const v = t[k];
  return v === null ? -Infinity : v;
}

export function TradesTable({ rows }: { rows: TradeRow[] }) {
  const [, navigate] = useLocation();
  const [sort, setSort] = useState<SortKey>("openTime");
  const [dir, setDir] = useState<1 | -1>(-1);

  const sorted = useMemo(() => {
    return rows.slice().sort((a, b) => {
      const av = val(a, sort);
      const bv = val(b, sort);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return a.id.localeCompare(b.id);
    });
  }, [rows, sort, dir]);

  const clickSort = (k: SortKey | null) => {
    if (!k) return;
    if (k === sort) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setSort(k);
      setDir(k === "symbol" ? 1 : -1);
    }
  };

  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            {COLS.map((c, i) => (
              <th
                key={i}
                className={`${c.right ? "right" : ""} ${c.key ? "sortable" : ""}`}
                onClick={() => clickSort(c.key)}
              >
                {c.label}
                {c.key === sort && <span className="sort-caret">{dir === 1 ? "▲" : "▼"}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr>
              <td colSpan={COLS.length} className="empty">
                No trades.
              </td>
            </tr>
          )}
          {sorted.map((t) => (
            <tr key={t.id} className="clickable" onClick={() => navigate(`/trades/${encodeURIComponent(t.id)}`)}>
              <td className="mono">
                {t.symbol}
                {!t.coverageOk && <span className="ccy-badge" title="Predates data coverage or a share-count change without matching fills (possible corporate action) — excluded from stats; risk/R not computed, P&L may be approximate">corp action?</span>}
              </td>
              <td className={t.direction === "LONG" ? "pos" : "neg"} style={{ fontSize: 11, fontWeight: 600 }}>
                {t.direction}
              </td>
              <td className="muted num">{date(t.openTime)}</td>
              <td className="muted num">{t.closeTime ? date(t.closeTime) : <span className="faint">open</span>}</td>
              <td className="right muted num">{holdTime(t.holdSeconds)}</td>
              <td className="right num">
                {price(t.avgEntry, t.currency)}
                <span className="faint"> → </span>
                {t.avgExit !== null ? price(t.avgExit, t.currency) : "—"}
              </td>
              <td className="right num" title={t.equityBasis === "latest" ? "≈ based on latest equity (no snapshot at open)" : undefined}>
                {t.sizePct !== null ? (
                  <>
                    {t.equityBasis === "latest" ? "≈" : ""}
                    {pct(t.sizePct)}
                  </>
                ) : (
                  <span className="faint">—</span>
                )}
              </td>
              <td className={`right num ${signClass(t.realizedPnl)}`}>
                {t.realizedPnl !== null ? money(t.realizedPnl, t.currency) : "—"}
              </td>
              <td className={`right num ${signClass(t.returnPct)}`} title="Realized P&L as a % of capital committed (avg entry × max size) — the trade's return; independent of account equity">
                {t.returnPct !== null ? pctSigned(t.returnPct) : <span className="faint">—</span>}
              </td>
              <td className={`right num ${signClass(t.rMultiple)}`}>{rMultiple(t.rMultiple)}</td>
              <td style={{ maxWidth: 260, whiteSpace: "normal" }}>
                <FlagChips flags={t.flags} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
