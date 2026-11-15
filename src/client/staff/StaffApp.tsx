import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Redirect, Route, Switch, useLocation } from "wouter";
import { api, ApiFailure } from "../lib/api";
import type { Me } from "../../shared/types";
import { Spinner } from "../components/ui";
import { AdminShell } from "./AdminShell";
import { ReviewerApp } from "./ReviewerApp";

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, e) => !(e instanceof ApiFailure && e.status >= 400 && e.status < 500) && n < 2,
      refetchOnWindowFocus: true,
      staleTime: 5_000,
    },
  },
});

function Gate() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/api/me"), refetchInterval: 60_000 });
  const [loc] = useLocation();
  if (me.isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center gap-2 text-muted">
        <Spinner /> Checking your access…
      </div>
    );
  }
  if (me.isError) {
    const e = me.error as ApiFailure;
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4">
        <h1 className="text-2xl font-semibold">{e.status === 401 ? "Please sign in again" : "No access"}</h1>
        <p className="mt-2 text-ink-2">{e.message}</p>
        <div className="mt-6 flex gap-2">
          <button className="btn-primary" onClick={() => location.reload()}>
            Reload
          </button>
          <a className="btn-outline" href="/cdn-cgi/access/logout">
            Sign out
          </a>
        </div>
      </div>
    );
  }
  const user = me.data;
  if (user.role === "reviewer") {
    if (!loc.startsWith("/review")) return <Redirect to="/review" />;
    return <ReviewerApp me={user} />;
  }
  return (
    <Switch>
      <Route path="/review" nest>
        <ReviewerApp me={user} />
      </Route>
      <Route path="/admin" nest>
        <AdminShell me={user} />
      </Route>
      <Route>
        <Redirect to="/admin" />
      </Route>
    </Switch>
  );
}

export default function StaffApp() {
  return (
    <QueryClientProvider client={qc}>
      <Gate />
    </QueryClientProvider>
  );
}
