import type { Flag } from "../lib/api";
import { FLAG_DEFS, flagDef, FLAG_CATEGORY_ORDER, FLAG_CATEGORY_LABEL } from "../../src/domain/flag-defs";
import { FlagChips } from "./FlagChips";
import { usePutFlags } from "../lib/hooks";

/** The trade-detail Flags card, editable: × on a chip dismisses a computed flag (or deletes a manual
 * one), the picker adds any registry flag the engine missed, and dismissed flags stay visible as
 * struck-through chips with a restore — so a correction is always reviewable and reversible, never a
 * silent hole. Server-side the overrides live apart from computed flags, so syncs can't undo them. */
export function FlagEditor({
  tradeId,
  flags,
  overrides,
}: {
  tradeId: string;
  flags: Flag[]; // merged set from the server (computed minus dismissed, plus manual)
  overrides: { added: string[]; dismissed: string[] };
}) {
  const save = usePutFlags(tradeId);
  const shown = new Set(flags.map((f) => f.ruleId));

  const removeFlag = (ruleId: string) => {
    if (overrides.added.includes(ruleId)) {
      // manual flag → just drop the 'add' override
      save.mutate({ added: overrides.added.filter((x) => x !== ruleId), dismissed: overrides.dismissed });
    } else {
      // computed flag → record a dismissal
      save.mutate({ added: overrides.added, dismissed: [...overrides.dismissed, ruleId] });
    }
  };
  const addFlag = (ruleId: string) => {
    if (!ruleId || shown.has(ruleId)) return;
    if (overrides.dismissed.includes(ruleId)) {
      // re-adding a dismissed computed flag = restoring it
      save.mutate({ added: overrides.added, dismissed: overrides.dismissed.filter((x) => x !== ruleId) });
    } else {
      save.mutate({ added: [...overrides.added, ruleId], dismissed: overrides.dismissed });
    }
  };

  // Anything in the registry that isn't currently showing is addable (a dismissed one shows in its
  // own restore row instead, so leave it out of the picker to avoid two paths to the same action).
  const addable = Object.values(FLAG_DEFS).filter(
    (d) => !shown.has(d.id) && !overrides.dismissed.includes(d.id),
  );

  return (
    <div className="card" style={{ padding: 12 }}>
      {flags.length === 0 ? (
        <div style={{ marginBottom: 10 }}>
          <span className="muted">No mistake flags — clean mechanics.</span>
        </div>
      ) : (
        FLAG_CATEGORY_ORDER.map((cat) => {
          const inCat = flags.filter((f) => flagDef(f.ruleId).category === cat);
          if (inCat.length === 0) return null;
          return (
            <div key={cat} style={{ marginBottom: 12 }}>
              <div
                className="muted"
                style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 5 }}
              >
                {FLAG_CATEGORY_LABEL[cat]}
              </div>
              <FlagChips flags={inCat} onRemove={removeFlag} />
              <ul className="muted" style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.7 }}>
                {inCat.map((f) => (
                  <li key={f.ruleId}>
                    {f.reason}
                    {overrides.added.includes(f.ruleId) && <span className="faint"> · manual</span>}
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}

      {overrides.dismissed.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div
            className="muted"
            style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 5 }}
          >
            Dismissed
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
            {overrides.dismissed.map((id) => (
              <span key={id} className="flag flag-info" style={{ opacity: 0.55, textDecoration: "line-through" }}>
                {flagDef(id).title}
                <button
                  type="button"
                  aria-label={`restore ${flagDef(id).title}`}
                  title="Restore this flag"
                  onClick={() => addFlag(id)}
                  style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: "0 0 0 4px", fontSize: 11, lineHeight: 1, textDecoration: "none" }}
                >
                  ↩
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {/* value pinned to "" so the select re-arms after each pick */}
        <select
          className="input"
          style={{ fontSize: 12, padding: "3px 6px" }}
          value=""
          disabled={save.isPending || addable.length === 0}
          onChange={(e) => addFlag(e.target.value)}
          aria-label="Add a flag"
        >
          <option value="" disabled>
            {addable.length === 0 ? "All flags applied" : "+ Add flag…"}
          </option>
          {addable.map((d) => (
            <option key={d.id} value={d.id} title={d.summary}>
              {d.title}
            </option>
          ))}
        </select>
        {save.isPending && <span className="faint" style={{ fontSize: 12 }}>Saving…</span>}
        {save.isError && <span className="neg" style={{ fontSize: 12 }}>Save failed</span>}
      </div>
    </div>
  );
}
