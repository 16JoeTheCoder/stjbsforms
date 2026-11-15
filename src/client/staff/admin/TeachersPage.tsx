import { useMemo, useState } from "react";
import { Link } from "wouter";
import clsx from "clsx";
import { Download, Plus, Search, Upload } from "lucide-react";
import { searchTeachers } from "../../../shared/search";
import { PageHeader, Stat, parseCsv, patch, post, useAction } from "../common";
import { Banner, Sheet, Spinner } from "../../components/ui";
import { teacherName, useTeachers, type TeacherRow } from "./data";

export function TeachersPage() {
  const q = useTeachers();
  const [query, setQuery] = useState("");
  const [onlyNeeds, setOnlyNeeds] = useState(false);
  const [edit, setEdit] = useState<TeacherRow | "new" | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const rows = useMemo(() => {
    let list = q.data?.teachers ?? [];
    if (query) list = searchTeachers(list, query);
    if (onlyNeeds) list = list.filter((t) => t.needed > 0);
    return list;
  }, [q.data, query, onlyNeeds]);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Banner tone="bad">{(q.error as Error).message}</Banner>;
  const all = q.data.teachers.filter((t) => t.active);
  const needing = all.filter((t) => t.needed > 0);
  return (
    <div>
      <PageHeader
        title="Teachers & coverage"
        lead={`Every active teacher should receive at least ${q.data.minimum} approved notes. Fill gaps with council-written notes; counts here are for planning, not comparison.`}
        actions={
          <>
            <button className="btn-outline btn-sm" onClick={() => setImportOpen(true)}>
              <Upload aria-hidden className="size-4" /> Import CSV
            </button>
            <a className="btn-outline btn-sm" href="/api/admin/export/coverage.csv">
              <Download aria-hidden className="size-4" /> Coverage CSV
            </a>
            <button className="btn-primary btn-sm" onClick={() => setEdit("new")}>
              <Plus aria-hidden className="size-4" /> Add teacher
            </button>
          </>
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Active teachers" value={all.length} />
        <Stat label="Covered" value={all.length - needing.length} tone="ok" />
        <Stat label="Need more notes" value={needing.length} tone={needing.length ? "warn" : undefined} />
        <Stat label="Notes still needed" value={needing.reduce((a, t) => a + t.needed, 0)} />
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-4">
        <span className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input
            aria-label="Search teachers"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search teachers"
            className="h-10 w-64 rounded-lg border border-line-strong bg-card pl-9 pr-3 text-sm focus:border-ink focus:outline-none"
          />
        </span>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--color-ink)]" checked={onlyNeeds} onChange={(e) => setOnlyNeeds(e.target.checked)} />
          Only teachers below {q.data.minimum}
        </label>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-[12px] text-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-2 font-medium">Teacher</th>
              <th className="px-3 py-2 text-right font-medium">Approved</th>
              <th className="px-3 py-2 text-right font-medium">Pending</th>
              <th className="px-3 py-2 text-right font-medium">Trash</th>
              <th className="px-3 py-2 font-medium">Coverage</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className={clsx("border-b border-line last:border-0", !t.active && "text-muted")}>
                <td className="px-4 py-2.5">
                  <span className="font-medium">{teacherName(t)}</span>
                  {!t.active ? <span className="ml-2 chip bg-paper-2 text-muted">Inactive</span> : null}
                </td>
                <td className="px-3 py-2.5 text-right tabular">{t.approved}</td>
                <td className="px-3 py-2.5 text-right tabular text-ink-2">{t.pending}</td>
                <td className="px-3 py-2.5 text-right tabular text-ink-2">{t.trashed}</td>
                <td className="px-3 py-2.5">
                  {!t.active ? "—" : t.needed > 0 ? <span className="chip bg-warn-soft text-warn">Needs {t.needed}</span> : <span className="chip bg-ok-soft text-ok">Covered</span>}
                </td>
                <td className="px-4 py-2.5 text-right whitespace-nowrap">
                  <Link className="btn-ghost btn-sm" href={`/notes?teacherId=${t.id}`}>
                    Notes
                  </Link>
                  <button className="btn-ghost btn-sm" onClick={() => setEdit(t)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TeacherEditor value={edit} onClose={() => setEdit(null)} />
      <TeacherImport open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}

function TeacherEditor({ value, onClose }: { value: TeacherRow | "new" | null; onClose: () => void }) {
  const t = value && value !== "new" ? value : null;
  const [key, setKey] = useState<string | null>(null);
  const [honorific, setHonorific] = useState("");
  const [fullName, setFullName] = useState("");
  const [active, setActive] = useState(true);
  const k = value === "new" ? "new" : t?.id ?? null;
  if (k !== key) {
    setKey(k);
    setHonorific(t?.honorific ?? "");
    setFullName(t?.fullName ?? "");
    setActive(t?.active ?? true);
  }
  const save = useAction(
    () => (t ? patch(`/api/admin/teachers/${t.id}`, { honorific, fullName, active }) : post("/api/admin/teachers", { honorific, fullName })),
    { invalidate: [["teachers"], ["notes"]], success: "Saved", onSuccess: onClose },
  );
  return (
    <Sheet open={value !== null} onOpenChange={(v) => !v && onClose()} title={t ? "Edit teacher" : "Add teacher"}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        <div className="grid grid-cols-[110px_1fr] gap-3">
          <label className="block">
            <span className="label">Title</span>
            <input className="field mt-1.5" value={honorific} onChange={(e) => setHonorific(e.target.value)} placeholder="Ms." maxLength={20} />
          </label>
          <label className="block">
            <span className="label">Full name</span>
            <input className="field mt-1.5" value={fullName} onChange={(e) => setFullName(e.target.value)} required minLength={2} maxLength={100} />
          </label>
        </div>
        <p className="hint">Shown as “{[honorific, fullName].filter(Boolean).join(" ") || "…"}”. Renaming keeps all votes and notes.</p>
        {t ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--color-ink)]" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Active (appears in the student form)
          </label>
        ) : null}
        <button className="btn-primary" disabled={save.isPending || fullName.trim().length < 2}>
          Save
        </button>
      </form>
    </Sheet>
  );
}

function TeacherImport({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<{ honorific: string; fullName: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const run = useAction(() => post<{ created: number; updated: number }>("/api/admin/teachers/import", { rows }), {
    invalidate: [["teachers"]],
    success: (r) => `${r.created} added · ${r.updated} updated`,
    onSuccess: () => (setRows([]), onClose()),
  });
  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()} title="Import teachers">
      <p className="text-sm text-ink-2">
        CSV with header <code>honorific,full_name</code>. Teachers already on the roster (same name) are updated, never duplicated.
      </p>
      <pre className="mt-3 rounded-lg bg-paper p-3 text-xs">honorific,full_name{"\n"}Ms.,Catherine Tan{"\n"}Mr.,Budi Santoso</pre>
      <input
        type="file"
        accept=".csv,text/csv"
        className="mt-4 block text-sm"
        onChange={async (e) => {
          setErr(null);
          const f = e.target.files?.[0];
          if (!f) return;
          const [head, ...body] = parseCsv(await f.text());
          const h = (head ?? []).map((x) => x.toLowerCase().replace(/\s+/g, "_"));
          const iH = h.findIndex((x) => x === "honorific" || x === "title");
          const iN = h.findIndex((x) => x === "full_name" || x === "name");
          if (iN < 0) return setErr("A full_name column is required.");
          setRows(body.filter((r) => r[iN]).map((r) => ({ honorific: iH >= 0 ? r[iH] ?? "" : "", fullName: r[iN]! })));
        }}
      />
      {err ? <Banner tone="bad" className="mt-3">{err}</Banner> : null}
      {rows.length ? (
        <div className="mt-4">
          <p className="text-sm font-medium">{rows.length} teachers ready</p>
          <ul className="mt-2 max-h-60 overflow-y-auto text-sm text-ink-2">
            {rows.map((r, i) => (
              <li key={i}>{[r.honorific, r.fullName].filter(Boolean).join(" ")}</li>
            ))}
          </ul>
          <button className="btn-primary mt-3" disabled={run.isPending} onClick={() => run.mutate(undefined)}>
            Import
          </button>
        </div>
      ) : null}
    </Sheet>
  );
}
