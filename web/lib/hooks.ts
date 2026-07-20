import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, type Drawing, type Res, type SyncStatus } from "./api";
import { syncToastContent } from "./sync-toast";
import type { ToastData } from "../components/Toast";

export const useStats = () => useQuery({ queryKey: ["stats"], queryFn: api.stats });
export const useTrades = () => useQuery({ queryKey: ["trades"], queryFn: api.trades });
export const useMeta = () => useQuery({ queryKey: ["meta"], queryFn: api.meta });
export const usePositions = () => useQuery({ queryKey: ["positions"], queryFn: api.positions });
export const useBreakdowns = (by: string) =>
  useQuery({ queryKey: ["breakdowns", by], queryFn: () => api.breakdowns(by), placeholderData: keepPreviousData });
export const useTradeDetail = (id: string) =>
  useQuery({ queryKey: ["trade", id], queryFn: () => api.trade(id), enabled: !!id });

export const useCandles = (id: string, res: Res = "1d") =>
  useQuery({
    queryKey: ["candles", id, res],
    queryFn: () => api.candles(id, res),
    enabled: !!id,
    placeholderData: keepPreviousData, // don't blank the chart while a resolution switch refetches
  });

export const useDrawings = (id: string) =>
  useQuery({ queryKey: ["drawings", id], queryFn: () => api.drawings(id), enabled: !!id });

/** Save a trade's chart drawings. Not derived data, so no cascade to trades/stats/breakdowns.
 * Write the saved set straight into the cache (setQueryData) rather than invalidating: a refetch
 * would land the server snapshot AFTER the user may have drawn more, and rehydrating from it could
 * drop that newer annotation. This also keeps the cache correct for a quick remount within staleTime. */
export function usePutDrawings(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (drawings: Drawing[]) => api.putDrawings(id, drawings),
    onSuccess: (data) => qc.setQueryData(["drawings", id], data),
  });
}

/** Save a trade's journal. A manual-stop/setup/tags change re-derives on the server, so invalidate
 * everything that depends on derived data (this trade + all list/stat/breakdown queries). */
export function usePutJournal(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.putJournal(id, body),
    onSuccess: (detail) => {
      qc.setQueryData(["trade", id], detail);
      // A manual-stop change re-derives risk/R/flags AND the open-trade stop that Positions shows,
      // plus per-week trade rows — invalidate all of them, not just the lists.
      for (const key of ["trades", "stats", "breakdowns", "meta", "positions", "week"]) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

/** Save the user's flag corrections (dismiss computed / add manual). Flags are annotations — they
 * don't feed risk/R/stats math — but they DO show on the trades list and the dashboard's flagged
 * section, so refresh those lists alongside writing the returned detail into the cache. */
export function usePutFlags(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { added: string[]; dismissed: string[] }) => api.putFlags(id, body),
    onSuccess: (detail) => {
      qc.setQueryData(["trade", id], detail);
      qc.invalidateQueries({ queryKey: ["trades"] });
    },
  });
}

// ---- Daily market heatmap + daily journal ----
// The server fans out to the candle source, so give it a real staleTime — a page revisit within a few
// minutes reuses the cached response instead of re-hitting Yahoo ~25 times. `enabled` lets the Daily
// page skip the live fetch entirely when it's showing a past day's frozen snapshot.
export const useHeatmap = (enabled = true) =>
  useQuery({ queryKey: ["heatmap"], queryFn: api.heatmap, staleTime: 5 * 60_000, enabled });

export function usePutHeatmapGroups() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (groups: Array<{ name: string; symbols: Array<{ symbol: string; label: string | null }> }>) =>
      api.putHeatmapGroups(groups),
    // The groups changed → the heatmap's composition changed; refetch it (new symbols need candles).
    onSuccess: () => qc.invalidateQueries({ queryKey: ["heatmap"] }),
  });
}

/** Edit the thematic ranking universe (the candidate list behind "Top 10 thematic"). */
export function usePutThematic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (symbols: Array<{ symbol: string; label: string | null }>) => api.putThematic(symbols),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["heatmap"] }),
  });
}

/** "Reset to defaults": drops the stored group config so the app's built-in lists (with industry
 * labels and the EW sector group) apply again. */
export function useResetHeatmapGroups() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.resetHeatmapGroups,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["heatmap"] }),
  });
}

export const useDay = (dayKey: string) =>
  useQuery({ queryKey: ["day", dayKey], queryFn: () => api.day(dayKey), enabled: !!dayKey });

export function usePutDay(dayKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.putDay(dayKey, body),
    onSuccess: (view) => qc.setQueryData(["day", dayKey], view),
  });
}

/** Poll sync status only while a sync is running; when it flips to done, invalidate everything so
 * the whole app refetches the freshly-synced data (one place, not a manual refetch cascade). */
export function useSyncStatus() {
  const qc = useQueryClient();
  const [wasRunning, setWasRunning] = useState(false);
  const q = useQuery({
    queryKey: ["syncStatus"],
    queryFn: api.syncStatus,
    refetchInterval: (query) => (query.state.data?.running ? 1200 : false),
  });
  useEffect(() => {
    const running = q.data?.running ?? false;
    if (wasRunning && !running) {
      // Sync just finished → refresh EVERY data-bearing query so a mounted detail/positions/weekly
      // page reflects re-synced data (["trades"] does not prefix-match ["trade", id]/["candles",…]).
      for (const key of ["stats", "trades", "trade", "candles", "positions", "meta", "breakdowns", "week"]) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    }
    setWasRunning(running);
  }, [q.data?.running, wasRunning, qc]);
  return q;
}

export const useWeek = (isoWeek: string) =>
  useQuery({ queryKey: ["week", isoWeek], queryFn: () => api.week(isoWeek), enabled: !!isoWeek });

export function usePutWeek(isoWeek: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.putWeek(isoWeek, body),
    onSuccess: (view) => qc.setQueryData(["week", isoWeek], view),
  });
}

export function useStartSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.startSync,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["syncStatus"] }),
  });
}

/** Ask the local app to shut down (the Quit button). The server 202s, then stops a beat later — so
 * the browser tab is expected to lose the backend right after this resolves; the caller shows a
 * "closed" state on success. */
export function useQuit() {
  return useMutation({ mutationFn: api.quit });
}

/** Notify-only update check. Slow cadence — a new release doesn't appear mid-session often, and the
 * unauthenticated GitHub API is rate-limited (60/hr). The server also caches successful checks for 6h.
 * A failed check (offline/rate-limited at startup) returns 200 with `error` set, so poll again in a
 * few minutes rather than sitting on the stale error for 6h — mirrors the server not caching failures. */
export const useUpdateCheck = () =>
  useQuery({
    queryKey: ["updateCheck"],
    // Wrap so TanStack's QueryFunctionContext isn't passed as `force` (which would bypass the cache
    // on every background poll and burn the 60/hr GitHub rate limit).
    queryFn: () => api.updateCheck(),
    staleTime: 6 * 60 * 60_000,
    refetchInterval: (query) => (query.state.data?.error ? 5 * 60_000 : 6 * 60 * 60_000),
    refetchOnWindowFocus: false,
    retry: false,
  });

/** On-demand "Check for updates" (Settings button): forces a fresh check past the 6h cache and writes
 * the result into the shared updateCheck cache, so the top-of-app banner reflects it immediately. */
export const useCheckForUpdatesNow = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.updateCheck(true),
    onSuccess: (data) => qc.setQueryData(["updateCheck"], data),
  });
};

export const useOpendSettings = () =>
  useQuery({ queryKey: ["opendSettings"], queryFn: api.opendSettings });

export function usePutOpendSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { key?: string; port?: number }) => api.putOpendSettings(body),
    onSuccess: (data) => qc.setQueryData(["opendSettings"], data),
  });
}

/** Surface a toast each time a sync COMPLETES (success or failure), keyed off `finishedAt` changing.
 * The first observed status just seeds the baseline, so a sync that finished before this mount (the
 * common page-load case) never pops a stale toast. */
export function useSyncToasts(status: SyncStatus | undefined) {
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const seenFinish = useRef<number | null | undefined>(undefined); // undefined = not yet baselined
  const nextId = useRef(1);
  useEffect(() => {
    if (!status) return;
    const fin = status.finishedAt;
    if (seenFinish.current === undefined) {
      seenFinish.current = fin; // baseline the first status we see; don't toast for it
      return;
    }
    if (fin !== null && fin !== seenFinish.current) {
      seenFinish.current = fin;
      const content = syncToastContent(status);
      if (content) setToasts((ts) => [...ts, { id: nextId.current++, ...content }]);
    }
  }, [status]);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  return { toasts, dismiss };
}

// ---- theme (shared external store) ----
export type ThemeMode = "light" | "dark" | "system";

// A single app-wide theme so the header toggle re-themes EVERY mounted component (esp. the canvas
// charts, which sample resolved CSS colors on `themeKey` change) — a per-component useState would
// only update the toggle's own instance.
let themeMode: ThemeMode = ((): ThemeMode => {
  const v = typeof localStorage !== "undefined" ? localStorage.getItem("theme") : null;
  return v === "light" || v === "dark" ? v : "system";
})();
const themeListeners = new Set<() => void>();

function applyTheme() {
  const root = document.documentElement;
  if (themeMode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", themeMode);
}
applyTheme();

/** Resolved-theme snapshot: changes on toggle AND on OS scheme change while in "system" — so charts
 * re-theme in both cases. The mode is the prefix before "|". */
function themeSnapshot(): string {
  const dark =
    themeMode === "dark" ||
    (themeMode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  return `${themeMode}|${dark ? "d" : "l"}`;
}
function subscribeTheme(cb: () => void): () => void {
  themeListeners.add(cb);
  return () => themeListeners.delete(cb);
}
function notifyTheme() {
  for (const l of themeListeners) l();
}
if (typeof window !== "undefined") {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", notifyTheme);
}

export function setThemeMode(m: ThemeMode): void {
  themeMode = m;
  if (typeof localStorage !== "undefined") localStorage.setItem("theme", m);
  applyTheme();
  notifyTheme();
}

/** Returns { mode, themeKey, setMode }. `mode` drives the toggle glyph; `themeKey` (resolved) is what
 * chart components watch to re-apply colors. */
export function useTheme(): { mode: ThemeMode; themeKey: string; setMode: (m: ThemeMode) => void } {
  const snap = useSyncExternalStore(subscribeTheme, themeSnapshot, themeSnapshot);
  return { mode: snap.split("|")[0] as ThemeMode, themeKey: snap, setMode: setThemeMode };
}
