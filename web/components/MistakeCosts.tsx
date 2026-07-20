import type { TradeRow } from "../lib/api";
import { flagDef } from "../../src/domain/flag-defs";
import { money, pct, rMultiple, signClass } from "../lib/format";

/** What each mistake flag COSTS: per currency (never summed across), the losses booked on trades
 * carrying that flag and what share of ALL losses they represent. Uses the merged flag set, so the
 * user's own added/dismissed corrections shape the numbers. A trade can carry several flags, so the
 * shares deliberately overlap (they can sum past 100%) — each row answers "how much of my losing
 * was flagged with THIS mistake", not a partition. */
export function MistakeCosts({ rows }: { rows: TradeRow[] }) {
  const closed = rows.filter((t) => t.status === "closed" && t.coverageOk && t.realizedPnl !== null);
  const currencies = [...new Set(closed.map((t) => t.currency))].sort();

  const blocks = currencies
    .map((currency) => {
      const trades = closed.filter((t) => t.currency === currency);
      const totalLosses = trades.reduce((a, t) => a + Math.min(t.realizedPnl as number, 0), 0); // ≤ 0
      const flagIds = [...new Set(trades.flatMap((t) => t.flags.map((f) => f.ruleId)))];
      const stats = flagIds
        .map((id) => {
          const flagged = trades.filter((t) => t.flags.some((f) => f.ruleId === id));
          const lossSum = flagged.reduce((a, t) => a + Math.min(t.realizedPnl as number, 0), 0); // ≤ 0
          const rs = flagged.filter((t) => t.rMultiple !== null).map((t) => t.rMultiple as number);
          return {
            id,
            n: flagged.length,
            losers: flagged.filter((t) => (t.realizedPnl as number) < 0).length,
            lossSum,
            share: totalLosses < 0 ? lossSum / totalLosses : null, // fraction of ALL losses
            avgR: rs.length > 0 ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
          };
        })
        .filter((s) => s.n > 0)
        .sort((a, b) => a.lossSum - b.lossSum); // most negative (costliest) first
      return { currency, totalLosses, stats };
    })
    .filter((b) => b.stats.length > 0);

  if (blocks.length === 0) return <div className="empty card">No flagged closed trades yet.</div>;

  return (
    <div className="grid" style={{ gap: 14 }}>
      {blocks.map(({ currency, totalLosses, stats }) => (
        <div key={currency}>
          <div className="kpi-label" style={{ marginBottom: 4 }}>
            {currency} · total losses {money(totalLosses, currency)}
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Mistake</th>
                  <th className="right">Trades</th>
                  <th className="right">Losers</th>
                  <th className="right" title="Sum of the realized losses on trades carrying this flag (winners on those trades are NOT netted against it)">
                    Losses w/ flag
                  </th>
                  <th className="right" title="Those losses as a share of ALL this currency's losses. Flags overlap, so shares can sum past 100%">
                    % of all losses
                  </th>
                  <th className="right">Avg R</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <span className="flag flag-info" title={flagDef(s.id).summary}>
                        {flagDef(s.id).title}
                      </span>
                    </td>
                    <td className="right num">{s.n}</td>
                    <td className="right num">{s.losers}</td>
                    <td className={`right num ${signClass(s.lossSum)}`}>{s.lossSum !== 0 ? money(s.lossSum, currency) : "—"}</td>
                    <td className="right num">{s.share !== null && s.lossSum < 0 ? pct(s.share) : "—"}</td>
                    <td className={`right num ${signClass(s.avgR)}`}>{rMultiple(s.avgR)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <div className="faint" style={{ fontSize: 11 }}>
        Flags overlap (one trade can carry several), so the shares are not a partition — each row
        reads "of everything I lost, this much was on trades with this mistake". Add or dismiss flags
        on any trade's detail page and this table follows.
      </div>
    </div>
  );
}
