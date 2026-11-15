import { useState } from "react";
import { Link, Route, Switch, useLocation } from "wouter";
import clsx from "clsx";
import {
  Award,
  ClipboardList,
  FileText,
  Gauge,
  GraduationCap,
  History,
  Inbox,
  LogOut,
  Menu,
  Printer,
  Settings,
  Trash2,
  Users,
  UserSquare2,
  X,
} from "lucide-react";
import type { Me } from "../../shared/types";
import { ToastProvider } from "./common";
import { OverviewPage } from "./admin/OverviewPage";
import { NotesBoard } from "./admin/NotesBoard";
import { AssignmentsPage } from "./admin/AssignmentsPage";
import { SubmissionsPage } from "./admin/SubmissionsPage";
import { ClassesPage } from "./admin/ClassesPage";
import { TeachersPage } from "./admin/TeachersPage";
import { AwardsPage } from "./admin/AwardsPage";
import { PrintPage } from "./admin/PrintPage";
import { UsersPage } from "./admin/UsersPage";
import { SettingsPage } from "./admin/SettingsPage";
import { AuditPage } from "./admin/AuditPage";

const NAV = [
  { href: "/", label: "Overview", icon: Gauge },
  { href: "/notes", label: "Notes", icon: Inbox },
  { href: "/trash", label: "Trash", icon: Trash2 },
  { href: "/assignments", label: "Review workload", icon: ClipboardList },
  { href: "/submissions", label: "Submissions", icon: FileText },
  { href: "/classes", label: "Classes", icon: GraduationCap },
  { href: "/teachers", label: "Teachers & coverage", icon: UserSquare2 },
  { href: "/awards", label: "Awards", icon: Award },
  { href: "/print", label: "Print & export", icon: Printer },
  { href: "/users", label: "People", icon: Users },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/audit", label: "Audit log", icon: History },
];

export function AdminShell({ me }: { me: Me }) {
  const [loc] = useLocation();
  const [open, setOpen] = useState(false);
  const nav = (
    <nav aria-label="Admin" className="flex flex-col gap-0.5">
      {NAV.map((n) => {
        const active = n.href === "/" ? loc === "/" : loc.startsWith(n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            onClick={() => setOpen(false)}
            aria-current={active ? "page" : undefined}
            className={clsx(
              "relative flex h-9 items-center gap-2.5 rounded-lg px-3 text-[14px] font-medium transition-colors duration-150",
              active ? "bg-card text-ink shadow-[0_1px_2px_rgb(13_14_16/0.06)]" : "text-ink-2 hover:bg-paper hover:text-ink",
            )}
          >
            {active ? <span aria-hidden className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-fire" /> : null}
            <n.icon aria-hidden className="size-4" />
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
  const footer = (
    <div className="border-t border-line pt-3 text-[13px]">
      <p className="truncate font-medium" title={me.email}>
        {me.email}
      </p>
      <p className="text-muted">Administrator{me.isOwner ? " · owner" : ""}</p>
      <div className="mt-2 flex flex-col items-start">
        <Link href="~/review" className="btn-ghost btn-sm -ml-3.5 whitespace-nowrap">
          My review queue
        </Link>
        <a href={me.logoutUrl} className="btn-ghost btn-sm -ml-3.5 whitespace-nowrap">
          <LogOut aria-hidden className="size-4" /> Sign out
        </a>
      </div>
    </div>
  );
  return (
    <ToastProvider>
      <div className="min-h-dvh lg:grid lg:grid-cols-[248px_1fr]">
        <aside className="sticky top-0 hidden h-dvh flex-col gap-4 border-r border-line bg-paper-2/60 px-3 py-5 lg:flex">
          <p className="px-3 text-[13px] font-semibold tracking-wide">
            STJB <span className="text-muted">· Thanks admin</span>
          </p>
          <div className="min-h-0 flex-1 overflow-y-auto">{nav}</div>
          {footer}
        </aside>
        <div className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-paper/95 px-4 py-3 backdrop-blur-sm lg:hidden">
          <p className="text-[13px] font-semibold tracking-wide">
            STJB <span className="text-muted">· Thanks admin</span>
          </p>
          <button className="btn-ghost btn-sm" onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open}>
            <Menu className="size-5" />
          </button>
        </div>
        {open ? (
          <div className="fixed inset-0 z-50 flex lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
            <div className="flex w-72 flex-col gap-4 bg-paper-2 px-3 py-5">
              <div className="flex items-center justify-between px-3">
                <p className="text-[13px] font-semibold">Menu</p>
                <button className="btn-ghost btn-sm" onClick={() => setOpen(false)} aria-label="Close menu">
                  <X className="size-5" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">{nav}</div>
              {footer}
            </div>
            <button className="flex-1 bg-ink/30" aria-label="Close menu" onClick={() => setOpen(false)} />
          </div>
        ) : null}
        <main className="min-w-0 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
          <Switch>
            <Route path="/" component={OverviewPage} />
            <Route path="/notes">{() => <NotesBoard key="notes" />}</Route>
            <Route path="/trash">{() => <NotesBoard key="trash" preset={{ status: "trashed" }} title="Trash" />}</Route>
            <Route path="/assignments" component={AssignmentsPage} />
            <Route path="/submissions" component={SubmissionsPage} />
            <Route path="/classes" component={ClassesPage} />
            <Route path="/teachers" component={TeachersPage} />
            <Route path="/awards" component={AwardsPage} />
            <Route path="/print" component={PrintPage} />
            <Route path="/users">{() => <UsersPage me={me} />}</Route>
            <Route path="/settings" component={SettingsPage} />
            <Route path="/audit" component={AuditPage} />
            <Route>
              <p>Page not found.</p>
            </Route>
          </Switch>
        </main>
      </div>
    </ToastProvider>
  );
}
