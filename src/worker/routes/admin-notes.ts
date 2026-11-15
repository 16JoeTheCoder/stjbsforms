import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { ApiError, notFound, readJson } from "../lib/http";
import { auditStmt, chunk, getSettings, nowIso, placeholders, uid } from "../lib/db";
import { sha256Hex } from "../lib/crypto";
import { changeNoteStatus, decodeCursor, encodeCursor, NOTE_SELECT, toAdminNote, type NoteRow } from "../lib/notes";
import {
  bulkStatusChange,
  councilNote,
  displayEdit,
  distribute,
  id as idSchema,
  manualAssign,
  noteStatus,
  rebalance,
  statusChange,
  voidInput,
} from "../../shared/schemas";
import { cleanNoteText, countChars, normalizeForCompare, noteProblem, NOTE_MAX_CHARS } from "../../shared/text";
import { teacherDisplayName } from "../../shared/search";
import type { AdminNote, Page, PrintSnapshot } from "../../shared/types";

export const adminNotes = new Hono<AppEnv>();

const ACTIVE = "(n.submission_id IS NULL OR s.status = 'active')";

const noteQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: noteStatus.optional(),
  teacherId: idSchema.optional(),
  classId: idSchema.optional(),
  grade: z.string().max(20).optional(),
  reviewerId: z.union([idSchema, z.literal("none")]).optional(),
  source: z.enum(["student", "council"]).optional(),
  maxChars: z.coerce.number().int().min(0).max(NOTE_MAX_CHARS).optional(),
  minChars: z.coerce.number().int().min(0).max(NOTE_MAX_CHARS).optional(),
  overQuota: z.enum(["1"]).optional(),
  flagged: z.enum(["1"]).optional(),
  submission: z.enum(["active", "voided", "all"]).optional().default("active"),
  submissionId: idSchema.optional(),
  order: z.enum(["newest", "oldest"]).optional().default("newest"),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(120).optional().default(48),
});

function buildNoteWhere(f: z.infer<typeof noteQuery>) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.submission === "active") where.push(ACTIVE);
  else if (f.submission === "voided") where.push("s.status = 'voided'");
  if (f.status) (where.push("n.status = ?"), args.push(f.status));
  if (f.teacherId) (where.push("n.teacher_id = ?"), args.push(f.teacherId));
  if (f.classId) (where.push("n.class_id = ?"), args.push(f.classId));
  if (f.grade) (where.push("n.grade_label = ?"), args.push(f.grade));
  if (f.reviewerId === "none") where.push("n.assigned_reviewer_id IS NULL");
  else if (f.reviewerId) (where.push("n.assigned_reviewer_id = ?"), args.push(f.reviewerId));
  if (f.source) (where.push("n.source = ?"), args.push(f.source));
  if (f.maxChars !== undefined) (where.push("n.char_count <= ?"), args.push(f.maxChars));
  if (f.minChars !== undefined) (where.push("n.char_count >= ?"), args.push(f.minChars));
  if (f.overQuota) where.push("s.over_quota = 1");
  if (f.flagged) where.push("(n.flags != '[]' OR s.over_quota = 1)");
  if (f.submissionId) (where.push("n.submission_id = ?"), args.push(f.submissionId));
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
    where.push("(n.body LIKE ? ESCAPE '\\' OR COALESCE(n.display_body,'') LIKE ? ESCAPE '\\' OR t.full_name LIKE ? ESCAPE '\\')");
    args.push(like, like, like);
  }
  return { where, args };
}

adminNotes.get("/notes", async (c) => {
  const p = noteQuery.safeParse(c.req.query());
  if (!p.success) throw new ApiError(400, "VALIDATION", "Invalid filters.");
  const f = p.data;
  const { where, args } = buildNoteWhere(f);
  const countWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const cur = decodeCursor(f.cursor);
  const pageWhere = [...where];
  const pageArgs = [...args];
  if (cur) {
    pageWhere.push(f.order === "oldest" ? "(n.created_at, n.id) > (?, ?)" : "(n.created_at, n.id) < (?, ?)");
    pageArgs.push(cur.createdAt, cur.id);
  }
  const dir = f.order === "oldest" ? "ASC" : "DESC";
  const [rows, total] = await Promise.all([
    c.env.DB.prepare(
      `${NOTE_SELECT} ${pageWhere.length ? `WHERE ${pageWhere.join(" AND ")}` : ""}
       ORDER BY n.created_at ${dir}, n.id ${dir} LIMIT ?`,
    )
      .bind(...pageArgs, f.limit + 1)
      .all<NoteRow>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM notes n JOIN teachers t ON t.id = n.teacher_id
         LEFT JOIN submissions s ON s.id = n.submission_id ${countWhere}`,
    )
      .bind(...args)
      .first<{ n: number }>(),
  ]);
  const items = rows.results.slice(0, f.limit).map(toAdminNote);
  const last = rows.results.length > f.limit ? rows.results[f.limit - 1]! : null;
  const page: Page<AdminNote> = {
    items,
    nextCursor: last ? encodeCursor(last.created_at, last.id) : null,
    total: total?.n ?? 0,
  };
  return c.json(page);
});

adminNotes.get("/notes/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(`${NOTE_SELECT} WHERE n.id = ?`).bind(id).first<NoteRow>();
  if (!row) throw notFound("Note not found");
  const { results: events } = await c.env.DB.prepare(
    `SELECT e.id, e.action, e.prev_status, e.new_status, e.detail, e.created_at, u.email AS actor
       FROM note_events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.note_id = ? ORDER BY e.created_at DESC LIMIT 100`,
  )
    .bind(id)
    .all();
  return c.json({ note: toAdminNote(row), events });
});

adminNotes.post("/notes/:id/status", async (c) => {
  const body = await readJson(c, statusChange, 4096);
  const row = await changeNoteStatus(c.env.DB, c.get("user"), c.req.param("id"), body.version, body.status, body.reason);
  return c.json(toAdminNote(row));
});

adminNotes.post("/notes/bulk-status", async (c) => {
  const user = c.get("user");
  const body = await readJson(c, bulkStatusChange, 32 * 1024);
  const ids = [...new Set(body.ids)];
  const now = nowIso();
  let changed = 0;
  for (const part of chunk(ids, 80)) {
    const ph = placeholders(part.length);
    const res = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO note_events (id, note_id, actor_user_id, action, prev_status, new_status, detail, created_at)
         SELECT 'nev_' || lower(hex(randomblob(10))), id, ?, 'status', status, ?, ?, ? FROM notes
          WHERE id IN (${ph}) AND status != ?`,
      ).bind(user.id, body.status, JSON.stringify({ bulk: true, reason: body.reason ?? null }), now, ...part, body.status),
      c.env.DB.prepare(
        `UPDATE notes SET status = ?, status_reason = ?, reviewed_by = ?, reviewed_at = ?, version = version + 1, updated_at = ?
          WHERE id IN (${ph}) AND status != ?`,
      ).bind(body.status, body.reason ?? null, user.id, now, now, ...part, body.status),
    ]);
    changed += res[1]?.meta.changes ?? 0;
  }
  await auditStmt(c.env.DB, user, "notes.bulk_status", "note", null, { count: changed, requested: ids.length, status: body.status }).run();
  return c.json({ changed, requested: ids.length });
});

adminNotes.patch("/notes/:id/display", async (c) => {
  const user = c.get("user");
  const body = await readJson(c, displayEdit, 16 * 1024);
  const id = c.req.param("id");
  let display: string | null = null;
  if (body.displayBody !== null) {
    display = cleanNoteText(body.displayBody);
    const n = countChars(display);
    if (n === 0 || n > NOTE_MAX_CHARS) throw new ApiError(400, "VALIDATION", "Display text must be 1–400 characters.");
  }
  const now = nowIso();
  const [, upd] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO note_events (id, note_id, actor_user_id, action, prev_status, new_status, detail, created_at)
       SELECT 'nev_' || lower(hex(randomblob(10))), id, ?, 'edit', status, status, ?, ? FROM notes WHERE id = ? AND version = ?`,
    ).bind(user.id, JSON.stringify({ displayEdited: display !== null }), now, id, body.version),
    c.env.DB.prepare("UPDATE notes SET display_body = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?").bind(
      display,
      now,
      id,
      body.version,
    ),
  ]);
  if ((upd?.meta.changes ?? 0) === 0) throw new ApiError(409, "CONFLICT", "This note changed. Reload and try again.");
  const row = await c.env.DB.prepare(`${NOTE_SELECT} WHERE n.id = ?`).bind(id).first<NoteRow>();
  return c.json(toAdminNote(row!));
});

adminNotes.post("/notes/council", async (c) => {
  const user = c.get("user");
  const body = await readJson(c, councilNote, 16 * 1024);
  const text = cleanNoteText(body.body);
  const problem = noteProblem(text);
  if (problem) throw new ApiError(400, "VALIDATION", "Notes must be 100–400 characters.", { problem });
  const teacher = await c.env.DB.prepare("SELECT id FROM teachers WHERE id = ?").bind(body.teacherId).first();
  if (!teacher) throw notFound("Teacher not found");
  const hash = await sha256Hex(normalizeForCompare(text));
  const dupe = await c.env.DB.prepare("SELECT id FROM notes WHERE source = 'council' AND teacher_id = ? AND body_hash = ?")
    .bind(body.teacherId, hash)
    .first<{ id: string }>();
  if (dupe) {
    const row = await c.env.DB.prepare(`${NOTE_SELECT} WHERE n.id = ?`).bind(dupe.id).first<NoteRow>();
    return c.json(toAdminNote(row!), 200);
  }
  const id = uid("note");
  const now = nowIso();
  const status = body.approve ? "approved" : "pending";
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO notes (id, submission_id, slot, teacher_id, source, body, body_hash, char_count, status, flags, created_by,
                          reviewed_by, reviewed_at, version, created_at, updated_at)
       VALUES (?, NULL, NULL, ?, 'council', ?, ?, ?, ?, '[]', ?, ?, ?, 1, ?, ?)`,
    ).bind(
      id,
      body.teacherId,
      text,
      hash,
      countChars(text),
      status,
      user.id,
      body.approve ? user.id : null,
      body.approve ? now : null,
      now,
      now,
    ),
    c.env.DB.prepare(
      `INSERT INTO note_events (id, note_id, actor_user_id, action, prev_status, new_status, detail, created_at)
       VALUES (?, ?, ?, 'create', NULL, ?, '{"source":"council"}', ?)`,
    ).bind(uid("nev"), id, user.id, status, now),
    auditStmt(c.env.DB, user, "note.council_create", "note", id, { teacherId: body.teacherId, status }),
  ]);
  const row = await c.env.DB.prepare(`${NOTE_SELECT} WHERE n.id = ?`).bind(id).first<NoteRow>();
  return c.json(toAdminNote(row!), 201);
});

// ---------- Review assignments ----------

adminNotes.get("/assignments", async (c) => {
  const db = c.env.DB;
  const [reviewers, unassigned] = await Promise.all([
    db.prepare(
      `SELECT u.id, u.email, u.role, u.active,
              COUNT(n.id) AS total,
              COALESCE(SUM(n.status = 'pending'), 0) AS pending,
              COALESCE(SUM(n.status = 'approved'), 0) AS approved,
              COALESCE(SUM(n.status = 'trashed'), 0) AS trashed
         FROM users u
         LEFT JOIN (notes n LEFT JOIN submissions s ON s.id = n.submission_id)
           ON n.assigned_reviewer_id = u.id AND ${ACTIVE}
        GROUP BY u.id ORDER BY u.role DESC, u.email`,
    ).all(),
    db.prepare(
      `SELECT COUNT(*) AS n FROM notes n LEFT JOIN submissions s ON s.id = n.submission_id
        WHERE n.assigned_reviewer_id IS NULL AND n.status = 'pending' AND ${ACTIVE}`,
    ).first<{ n: number }>(),
  ]);
  return c.json({ reviewers: reviewers.results, unassignedPending: unassigned?.n ?? 0 });
});

async function activeReviewerIds(db: D1Database, ids: string[]): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT id FROM users WHERE active = 1 AND id IN (${placeholders(ids.length)})`)
    .bind(...ids)
    .all<{ id: string }>();
  const ok = new Set(results.map((r) => r.id));
  const missing = ids.filter((i) => !ok.has(i));
  if (missing.length) throw new ApiError(400, "VALIDATION", "Some selected reviewers are disabled or missing.");
  return ids;
}

async function pendingLoads(db: D1Database, ids: string[]): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT n.assigned_reviewer_id AS id, COUNT(*) AS n FROM notes n LEFT JOIN submissions s ON s.id = n.submission_id
        WHERE n.status = 'pending' AND ${ACTIVE} AND n.assigned_reviewer_id IN (${placeholders(ids.length)})
        GROUP BY n.assigned_reviewer_id`,
    )
    .bind(...ids)
    .all<{ id: string; n: number }>();
  const m = new Map(ids.map((i) => [i, 0]));
  for (const r of results) m.set(r.id, r.n);
  return m;
}

/** Greedy least-loaded assignment, deterministic for a given input order. */
function plan(noteIds: string[], loads: Map<string, number>, order: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>(order.map((r) => [r, []]));
  for (const n of noteIds) {
    let best = order[0]!;
    for (const r of order) if (loads.get(r)! < loads.get(best)!) best = r;
    out.get(best)!.push(n);
    loads.set(best, loads.get(best)! + 1);
  }
  return out;
}

async function applyPlan(
  db: D1Database,
  actorId: string,
  p: Map<string, string[] | null>,
  guard: string,
  reason: string,
  guardArgs: unknown[] = [],
): Promise<number> {
  const now = nowIso();
  let changed = 0;
  for (const [reviewerId, noteIds] of p) {
    if (!noteIds?.length) continue;
    for (const part of chunk(noteIds, 80)) {
      const ph = placeholders(part.length);
      const res = await db.batch([
        db.prepare(
          `INSERT INTO note_events (id, note_id, actor_user_id, action, prev_status, new_status, detail, created_at)
           SELECT 'nev_' || lower(hex(randomblob(10))), id, ?, 'assign', status, status,
                  json_object('from', assigned_reviewer_id, 'to', ?, 'reason', ?), ?
             FROM notes WHERE id IN (${ph}) AND ${guard}`,
        ).bind(actorId, reviewerId === "__none__" ? null : reviewerId, reason, now, ...part, ...guardArgs),
        db.prepare(
          `UPDATE notes SET assigned_reviewer_id = ?, assigned_at = ?, updated_at = ? WHERE id IN (${ph}) AND ${guard}`,
        ).bind(reviewerId === "__none__" ? null : reviewerId, now, now, ...part, ...guardArgs),
      ]);
      changed += res[1]?.meta.changes ?? 0;
    }
  }
  return changed;
}

adminNotes.post("/assignments/distribute", async (c) => {
  const user = c.get("user");
  const { reviewerIds } = await readJson(c, distribute);
  const ids = await activeReviewerIds(c.env.DB, [...new Set(reviewerIds)]);
  const { results } = await c.env.DB.prepare(
    `SELECT n.id FROM notes n LEFT JOIN submissions s ON s.id = n.submission_id
      WHERE n.assigned_reviewer_id IS NULL AND n.status = 'pending' AND ${ACTIVE}
      ORDER BY n.created_at, n.id`,
  ).all<{ id: string }>();
  const p = plan(
    results.map((r) => r.id),
    await pendingLoads(c.env.DB, ids),
    ids,
  );
  // Guard: only still-unassigned pending notes are touched (new arrivals stay queued, reviewed notes untouched).
  const changed = await applyPlan(c.env.DB, user.id, p, "assigned_reviewer_id IS NULL AND status = 'pending'", "distribute");
  await auditStmt(c.env.DB, user, "assignments.distribute", "note", null, { reviewers: ids.length, assigned: changed }).run();
  return c.json({ assigned: changed });
});

adminNotes.post("/assignments/rebalance", async (c) => {
  const user = c.get("user");
  const { reviewerIds } = await readJson(c, rebalance);
  const ids = await activeReviewerIds(c.env.DB, [...new Set(reviewerIds)]);
  const { results } = await c.env.DB.prepare(
    `SELECT n.id, n.assigned_reviewer_id AS rid FROM notes n LEFT JOIN submissions s ON s.id = n.submission_id
      WHERE n.status = 'pending' AND ${ACTIVE}
        AND (n.assigned_reviewer_id IS NULL OR n.assigned_reviewer_id IN (${placeholders(ids.length)}))
      ORDER BY n.created_at, n.id`,
  )
    .bind(...ids)
    .all<{ id: string; rid: string | null }>();
  const target = Math.ceil(results.length / ids.length);
  const keep = new Map(ids.map((i) => [i, 0]));
  const pool: string[] = [];
  const fromOf = new Map<string, string | null>();
  for (const r of results) {
    fromOf.set(r.id, r.rid);
    if (r.rid && keep.get(r.rid)! < target) keep.set(r.rid, keep.get(r.rid)! + 1);
    else pool.push(r.id);
  }
  const p = plan(pool, keep, ids);
  // Guard: note must still be pending and still with the reviewer we planned around.
  let changed = 0;
  for (const [rid, noteIds] of p) {
    const groups = new Map<string, string[]>();
    for (const n of noteIds) {
      const from = fromOf.get(n) ?? "__null__";
      if (!groups.has(from)) groups.set(from, []);
      groups.get(from)!.push(n);
    }
    for (const [from, ns] of groups) {
      if (from === rid) continue; // planned back to the same reviewer: nothing to do
      changed +=
        from === "__null__"
          ? await applyPlan(c.env.DB, user.id, new Map([[rid, ns]]), "status = 'pending' AND assigned_reviewer_id IS NULL", "rebalance")
          : await applyPlan(c.env.DB, user.id, new Map([[rid, ns]]), "status = 'pending' AND assigned_reviewer_id = ?", "rebalance", [from]);
    }
  }
  await auditStmt(c.env.DB, user, "assignments.rebalance", "note", null, { reviewers: ids.length, moved: changed, target }).run();
  return c.json({ moved: changed, target });
});

adminNotes.post("/assignments/assign", async (c) => {
  const user = c.get("user");
  const body = await readJson(c, manualAssign, 64 * 1024);
  if (body.reviewerId) await activeReviewerIds(c.env.DB, [body.reviewerId]);
  const guard = body.includeReviewed ? "1 = 1" : "status = 'pending'";
  const changed = await applyPlan(
    c.env.DB,
    user.id,
    new Map([[body.reviewerId ?? "__none__", [...new Set(body.noteIds)]]]),
    guard,
    "manual",
  );
  await auditStmt(c.env.DB, user, "assignments.manual", "note", null, { reviewerId: body.reviewerId, changed }).run();
  return c.json({ changed });
});

adminNotes.post("/assignments/release/:reviewerId", async (c) => {
  const user = c.get("user");
  const rid = c.req.param("reviewerId");
  const { results } = await c.env.DB.prepare("SELECT id FROM notes WHERE assigned_reviewer_id = ? AND status = 'pending'")
    .bind(rid)
    .all<{ id: string }>();
  const changed = await applyPlan(
    c.env.DB,
    user.id,
    new Map([["__none__", results.map((r) => r.id)]]),
    "status = 'pending' AND assigned_reviewer_id = ?",
    "release",
    [rid],
  );
  await auditStmt(c.env.DB, user, "assignments.release", "user", rid, { released: changed }).run();
  return c.json({ released: changed });
});

// ---------- Submissions ----------

const subQuery = z.object({
  classId: idSchema.optional(),
  status: z.enum(["active", "voided"]).optional(),
  overQuota: z.enum(["1"]).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

adminNotes.get("/submissions", async (c) => {
  const p = subQuery.safeParse(c.req.query());
  if (!p.success) throw new ApiError(400, "VALIDATION", "Invalid filters.");
  const f = p.data;
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.classId) (where.push("s.class_id = ?"), args.push(f.classId));
  if (f.status) (where.push("s.status = ?"), args.push(f.status));
  if (f.overQuota) where.push("s.over_quota = 1");
  const cur = decodeCursor(f.cursor);
  if (cur) (where.push("(s.created_at, s.id) < (?, ?)"), args.push(cur.createdAt, cur.id));
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.class_id, cl.label AS class_label, s.grade_label, s.receipt_code, s.over_quota, s.class_position,
            s.status, s.void_reason, s.voided_at, vu.email AS voided_by_email, s.created_at,
            (SELECT COUNT(*) FROM notes n WHERE n.submission_id = s.id AND n.flags != '[]') AS flagged_notes,
            (SELECT COUNT(*) FROM notes n WHERE n.submission_id = s.id AND n.status = 'trashed') AS trashed_notes
       FROM submissions s JOIN classes cl ON cl.id = s.class_id LEFT JOIN users vu ON vu.id = s.voided_by
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY s.created_at DESC, s.id DESC LIMIT ?`,
  )
    .bind(...args, f.limit + 1)
    .all<{ id: string; created_at: string }>();
  const items = results.slice(0, f.limit);
  const last = results.length > f.limit ? results[f.limit - 1]! : null;
  return c.json({ items, nextCursor: last ? encodeCursor(last.created_at, last.id) : null });
});

adminNotes.get("/submissions/:id", async (c) => {
  const id = c.req.param("id");
  const sub = await c.env.DB.prepare(
    `SELECT s.*, cl.label AS class_label, vu.email AS voided_by_email FROM submissions s
       JOIN classes cl ON cl.id = s.class_id LEFT JOIN users vu ON vu.id = s.voided_by WHERE s.id = ?`,
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!sub) throw notFound("Submission not found");
  delete sub.browser_hash;
  delete sub.idempotency_key;
  const [votes, notes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT a.id AS award_id, a.name AS award_name, t.honorific, t.full_name FROM votes v
         JOIN awards a ON a.id = v.award_id JOIN teachers t ON t.id = v.teacher_id
        WHERE v.submission_id = ? ORDER BY a.display_order`,
    )
      .bind(id)
      .all<{ award_id: string; award_name: string; honorific: string; full_name: string }>(),
    c.env.DB.prepare(`${NOTE_SELECT} WHERE n.submission_id = ? ORDER BY n.slot`).bind(id).all<NoteRow>(),
  ]);
  return c.json({
    submission: sub,
    votes: votes.results.map((v) => ({
      awardId: v.award_id,
      awardName: v.award_name,
      teacherName: teacherDisplayName({ honorific: v.honorific, fullName: v.full_name }),
    })),
    notes: notes.results.map(toAdminNote),
  });
});

adminNotes.post("/submissions/:id/void", async (c) => {
  const user = c.get("user");
  const { reason } = await readJson(c, voidInput, 4096);
  const id = c.req.param("id");
  const now = nowIso();
  const [res] = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE submissions SET status = 'voided', void_reason = ?, voided_by = ?, voided_at = ? WHERE id = ? AND status = 'active'",
    ).bind(reason, user.id, now, id),
    c.env.DB.prepare(
      `INSERT INTO audit_log (id, actor_user_id, actor_email, action, entity_type, entity_id, detail, created_at)
       SELECT ?, ?, ?, 'submission.void', 'submission', id, json_object('reason', ?), ? FROM submissions
        WHERE id = ? AND status = 'voided' AND voided_at = ?`,
    ).bind(uid("au"), user.id, user.email, reason, now, id, now),
  ]);
  if ((res?.meta.changes ?? 0) === 0) {
    const exists = await c.env.DB.prepare("SELECT status FROM submissions WHERE id = ?").bind(id).first();
    if (!exists) throw notFound("Submission not found");
    throw new ApiError(409, "CONFLICT", "This submission is already voided.");
  }
  return c.json({ ok: true });
});

adminNotes.post("/submissions/:id/restore", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const prev = await c.env.DB.prepare("SELECT void_reason FROM submissions WHERE id = ? AND status = 'voided'")
    .bind(id)
    .first<{ void_reason: string }>();
  if (!prev) throw new ApiError(409, "CONFLICT", "This submission is not voided.");
  const now = nowIso();
  const [audit, res] = await c.env.DB.batch([
    // audit first, guarded by the same predicate, so it exists iff the restore happens
    c.env.DB.prepare(
      `INSERT INTO audit_log (id, actor_user_id, actor_email, action, entity_type, entity_id, detail, created_at)
       SELECT ?, ?, ?, 'submission.restore', 'submission', id, json_object('previousReason', void_reason), ? FROM submissions
        WHERE id = ? AND status = 'voided'`,
    ).bind(uid("au"), user.id, user.email, now, id),
    c.env.DB.prepare(
      "UPDATE submissions SET status = 'active', void_reason = NULL, voided_by = NULL, voided_at = NULL WHERE id = ? AND status = 'voided'",
    ).bind(id),
  ]);
  void audit;
  if ((res?.meta.changes ?? 0) === 0) throw new ApiError(409, "CONFLICT", "This submission is not voided.");
  return c.json({ ok: true });
});

// ---------- Print snapshot ----------

adminNotes.get("/print/snapshot", async (c) => {
  const s = await getSettings(c.env);
  const seed = (c.req.query("seed") || s.printSeed).slice(0, 60);
  // One read = one consistent snapshot of approved, active notes.
  const [notes, teachers] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT n.id, n.teacher_id, t.honorific, t.full_name, COALESCE(n.display_body, n.body) AS body, n.source
         FROM notes n JOIN teachers t ON t.id = n.teacher_id LEFT JOIN submissions s ON s.id = n.submission_id
        WHERE n.status = 'approved' AND ${ACTIVE} AND t.active = 1
        ORDER BY n.id`,
    ),
    c.env.DB.prepare("SELECT id, honorific, full_name, active FROM teachers ORDER BY full_name"),
  ]);
  type NR = { id: string; teacher_id: string; honorific: string; full_name: string; body: string; source: "student" | "council" };
  type TR = { id: string; honorific: string; full_name: string; active: number };
  const snap: PrintSnapshot = {
    snapshotAt: nowIso(),
    seed,
    showCouncilLabel: s.showCouncilLabel,
    notes: (notes!.results as NR[]).map((n) => ({
      id: n.id,
      teacherId: n.teacher_id,
      teacherName: teacherDisplayName({ honorific: n.honorific, fullName: n.full_name }),
      body: n.body,
      source: n.source,
    })),
    teachers: (teachers!.results as TR[]).map((t) => ({
      id: t.id,
      name: teacherDisplayName({ honorific: t.honorific, fullName: t.full_name }),
      active: t.active === 1,
    })),
  };
  await auditStmt(c.env.DB, c.get("user"), "print.snapshot", "note", null, { count: snap.notes.length, seed }).run();
  c.header("cache-control", "no-store");
  return c.json(snap);
});
