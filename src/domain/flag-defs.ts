// Single source of truth for what each mistake-flag MEANS. The rule engine emits per-trade
// `Flag{ruleId, severity, reason}` where `reason` is the dynamic instance ("Loss reached -1.5R");
// this registry supplies the STATIC definition — title, category, kind, and the tooltip copy —
// shared verbatim by the engine, the analytics grouping, and the web UI (imported directly).

export type FlagCategory = "stop-risk" | "sizing" | "entry" | "exit" | "timing" | "hygiene";

// How much a fired flag is a "mistake": a behaviour is fully in your control; an outcome may include
// bad luck (a gap through a correct stop); context is about the environment; hygiene is data quality.
export type FlagKind = "behavior" | "outcome" | "context" | "hygiene";

export interface FlagDef {
  id: string;
  title: string; // human label ("Loosened stop")
  category: FlagCategory;
  kind: FlagKind;
  defaultSeverity: "info" | "warn";
  summary: string; // one line: what the flag means, in general
  why: string; // one line: why it's worth reviewing
}

const DEFS: FlagDef[] = [
  {
    id: "added_to_loser",
    title: "Added to a loser",
    category: "sizing",
    kind: "behavior",
    defaultSeverity: "warn",
    summary: "You increased size while the position was underwater.",
    why: "Averaging down turns a small, planned loss into a large, unplanned one.",
  },
  {
    id: "cut_winner_early",
    title: "Small win (< 1R)",
    category: "exit",
    kind: "behavior",
    defaultSeverity: "info",
    // Named for the FACT (a sub-1R win), not "cut early" — the trigger has no post-exit check, so it
    // can't tell a perfect exit near the peak from one you bailed on while it kept running.
    summary: "You banked a winner for less than 1R.",
    why: "Small wins can't pay for full-size losses — the math needs your winners to run.",
  },
  {
    id: "oversized",
    title: "Oversized",
    category: "sizing",
    kind: "behavior",
    defaultSeverity: "warn",
    summary: "Risk on this trade was well above your recent average.",
    why: "Outsized bets make one trade's outcome dominate the account.",
  },
  {
    id: "round_tripped_gain",
    title: "Round-tripped a gain",
    category: "exit",
    kind: "behavior",
    defaultSeverity: "info",
    summary: "The trade reached your target then closed flat or red.",
    why: "Letting a real gain evaporate is an avoidable, protectable loss.",
  },
  {
    id: "overtrading_revenge",
    title: "Revenge trade",
    category: "timing",
    kind: "behavior",
    defaultSeverity: "warn",
    summary: "You opened this soon after closing a losing trade.",
    why: "Trading to win back a loss is emotional, not process-driven.",
  },
  {
    id: "excess_loss",
    title: "Excess loss",
    category: "stop-risk",
    kind: "outcome",
    defaultSeverity: "warn",
    summary: "The realized loss was materially deeper than your planned 1R.",
    why: "Gaps, slippage, or an unhonored stop broke the 'keep losses small' rule.",
  },
  {
    id: "no_stop",
    title: "No stop",
    category: "stop-risk",
    kind: "behavior",
    defaultSeverity: "warn",
    summary: "No loss-limiting stop was found for this trade.",
    why: "Without a stop bounding the downside, risk is unbounded and R can't be measured.",
  },
  {
    id: "unreliable_stop",
    title: "Unreliable stop",
    category: "stop-risk",
    // Not a trading mistake — a data-quality caveat: FUTU reports only a stop's final trigger, so a
    // trailed/moved stop can't be read as the initial risk. R stays visible but is excluded from the R
    // averages, and we prompt for a Manual stop rather than silently trusting a suspect basis.
    kind: "hygiene",
    defaultSeverity: "warn",
    summary: "Price ran past this stop while the trade stayed open, so it isn't your initial risk — set a Manual stop for an accurate R.",
    why: "A trailed or moved stop reports only its final trigger, so its R is suspect and left out of your R averages until you confirm the real stop.",
  },
  {
    id: "wide_stop",
    title: "Wide stop",
    category: "stop-risk",
    kind: "behavior",
    defaultSeverity: "warn",
    summary: "The stop sat further from entry than your max-loss cap.",
    why: "A wide stop signals an extended entry and inflates the risk per share.",
  },
  {
    id: "improper_pyramid",
    title: "Improper pyramid",
    category: "sizing",
    kind: "behavior",
    defaultSeverity: "info",
    summary: "You added a tranche bigger than your first entry, or well past your initial buy point.",
    why: "Sound pyramiding adds smaller and only near the entry — not bigger and higher.",
  },
  {
    id: "overtrading_freq",
    title: "Overtrading",
    category: "timing",
    kind: "behavior",
    defaultSeverity: "info",
    summary: "You opened more positions in a short window than usual.",
    why: "High frequency signals impatience — swing/position edges come from waiting.",
  },
];

export const FLAG_DEFS: Record<string, FlagDef> = Object.fromEntries(
  DEFS.map((d) => [d.id, d]),
);

/** Display order for grouping flags in the UI (most consequential first). */
export const FLAG_CATEGORY_ORDER: FlagCategory[] = [
  "stop-risk",
  "sizing",
  "entry",
  "exit",
  "timing",
  "hygiene",
];

export const FLAG_CATEGORY_LABEL: Record<FlagCategory, string> = {
  "stop-risk": "Stop & risk",
  sizing: "Sizing",
  entry: "Entry",
  exit: "Exit",
  timing: "Timing",
  hygiene: "Hygiene",
};

/** Turn a snake_case ruleId into a Title Case label — fallback for ids missing from the registry. */
function humanize(id: string): string {
  const s = id.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The definition for a ruleId, or a graceful humanized fallback so a new/unknown rule still renders. */
export function flagDef(id: string): FlagDef {
  return (
    FLAG_DEFS[id] ?? {
      id,
      title: humanize(id),
      category: "hygiene",
      kind: "behavior",
      defaultSeverity: "info",
      summary: "",
      why: "",
    }
  );
}
