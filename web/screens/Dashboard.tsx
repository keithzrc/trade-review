import { useStats, useTrades, useTheme } from "../lib/hooks";
import { Kpis } from "../components/Kpis";
import { EquityChart } from "../components/EquityChart";
import { BreakdownTable } from "../components/BreakdownTable";
import { MistakeCosts } from "../components/MistakeCosts";
import { TradesTable } from "../components/TradesTable";

export function Dashboard() {
  const stats = useStats();
  const trades = useTrades();
  const { themeKey } = useTheme();

  const byCurrency = stats.data?.byCurrency ?? [];
  const flagged = (trades.data ?? []).filter((t) => t.flags.length > 0);

  return (
    <div>
      {stats.isLoading ? (
        <div className="spinner">Loading…</div>
      ) : (
        <Kpis stats={byCurrency} />
      )}

      {byCurrency.some((c) => c.equityCurve.length > 1) && (
        <>
          <div className="section-title">Equity curve</div>
          {/* One-line key so the chart is self-explaining: what the line is, and what the color means
              (EquityChart tints the whole series by the LATEST cumulative value's sign). */}
          <div className="faint" style={{ fontSize: 11, margin: "-6px 0 8px" }}>
            Cumulative realized P&L across closed trades, one chart per currency — green while the
            running total is above zero, red while below.
          </div>
          <div className="grid" style={{ gridTemplateColumns: byCurrency.length > 1 ? "1fr 1fr" : "1fr" }}>
            {byCurrency
              .filter((c) => c.equityCurve.length > 1)
              .map((c) => (
                <div className="card" key={c.currency} style={{ padding: "10px 12px" }}>
                  <div className="kpi-label" style={{ marginBottom: 4 }}>
                    {c.currency}
                  </div>
                  <EquityChart
                    themeKey={themeKey}
                    points={c.equityCurve.map((p) => ({ time: p.time, value: p.cumPnl }))}
                  />
                </div>
              ))}
          </div>
        </>
      )}

      <div className="section-title">Find my edge</div>
      <BreakdownTable />

      <div className="section-title">Cost of mistakes</div>
      {trades.isLoading ? <div className="spinner">Loading…</div> : <MistakeCosts rows={trades.data ?? []} />}

      <div className="section-title">Flagged trades ({flagged.length})</div>
      {trades.isLoading ? (
        <div className="spinner">Loading…</div>
      ) : flagged.length === 0 ? (
        <div className="empty card">No flags — clean mechanics, or no trades yet.</div>
      ) : (
        <TradesTable rows={flagged} />
      )}
    </div>
  );
}
