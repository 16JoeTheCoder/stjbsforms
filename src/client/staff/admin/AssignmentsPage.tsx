import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Shuffle, Scale } from "lucide-react";
import { api } from "../../lib/api";
import { Empty, Meter, PageHeader, post, useAction } from "../common";
import { Banner, ConfirmDialog, Spinner } from "../../components/ui";

interface Row {
  id: string;
  email: string;
  role: string;
  active: number;
  total: number;
  pending: number;
  approved: number;
  trashed: number;
}

export function AssignmentsPage() {
  const q = useQuery({
    queryKey: ["assignments"],
    queryFn: () => api<{ reviewers: Row[]; unassignedPending: number }>("/api/admin/assignments"),
    refetchInterval: 15_000,
  });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<null | "distribute" | "rebalance" | { release: Row }>(null);
  const inv = [["assignments"], ["notes"], ["overview"], ["users"]];
  const distribute = useAction((ids: string[]) => post<{ assigned: number }>("/api/admin/assignments/distribute", { reviewerIds: ids }), {
    invalidate: inv,
    success: (r) => `${r.assigned} notes assigned`,
  });
  const rebalance = useAction((ids: string[]) => post<{ moved: number }>("/api/admin/assignments/rebalance", { reviewerIds: ids }), {
    invalidate: inv,
    success: (r) => `${r.moved} pending notes moved`,
  });
  const release = useAction((id: string) => post<{ released: number }>(`/api/admin/assignments/release/${id}`), {
    invalidate: inv,
    success: (r) => `${r.released} pending notes returned to the queue`,
  });

  if (q.isPending) return <Spinner />;
  if (q.isError) return <Banner tone="bad">{(q.error as Error).message}</Banner>;
  const rows = q.data.reviewers;
  const active = rows.filter((r) => r.active);
  const busy = distribute.isPending || rebalance.isPending || release.isPending;
  const ids = [...picked];
  const perHead = ids.length ? Math.ceil(q.data.unassignedPending / ids.length) : 0;

  return (
    <div>
      <PageHeader
        title="Review workload"
        lead="Assignments are saved and stay put. New notes join the unassigned queue; approved and trashed notes are never reassigned."
      />
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-line bg-card px-4 py-3">
          <p className="text-[13px] text-muted">Unassigned pending</p>
          <p className="text-[24px] font-semibold tabular">{q.data.unassignedPending}</p>
        </div>
        <div className="rounded-xl border border-line bg-card px-4 py-3">
          <p className="text-[13px] text-muted">Assigned pending</p>
          <p className="text-[24px] font-semibold tabular">{rows.reduce((a, r) => a + r.pending, 0)}</p>
        </div>
        <div className="rounded-xl border border-line bg-card px-4 py-3">
          <p className="text-[13px] text-muted">Reviewed</p>
          <p className="text-[24px] font-semibold tabular">{rows.reduce((a, r) => a + r.approved + r.trashed, 0)}</p>
        </div>
      </div>

      {active.length === 0 ? (
        <Empty title="No reviewers yet">
          Invite reviewers on the <Link href="/users" className="underline">People</Link> page first.
        </Empty>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button className="btn-primary btn-sm" disabled={!ids.length || !q.data.unassignedPending || busy} onClick={() => setConfirm("distribute")}>
              <Shuffle aria-hidden className="size-4" /> Distribute evenly
            </button>
            <button className="btn-outline btn-sm" disabled={ids.length < 2 || busy} onClick={() => setConfirm("rebalance")}>
              <Scale aria-hidden className="size-4" /> Rebalance pending
            </button>
            <button className="btn-ghost btn-sm" onClick={() => setPicked(new Set(active.map((r) => r.id)))}>
              Select all active
            </button>
            {ids.length ? (
              <span className="text-sm text-muted">
                {ids.length} selected{q.data.unassignedPending ? ` · about ${perHead} new notes each` : ""}
              </span>
            ) : (
              <span className="text-sm text-muted">Select reviewers to distribute to.</span>
            )}
          </div>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[12px] text-muted">
                <tr className="border-b border-line">
                  <th className="w-10 px-4 py-2" />
                  <th className="px-2 py-2 font-medium">Reviewer</th>
                  <th className="px-3 py-2 text-right font-medium">Assigned</th>
                  <th className="px-3 py-2 text-right font-medium">Pending</th>
                  <th className="px-3 py-2 text-right font-medium">Approved</th>
                  <th className="px-3 py-2 text-right font-medium">Trash</th>
                  <th className="w-48 px-3 py-2 font-medium">Progress</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2.5">
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--color-ink)]"
                        aria-label={`Select ${r.email}`}
                        disabled={!r.active}
                        checked={picked.has(r.id)}
                        onChange={(e) =>
                          setPicked((s) => {
                            const n = new Set(s);
                            if (e.target.checked) n.add(r.id);
                            else n.delete(r.id);
                            return n;
                          })
                        }
                      />
                    </td>
                    <td className="px-2 py-2.5">
                      <Link className="font-medium hover:underline" href={`/notes?reviewerId=${r.id}`}>
                        {r.email}
                      </Link>
                      <span className="ml-2 text-xs text-muted">
                        {r.role}
                        {r.active ? "" : " · disabled"}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular">{r.total}</td>
                    <td className="px-3 py-2.5 text-right tabular">{r.pending}</td>
                    <td className="px-3 py-2.5 text-right tabular">{r.approved}</td>
                    <td className="px-3 py-2.5 text-right tabular">{r.trashed}</td>
                    <td className="px-3 py-2.5">
                      <Meter value={r.total - r.pending} max={r.total} label={`${r.email} progress`} />
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {r.pending ? (
                        <button className="btn-ghost btn-sm" onClick={() => setConfirm({ release: r })} disabled={busy}>
                          Release pending
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-sm text-ink-2">
            To hand specific notes to someone, select them on the <Link className="underline" href="/notes?status=pending">Notes</Link> board and use “Assign to”.
          </p>
        </>
      )}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(v) => !v && setConfirm(null)}
        title={
          confirm === "distribute"
            ? "Distribute unassigned notes?"
            : confirm === "rebalance"
              ? "Rebalance pending notes?"
              : "Return this reviewer's pending notes?"
        }
        description={
          confirm === "distribute"
            ? `${q.data.unassignedPending} unassigned pending notes go to the ${ids.length} selected reviewers, topping up whoever has the fewest pending first.`
            : confirm === "rebalance"
              ? "Pending notes among the selected reviewers are evened out. Reviewers keep their oldest notes up to the target; only the excess moves."
              : confirm && typeof confirm === "object"
                ? `${confirm.release.pending} pending notes from ${confirm.release.email} go back to the unassigned queue. Their reviewed notes stay with them.`
                : ""
        }
        confirmLabel="Continue"
        busy={busy}
        onConfirm={() => {
          if (confirm === "distribute") distribute.mutate(ids);
          else if (confirm === "rebalance") rebalance.mutate(ids);
          else if (confirm) release.mutate(confirm.release.id);
          setConfirm(null);
        }}
      />
    </div>
  );
}
