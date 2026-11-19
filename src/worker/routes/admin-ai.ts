import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { ApiError, readJson } from "../lib/http";
import { auditStmt, chunk, nowIso, parseFlags, placeholders, uid } from "../lib/db";
import { teacherDisplayName } from "../../shared/search";
import { AI_FORMAT, parseAiImport, type AiExport } from "../../shared/ai-review";

export const adminAi = new Hono<AppEnv>();

const ACTIVE = "(n.submission_id IS NULL OR s.status = 'active')";

const exportInput = z.object({ onlyUnassigned: z.boolean().optional().default(false) });

/** Creates an export of pending notes and records each note's version. */
adminAi.post("/ai-review/exports", async (c) => {
  const user = c.get("user");
  const { onlyUnassigned } = await readJson(c, exportInput, 1024);
  const { results } = await c.env.DB.prepare(
    `SELECT n.id, n.version, n.char_count, n.grade_label, n.flags, COALESCE(n.display_body, n.body) AS body, t.honorific, t.full_name
       FROM notes n JOIN teachers t ON t.id = n.teacher_id LEFT JOIN submissions s ON s.id = n.submission_id
      WHERE n.status = 'pending' AND ${ACTIVE} ${onlyUnassigned ? "AND n.assigned_reviewer_id IS NULL" : ""}
      ORDER BY n.id`,
  ).all<{ id: string; version: number; char_count: number; grade_label: string | null; flags: string; body: string; honorific: string; full_name: string }>();
  if (!results.length) throw new ApiError(409, "CONFLICT", "There are no pending notes to export.");
  const id = uid("aix");
  const createdAt = nowIso();
  const versions: Record<string, number> = {};
  for (const r of results) versions[r.id] = r.version;
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO ai_review_exports (id, created_at, created_by, note_count, note_versions) VALUES (?, ?, ?, ?, ?)").bind(
      id,
      createdAt,
      user.id,
      results.length,
      JSON.stringify(versions),
    ),
    auditStmt(c.env.DB, user, "ai_review.export", "ai_review", id, { notes: results.length, onlyUnassigned }),
  ]);
  const body: AiExport = {
    format: AI_FORMAT,
    exportId: id,
    createdAt,
    // Only what a reviewer needs: no class, submission, reviewer or timestamps per note.
    notes: results.map((r) => ({
      id: r.id,
      teacher: teacherDisplayName({ honorific: r.honorific, fullName: r.full_name }),
      grade: r.grade_label,
      chars: r.char_count,
      flags: parseFlags(r.flags),
      text: r.body,
    })),
  };
  c.header("cache-control", "no-store");
  return c.json(body, 201);
});

adminAi.get("/ai-review", async (c) => {
  const [exports, imports] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT e.id, e.created_at AS createdAt, e.note_count AS noteCount, u.email AS createdBy
         FROM ai_review_exports e LEFT JOIN users u ON u.id = e.created_by ORDER BY e.created_at DESC LIMIT 20`,
    ),
    c.env.DB.prepare(
      `SELECT i.id, i.export_id AS exportId, i.created_at AS createdAt, i.approved, i.trashed, i.unsure, i.skipped, u.email AS createdBy
         FROM ai_review_imports i LEFT JOIN users u ON u.id = i.created_by ORDER BY i.created_at DESC LIMIT 50`,
    ),
  ]);
  return c.json({ exports: exports!.results, imports: imports!.results });
});

const importInput = z.object({ raw: z.string().min(2).max(600_000), apply: z.boolean().optional().default(false) });

export type SkipReason = "not_in_export" | "duplicate" | "already_reviewed" | "changed_since_export" | "submission_voided" | "note_missing";
interface PlanItem {
  id: string;
  decision: "approve" | "trash" | "unsure";
  reason: string;
  expectedVersion: number;
}

adminAi.post("/ai-review/import", async (c) => {
  const user = c.get("user");
  const { raw, apply } = await readJson(c, importInput, 700 * 1024);
  const parsed = parseAiImport(raw);
  if (!parsed.ok) throw new ApiError(400, "VALIDATION", `The AI reply isn't in the expected format. ${parsed.error}`);
  const input = parsed.value;
  const exp = await c.env.DB.prepare("SELECT id, note_versions, note_count FROM ai_review_exports WHERE id = ?")
    .bind(input.exportId)
    .first<{ id: string; note_versions: string; note_count: number }>();
  if (!exp) throw new ApiError(404, "NOT_FOUND", "That exportId doesn't match any export from this app.");
  const versions = JSON.parse(exp.note_versions) as Record<string, number>;

  const skipped: { id: string; reason: SkipReason }[] = [];
  const seen = new Set<string>();
  const candidates: PlanItem[] = [];
  for (const d of input.decisions) {
    if (seen.has(d.id)) {
      skipped.push({ id: d.id, reason: "duplicate" });
      continue;
    }
    seen.add(d.id);
    const v = versions[d.id];
    if (v === undefined) {
      skipped.push({ id: d.id, reason: "not_in_export" });
      continue;
    }
    candidates.push({ id: d.id, decision: d.decision, reason: d.reason ?? "", expectedVersion: v });
  }

  // Current state of the notes, in parameter-safe chunks.
  const current = new Map<string, { status: string; version: number; sub: string | null }>();
  for (const part of chunk(candidates.map((p) => p.id), 90)) {
    const { results } = await c.env.DB.prepare(
      `SELECT n.id, n.status, n.version, s.status AS sub FROM notes n LEFT JOIN submissions s ON s.id = n.submission_id
        WHERE n.id IN (${placeholders(part.length)})`,
    )
      .bind(...part)
      .all<{ id: string; status: string; version: number; sub: string | null }>();
    for (const r of results) current.set(r.id, { status: r.status, version: r.version, sub: r.sub });
  }
  const plan: PlanItem[] = [];
  for (const p of candidates) {
    const n = current.get(p.id);
    if (!n) skipped.push({ id: p.id, reason: "note_missing" });
    else if (n.sub === "voided") skipped.push({ id: p.id, reason: "submission_voided" });
    else if (n.status !== "pending") skipped.push({ id: p.id, reason: "already_reviewed" });
    else if (n.version !== p.expectedVersion) skipped.push({ id: p.id, reason: "changed_since_export" });
    else plan.push(p);
  }
  const count = (k: PlanItem["decision"]) => plan.filter((p) => p.decision === k).length;
  const summary = {
    exportId: exp.id,
    exportNotes: exp.note_count,
    decisions: input.decisions.length,
    approve: count("approve"),
    trash: count("trash"),
    unsure: count("unsure"),
    skipped,
    notInThisFile: exp.note_count - seen.size + skipped.filter((s) => s.reason === "not_in_export").length,
    plan: plan.map((p) => ({ id: p.id, decision: p.decision, reason: p.reason })),
  };
  if (!apply) return c.json({ applied: false, ...summary });
  if (!plan.length) throw new ApiError(409, "CONFLICT", "Nothing to apply: every decision was skipped.");

  const db = c.env.DB;
  const importId = uid("aii"); // [a-z0-9_] only, safe to inline below
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [
    db.prepare("INSERT INTO ai_review_imports (id, export_id, created_at, created_by, skipped) VALUES (?, ?, ?, ?, ?)").bind(
      importId,
      exp.id,
      now,
      user.id,
      skipped.length,
    ),
  ];
  for (const part of chunk(plan, 25)) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO ai_review_decisions (import_id, note_id, decision, reason, expected_version) VALUES ${part.map(() => `('${importId}', ?, ?, ?, ?)`).join(", ")}`,
        )
        .bind(...part.flatMap((p) => [p.id, p.decision, p.reason || null, p.expectedVersion])),
    );
  }
  const statusGuard = `n.status = 'pending' AND n.version = d.expected_version AND ${ACTIVE}`;
  const reasonText = `'AI review: ' || COALESCE(NULLIF(d.reason, ''), 'no reason given')`;
  const unsureGuard = `NOT EXISTS (SELECT 1 FROM json_each(n.flags) WHERE value = 'ai_unsure')`;
  stmts.push(
    // history rows first, guarded exactly like the update that follows
    db.prepare(
      `INSERT INTO note_events (id, note_id, actor_user_id, action, prev_status, new_status, detail, created_at)
       SELECT 'nev_' || lower(hex(randomblob(10))), n.id, ?, 'status', n.status,
              CASE d.decision WHEN 'approve' THEN 'approved' ELSE 'trashed' END,
              json_object('source', 'ai_import', 'importId', ?, 'reason', d.reason), ?
         FROM notes n JOIN ai_review_decisions d ON d.note_id = n.id AND d.import_id = ?
         LEFT JOIN submissions s ON s.id = n.submission_id
        WHERE d.decision IN ('approve', 'trash') AND ${statusGuard}`,
    ).bind(user.id, importId, now, importId),
    db.prepare(
      `UPDATE notes SET
         status = (SELECT CASE d.decision WHEN 'approve' THEN 'approved' ELSE 'trashed' END FROM ai_review_decisions d WHERE d.import_id = ? AND d.note_id = notes.id),
         status_reason = (SELECT CASE d.decision WHEN 'trash' THEN ${reasonText} END FROM ai_review_decisions d WHERE d.import_id = ? AND d.note_id = notes.id),
         reviewed_by = ?, reviewed_at = ?, version = version + 1, updated_at = ?
       WHERE id IN (
         SELECT n.id FROM notes n JOIN ai_review_decisions d ON d.note_id = n.id AND d.import_id = ?
           LEFT JOIN submissions s ON s.id = n.submission_id
          WHERE d.decision IN ('approve', 'trash') AND ${statusGuard})`,
    ).bind(importId, importId, user.id, now, now, importId),
    db.prepare(
      `INSERT INTO note_events (id, note_id, actor_user_id, action, prev_status, new_status, detail, created_at)
       SELECT 'nev_' || lower(hex(randomblob(10))), n.id, ?, 'flag', n.status, n.status,
              json_object('source', 'ai_import', 'importId', ?, 'flag', 'ai_unsure', 'reason', d.reason), ?
         FROM notes n JOIN ai_review_decisions d ON d.note_id = n.id AND d.import_id = ?
         LEFT JOIN submissions s ON s.id = n.submission_id
        WHERE d.decision = 'unsure' AND ${statusGuard} AND ${unsureGuard}`,
    ).bind(user.id, importId, now, importId),
    // Unsure keeps the note pending for a human; adding a flag isn't a moderation change, so version stays.
    db.prepare(
      `UPDATE notes SET flags = json_insert(flags, '$[#]', 'ai_unsure'), status_reason = (
           SELECT ${reasonText.replace("AI review: ", "AI unsure: ")} FROM ai_review_decisions d WHERE d.import_id = ? AND d.note_id = notes.id),
         updated_at = ?
       WHERE id IN (
         SELECT n.id FROM notes n JOIN ai_review_decisions d ON d.note_id = n.id AND d.import_id = ?
           LEFT JOIN submissions s ON s.id = n.submission_id
          WHERE d.decision = 'unsure' AND ${statusGuard} AND ${unsureGuard})`,
    ).bind(importId, now, importId),
  );
  const res = await db.batch(stmts);
  const n = stmts.length;
  const changed = res[n - 3]!.meta.changes; // approve + trash update
  const unsure = res[n - 1]!.meta.changes;
  const counts = await db
    .prepare(
      `SELECT COALESCE(SUM(d.decision = 'approve' AND n.status = 'approved'), 0) AS approved,
              COALESCE(SUM(d.decision = 'trash' AND n.status = 'trashed'), 0) AS trashed
         FROM ai_review_decisions d JOIN notes n ON n.id = d.note_id WHERE d.import_id = ?`,
    )
    .bind(importId)
    .first<{ approved: number; trashed: number }>();
  const applied = { approved: counts?.approved ?? 0, trashed: counts?.trashed ?? 0, unsure };
  const lateSkips = plan.length - changed - unsure; // changed between preview and apply
  await db.batch([
    db.prepare("UPDATE ai_review_imports SET approved = ?, trashed = ?, unsure = ?, skipped = ? WHERE id = ?").bind(
      applied.approved,
      applied.trashed,
      applied.unsure,
      skipped.length + Math.max(0, lateSkips),
      importId,
    ),
    auditStmt(db, user, "ai_review.import", "ai_review", importId, { exportId: exp.id, ...applied, skipped: skipped.length + Math.max(0, lateSkips) }),
  ]);
  return c.json({ applied: true, importId, ...summary, result: { ...applied, skippedAtApply: Math.max(0, lateSkips) } });
});
