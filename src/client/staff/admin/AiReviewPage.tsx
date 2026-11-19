import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Download, FileUp, ShieldCheck } from "lucide-react";
import { zipSync, strToU8 } from "fflate";
import { api, ApiFailure, downloadBlob, fmtTime } from "../../lib/api";
import { AI_MAX_DECISIONS, batchExport, buildAiPrompt, type AiExport } from "../../../shared/ai-review";
import { Empty, PageHeader, Select, Stat, post, useToast } from "../common";
import { Banner, ConfirmDialog, Spinner } from "../../components/ui";
import { NoteDetail } from "./NotesBoard";

interface Preview {
  applied: boolean;
  importId?: string;
  exportId: string;
  exportNotes: number;
  decisions: number;
  approve: number;
  trash: number;
  unsure: number;
  skipped: { id: string; reason: string }[];
  notInThisFile: number;
  plan: { id: string; decision: "approve" | "trash" | "unsure"; reason: string }[];
  result?: { approved: number; trashed: number; unsure: number; skippedAtApply: number };
}

const SKIP_LABEL: Record<string, string> = {
  not_in_export: "not part of this export",
  duplicate: "listed more than once",
  already_reviewed: "already reviewed by a person or an earlier import",
  changed_since_export: "changed since the export",
  submission_voided: "its submission was voided",
  note_missing: "note no longer exists",
};

export function AiReviewPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const history = useQuery({
    queryKey: ["ai-review"],
    queryFn: () =>
      api<{
        exports: { id: string; createdAt: string; noteCount: number; createdBy: string | null }[];
        imports: { id: string; exportId: string; createdAt: string; approved: number; trashed: number; unsure: number; skipped: number; createdBy: string | null }[];
      }>("/api/admin/ai-review"),
  });

  // ---- export
  const [onlyUnassigned, setOnlyUnassigned] = useState(false);
  const [batchSize, setBatchSize] = useState(150);
  const [exp, setExp] = useState<AiExport | null>(null);
  const [exporting, setExporting] = useState(false);
  const batches = useMemo(() => (exp ? batchExport(exp, batchSize) : []), [exp, batchSize]);
  const prompts = useMemo(() => batches.map((b, i) => buildAiPrompt(b, { index: i + 1, total: batches.length })), [batches]);

  const doExport = async () => {
    setExporting(true);
    try {
      const e = await post<AiExport>("/api/admin/ai-review/exports", { onlyUnassigned });
      setExp(e);
      void qc.invalidateQueries({ queryKey: ["ai-review"] });
    } catch (e) {
      toast("bad", e instanceof ApiFailure ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };
  const downloadPrompts = () => {
    if (!exp) return;
    const day = exp.createdAt.slice(0, 10);
    if (prompts.length === 1) {
      downloadBlob(new Blob([prompts[0]!], { type: "text/markdown" }), `ai-review-${day}-${exp.exportId}.md`);
      return;
    }
    const files: Record<string, Uint8Array> = {};
    prompts.forEach((p, i) => (files[`ai-review-${day}-batch-${String(i + 1).padStart(2, "0")}-of-${prompts.length}.md`] = strToU8(p)));
    downloadBlob(new Blob([zipSync(files) as BlobPart], { type: "application/zip" }), `ai-review-${day}-${exp.exportId}.zip`);
  };

  // ---- import
  const [raw, setRaw] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [applying, setApplying] = useState(false);
  const [openNote, setOpenNote] = useState<string | null>(null);

  const check = async (text = raw) => {
    setChecking(true);
    setError(null);
    setPreview(null);
    try {
      setPreview(await post<Preview>("/api/admin/ai-review/import", { raw: text, apply: false }));
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Couldn't read that reply.");
    } finally {
      setChecking(false);
    }
  };
  const applyImport = async () => {
    setApplying(true);
    try {
      const r = await post<Preview>("/api/admin/ai-review/import", { raw, apply: true });
      setPreview(r);
      toast("ok", `Applied: ${r.result!.approved} approved, ${r.result!.trashed} trashed, ${r.result!.unsure} flagged unsure`);
      for (const k of [["ai-review"], ["notes"], ["overview"], ["teachers"], ["assignments"]]) void qc.invalidateQueries({ queryKey: k });
    } catch (e) {
      toast("bad", e instanceof ApiFailure ? e.message : "Import failed");
    } finally {
      setApplying(false);
      setConfirm(false);
    }
  };

  const skippedBy = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of preview?.skipped ?? []) m.set(s.reason, (m.get(s.reason) ?? 0) + 1);
    return [...m];
  }, [preview]);

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="AI review"
        lead="Review notes with an AI assistant outside this app. Export pending notes with instructions, give the file to the AI, then paste its reply here. You see a preview before anything changes, and every change is logged and reversible."
      />

      <ol className="grid gap-5 lg:grid-cols-2">
        <li className="card p-5">
          <p className="text-xs font-semibold text-muted">Step 1</p>
          <h2 className="mt-0.5 font-semibold">Export notes for the AI</h2>
          <p className="mt-1 text-sm text-ink-2">
            Only pending notes are exported, with teacher name, grade and text. No class, submission or reviewer details leave the app.
          </p>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <Select label="Notes per file" value={String(batchSize)} onChange={(e) => setBatchSize(Number(e.target.value))}>
              {[100, 150, 250, AI_MAX_DECISIONS].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
            <label className="flex h-10 items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-[var(--color-ink)]" checked={onlyUnassigned} onChange={(e) => setOnlyUnassigned(e.target.checked)} />
              Only notes not assigned to a reviewer
            </label>
          </div>
          <button className="btn-primary btn-sm mt-4" onClick={() => void doExport()} disabled={exporting}>
            {exporting ? <Spinner /> : null} Create export
          </button>
          {exp ? (
            <div className="mt-4 rounded-xl bg-paper p-4 text-sm">
              <p>
                <strong className="tabular">{exp.notes.length}</strong> pending notes in <strong className="tabular">{batches.length}</strong> file
                {batches.length === 1 ? "" : "s"}. Export id <code className="text-[13px]">{exp.exportId}</code>.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button className="btn-fire btn-sm" onClick={downloadPrompts}>
                  <Download aria-hidden className="size-4" /> Download {batches.length === 1 ? "prompt file (.md)" : "prompt files (.zip)"}
                </button>
                <button
                  className="btn-outline btn-sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(prompts[0]!).then(() => toast("ok", batches.length > 1 ? "Batch 1 copied" : "Prompt copied"));
                  }}
                >
                  <Copy aria-hidden className="size-4" /> Copy {batches.length > 1 ? "batch 1" : "prompt"}
                </button>
              </div>
              <p className="mt-3 text-ink-2">
                Give each file to the AI (attach it or paste it). It replies with JSON only. Paste each reply into Step 2 — batches can be imported one at a time.
              </p>
              <details className="mt-3">
                <summary className="cursor-pointer font-medium">Preview the instructions</summary>
                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-card p-3 text-xs leading-relaxed">
                  {prompts[0]!.split("## Field guide")[0]}
                </pre>
              </details>
            </div>
          ) : null}
        </li>

        <li className="card p-5">
          <p className="text-xs font-semibold text-muted">Step 2</p>
          <h2 className="mt-0.5 font-semibold">Import the AI's decisions</h2>
          <p className="mt-1 text-sm text-ink-2">
            Paste the AI's reply or upload it. Notes a person changed after the export are never overwritten.
          </p>
          <textarea
            aria-label="AI reply"
            className="field mt-3 h-44 py-3 font-mono text-xs"
            placeholder='{"format": "stjb-ai-review-v1", "exportId": "…", "decisions": [ … ] }'
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              setPreview(null);
            }}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="btn-outline btn-sm cursor-pointer">
              <FileUp aria-hidden className="size-4" /> Upload file
              <input
                type="file"
                accept=".json,.txt,.md,application/json,text/plain"
                className="sr-only"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const t = await f.text();
                  setRaw(t);
                  void check(t);
                  e.target.value = "";
                }}
              />
            </label>
            <button className="btn-primary btn-sm" disabled={!raw.trim() || checking} onClick={() => void check()}>
              {checking ? <Spinner /> : <ShieldCheck aria-hidden className="size-4" />} Check (no changes)
            </button>
          </div>
          {error ? <Banner tone="bad" className="mt-3">{error}</Banner> : null}
        </li>
      </ol>

      {preview ? (
        <section className="card mt-6 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">{preview.applied ? "Import applied" : "Preview — nothing has changed yet"}</h2>
            {!preview.applied ? (
              <button
                className="btn-fire btn-sm"
                disabled={preview.approve + preview.trash + preview.unsure === 0}
                onClick={() => setConfirm(true)}
              >
                <Check aria-hidden className="size-4" /> Apply {preview.approve + preview.trash + preview.unsure} decisions
              </button>
            ) : null}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Approve" value={preview.applied ? preview.result!.approved : preview.approve} tone="ok" />
            <Stat label="Move to Trash" value={preview.applied ? preview.result!.trashed : preview.trash} />
            <Stat label="Unsure → human" value={preview.applied ? preview.result!.unsure : preview.unsure} tone={preview.unsure ? "warn" : undefined} />
            <Stat label="Skipped" value={preview.skipped.length + (preview.result?.skippedAtApply ?? 0)} />
          </div>
          <p className="mt-3 text-sm text-ink-2">
            Export {preview.exportId}: {preview.exportNotes} notes, {preview.decisions} decisions in this reply.
            {preview.notInThisFile > 0 ? ` ${preview.notInThisFile} exported notes have no decision here (expected if you're importing batches).` : ""}
          </p>
          {skippedBy.length ? (
            <ul className="mt-2 list-disc pl-5 text-sm text-ink-2">
              {skippedBy.map(([reason, n]) => (
                <li key={reason}>
                  {n} skipped — {SKIP_LABEL[reason] ?? reason}
                </li>
              ))}
            </ul>
          ) : null}
          {preview.plan.some((p) => p.decision !== "approve") ? (
            <details className="mt-4" open={!preview.applied}>
              <summary className="cursor-pointer text-sm font-medium">Trash and unsure decisions with the AI's reasons (click an id to read the note)</summary>
              <table className="mt-2 w-full text-sm">
                <tbody>
                  {preview.plan
                    .filter((p) => p.decision !== "approve")
                    .map((p) => (
                      <tr key={p.id} className="border-b border-line last:border-0">
                        <td className="py-1.5 pr-3">
                          <button className="font-mono text-xs text-ink-2 underline underline-offset-2 hover:text-ink" onClick={() => setOpenNote(p.id)}>
                            {p.id}
                          </button>
                        </td>
                        <td className="py-1.5 pr-3">
                          <span className={p.decision === "trash" ? "chip bg-bad-soft text-bad" : "chip bg-warn-soft text-warn"}>
                            {p.decision === "trash" ? "Trash" : "Unsure"}
                          </span>
                        </td>
                        <td className="py-1.5 text-ink-2">{p.reason || "—"}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </details>
          ) : null}
          {preview.applied ? (
            <p className="mt-4 text-sm text-ink-2">
              Unsure notes stay pending with an “AI unsure” flag — find them on the Notes board with the Flagged filter. Trashed notes can be restored from Trash.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className="mb-3 font-semibold">History</h2>
        {history.isPending ? (
          <Spinner />
        ) : !history.data?.exports.length ? (
          <Empty title="No AI reviews yet">Exports and imports will be listed here.</Empty>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[12px] text-muted">
                <tr className="border-b border-line">
                  <th className="px-4 py-2 font-medium">Export</th>
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 text-right font-medium">Notes</th>
                  <th className="px-4 py-2 font-medium">Imports (approved / trashed / unsure / skipped)</th>
                </tr>
              </thead>
              <tbody>
                {history.data.exports.map((e) => {
                  const imps = history.data!.imports.filter((i) => i.exportId === e.id);
                  return (
                    <tr key={e.id} className="border-b border-line last:border-0 align-top">
                      <td className="px-4 py-2.5 font-mono text-xs">{e.id}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {fmtTime(e.createdAt)}
                        <span className="block text-xs text-muted">{e.createdBy}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular">{e.noteCount}</td>
                      <td className="px-4 py-2.5 tabular">
                        {imps.length
                          ? imps.map((i) => (
                              <span key={i.id} className="block">
                                {fmtTime(i.createdAt)}: {i.approved} / {i.trashed} / {i.unsure} / {i.skipped}
                              </span>
                            ))
                          : <span className="text-muted">Not imported yet</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <NoteDetail id={openNote} onClose={() => setOpenNote(null)} />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Apply the AI's decisions?"
        description={
          preview
            ? `${preview.approve} notes will be approved, ${preview.trash} moved to Trash (restorable), and ${preview.unsure} flagged for a person to check. Notes changed since the export are skipped. Everything is logged.`
            : ""
        }
        confirmLabel="Apply"
        tone="fire"
        busy={applying}
        onConfirm={() => void applyImport()}
      />
    </div>
  );
}
