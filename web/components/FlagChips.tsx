import type { Flag } from "../lib/api";
import { flagDef } from "../../src/domain/flag-defs";

/** One flag chip: registry title as the label, with a hover tooltip that explains what the flag
 * means (summary), what happened on this trade (reason), and why it matters (why). When `onRemove`
 * is provided (the trade-detail editor), each chip grows an × — read-only lists just omit it. */
export function FlagChips({ flags, onRemove }: { flags: Flag[]; onRemove?: (ruleId: string) => void }) {
  if (flags.length === 0) return <span className="faint">—</span>;
  return (
    <>
      {flags.map((f) => {
        const def = flagDef(f.ruleId);
        const tip = [def.summary, f.reason, def.why && `Why: ${def.why}`]
          .filter(Boolean)
          .join("\n\n");
        return (
          <span
            key={f.ruleId}
            className={`flag flag-${f.severity === "warn" ? "warn" : "info"}`}
            title={tip}
          >
            {def.title}
            {onRemove && (
              <button
                type="button"
                aria-label={`remove ${def.title}`}
                title="Remove this flag"
                onClick={() => onRemove(f.ruleId)}
                style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: "0 0 0 4px", fontSize: 12, lineHeight: 1 }}
              >
                ×
              </button>
            )}
          </span>
        );
      })}
    </>
  );
}
