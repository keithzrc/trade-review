import { Route, Switch } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Layout } from "./components/Layout";
import { Dashboard } from "./screens/Dashboard";
import { Daily } from "./screens/Daily";
import { Trades } from "./screens/Trades";
import { TradeDetail } from "./screens/TradeDetail";
import { Positions } from "./screens/Positions";
import { WeeklyJournal } from "./screens/WeeklyJournal";
import { Settings } from "./screens/Settings";

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
});

export function App() {
  return (
    <QueryClientProvider client={qc}>
      <Switch>
        <Route path="/">
          <Layout title="Dashboard">
            <Dashboard />
          </Layout>
        </Route>
        <Route path="/daily">
          <Layout title="Daily market">
            <Daily />
          </Layout>
        </Route>
        <Route path="/trades">
          <Layout title="Trades">
            <Trades />
          </Layout>
        </Route>
        <Route path="/trades/:id">
          {(params) => (
            <Layout title="Trade detail">
              {/* key by id: remount on trade change so a pending debounced drawing-save (flushed on
                  unmount) can never PUT one trade's drawings into another's row. */}
              <TradeDetail key={params.id} id={decodeURIComponent(params.id)} />
            </Layout>
          )}
        </Route>
        <Route path="/positions">
          <Layout title="Open positions">
            <Positions />
          </Layout>
        </Route>
        <Route path="/journal">
          <Layout title="Weekly journal">
            <WeeklyJournal />
          </Layout>
        </Route>
        <Route path="/settings">
          <Layout title="Settings">
            <Settings />
          </Layout>
        </Route>
        <Route>
          <Layout title="Not found">
            <div className="empty card">Page not found.</div>
          </Layout>
        </Route>
      </Switch>
    </QueryClientProvider>
  );
}
