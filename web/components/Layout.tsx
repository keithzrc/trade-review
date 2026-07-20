import { Link, useLocation } from "wouter";
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSyncStatus, useStartSync, useSyncToasts, useTheme, useQuit, type ThemeMode } from "../lib/hooks";
import { dateTime } from "../lib/format";
import { ToastHost } from "./Toast";
import { UpdateBanner } from "./UpdateBanner";

const NAV = [
  { href: "/", label: "Dashboard", icon: "M3 12h4l2-7 4 14 2-7h4" },
  { href: "/daily", label: "Daily market", icon: "M4 5h12v12H4zM4 8h12M7 3v3M13 3v3" },
  { href: "/trades", label: "Trades", icon: "M3 5h14M3 10h14M3 15h9" },
  { href: "/positions", label: "Positions", icon: "M3 15l4-4 3 3 6-7" },
  { href: "/journal", label: "Weekly journal", icon: "M5 3h8l3 3v11H5zM12 3v4h4" },
  { href: "/settings", label: "Settings", icon: "M8 3h4l.5 2.5 2-1 2 3.5-2 1.5 2 1.5-2 3.5-2-1L12 17H8l-.5-2.5-2 1-2-3.5 2-1.5-2-1.5 2-3.5 2 1z" },
];

function Icon({ d }: { d: string }) {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

function SyncIcon() {
  // Circular-arrow refresh glyph; CSS spins it while a sync is running.
  return (
    <svg className="sync-ico" width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M16.5 5.5a7 7 0 1 0 1.2 5" />
      <path d="M17 3v4h-4" />
    </svg>
  );
}

function SyncControl() {
  const status = useSyncStatus();
  const start = useStartSync();
  const { toasts, dismiss } = useSyncToasts(status.data);
  const running = status.data?.running ?? false;
  const err = status.data?.lastError;
  const last = status.data?.finishedAt;
  const dotClass = running ? "run" : err ? "err" : "ok";
  const title = running
    ? "Sync in progress…"
    : err
      ? `Last sync failed: ${err}`
      : last
        ? `Last synced ${dateTime(last)}`
        : "Not synced yet";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span className={`status-dot ${dotClass}`} role="img" title={title} aria-label={title} />
      <button
        className={`btn sync-btn${running ? " is-running" : ""}`}
        disabled={running}
        onClick={() => start.mutate()}
        title={title}
      >
        <SyncIcon />
        {running ? "Syncing…" : "Sync now"}
      </button>
      <ToastHost toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function PowerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 3v7" />
      <path d="M6 5.5a6 6 0 1 0 8 0" />
    </svg>
  );
}

/** Quit button → graceful backend shutdown. A hidden/windowless app has no console to close, so this
 * is the intended way out. On success the backend stops within ~150ms, so we replace the screen with
 * a "closed" notice rather than leave a tab making failing requests. */
function QuitControl() {
  const quit = useQuit();
  const [closed, setClosed] = useState(false);
  const onQuit = () => {
    if (!window.confirm("Quit Trade Review? The local app stops — the page and syncing won't work until you start it again.")) return;
    quit.mutate(undefined, { onSuccess: () => setClosed(true) });
  };
  return (
    <>
      <button
        className="btn btn-icon"
        title="Quit Trade Review (stops the local app)"
        aria-label="Quit Trade Review"
        onClick={onQuit}
        disabled={quit.isPending || closed}
      >
        <PowerIcon />
      </button>
      {closed &&
        createPortal(
          <div className="shutdown-overlay" role="alertdialog" aria-label="Trade Review has shut down">
            <div className="shutdown-card">
              <PowerIcon />
              <strong>Trade Review has shut down</strong>
              <p>You can close this tab. To use it again, start Trade Review from your desktop.</p>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function ThemeToggle() {
  const { mode, setMode } = useTheme();
  const order: ThemeMode[] = ["system", "light", "dark"];
  const next = order[(order.indexOf(mode) + 1) % order.length]!;
  const glyph = mode === "dark" ? "☾" : mode === "light" ? "☀" : "◐";
  return (
    <button className="btn btn-icon" title={`Theme: ${mode} (click for ${next})`} onClick={() => setMode(next)}>
      <span style={{ fontSize: 14, lineHeight: 1 }}>{glyph}</span>
    </button>
  );
}

export function Layout({ title, children }: { title: string; children: ReactNode }) {
  const [location] = useLocation();
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          Trade Review
        </div>
        {NAV.map((n) => {
          const active = n.href === "/" ? location === "/" : location.startsWith(n.href);
          return (
            <Link key={n.href} href={n.href} className={`nav-item${active ? " active" : ""}`}>
              <Icon d={n.icon} />
              {n.label}
            </Link>
          );
        })}
        <div className="nav-spacer" />
      </aside>
      <div className="main">
        <header className="topbar">
          <h1>{title}</h1>
          <div className="topbar-spacer" />
          <SyncControl />
          <ThemeToggle />
          <QuitControl />
        </header>
        <div className="content">
          <UpdateBanner />
          {children}
        </div>
      </div>
    </div>
  );
}
