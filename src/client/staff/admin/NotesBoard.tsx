import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearch, useLocation } from "wouter";
import clsx from "clsx";
import { Check, LayoutGrid, List, Plus, RotateCcw, Search, Trash2, UserPlus } from "lucide-react";
import { api, ApiFailure, fmtTime } from "../../lib/api";
import type { AdminNote, Page } from "../../../shared/types";
import { Empty, Flags, PageHeader, Select, StatusChip, patch, post, useAction, useToast } from "../common";
import { Banner, ConfirmDialog, Sheet, Spinner } from "../../components/ui";
import { teacherName, useClasses, useTeachers, useUsers } from "./data";
import { TeacherPicker } from "../../components/TeacherPicker";
import { countChars, NOTE_MAX_CHARS, NOTE_MIN_CHARS } from "../../../shared/text";

const FILTER_KEYS = ["q", "status", "teacherId", "classId", "grade", "reviewerId", "source", "maxChars", "overQuota", "flagged", "submission", "order"] as const;
type Filters = Partial<Record<(typeof FILTER_KEYS)[number], string>>;

function useFilters(preset: Filters): [Filters, (f: Filters) => void] {
  const search = useSearch();
  const [loc, navigate] = useLocation();
  const f = useMemo(() => {
    const p = new URLSearchParams(search);
    const out: Filters = { ...preset };
    for (const k of FILTER_KEYS) {
      const v = p.get(k);
      if (v) out[k] = v;
    }
    return out;
  }, [search, preset]);
  const set = (next: Filters) => {
    const p = new URLSearchParams();
    for (const k of FILTER_KEYS) if (next[k] && next[k] !== preset[k]) p.set(k, next[k]!);
    navigate(`${loc}${p.toString() ? `?${p}` : ""}`, { replace: true });
  };
  return [f, set];
}

export function NotesBoard({ preset = {}, title = "Notes" }: { preset?: Filters; title?: string }) {
  const stablePreset = useMemo(() => preset, [JSON.stringify(preset)]); // eslint-disable-line react-hooks/exhaustive-deps
  const [filters, setFilters] = useFilters(stablePreset);
  const [qInput, setQInput] = useState(filters.q ?? "");
  const [mode, setMode] = useState<"grid" | "list">(() => (localStorage.getItem("stjb.notes.mode") as "grid" | "list") || "grid");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [bulk, setBulk] = useState<null | "approved" | "trashed" | "pending">(null);
  const [assignTo, setAssignTo] = useState("");
  const [councilOpen, setCouncilOpen] = useState(false);
  const teachers = useTeachers();
  const classes = useClasses();
  const users = useUsers();
  const qc = useQueryClient();
  const toast = useToast();

  useEffect(() => {
    const t = setTimeout(() => {
      if ((filters.q ?? "") !== qInput) setFilters({ ...filters, q: qInput || undefined });
    }, 300);
    return () => clearTimeout(t);
  }, [qInput]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    try {
      localStorage.setItem("stjb.notes.mode", mode);
    } catch {
      /* ignore */
    }
  }, [mode]);

  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]).toString();
  const notes = useInfiniteQuery({
    queryKey: ["notes", qs],
    queryFn: ({ pageParam }) => api<Page<AdminNote>>(`/api/admin/notes?${qs}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
  const items = notes.data?.pages.flatMap((p) => p.items) ?? [];
  const total = notes.data?.pages[0]?.total ?? 0;

  useEffect(() => setSelected(new Set()), [qs]);

  const bulkStatus = useAction((v: { ids: string[]; status: string }) => post<{ changed: number }>("/api/admin/notes/bulk-status", v), {
    invalidate: [["notes"], ["overview"], ["teachers"]],
    success: (r) => `${r.changed} note${r.changed === 1 ? "" : "s"} updated`,
    onSuccess: () => setSelected(new Set()),
  });
  const assign = useAction(
    (v: { noteIds: string[]; reviewerId: string | null }) => post<{ changed: number }>("/api/admin/assignments/assign", v),
    { invalidate: [["notes"], ["assignments"]], success: (r) => `${r.changed} pending note${r.changed === 1 ? "" : "s"} reassigned` },
  );

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const reviewers = users.data?.users.filter((u) => u.active) ?? [];
  const grades = [...new Set((classes.data ?? []).map((c) => c.grade))];

  return (
    <div>
      <PageHeader
        title={title}
        lead={
          title === "Trash"
            ? "Trashed notes stay in the database and can be restored at any time. They're excluded from printing and coverage."
            : "Every appreciation note. Filters are kept in the address bar, so you can return to the same view."
        }
        actions={
          title === "Notes" ? (
            <button className="btn-outline btn-sm" onClick={() => setCouncilOpen(true)}>
              <Plus aria-hidden className="size-4" /> Council-written note
            </button>
          ) : null
        }
      />

      <div className="card mb-4 p-3 sm:p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-[13px] font-medium text-ink-2">
            Search
            <span className="relative">
              <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <input
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="Words in the message or teacher name"
                className="h-10 w-full rounded-lg border border-line-strong bg-card pl-9 pr-3 text-sm focus:border-ink focus:outline-none"
              />
            </span>
          </label>
          {!stablePreset.status ? (
            <Select label="Status" value={filters.status ?? ""} onChange={(e) => setFilters({ ...filters, status: e.target.value || undefined })}>
              <option value="">Any</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="trashed">Trash</option>
            </Select>
          ) : null}
          <Select label="Teacher" value={filters.teacherId ?? ""} onChange={(e) => setFilters({ ...filters, teacherId: e.target.value || undefined })}>
            <option value="">All teachers</option>
            {teachers.data?.teachers.map((t) => (
              <option key={t.id} value={t.id}>
                {teacherName(t)}
              </option>
            ))}
          </Select>
          <Select label="Grade" value={filters.grade ?? ""} onChange={(e) => setFilters({ ...filters, grade: e.target.value || undefined })}>
            <option value="">All</option>
            {grades.map((g) => (
              <option key={g}>{g}</option>
            ))}
          </Select>
          <Select label="Class" value={filters.classId ?? ""} onChange={(e) => setFilters({ ...filters, classId: e.target.value || undefined })}>
            <option value="">All classes</option>
            {classes.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
          <Select label="Reviewer" value={filters.reviewerId ?? ""} onChange={(e) => setFilters({ ...filters, reviewerId: e.target.value || undefined })}>
            <option value="">Anyone</option>
            <option value="none">Unassigned</option>
            {users.data?.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.email}
              </option>
            ))}
          </Select>
          <Select label="Order" value={filters.order ?? "newest"} onChange={(e) => setFilters({ ...filters, order: e.target.value })}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </Select>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          {(
            [
              ["flagged", "1", "Flagged"],
              ["overQuota", "1", "Over-quota classes"],
              ["maxChars", "150", "Short (≤150 chars)"],
              ["source", "council", "Council-written"],
              ["submission", "voided", "From voided submissions"],
            ] as const
          ).map(([k, v, label]) => (
            <label key={k} className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4 accent-[var(--color-ink)]"
                checked={filters[k] === v}
                onChange={(e) => setFilters({ ...filters, [k]: e.target.checked ? v : undefined })}
              />
              {label}
            </label>
          ))}
          <span className="ml-auto flex items-center gap-1">
            <span className="mr-2 text-muted tabular">{total} notes</span>
            <button className={clsx("btn-ghost btn-sm", mode === "grid" && "bg-paper-2")} onClick={() => setMode("grid")} aria-pressed={mode === "grid"}>
              <LayoutGrid aria-hidden className="size-4" /> Board
            </button>
            <button className={clsx("btn-ghost btn-sm", mode === "list" && "bg-paper-2")} onClick={() => setMode("list")} aria-pressed={mode === "list"}>
              <List aria-hidden className="size-4" /> List
            </button>
          </span>
        </div>
      </div>

      {selected.size > 0 ? (
        <div className="sticky top-14 z-20 mb-4 flex flex-wrap items-center gap-2 rounded-xl bg-ink px-4 py-2.5 text-paper lg:top-2">
          <span className="mr-2 text-sm font-semibold tabular">{selected.size} selected</span>
          <button className="btn btn-sm bg-paper text-ink hover:bg-card" onClick={() => setBulk("approved")}>
            <Check aria-hidden className="size-4" /> Approve
          </button>
          <button className="btn btn-sm bg-paper text-ink hover:bg-card" onClick={() => setBulk("trashed")}>
            <Trash2 aria-hidden className="size-4" /> Trash
          </button>
          <button className="btn btn-sm bg-paper text-ink hover:bg-card" onClick={() => setBulk("pending")}>
            <RotateCcw aria-hidden className="size-4" /> Back to pending
          </button>
          <span className="flex items-center gap-1.5">
            <select
              value={assignTo}
              onChange={(e) => setAssignTo(e.target.value)}
              className="h-9 rounded-full border-0 bg-paper px-3 text-sm text-ink"
              aria-label="Assign selected to"
            >
              <option value="">Assign to…</option>
              <option value="__none__">Unassign</option>
              {reviewers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email}
                </option>
              ))}
            </select>
            <button
              className="btn btn-sm bg-paper text-ink hover:bg-card"
              disabled={!assignTo || assign.isPending}
              onClick={() => assign.mutate({ noteIds: [...selected], reviewerId: assignTo === "__none__" ? null : assignTo })}
            >
              <UserPlus aria-hidden className="size-4" /> Apply
            </button>
          </span>
          <button className="btn btn-sm ml-auto text-paper hover:bg-ink-2" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      ) : null}

      {notes.isError ? <Banner tone="bad" title="Couldn't load notes">{(notes.error as Error).message}</Banner> : null}
      {notes.isPending ? (
        <div className={clsx(mode === "grid" ? "columns-1 gap-4 sm:columns-2 xl:columns-3 2xl:columns-4" : "space-y-2")}>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="mb-4 h-40 animate-pulse rounded-[var(--radius-card)] bg-paper-2" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <Empty title={title === "Trash" ? "Trash is empty" : "No notes match these filters"}>
          {title === "Trash" ? "Notes moved to Trash by reviewers or admins appear here." : "Try removing a filter, or check back when more responses arrive."}
        </Empty>
      ) : (
        <>
          <div className="mb-2 flex items-center gap-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4 accent-[var(--color-ink)]"
                checked={items.length > 0 && items.every((n) => selected.has(n.id))}
                onChange={(e) => setSelected(e.target.checked ? new Set(items.map((n) => n.id)) : new Set())}
              />
              Select all {items.length} loaded
            </label>
          </div>
          {mode === "grid" ? (
            <div className="columns-1 gap-4 sm:columns-2 xl:columns-3 2xl:columns-4">
              {items.map((n) => (
                <NoteCard key={n.id} n={n} selected={selected.has(n.id)} onToggle={() => toggle(n.id)} onOpen={() => setOpenId(n.id)} />
              ))}
            </div>
          ) : (
            <div className="card divide-y divide-line">
              {items.map((n) => (
                <div key={n.id} className="flex items-start gap-3 px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label={`Select note to ${n.teacherName}`}
                    className="mt-1 size-4 accent-[var(--color-ink)]"
                    checked={selected.has(n.id)}
                    onChange={() => toggle(n.id)}
                  />
                  <button className="min-w-0 flex-1 text-left" onClick={() => setOpenId(n.id)}>
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-semibold">{n.teacherName}</span>
                      <StatusChip status={n.status} />
                      <span className="text-muted">
                        {n.classLabel ?? "Council"} · {n.charCount} chars · {n.reviewerEmail ?? "unassigned"}
                      </span>
                      <Flags flags={n.flags} />
                    </p>
                    <p className="mt-0.5 truncate text-sm text-ink-2">{n.body}</p>
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="mt-6 flex justify-center">
            {notes.hasNextPage ? (
              <button className="btn-outline" onClick={() => void notes.fetchNextPage()} disabled={notes.isFetchingNextPage}>
                {notes.isFetchingNextPage ? <Spinner /> : null} Load more
              </button>
            ) : (
              <p className="text-sm text-muted">End of list · {items.length} shown</p>
            )}
          </div>
        </>
      )}

      <NoteDetail id={openId} onClose={() => setOpenId(null)} />

      <ConfirmDialog
        open={bulk !== null}
        onOpenChange={(v) => !v && setBulk(null)}
        title={bulk === "approved" ? "Approve selected notes?" : bulk === "trashed" ? "Move selected notes to Trash?" : "Move selected notes back to pending?"}
        description={`${selected.size} notes. Every change is logged and reversible.`}
        confirmLabel={bulk === "approved" ? "Approve" : bulk === "trashed" ? "Move to Trash" : "Move to pending"}
        tone={bulk === "trashed" ? "danger" : "primary"}
        busy={bulkStatus.isPending}
        onConfirm={() => {
          if (!bulk) return;
          bulkStatus.mutate({ ids: [...selected], status: bulk }, { onSettled: () => setBulk(null) });
        }}
      />
      <CouncilNoteSheet
        open={councilOpen}
        onClose={() => setCouncilOpen(false)}
        onCreated={() => {
          void qc.invalidateQueries({ queryKey: ["notes"] });
          void qc.invalidateQueries({ queryKey: ["teachers"] });
          toast("ok", "Council note added");
        }}
      />
    </div>
  );
}

function NoteCard({ n, selected, onToggle, onOpen }: { n: AdminNote; selected: boolean; onToggle: () => void; onOpen: () => void }) {
  return (
    <article
      className={clsx(
        "group relative mb-4 break-inside-avoid rounded-[var(--radius-card)] border bg-card p-4 transition-[border-color,box-shadow] duration-150 hover:shadow-[var(--shadow-lift)]",
        selected ? "border-ink ring-2 ring-ink/15" : "border-line",
        n.status === "trashed" && "opacity-80",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 font-semibold leading-snug">{n.teacherName}</p>
        <input
          type="checkbox"
          aria-label={`Select note to ${n.teacherName}`}
          className="mt-0.5 size-4 shrink-0 accent-[var(--color-ink)]"
          checked={selected}
          onChange={onToggle}
        />
      </div>
      <button onClick={onOpen} className="mt-2 block w-full text-left focus-visible:outline-offset-4">
        <p className="line-clamp-[8] whitespace-pre-wrap break-words font-serif text-[15px] leading-[1.55] text-ink">{n.body}</p>
        <span className="sr-only">Open note details</span>
      </button>
      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <StatusChip status={n.status} />
        <span className="tabular">{n.charCount} ch</span>
        <span>·</span>
        <span>{n.source === "council" ? "Council" : `${n.gradeLabel ?? ""} · ${n.classLabel ?? ""}`}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <span className="truncate">{n.reviewerEmail ?? "Unassigned"}</span>
        <Flags flags={n.flags} />
      </div>
    </article>
  );
}

interface NoteEvent {
  id: string;
  action: string;
  prev_status: string | null;
  new_status: string | null;
  detail: string | null;
  created_at: string;
  actor: string | null;
}

export function NoteDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["note", id],
    queryFn: () => api<{ note: AdminNote; events: NoteEvent[] }>(`/api/admin/notes/${id}`),
    enabled: Boolean(id),
  });
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const n = q.data?.note;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["note", id] });
    void qc.invalidateQueries({ queryKey: ["notes"] });
    void qc.invalidateQueries({ queryKey: ["overview"] });
  };

  const setStatus = async (status: "approved" | "trashed" | "pending") => {
    if (!n) return;
    setBusy(true);
    try {
      await post(`/api/admin/notes/${n.id}/status`, { status, version: n.version, reason: reason || undefined });
      toast("ok", status === "approved" ? "Approved" : status === "trashed" ? "Moved to Trash" : "Moved to pending");
      setReason("");
      refresh();
    } catch (e) {
      toast("bad", e instanceof ApiFailure ? e.message : "Failed");
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const saveDisplay = async (value: string | null) => {
    if (!n) return;
    setBusy(true);
    try {
      await patch(`/api/admin/notes/${n.id}/display`, { displayBody: value, version: n.version });
      toast("ok", value === null ? "Restored original text" : "Print text saved");
      setEditing(null);
      refresh();
    } catch (e) {
      toast("bad", e instanceof ApiFailure ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={Boolean(id)} onOpenChange={(v) => !v && onClose()} title="Note">
      {q.isPending ? <Spinner /> : null}
      {n ? (
        <div className="space-y-6">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip status={n.status} />
              <Flags flags={n.flags} />
            </div>
            <p className="mt-3 font-serif text-[17px] italic text-ink-2">Dear {n.teacherName},</p>
            {editing !== null ? (
              <div className="mt-2">
                <textarea
                  value={editing}
                  onChange={(e) => setEditing(e.target.value)}
                  rows={8}
                  className="field h-auto py-3 font-serif leading-[1.6]"
                  aria-label="Print text"
                />
                <p className="mt-1 text-sm tabular text-muted">{countChars(editing)} / {NOTE_MAX_CHARS}</p>
                <div className="mt-2 flex gap-2">
                  <button className="btn-primary btn-sm" disabled={busy} onClick={() => void saveDisplay(editing)}>
                    Save print text
                  </button>
                  <button className="btn-ghost btn-sm" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <p className="mt-1 whitespace-pre-wrap break-words font-serif text-[17px] leading-[1.6]">{n.body}</p>
            )}
            {n.displayBody !== null && editing === null ? (
              <details className="mt-3 rounded-lg bg-paper px-3 py-2 text-sm">
                <summary className="cursor-pointer font-medium">Original text (edited for print)</summary>
                <p className="mt-2 whitespace-pre-wrap font-serif">{n.originalBody}</p>
              </details>
            ) : null}
            {editing === null ? (
              <div className="mt-2 flex gap-2">
                <button className="btn-ghost btn-sm -ml-3" onClick={() => setEditing(n.body)}>
                  Edit print text
                </button>
                {n.displayBody !== null ? (
                  <button className="btn-ghost btn-sm" onClick={() => void saveDisplay(null)} disabled={busy}>
                    Use original
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          {n.submissionStatus === "voided" ? (
            <Banner tone="warn" title="Its submission is voided">This note is excluded from printing and coverage until the submission is restored.</Banner>
          ) : null}

          <div>
            <label className="label" htmlFor="mod-reason">Reason (optional)</label>
            <input id="mod-reason" className="field mt-1.5 h-10 text-sm" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
            <div className="mt-3 flex flex-wrap gap-2">
              {n.status !== "approved" ? (
                <button className="btn-primary btn-sm" disabled={busy} onClick={() => void setStatus("approved")}>
                  <Check aria-hidden className="size-4" /> Approve
                </button>
              ) : null}
              {n.status !== "trashed" ? (
                <button className="btn-outline btn-sm" disabled={busy} onClick={() => void setStatus("trashed")}>
                  <Trash2 aria-hidden className="size-4" /> Move to Trash
                </button>
              ) : null}
              {n.status !== "pending" ? (
                <button className="btn-outline btn-sm" disabled={busy} onClick={() => void setStatus("pending")}>
                  <RotateCcw aria-hidden className="size-4" /> {n.status === "trashed" ? "Restore to pending" : "Back to pending"}
                </button>
              ) : null}
            </div>
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted">Source</dt>
            <dd>{n.source === "council" ? "Council-written" : "Student"}</dd>
            <dt className="text-muted">Class</dt>
            <dd>{n.classLabel ? `${n.classLabel} · ${n.gradeLabel}` : "—"}</dd>
            <dt className="text-muted">Characters</dt>
            <dd className="tabular">{n.charCount}</dd>
            <dt className="text-muted">Reviewer</dt>
            <dd>{n.reviewerEmail ?? "Unassigned"}</dd>
            <dt className="text-muted">Last reviewed</dt>
            <dd>{n.reviewedByEmail ? `${n.reviewedByEmail}, ${fmtTime(n.reviewedAt)}` : "—"}</dd>
            {n.statusReason ? (
              <>
                <dt className="text-muted">Reason</dt>
                <dd>{n.statusReason}</dd>
              </>
            ) : null}
            <dt className="text-muted">Received</dt>
            <dd>{fmtTime(n.createdAt)}</dd>
            {n.submissionId ? (
              <>
                <dt className="text-muted">Submission</dt>
                <dd>
                  <Link className="underline" href={`/submissions?open=${n.submissionId}`}>
                    View whole submission
                  </Link>
                </dd>
              </>
            ) : null}
          </dl>

          <div>
            <h3 className="mb-2 text-sm font-semibold">History</h3>
            <ol className="space-y-2 text-sm">
              {q.data!.events.map((e) => {
                let detail: Record<string, unknown> = {};
                try {
                  detail = e.detail ? JSON.parse(e.detail) : {};
                } catch {
                  /* ignore */
                }
                return (
                  <li key={e.id} className="border-l-2 border-line pl-3">
                    <p>
                      <span className="font-medium">{e.actor ?? "system"}</span>{" "}
                      {e.action === "status"
                        ? `${e.prev_status} → ${e.new_status}`
                        : e.action === "assign"
                          ? "changed assignment"
                          : e.action === "edit"
                            ? "edited print text"
                            : e.action}
                      {detail.reason ? ` — “${String(detail.reason)}”` : ""}
                    </p>
                    <p className="text-xs text-muted">{fmtTime(e.created_at)}</p>
                  </li>
                );
              })}
              {q.data!.events.length === 0 ? <li className="text-muted">No changes yet.</li> : null}
            </ol>
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}

function CouncilNoteSheet({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const teachers = useTeachers();
  const [teacherId, setTeacherId] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [approve, setApprove] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const n = countChars(body);
  const list = (teachers.data?.teachers ?? []).filter((t) => t.active);
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()} title="Council-written note">
      <p className="mb-4 text-sm text-ink-2">
        For teachers who need more notes. Council notes follow the same 100–400 character rule and print alongside student notes without a label (unless enabled in Settings).
      </p>
      {teachers.data ? (
        <div className="space-y-4">
          <TeacherPicker
            id="council-teacher"
            label="Teacher"
            teachers={list.map((t) => ({ id: t.id, honorific: t.honorific, fullName: `${t.fullName}` }))}
            value={teacherId}
            onChange={setTeacherId}
          />
          {teacherId ? (
            <p className="text-sm text-muted">
              Currently {list.find((t) => t.id === teacherId)?.approved ?? 0} approved · needs {list.find((t) => t.id === teacherId)?.needed ?? 0} more
            </p>
          ) : null}
          <div>
            <label className="label" htmlFor="council-body">Message</label>
            <textarea id="council-body" className="field mt-1.5 h-auto py-3 font-serif leading-[1.6]" rows={7} value={body} onChange={(e) => setBody(e.target.value)} />
            <p className={clsx("mt-1 text-sm tabular", n > NOTE_MAX_CHARS || (n > 0 && n < NOTE_MIN_CHARS) ? "text-bad" : "text-muted")}>
              {n} / {NOTE_MAX_CHARS} characters (min {NOTE_MIN_CHARS})
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--color-ink)]" checked={approve} onChange={(e) => setApprove(e.target.checked)} />
            Approve immediately
          </label>
          {err ? <Banner tone="bad">{err}</Banner> : null}
          <button
            className="btn-primary"
            disabled={busy || !teacherId || n < NOTE_MIN_CHARS || n > NOTE_MAX_CHARS}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await post("/api/admin/notes/council", { teacherId, body, approve });
                setBody("");
                setTeacherId(null);
                onCreated();
                onClose();
              } catch (e) {
                setErr(e instanceof ApiFailure ? e.message : "Failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            Add note
          </button>
        </div>
      ) : (
        <Spinner />
      )}
    </Sheet>
  );
}
