import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import clsx from "clsx";
import { api, fmtTime } from "../../lib/api";
import type { AdminNote } from "../../../shared/types";
import { Empty, Flags, PageHeader, Select, StatusChip, post, useAction } from "../common";
import { Banner, Sheet, Spinner } from "../../components/ui";
import { useClasses } from "./data";

interface SubRow {
  id: string;
  class_label: string;
  grade_label: string;
  receipt_code: string;
  over_quota: number;
  class_position: number;
  status: "active" | "voided";
  void_reason: string | null;
  voided_by_email: string | null;
  created_at: string;
  flagged_notes: number;
  trashed_notes: number;
}

export function SubmissionsPage() {
  const search = useSearch();
  const [loc, navigate] = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const classId = params.get("classId") ?? "";
  const status = params.get("status") ?? "";
  const overQuota = params.get("overQuota") ?? "";
  const openId = params.get("open");
  const classes = useClasses();

  const set = (k: string, v: string) => {
    const p = new URLSearchParams(search);
    if (v) p.set(k, v);
    else p.delete(k);
    navigate(`${loc}?${p}`, { replace: true });
  };

  const qs = new URLSearchParams(Object.entries({ classId, status, overQuota }).filter(([, v]) => v)).toString();
  const q = useInfiniteQuery({
    queryKey: ["submissions", qs],
    queryFn: ({ pageParam }) =>
      api<{ items: SubRow[]; nextCursor: string | null }>(`/api/admin/submissions?${qs}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: "",
    getNextPageParam: (l) => l.nextCursor ?? undefined,
    refetchInterval: 20_000,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const cls = classes.data?.find((c) => c.id === classId);

  return (
    <div>
      <PageHeader
        title="Submissions"
        lead="Each submission is one anonymous ballot plus three notes. Voiding removes its votes and notes from results and printing, keeps the data, and can be undone."
      />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Select label="Class" value={classId} onChange={(e) => set("classId", e.target.value)}>
          <option value="">All classes</option>
          {classes.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
        <Select label="Status" value={status} onChange={(e) => set("status", e.target.value)}>
          <option value="">Any</option>
          <option value="active">Active</option>
          <option value="voided">Voided</option>
        </Select>
        <label className="flex h-10 items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--color-ink)]" checked={overQuota === "1"} onChange={(e) => set("overQuota", e.target.checked ? "1" : "")} />
          Over quota only
        </label>
      </div>
      {cls ? (
        <p className="mb-4 text-sm text-ink-2">
          <strong>{cls.label}</strong> — {cls.activeSubmissions} active / {cls.softQuota} recommended maximum · {cls.expectedStudents} students expected ·{" "}
          {cls.voidedSubmissions} voided · {cls.rawSubmissions} received in total. Counts are anonymous and can't show which students took part.
        </p>
      ) : null}
      {q.isPending ? (
        <Spinner />
      ) : items.length === 0 ? (
        <Empty title="No submissions match">Responses appear here as soon as students submit.</Empty>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-[12px] text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-medium">Received</th>
                <th className="px-3 py-2 font-medium">Class</th>
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Signals</th>
                <th className="px-4 py-2 font-medium">Receipt</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr
                  key={s.id}
                  className={clsx("cursor-pointer border-b border-line last:border-0 hover:bg-paper", s.status === "voided" && "text-muted")}
                  onClick={() => set("open", s.id)}
                >
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <button className="font-medium hover:underline" onClick={() => set("open", s.id)}>
                      {fmtTime(s.created_at)}
                    </button>
                  </td>
                  <td className="px-3 py-2.5">
                    {s.class_label} <span className="text-muted">{s.grade_label}</span>
                  </td>
                  <td className="px-3 py-2.5 tabular">{s.class_position}</td>
                  <td className="px-3 py-2.5">
                    <StatusChip status={s.status} />
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="flex flex-wrap gap-1">
                      {s.over_quota ? <span className="chip bg-warn-soft text-warn">Over quota</span> : null}
                      {s.flagged_notes ? <span className="chip bg-warn-soft text-warn">{s.flagged_notes} flagged</span> : null}
                      {s.trashed_notes ? <span className="chip bg-bad-soft text-bad">{s.trashed_notes} trashed</span> : null}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 tabular text-ink-2">{s.receipt_code}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.hasNextPage ? (
        <div className="mt-4 flex justify-center">
          <button className="btn-outline" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            Load more
          </button>
        </div>
      ) : null}
      <SubmissionDetail id={openId} onClose={() => set("open", "")} />
    </div>
  );
}

function SubmissionDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["submission", id],
    queryFn: () =>
      api<{
        submission: Record<string, string | number | null>;
        votes: { awardId: string; awardName: string; teacherName: string }[];
        notes: AdminNote[];
      }>(`/api/admin/submissions/${id}`),
    enabled: Boolean(id),
  });
  const [reason, setReason] = useState("");
  const inv = [["submission", id ?? ""], ["submissions"], ["notes"], ["overview"], ["awards"], ["teachers"], ["classes"]];
  const voidIt = useAction(() => post(`/api/admin/submissions/${id}/void`, { reason }), {
    invalidate: inv,
    success: "Submission voided",
    onSuccess: () => setReason(""),
  });
  const restore = useAction(() => post(`/api/admin/submissions/${id}/restore`), { invalidate: inv, success: "Submission restored" });
  const s = q.data?.submission;
  return (
    <Sheet open={Boolean(id)} onOpenChange={(v) => !v && onClose()} title="Submission" width="max-w-2xl">
      {q.isPending ? <Spinner /> : null}
      {s ? (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <StatusChip status={String(s.status)} />
            <span>
              {String(s.class_label)} · {String(s.grade_label)}
            </span>
            <span className="text-muted">· #{String(s.class_position)} in class · {fmtTime(String(s.created_at))}</span>
            {s.over_quota ? <span className="chip bg-warn-soft text-warn">Over quota</span> : null}
          </div>
          {s.status === "voided" ? (
            <Banner tone="warn" title="Voided" action={<button className="btn-outline btn-sm" disabled={restore.isPending} onClick={() => restore.mutate(undefined)}>Restore submission</button>}>
              {String(s.void_reason)} — by {String(s.voided_by_email ?? "unknown")}, {fmtTime(String(s.voided_at))}. Restoring brings back its votes and notes with their current moderation states.
            </Banner>
          ) : (
            <div className="rounded-xl border border-line p-4">
              <label className="label" htmlFor="void-reason">Void this whole submission</label>
              <p className="hint mt-0.5">Use for spam. Its 6 votes and 3 notes stop counting. Nothing is deleted.</p>
              <div className="mt-2 flex gap-2">
                <input id="void-reason" className="field h-10 text-sm" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
                <button className="btn-danger btn-sm h-10 shrink-0" disabled={reason.trim().length < 3 || voidIt.isPending} onClick={() => voidIt.mutate(undefined)}>
                  Void
                </button>
              </div>
            </div>
          )}
          <div>
            <h3 className="mb-2 text-sm font-semibold">Award votes</h3>
            <dl className="space-y-1.5 text-sm">
              {q.data!.votes.map((v) => (
                <div key={v.awardId} className="grid grid-cols-[1fr_auto] gap-4">
                  <dt className="text-ink-2">{v.awardName}</dt>
                  <dd className="font-medium">{v.teacherName}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold">Notes</h3>
            <div className="space-y-3">
              {q.data!.notes.map((n) => (
                <div key={n.id} className="rounded-xl bg-paper px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-semibold">{n.teacherName}</span>
                    <StatusChip status={n.status} />
                    <Flags flags={n.flags.filter((f) => f !== "over_quota" && f !== "submission_voided")} />
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap break-words font-serif leading-[1.55]">{n.body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}
