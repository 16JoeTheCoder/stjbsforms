import { useEffect, useState } from "react";
import { Download, FileText, Package } from "lucide-react";
import { zipSync } from "fflate";
import { api, ApiFailure, downloadBlob, fmtTime } from "../../lib/api";
import type { PrintSnapshot } from "../../../shared/types";
import { PageHeader, Select } from "../common";
import { Banner, Spinner } from "../../components/ui";
import type { LayoutProblem } from "../../pdf/engine";
import { NoteDetail } from "./NotesBoard";

type Engine = typeof import("../../pdf/engine");
const loadEngine = async () => {
  const [engine, fonts] = await Promise.all([import("../../pdf/engine"), import("../../pdf/fonts")]);
  return { engine: engine as Engine, fonts: await fonts.loadFonts() };
};

export function PrintPage() {
  const [seed, setSeed] = useState("");
  const [snap, setSnap] = useState<PrintSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<LayoutProblem[]>([]);
  const [preview, setPreview] = useState<{ url: string; name: string; pages: number; blob: Blob } | null>(null);
  const [teacherId, setTeacherId] = useState("");
  const [openNote, setOpenNote] = useState<string | null>(null);

  useEffect(() => () => (preview ? URL.revokeObjectURL(preview.url) : undefined), [preview]);

  const snapshot = async () => {
    const s = await api<PrintSnapshot>(`/api/admin/print/snapshot${seed ? `?seed=${encodeURIComponent(seed)}` : ""}`);
    setSnap(s);
    if (!seed) setSeed(s.seed);
    return s;
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setProblems([]);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  };

  const showPdf = (bytes: Uint8Array, name: string, pages: number) => {
    const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview({ url: URL.createObjectURL(blob), name, pages, blob });
  };

  const mosaic = () =>
    run("mosaic", async () => {
      const s = await snapshot();
      if (!s.notes.length) throw new Error("There are no approved notes to print yet.");
      const { engine, fonts } = await loadEngine();
      const r = await engine.buildMosaic(s.notes, fonts, { seed: s.seed, councilLabel: s.showCouncilLabel, title: "Teacher's Day 2026" });
      if (r.problems.length) {
        setProblems(r.problems);
        return;
      }
      if (r.order.length !== s.notes.length || new Set(r.order).size !== s.notes.length) throw new Error("Completeness check failed: note count mismatch.");
      showPdf(r.bytes!, `appreciation-wall-${s.seed}.pdf`, r.pages);
    });

  const keepsake = () =>
    run("keepsake", async () => {
      const s = await snapshot();
      const t = s.teachers.find((x) => x.id === teacherId);
      if (!t) throw new Error("Choose a teacher.");
      const notes = s.notes.filter((n) => n.teacherId === t.id);
      if (!notes.length) throw new Error(`${t.name} has no approved notes yet.`);
      const { engine, fonts } = await loadEngine();
      const r = await engine.buildKeepsake(t.name, notes, fonts, { councilLabel: s.showCouncilLabel });
      if (r.problems.length) return setProblems(r.problems);
      showPdf(r.bytes!, `keepsake-${engine.slug(t.name)}.pdf`, r.pages);
    });

  const allKeepsakes = () =>
    run("zip", async () => {
      const s = await snapshot();
      const { engine, fonts } = await loadEngine();
      const files: Record<string, Uint8Array> = {};
      const probs: LayoutProblem[] = [];
      const used = new Set<string>();
      for (const t of s.teachers.filter((x) => x.active)) {
        const notes = s.notes.filter((n) => n.teacherId === t.id);
        if (!notes.length) continue;
        const r = await engine.buildKeepsake(t.name, notes, fonts, { councilLabel: s.showCouncilLabel });
        probs.push(...r.problems);
        if (r.bytes) {
          let name = `keepsake-${engine.slug(t.name)}.pdf`;
          for (let i = 2; used.has(name); i++) name = `keepsake-${engine.slug(t.name)}-${i}.pdf`;
          used.add(name);
          files[name] = r.bytes;
        }
      }
      if (probs.length) return setProblems(probs);
      if (!Object.keys(files).length) throw new Error("No teacher has approved notes yet.");
      downloadBlob(new Blob([zipSync(files, { level: 0 }) as BlobPart], { type: "application/zip" }), `keepsakes-${new Date().toISOString().slice(0, 10)}.zip`);
    });

  const teachersWithNotes = snap?.teachers.filter((t) => t.active) ?? [];

  return (
    <div>
      <PageHeader
        title="Print & export"
        lead="PDFs are built in your browser from one consistent snapshot of approved notes. Trashed notes, voided submissions and inactive teachers are left out. Nothing is clipped: if a note can't fit, you'll be told which one."
      />
      <div className="grid gap-5 xl:grid-cols-2">
        <section className="card p-5">
          <h2 className="font-semibold">Appreciation wall (A4 mosaic)</h2>
          <p className="mt-1 text-sm text-ink-2">
            Six notes per A4 page in a 2 × 3 grid, shuffled so teachers are mixed, with sheet numbers in the margin. The same seed always gives the same order.
          </p>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-[13px] font-medium text-ink-2">
              Shuffle seed
              <input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="from Settings" className="h-10 w-56 rounded-lg border border-line-strong bg-card px-3 text-sm text-ink focus:border-ink focus:outline-none" />
            </label>
            <button className="btn-primary btn-sm h-10" onClick={mosaic} disabled={busy !== null}>
              {busy === "mosaic" ? <Spinner /> : <FileText aria-hidden className="size-4" />} Build preview
            </button>
          </div>
        </section>
        <section className="card p-5">
          <h2 className="font-semibold">Teacher keepsakes</h2>
          <p className="mt-1 text-sm text-ink-2">One clean A4 document per teacher with all their approved notes. No author or class details.</p>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <Select label="Teacher" value={teacherId} onFocus={() => !snap && void snapshot().catch(() => undefined)} onChange={(e) => setTeacherId(e.target.value)}>
              <option value="">Choose…</option>
              {teachersWithNotes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({snap!.notes.filter((n) => n.teacherId === t.id).length})
                </option>
              ))}
            </Select>
            <button className="btn-outline btn-sm h-10" onClick={keepsake} disabled={busy !== null || !teacherId}>
              {busy === "keepsake" ? <Spinner /> : <FileText aria-hidden className="size-4" />} Preview
            </button>
            <button className="btn-outline btn-sm h-10" onClick={allKeepsakes} disabled={busy !== null}>
              {busy === "zip" ? <Spinner /> : <Package aria-hidden className="size-4" />} All teachers (ZIP)
            </button>
          </div>
        </section>
      </div>

      {snap ? (
        <p className="mt-4 text-sm text-muted">
          Snapshot {fmtTime(snap.snapshotAt)} · {snap.notes.length} approved notes · {snap.teachers.filter((t) => t.active).length} active teachers
        </p>
      ) : null}
      {error ? <Banner tone="bad" className="mt-4" title="Couldn't build the PDF">{error}</Banner> : null}
      {problems.length ? (
        <Banner tone="bad" className="mt-4" title={`${problems.length} note${problems.length === 1 ? "" : "s"} can't be printed as-is`}>
          <p>Nothing was generated, so no note is silently dropped. Fix these by editing their print text, then build again.</p>
          <ul className="mt-2 space-y-1">
            {problems.map((p) => (
              <li key={p.noteId + p.kind}>
                <strong>{p.teacherName}</strong> — {p.kind === "unsupported_characters" ? `characters the print font can't show: ${p.detail}` : p.detail}{" "}
                {p.noteId !== "-" ? (
                  <button className="font-medium underline" onClick={() => setOpenNote(p.noteId)}>
                    Edit print text
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}

      {preview ? (
        <section className="mt-6">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">
              {preview.name} · {preview.pages} page{preview.pages === 1 ? "" : "s"}
            </p>
            <button className="btn-fire btn-sm" onClick={() => downloadBlob(preview.blob, preview.name)}>
              <Download aria-hidden className="size-4" /> Download PDF
            </button>
          </div>
          <iframe title="PDF preview" src={preview.url} className="h-[80vh] w-full rounded-xl border border-line bg-paper-2" />
        </section>
      ) : null}
      <NoteDetail id={openNote} onClose={() => setOpenNote(null)} />
    </div>
  );
}
