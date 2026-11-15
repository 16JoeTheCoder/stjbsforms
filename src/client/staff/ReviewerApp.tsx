import { useCallback, useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { Link } from "wouter";
import clsx from "clsx";
import { Check, Keyboard, LogOut, RotateCcw, Trash2 } from "lucide-react";
import { api, ApiFailure } from "../lib/api";
import type { Me, Page, ReviewerNote } from "../../shared/types";
import { Empty, Flags, Meter, ToastProvider, post, useToast } from "./common";
import { Spinner } from "../components/ui";

type Tab = "pending" | "approved" | "trashed";
interface Progress {
  total: number;
  pending: number;
  approved: number;
  trashed: number;
  canRestore: boolean;
}

export function ReviewerApp({ me }: { me: Me }) {
  return (
    <ToastProvider>
      <Queue me={me} />
    </ToastProvider>
  );
}

function Queue({ me }: { me: Me }) {
  const [tab, setTab] = useState<Tab>("pending");
  const [focus, setFocus] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [help, setHelp] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const cards = useRef<(HTMLElement | null)[]>([]);

  const progress = useQuery({ queryKey: ["review-progress"], queryFn: () => api<Progress>("/api/review/progress"), refetchInterval: 30_000 });
  const key = ["review-notes", tab];
  const q = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => api<Page<ReviewerNote>>(`/api/review/notes?status=${tab}&limit=25${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: "",
    getNextPageParam: (l) => l.nextCursor ?? undefined,
    refetchOnWindowFocus: false,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  useEffect(() => setFocus(0), [tab]);

  const removeLocal = useCallback(
    (id: string) =>
      qc.setQueryData<InfiniteData<Page<ReviewerNote>>>(key, (d) =>
        d ? { ...d, pages: d.pages.map((p) => ({ ...p, items: p.items.filter((n) => n.id !== id) })) } : d,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [qc, tab],
  );

  const act = useCallback(
    async (n: ReviewerNote, status: Tab, why?: string) => {
      if (busy || n.status === status) return;
      setBusy(n.id);
      try {
        await post(`/api/review/notes/${n.id}/status`, { status, version: n.version, reason: why || undefined });
        removeLocal(n.id);
        setReasonFor(null);
        setReason("");
        void qc.invalidateQueries({ queryKey: ["review-progress"] });
        void qc.invalidateQueries({ queryKey: ["review-notes", status] });
        toast("ok", status === "approved" ? "Approved" : status === "trashed" ? "Moved to Trash" : "Moved back to pending");
        requestAnimationFrame(() => cards.current[Math.min(focus, items.length - 2)]?.focus());
      } catch (e) {
        const err = e instanceof ApiFailure ? e : null;
        if (err?.status === 404) removeLocal(n.id);
        toast("bad", err?.message ?? "Couldn't save. Try again.");
        if (err?.status === 409) void q.refetch();
      } finally {
        setBusy(null);
      }
    },
    [busy, removeLocal, qc, toast, focus, items.length, q],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) return;
      const n = items[focus];
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        const i = Math.min(items.length - 1, focus + 1);
        setFocus(i);
        cards.current[i]?.focus();
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        const i = Math.max(0, focus - 1);
        setFocus(i);
        cards.current[i]?.focus();
      } else if (n && e.key === "a") void act(n, "approved");
      else if (n && e.key === "t") void act(n, "trashed");
      else if (n && e.key === "u" && (n.status !== "trashed" || progress.data?.canRestore)) void act(n, "pending");
      else if (e.key === "?") setHelp((h) => !h);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, focus, act, progress.data?.canRestore]);

  const p = progress.data;
  const done = p ? p.total - p.pending : 0;

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-line bg-paper/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <p className="text-[13px] font-semibold tracking-wide">
            STJB <span className="text-muted">· Review</span>
          </p>
          <div className="flex items-center gap-1">
            {me.role === "admin" ? (
              <Link href="~/admin" className="btn-ghost btn-sm">
                Admin
              </Link>
            ) : null}
            <button className="btn-ghost btn-sm" onClick={() => setHelp((h) => !h)} aria-expanded={help}>
              <Keyboard aria-hidden className="size-4" /> <span className="hidden sm:inline">Shortcuts</span>
            </button>
            <a className="btn-ghost btn-sm" href={me.logoutUrl}>
              <LogOut aria-hidden className="size-4" /> <span className="hidden sm:inline">Sign out</span>
            </a>
          </div>
        </div>
        <div className="mx-auto max-w-3xl px-4 pb-3">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium">{p ? `${done} of ${p.total} reviewed` : "…"}</span>
            <span className="truncate text-muted">{me.email}</span>
          </div>
          <div className="mt-1.5">
            <Meter value={done} max={p?.total ?? 0} label="Review progress" />
          </div>
          <div role="tablist" aria-label="Queue" className="mt-3 flex gap-1">
            {(
              [
                ["pending", "Pending", p?.pending],
                ["approved", "Approved", p?.approved],
                ["trashed", "Trash", p?.trashed],
              ] as const
            ).map(([k, label, n]) => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={clsx("btn-sm btn rounded-full", tab === k ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2")}
              >
                {label} <span className="tabular opacity-70">{n ?? ""}</span>
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-6">
        {help ? (
          <div className="card mb-5 p-4 text-sm">
            <p className="font-semibold">Keyboard</p>
            <p className="mt-1 text-ink-2">
              <kbd className="font-semibold">J</kbd>/<kbd className="font-semibold">K</kbd> next/previous · <kbd className="font-semibold">A</kbd> approve ·{" "}
              <kbd className="font-semibold">T</kbd> trash · <kbd className="font-semibold">U</kbd> back to pending · <kbd className="font-semibold">?</kbd> toggle this help
            </p>
            <p className="mt-2 text-ink-2">
              Approve notes that are kind and appropriate to print. Trash anything hurtful, inappropriate, or that identifies another student. Trash can be undone.
            </p>
          </div>
        ) : null}
        {q.isPending ? (
          <p className="flex items-center gap-2 text-muted">
            <Spinner /> Loading your notes…
          </p>
        ) : q.isError ? (
          <p className="text-bad">{(q.error as Error).message}</p>
        ) : items.length === 0 ? (
          <Empty title={tab === "pending" ? (p?.total ? "All done — thank you!" : "Nothing assigned yet") : "Nothing here"}>
            {tab === "pending"
              ? p?.total
                ? "You've reviewed every note assigned to you. New ones will appear here if an admin assigns more."
                : "An administrator will assign notes to you. This page refreshes when you come back to it."
              : null}
          </Empty>
        ) : (
          <ol className="space-y-4">
            {items.map((n, i) => (
              <li key={n.id}>
                <article
                  ref={(el) => {
                    cards.current[i] = el;
                  }}
                  tabIndex={0}
                  onFocus={() => setFocus(i)}
                  aria-label={`Note to ${n.teacherName}`}
                  className={clsx("card p-5 transition-[box-shadow,border-color] duration-150 focus:outline-none", i === focus ? "border-ink shadow-[var(--shadow-lift)]" : "")}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold">{n.teacherName}</p>
                    <p className="flex items-center gap-2 text-xs text-muted">
                      <span>{n.gradeLabel ?? "Council"}</span>·<span className="tabular">{n.charCount} characters</span>
                      <Flags flags={n.flags} />
                    </p>
                  </div>
                  <p className="mt-1 font-serif text-[15px] italic text-ink-2">Dear {n.teacherName},</p>
                  <p className="mt-1 whitespace-pre-wrap break-words font-serif text-[17px] leading-[1.6]">{n.body}</p>
                  {n.statusReason && n.status !== "pending" ? <p className="mt-2 text-sm text-muted">Reason: {n.statusReason}</p> : null}
                  {reasonFor === n.id ? (
                    <div className="mt-3 flex gap-2">
                      <input
                        autoFocus
                        aria-label="Reason for trashing"
                        className="field h-10 text-sm"
                        placeholder="Why? (optional)"
                        value={reason}
                        maxLength={300}
                        onChange={(e) => setReason(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void act(n, "trashed", reason);
                          if (e.key === "Escape") setReasonFor(null);
                        }}
                      />
                      <button className="btn-danger btn-sm h-10 shrink-0" onClick={() => void act(n, "trashed", reason)} disabled={busy === n.id}>
                        Trash
                      </button>
                    </div>
                  ) : null}
                  <div className="mt-4 flex flex-wrap gap-2">
                    {n.status !== "approved" ? (
                      <button className="btn-primary btn-sm" disabled={busy === n.id} onClick={() => void act(n, "approved")}>
                        <Check aria-hidden className="size-4" /> Approve
                      </button>
                    ) : null}
                    {n.status !== "trashed" ? (
                      <>
                        <button className="btn-outline btn-sm" disabled={busy === n.id} onClick={() => void act(n, "trashed")}>
                          <Trash2 aria-hidden className="size-4" /> Trash
                        </button>
                        {reasonFor !== n.id ? (
                          <button className="btn-ghost btn-sm" onClick={() => setReasonFor(n.id)}>
                            Trash with reason
                          </button>
                        ) : null}
                      </>
                    ) : null}
                    {n.status !== "pending" && (n.status !== "trashed" || p?.canRestore) ? (
                      <button className="btn-outline btn-sm" disabled={busy === n.id} onClick={() => void act(n, "pending")}>
                        <RotateCcw aria-hidden className="size-4" /> Back to pending
                      </button>
                    ) : null}
                  </div>
                </article>
              </li>
            ))}
          </ol>
        )}
        {q.hasNextPage ? (
          <div className="mt-6 flex justify-center">
            <button className="btn-outline" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              {q.isFetchingNextPage ? <Spinner /> : null} Load more
            </button>
          </div>
        ) : null}
      </main>
    </div>
  );
}
