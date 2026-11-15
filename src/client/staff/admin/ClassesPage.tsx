import { useState } from "react";
import { Link } from "wouter";
import clsx from "clsx";
import { Download, Eye, KeyRound, Plus, Upload } from "lucide-react";
import { api, ApiFailure, fmtTime } from "../../lib/api";
import { Empty, PageHeader, Select, StatusChip, parseCsv, patch, post, useAction, useToast } from "../common";
import { Banner, ConfirmDialog, Sheet, Spinner } from "../../components/ui";
import { useClasses, useGrades, type ClassRow } from "./data";

export function ClassesPage() {
  const classes = useClasses();
  const grades = useGrades();
  const toast = useToast();
  const [edit, setEdit] = useState<ClassRow | "new" | null>(null);
  const [rotate, setRotate] = useState<ClassRow | null>(null);
  const [shown, setShown] = useState<Record<string, string>>({});
  const [importOpen, setImportOpen] = useState(false);

  const rotateCode = useAction((id: string) => post<{ code: string }>(`/api/admin/classes/${id}/rotate-code`), {
    invalidate: [["classes"]],
    onSuccess: (r, id) => setShown((s) => ({ ...s, [id]: r.code })),
    success: "New code issued. The old code stops working now.",
  });

  const reveal = async (id: string) => {
    try {
      const r = await api<{ code: string }>(`/api/admin/classes/${id}/code`);
      setShown((s) => ({ ...s, [id]: r.code }));
    } catch (e) {
      toast("bad", e instanceof ApiFailure ? e.message : "Failed");
    }
  };

  return (
    <div>
      <PageHeader
        title="Classes"
        lead="Each class shares one five-character code. Soft quotas never reject a student — extra submissions are accepted and flagged."
        actions={
          <>
            <button className="btn-outline btn-sm" onClick={() => setImportOpen(true)}>
              <Upload aria-hidden className="size-4" /> Import CSV
            </button>
            <a className="btn-outline btn-sm" href="/api/admin/export/classes.csv">
              <Download aria-hidden className="size-4" /> Export
            </a>
            <a className="btn-outline btn-sm" href="/api/admin/export/classes.csv?codes=1">
              <Download aria-hidden className="size-4" /> Export with codes
            </a>
            <button className="btn-primary btn-sm" onClick={() => setEdit("new")}>
              <Plus aria-hidden className="size-4" /> Add class
            </button>
          </>
        }
      />
      {classes.isPending ? (
        <Spinner />
      ) : !classes.data?.length ? (
        <Empty title="No classes yet">Add classes one by one or import a CSV with columns: class, grade, expected_students, soft_quota.</Empty>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-[12px] text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-medium">Class</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Code</th>
                <th className="px-3 py-2 text-right font-medium">Expected</th>
                <th className="px-3 py-2 text-right font-medium">Soft quota</th>
                <th className="px-3 py-2 text-right font-medium">Active</th>
                <th className="px-3 py-2 text-right font-medium">Voided</th>
                <th className="px-3 py-2 text-right font-medium">Received</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {classes.data.map((c) => {
                const over = c.activeSubmissions > c.softQuota;
                return (
                  <tr key={c.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2.5">
                      <span className="font-medium">{c.label}</span> <span className="text-muted">{c.grade}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusChip status={c.status} />
                    </td>
                    <td className="px-3 py-2.5">
                      {shown[c.id] ? (
                        <span className="font-semibold tracking-[0.2em] tabular">{shown[c.id]}</span>
                      ) : (
                        <button className="btn-ghost btn-sm -ml-3" onClick={() => void reveal(c.id)} aria-label={`Show code for ${c.label}`}>
                          <Eye aria-hidden className="size-4" /> Show
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular">{c.expectedStudents}</td>
                    <td className="px-3 py-2.5 text-right tabular">{c.softQuota}</td>
                    <td className={clsx("px-3 py-2.5 text-right tabular", over && "font-semibold text-bad")}>
                      <Link className="hover:underline" href={`/submissions?classId=${c.id}`}>
                        {c.activeSubmissions}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular text-ink-2">{c.voidedSubmissions}</td>
                    <td className="px-3 py-2.5 text-right tabular text-ink-2">{c.rawSubmissions}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <Link className="btn-ghost btn-sm" href={`/notes?classId=${c.id}`}>
                        Notes
                      </Link>
                      <button className="btn-ghost btn-sm" onClick={() => setRotate(c)}>
                        <KeyRound aria-hidden className="size-4" /> Rotate
                      </button>
                      <button className="btn-ghost btn-sm" onClick={() => setEdit(c)}>
                        Edit
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {classes.data?.some((c) => c.activeSubmissions > c.softQuota) ? (
        <Banner tone="warn" className="mt-4" title="Over the recommended maximum">
          {classes.data
            .filter((c) => c.activeSubmissions > c.softQuota)
            .map((c) => `Class ${c.label} — ${c.activeSubmissions} submissions / ${c.softQuota} recommended maximum`)
            .join(" · ")}
          . Review them on the Submissions page.
        </Banner>
      ) : null}

      <ClassEditor
        value={edit}
        grades={grades.data ?? []}
        onClose={() => setEdit(null)}
        onCreated={(id, code) => setShown((s) => ({ ...s, [id]: code }))}
      />
      <ConfirmDialog
        open={rotate !== null}
        onOpenChange={(v) => !v && setRotate(null)}
        title={`Rotate the code for ${rotate?.label}?`}
        description="The current code stops working immediately. Students with saved drafts keep their answers and will be asked for the new code."
        confirmLabel="Issue new code"
        busy={rotateCode.isPending}
        onConfirm={() => {
          if (rotate) rotateCode.mutate(rotate.id);
          setRotate(null);
        }}
      />
      <ClassImport open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}

function ClassEditor({
  value,
  grades,
  onClose,
  onCreated,
}: {
  value: ClassRow | "new" | null;
  grades: { id: string; label: string }[];
  onClose: () => void;
  onCreated: (id: string, code: string) => void;
}) {
  const isNew = value === "new";
  const c = value && value !== "new" ? value : null;
  const [label, setLabel] = useState("");
  const [gradeId, setGradeId] = useState("");
  const [expected, setExpected] = useState("25");
  const [quota, setQuota] = useState("");
  const [status, setStatus] = useState<ClassRow["status"]>("active");
  const [key, setKey] = useState<string | null>(null);
  const k = isNew ? "new" : c?.id ?? null;
  if (k !== key) {
    setKey(k);
    setLabel(c?.label ?? "");
    setGradeId(c?.gradeId ?? grades[0]?.id ?? "");
    setExpected(String(c?.expectedStudents ?? 25));
    setQuota(c ? String(c.softQuota) : "");
    setStatus(c?.status ?? "active");
  }
  const save = useAction(
    async () => {
      const body = {
        label,
        gradeId,
        expectedStudents: Number(expected),
        ...(quota !== "" ? { softQuota: Number(quota) } : {}),
      };
      if (isNew) {
        const r = await post<{ id: string; code: string }>("/api/admin/classes", body);
        onCreated(r.id, r.code);
        return r;
      }
      return patch(`/api/admin/classes/${c!.id}`, { ...body, status });
    },
    { invalidate: [["classes"], ["overview"]], success: isNew ? "Class added with a new code" : "Class saved", onSuccess: onClose },
  );
  return (
    <Sheet open={value !== null} onOpenChange={(v) => !v && onClose()} title={isNew ? "Add class" : `Edit ${c?.label ?? ""}`}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        <label className="block">
          <span className="label">Class name</span>
          <input className="field mt-1.5" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Secondary 2B" required maxLength={80} />
        </label>
        <Select label="Grade level" value={gradeId} onChange={(e) => setGradeId(e.target.value)}>
          {grades.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label}
            </option>
          ))}
        </Select>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="label">Expected students</span>
            <input className="field mt-1.5 tabular" type="number" min={0} max={500} value={expected} onChange={(e) => setExpected(e.target.value)} />
          </label>
          <label className="block">
            <span className="label">Soft quota</span>
            <input
              className="field mt-1.5 tabular"
              type="number"
              min={0}
              max={1000}
              value={quota}
              placeholder={`${Number(expected || 0) + 5} (default)`}
              onChange={(e) => setQuota(e.target.value)}
            />
          </label>
        </div>
        {!isNew ? (
          <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value as ClassRow["status"])}>
            <option value="active">Active — accepting responses</option>
            <option value="paused">Paused — code recognised, submissions on hold</option>
            <option value="disabled">Disabled — code rejected</option>
          </Select>
        ) : null}
        {c?.codeRotatedAt ? <p className="hint">Code last issued {fmtTime(c.codeRotatedAt)}.</p> : null}
        <button className="btn-primary" disabled={save.isPending || !label.trim() || !gradeId}>
          {save.isPending ? <Spinner /> : null} {isNew ? "Add class" : "Save"}
        </button>
      </form>
    </Sheet>
  );
}

function ClassImport({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<{ label: string; grade: string; expectedStudents: number; softQuota?: number }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: { label: string; code: string }[]; updated: number } | null>(null);
  const run = useAction(() => post<{ created: { label: string; code: string }[]; updated: number }>("/api/admin/classes/import", { rows }), {
    invalidate: [["classes"], ["grades"], ["overview"]],
    onSuccess: (r) => setResult(r),
  });
  const onFile = async (f: File) => {
    setErr(null);
    setResult(null);
    const data = parseCsv(await f.text());
    const [head, ...body] = data;
    if (!head) return setErr("The file is empty.");
    const h = head.map((x) => x.toLowerCase().replace(/\s+/g, "_"));
    const iL = h.findIndex((x) => x === "class" || x === "label" || x === "class_label");
    const iG = h.findIndex((x) => x === "grade" || x === "grade_level");
    const iE = h.findIndex((x) => x.startsWith("expected"));
    const iQ = h.findIndex((x) => x.includes("quota"));
    if (iL < 0 || iG < 0 || iE < 0) return setErr("Columns needed: class, grade, expected_students (soft_quota optional).");
    const parsed = body.map((r, i) => {
      const e = Number(r[iE]);
      const q = iQ >= 0 && r[iQ] ? Number(r[iQ]) : undefined;
      if (!r[iL] || !r[iG] || !Number.isInteger(e) || (q !== undefined && !Number.isInteger(q))) throw new Error(`Row ${i + 2} is incomplete.`);
      return { label: r[iL]!, grade: r[iG]!, expectedStudents: e, ...(q !== undefined ? { softQuota: q } : {}) };
    });
    setRows(parsed);
  };
  return (
    <Sheet open={open} onOpenChange={(v) => !v && (onClose(), setRows([]), setResult(null))} title="Import classes">
      <p className="text-sm text-ink-2">
        CSV with header <code>class,grade,expected_students,soft_quota</code>. Existing classes (same name) are updated; new ones get a fresh code. Unknown grades are created.
      </p>
      <pre className="mt-3 rounded-lg bg-paper p-3 text-xs">class,grade,expected_students,soft_quota{"\n"}Secondary 1A,Sec 1,25,30{"\n"}Junior College 2A,JC2,22,</pre>
      <input
        type="file"
        accept=".csv,text/csv"
        className="mt-4 block text-sm"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f).catch((x: Error) => setErr(x.message));
        }}
      />
      {err ? <Banner tone="bad" className="mt-3">{err}</Banner> : null}
      {rows.length && !result ? (
        <div className="mt-4">
          <p className="text-sm font-medium">{rows.length} rows ready</p>
          <ul className="mt-2 max-h-60 overflow-y-auto text-sm text-ink-2">
            {rows.map((r) => (
              <li key={r.label}>
                {r.label} · {r.grade} · {r.expectedStudents} expected{r.softQuota !== undefined ? ` · quota ${r.softQuota}` : ""}
              </li>
            ))}
          </ul>
          <button className="btn-primary mt-3" disabled={run.isPending} onClick={() => run.mutate(undefined)}>
            Import {rows.length} classes
          </button>
        </div>
      ) : null}
      {result ? (
        <Banner tone="ok" className="mt-4" title={`${result.created.length} created · ${result.updated} updated`}>
          {result.created.length ? (
            <ul className="mt-1 tabular">
              {result.created.map((c) => (
                <li key={c.label}>
                  {c.label}: <strong className="tracking-[0.15em]">{c.code}</strong>
                </li>
              ))}
            </ul>
          ) : null}
        </Banner>
      ) : null}
    </Sheet>
  );
}
