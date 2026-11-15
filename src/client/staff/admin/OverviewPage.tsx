import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { RefreshCw } from "lucide-react";
import clsx from "clsx";
import { api, fmtTime } from "../../lib/api";
import { Meter, PageHeader, Stat, StatusChip } from "../common";
import { Banner, Spinner } from "../../components/ui";

interface Overview {
  submissions: { total: number; active: number; voided: number; over_quota: number };
  notes: { total: number; pending: number; approved: number; trashed: number; unassigned: number; council: number };
  classes: {
    id: string;
    label: string;
    grade: string;
    expected_students: number;
    soft_quota: number;
    status: string;
    raw: number;
    active: number;
    voided: number;
  }[];
  coverage: { teachers: number; covered: number; notesNeeded: number; minimum: number };
  reviewers: { id: string; email: string; total: number; done: number }[];
  system: {
    open: boolean;
    submissionsOpen: boolean;
    opensAt: string | null;
    closesAt: string | null;
    lastSubmissionAt: string | null;
    environment: string;
    turnstile: boolean;
    accessSync: boolean;
    serverTime: string;
  };
}

export function OverviewPage() {
  const q = useQuery({ queryKey: ["overview"], queryFn: () => api<Overview>("/api/admin/overview"), refetchInterval: 15_000 });
  if (q.isPending) return <p className="flex items-center gap-2 text-muted"><Spinner /> Loading overview…</p>;
  if (q.isError) return <Banner tone="bad" title="Couldn't load the overview">{(q.error as Error).message}</Banner>;
  const d = q.data;
  const overQuota = d.classes.filter((c) => c.active > c.soft_quota);
  return (
    <div>
      <PageHeader
        title="Overview"
        lead={
          <>
            Submissions are{" "}
            <strong className={d.system.open ? "text-ok" : "text-warn"}>{d.system.open ? "open" : "closed"}</strong>
            {d.system.closesAt ? ` · closes ${fmtTime(d.system.closesAt)}` : ""}. Last response {fmtTime(d.system.lastSubmissionAt)}.
          </>
        }
        actions={
          <button className="btn-outline btn-sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
            <RefreshCw aria-hidden className={clsx("size-4", q.isFetching && "animate-spin")} /> Refresh
          </button>
        }
      />
      {!d.system.turnstile && d.system.environment === "production" ? (
        <Banner tone="bad" className="mb-6" title="Turnstile isn't configured">Students can't submit until TURNSTILE_SECRET_KEY and TURNSTILE_SITE_KEY are set.</Banner>
      ) : null}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Stat label="Submissions" value={d.submissions.active} sub={`${d.submissions.voided} voided · ${d.submissions.total} received`} />
        <Stat label="Award ballots" value={d.submissions.active} sub="6 votes each" />
        <Stat label="Notes" value={d.notes.total} sub={`${d.notes.council} council-written`} />
        <Stat label="Pending review" value={d.notes.pending} sub={`${d.notes.unassigned} unassigned`} tone={d.notes.unassigned ? "warn" : undefined} />
        <Stat label="Approved" value={d.notes.approved} tone="ok" />
        <Stat label="In Trash" value={d.notes.trashed} />
      </section>

      <div className="mt-8 grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <section className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <h2 className="font-semibold">Classes</h2>
            <p className="text-sm text-muted">
              {d.classes.filter((c) => c.status === "active").length} active · {overQuota.length} over quota
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[12px] text-muted">
                <tr className="border-b border-line">
                  <th className="px-5 py-2 font-medium">Class</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Active</th>
                  <th className="px-3 py-2 text-right font-medium">Expected</th>
                  <th className="px-3 py-2 text-right font-medium">Quota</th>
                  <th className="px-5 py-2 font-medium">Voided</th>
                </tr>
              </thead>
              <tbody>
                {d.classes.map((c) => {
                  const over = c.active > c.soft_quota;
                  return (
                    <tr key={c.id} className="border-b border-line last:border-0">
                      <td className="px-5 py-2">
                        <Link className="font-medium hover:underline" href={`/submissions?classId=${c.id}`}>
                          {c.label}
                        </Link>
                        <span className="ml-2 text-muted">{c.grade}</span>
                      </td>
                      <td className="px-3 py-2"><StatusChip status={c.status} /></td>
                      <td className={clsx("px-3 py-2 text-right tabular", over && "font-semibold text-bad")}>{c.active}</td>
                      <td className="px-3 py-2 text-right tabular text-ink-2">{c.expected_students}</td>
                      <td className="px-3 py-2 text-right tabular text-ink-2">{c.soft_quota}</td>
                      <td className="px-5 py-2 tabular text-ink-2">{c.voided || ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {overQuota.length ? (
            <p className="border-t border-line px-5 py-3 text-sm text-bad">
              {overQuota.map((c) => `${c.label} — ${c.active} submissions / ${c.soft_quota} recommended maximum`).join(" · ")}
            </p>
          ) : null}
        </section>

        <div className="space-y-6">
          <section className="card p-5">
            <div className="flex items-baseline justify-between">
              <h2 className="font-semibold">Teacher coverage</h2>
              <Link href="/teachers" className="text-sm font-medium underline">Details</Link>
            </div>
            <p className="mt-2 text-sm text-ink-2">
              {d.coverage.covered} of {d.coverage.teachers} teachers have at least {d.coverage.minimum} approved notes.
              {d.coverage.notesNeeded ? ` ${d.coverage.notesNeeded} more notes needed in total.` : " Everyone is covered."}
            </p>
            <div className="mt-3"><Meter value={d.coverage.covered} max={d.coverage.teachers} label="Teachers covered" /></div>
          </section>
          <section className="card p-5">
            <div className="flex items-baseline justify-between">
              <h2 className="font-semibold">Reviewer progress</h2>
              <Link href="/assignments" className="text-sm font-medium underline">Manage</Link>
            </div>
            {d.reviewers.length === 0 ? (
              <p className="mt-2 text-sm text-ink-2">No notes assigned yet.</p>
            ) : (
              <ul className="mt-3 space-y-2.5">
                {d.reviewers.map((r) => (
                  <li key={r.id}>
                    <div className="flex justify-between text-sm">
                      <span className="truncate">{r.email}</span>
                      <span className="tabular text-muted">{r.done}/{r.total}</span>
                    </div>
                    <Meter value={r.done} max={r.total} label={`${r.email} progress`} />
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="card p-5 text-sm">
            <h2 className="font-semibold">System</h2>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-ink-2">
              <dt>Environment</dt><dd className="text-ink">{d.system.environment}</dd>
              <dt>Turnstile</dt><dd className="text-ink">{d.system.turnstile ? "configured" : "not configured"}</dd>
              <dt>Access group sync</dt><dd className="text-ink">{d.system.accessSync ? "configured" : "off (D1 allowlist only)"}</dd>
              <dt>Server time</dt><dd className="text-ink">{fmtTime(d.system.serverTime)}</dd>
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
