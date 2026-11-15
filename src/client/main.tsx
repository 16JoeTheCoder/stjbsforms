import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { StudentApp } from "./student/StudentApp";

const StaffApp = lazy(() => import("./staff/StaffApp"));

function isStaffPath() {
  const p = location.pathname;
  return p.startsWith("/admin") || p.startsWith("/review") || p.startsWith("/staff");
}

async function boot() {
  let staff = isStaffPath();
  if (!staff && location.pathname === "/") {
    // On the staff hostname, "/" belongs to the dashboard.
    try {
      const r = await fetch("/api/public/config", { credentials: "same-origin" });
      if (r.ok) staff = (await r.json()).surface === "staff";
    } catch {
      /* offline: default to the student form */
    }
  }
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <StrictMode>
      {staff ? (
        <Suspense fallback={<div className="p-8 text-muted">Loading dashboard…</div>}>
          <StaffApp />
        </Suspense>
      ) : (
        <StudentApp />
      )}
    </StrictMode>,
  );
}

void boot();
