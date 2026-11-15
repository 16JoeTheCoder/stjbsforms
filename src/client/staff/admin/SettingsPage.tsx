import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { api, fmtTime } from "../../lib/api";
import { PageHeader, patch, useAction } from "../common";
import { Banner, ConfirmDialog, Spinner } from "../../components/ui";

interface Settings {
  submissionsOpen: boolean;
  opensAt: string | null;
  closesAt: string | null;
  reviewerCanRestore: boolean;
  minNotesPerTeacher: number;
  printSeed: string;
  showCouncilLabel: boolean;
  defaultQuotaExtra: number;
}

/** <input type=datetime-local> value in Asia/Jakarta (UTC+7, no DST) <-> UTC ISO. */
const JKT_OFFSET_MS = 7 * 3600_000;
const toLocal = (iso: string | null) => (iso ? new Date(Date.parse(iso) + JKT_OFFSET_MS).toISOString().slice(0, 16) : "");
const fromLocal = (v: string) => (v ? new Date(Date.parse(`${v}:00Z`) - JKT_OFFSET_MS).toISOString() : null);

export function SettingsPage() {
  const q = useQuery({ queryKey: ["settings"], queryFn: () => api<Settings>("/api/admin/settings") });
  const [toggle, setToggle] = useState<boolean | null>(null);
  const save = useAction((v: Partial<Settings>) => patch<Settings>("/api/admin/settings", v), {
    invalidate: [["settings"], ["overview"]],
    success: "Settings saved",
  });
  const [draft, setDraft] = useState<Partial<Settings>>({});
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Banner tone="bad">{(q.error as Error).message}</Banner>;
  const s = { ...q.data, ...draft };
  const dirty = Object.keys(draft).length > 0;
  return (
    <div className="max-w-3xl">
      <PageHeader title="Settings" lead="All times are Jakarta time (WIB, UTC+7) and stored in UTC." />

      <section className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Student submissions</h2>
            <p className="text-sm text-ink-2">
              Currently <strong>{q.data.submissionsOpen ? "switched on" : "switched off"}</strong>
              {q.data.opensAt ? ` · opens ${fmtTime(q.data.opensAt)}` : ""}
              {q.data.closesAt ? ` · closes ${fmtTime(q.data.closesAt)}` : ""}. Students keep their drafts either way.
            </p>
          </div>
          <button className={q.data.submissionsOpen ? "btn-outline" : "btn-fire"} onClick={() => setToggle(!q.data.submissionsOpen)}>
            {q.data.submissionsOpen ? "Close submissions" : "Open submissions"}
          </button>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="label">Opens at (optional)</span>
            <input type="datetime-local" className="field mt-1.5" value={toLocal(s.opensAt ?? null)} onChange={(e) => setDraft({ ...draft, opensAt: fromLocal(e.target.value) })} />
          </label>
          <label className="block">
            <span className="label">Closes at (optional)</span>
            <input type="datetime-local" className="field mt-1.5" value={toLocal(s.closesAt ?? null)} onChange={(e) => setDraft({ ...draft, closesAt: fromLocal(e.target.value) })} />
          </label>
        </div>
        <p className="hint mt-2">The form is open only while switched on and within these times.</p>
      </section>

      <section className="card mt-5 space-y-4 p-5">
        <h2 className="font-semibold">Review & printing</h2>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--color-ink)]" checked={s.reviewerCanRestore} onChange={(e) => setDraft({ ...draft, reviewerCanRestore: e.target.checked })} />
          Reviewers may move their own trashed notes back to pending
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--color-ink)]" checked={s.showCouncilLabel} onChange={(e) => setDraft({ ...draft, showCouncilLabel: e.target.checked })} />
          Label council-written notes in print (“— from the Student Council”)
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="label">Minimum notes per teacher</span>
            <input type="number" min={0} max={20} className="field mt-1.5 tabular" value={s.minNotesPerTeacher} onChange={(e) => setDraft({ ...draft, minNotesPerTeacher: Number(e.target.value) })} />
          </label>
          <label className="block">
            <span className="label">Default quota buffer</span>
            <input type="number" min={0} max={100} className="field mt-1.5 tabular" value={s.defaultQuotaExtra} onChange={(e) => setDraft({ ...draft, defaultQuotaExtra: Number(e.target.value) })} />
          </label>
          <label className="block">
            <span className="label">Print shuffle seed</span>
            <input className="field mt-1.5" value={s.printSeed} onChange={(e) => setDraft({ ...draft, printSeed: e.target.value })} maxLength={60} />
          </label>
        </div>
        <p className="hint">New classes default to expected students + buffer as their soft quota (25 → 30).</p>
      </section>

      <div className="mt-5 flex gap-2">
        <button className="btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft, { onSuccess: () => setDraft({}) })}>
          Save changes
        </button>
        {dirty ? (
          <button className="btn-ghost" onClick={() => setDraft({})}>
            Discard
          </button>
        ) : null}
      </div>

      <section className="card mt-8 p-5">
        <h2 className="font-semibold">Exports & backup</h2>
        <p className="mt-1 text-sm text-ink-2">CSV files open in Excel or Google Sheets. The JSON backup contains every table and should be stored somewhere private.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {[
            ["awards.csv", "Award results"],
            ["classes.csv", "Class participation"],
            ["coverage.csv", "Teacher coverage"],
            ["notes.csv", "Approved notes"],
            ["moderation.csv", "Moderation progress"],
            ["backup.json", "Full backup (JSON)"],
          ].map(([f, label]) => (
            <a key={f} className="btn-outline btn-sm" href={`/api/admin/export/${f}`}>
              <Download aria-hidden className="size-4" /> {label}
            </a>
          ))}
        </div>
      </section>

      <ConfirmDialog
        open={toggle !== null}
        onOpenChange={(v) => !v && setToggle(null)}
        title={toggle ? "Open submissions?" : "Close submissions?"}
        description={
          toggle
            ? "Students with a valid class code can submit straight away (subject to the times above)."
            : "Students can still open the form and keep their drafts, but can't submit until you reopen."
        }
        confirmLabel={toggle ? "Open" : "Close"}
        tone={toggle ? "fire" : "primary"}
        onConfirm={() => {
          if (toggle !== null) save.mutate({ submissionsOpen: toggle });
          setToggle(null);
        }}
      />
    </div>
  );
}
