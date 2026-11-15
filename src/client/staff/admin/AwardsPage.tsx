import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Download, Plus } from "lucide-react";
import { api } from "../../lib/api";
import { PageHeader, Select, patch, post, useAction } from "../common";
import { Banner, Sheet, Spinner } from "../../components/ui";

interface AwardResult {
  id: string;
  name: string;
  description: string;
  displayOrder: number;
  active: boolean;
  winnerTeacherId: string | null;
  winnerNote: string | null;
  winnerName: string | null;
  totalVotes: number;
  ranking: { teacherId: string; teacherName: string; votes: number; rank: number }[];
  leaders: string[];
  tie: boolean;
  overlaps: string[];
}

export function AwardsPage() {
  const q = useQuery({ queryKey: ["awards"], queryFn: () => api<AwardResult[]>("/api/admin/awards"), refetchInterval: 20_000 });
  const [edit, setEdit] = useState<AwardResult | "new" | null>(null);
  const reorder = useAction((ids: string[]) => post("/api/admin/awards/reorder", { ids }), { invalidate: [["awards"]] });
  const winner = useAction((v: { id: string; teacherId: string | null }) => post(`/api/admin/awards/${v.id}/winner`, { teacherId: v.teacherId }), {
    invalidate: [["awards"]],
    success: "Winner recorded",
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Banner tone="bad">{(q.error as Error).message}</Banner>;
  const list = q.data;
  const move = (i: number, d: -1 | 1) => {
    const ids = list.map((a) => a.id);
    const j = i + d;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    reorder.mutate(ids);
  };
  const anyOverlap = list.some((a) => a.active && a.overlaps.length);
  return (
    <div>
      <PageHeader
        title="Awards"
        lead="Results are visible to administrators only. Votes from voided submissions are excluded. Overlaps and ties are flagged for the council to decide — nothing is resolved automatically."
        actions={
          <>
            <a className="btn-outline btn-sm" href="/api/admin/export/awards.csv">
              <Download aria-hidden className="size-4" /> Export results
            </a>
            <button className="btn-primary btn-sm" onClick={() => setEdit("new")}>
              <Plus aria-hidden className="size-4" /> Add award
            </button>
          </>
        }
      />
      {anyOverlap ? (
        <Banner tone="warn" className="mb-5" title="Some teachers lead more than one award">
          Marked “also leads another award” below. Record the council's decision with “Recorded winner”.
        </Banner>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-2">
        {list.map((a, i) => (
          <section key={a.id} className={clsx("card p-5", !a.active && "opacity-70")}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-muted tabular">#{i + 1}{a.active ? "" : " · inactive"}</p>
                <h2 className="mt-0.5 text-[17px] font-semibold leading-snug">{a.name}</h2>
                {a.description ? <p className="mt-0.5 text-sm text-ink-2">{a.description}</p> : null}
              </div>
              <div className="flex shrink-0 gap-1">
                <button className="btn-ghost btn-sm px-2" aria-label="Move up" disabled={i === 0 || reorder.isPending} onClick={() => move(i, -1)}>
                  <ArrowUp className="size-4" />
                </button>
                <button className="btn-ghost btn-sm px-2" aria-label="Move down" disabled={i === list.length - 1 || reorder.isPending} onClick={() => move(i, 1)}>
                  <ArrowDown className="size-4" />
                </button>
                <button className="btn-ghost btn-sm" onClick={() => setEdit(a)}>
                  Edit
                </button>
              </div>
            </div>
            <p className="mt-3 text-sm text-muted tabular">
              {a.totalVotes} votes{a.tie ? " · tie at the top" : ""}
            </p>
            <ol className="mt-2 space-y-1.5">
              {a.ranking.slice(0, 6).map((r) => {
                const pct = a.totalVotes ? (r.votes / a.totalVotes) * 100 : 0;
                return (
                  <li key={r.teacherId} className="text-sm">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className={clsx("min-w-0 truncate", r.rank === 1 && "font-semibold")}>
                        <span className="mr-2 inline-block w-5 text-muted tabular">{r.rank}</span>
                        {r.teacherName}
                        {a.overlaps.includes(r.teacherId) ? <span className="ml-2 chip bg-warn-soft text-warn">also leads another award</span> : null}
                      </span>
                      <span className="tabular text-ink-2">{r.votes}</span>
                    </div>
                    <div className="ml-7 mt-1 h-1 rounded-full bg-paper-2">
                      <div className={clsx("h-full rounded-full", r.rank === 1 ? "bg-fire" : "bg-line-strong")} style={{ width: `${pct}%` }} />
                    </div>
                  </li>
                );
              })}
              {a.ranking.length === 0 ? <li className="text-sm text-muted">No votes yet.</li> : null}
            </ol>
            <div className="mt-4 border-t border-line pt-3">
              <Select
                label="Recorded winner (council decision)"
                value={a.winnerTeacherId ?? ""}
                onChange={(e) => winner.mutate({ id: a.id, teacherId: e.target.value || null })}
              >
                <option value="">Not decided</option>
                {a.ranking.map((r) => (
                  <option key={r.teacherId} value={r.teacherId}>
                    {r.teacherName} ({r.votes})
                  </option>
                ))}
              </Select>
            </div>
          </section>
        ))}
      </div>
      <AwardEditor value={edit} onClose={() => setEdit(null)} votingStarted={list.some((a) => a.totalVotes > 0)} />
    </div>
  );
}

function AwardEditor({ value, onClose, votingStarted }: { value: AwardResult | "new" | null; onClose: () => void; votingStarted: boolean }) {
  const a = value && value !== "new" ? value : null;
  const [key, setKey] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [active, setActive] = useState(true);
  const [reason, setReason] = useState("");
  const k = value === "new" ? "new" : a?.id ?? null;
  if (k !== key) {
    setKey(k);
    setName(a?.name ?? "");
    setDescription(a?.description ?? "");
    setActive(a?.active ?? true);
    setReason("");
  }
  const save = useAction(
    () =>
      a
        ? patch(`/api/admin/awards/${a.id}`, { name, description, active, reason: reason || undefined })
        : post("/api/admin/awards", { name, description }),
    { invalidate: [["awards"]], success: "Award saved", onSuccess: onClose },
  );
  return (
    <Sheet open={value !== null} onOpenChange={(v) => !v && onClose()} title={a ? "Edit award" : "Add award"}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        {votingStarted ? (
          <Banner tone="warn" title="Voting has started">
            Renaming keeps every existing vote. {a ? "Deactivating hides the award from new students and needs a reason." : "Students who already submitted won't have voted in a new award."} All changes are logged.
          </Banner>
        ) : null}
        <label className="block">
          <span className="label">Name</span>
          <input className="field mt-1.5" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} />
        </label>
        <label className="block">
          <span className="label">Description (optional)</span>
          <input className="field mt-1.5" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
        </label>
        {a ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--color-ink)]" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Active (shown to students)
          </label>
        ) : null}
        {a && votingStarted ? (
          <label className="block">
            <span className="label">Reason for change{!active && a.active ? " (required)" : ""}</span>
            <input className="field mt-1.5" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </label>
        ) : null}
        <button className="btn-primary" disabled={save.isPending || name.trim().length < 2}>
          Save
        </button>
      </form>
    </Sheet>
  );
}
