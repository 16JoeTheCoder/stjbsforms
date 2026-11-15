import { Hono } from "hono";
import { z } from "zod";
import { requireRole, type AppEnv } from "../auth";
import { ApiError, readJson } from "../lib/http";
import { getSettings } from "../lib/db";
import { changeNoteStatus, decodeCursor, encodeCursor, NOTE_SELECT, toReviewerNote, type NoteRow } from "../lib/notes";
import { noteStatus, statusChange } from "../../shared/schemas";
import type { Page, ReviewerNote } from "../../shared/types";

export const reviewRoutes = new Hono<AppEnv>();
reviewRoutes.use("*", requireRole("reviewer", "admin"));

const listQuery = z.object({
  status: noteStatus.optional(),
  order: z.enum(["oldest", "newest"]).optional().default("oldest"),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(30),
});

reviewRoutes.get("/notes", async (c) => {
  const q = listQuery.safeParse(c.req.query());
  if (!q.success) throw new ApiError(400, "VALIDATION", "Invalid filters.");
  const { status, order, limit } = q.data;
  const user = c.get("user");
  const where = ["n.assigned_reviewer_id = ?", "(n.submission_id IS NULL OR s.status = 'active')"];
  const args: unknown[] = [user.id];
  if (status) {
    where.push("n.status = ?");
    args.push(status);
  }
  // Ordered by random note id (not time) so a student's three notes aren't adjacent.
  const cur = decodeCursor(q.data.cursor);
  if (cur) {
    where.push(order === "oldest" ? "n.id > ?" : "n.id < ?");
    args.push(cur.id);
  }
  const dir = order === "oldest" ? "ASC" : "DESC";
  const { results } = await c.env.DB.prepare(`${NOTE_SELECT} WHERE ${where.join(" AND ")} ORDER BY n.id ${dir} LIMIT ?`)
    .bind(...args, limit + 1)
    .all<NoteRow>();
  const items = results.slice(0, limit).map(toReviewerNote);
  const last = results.length > limit ? results[limit - 1]! : null;
  const page: Page<ReviewerNote> = { items, nextCursor: last ? encodeCursor("id", last.id) : null };
  return c.json(page);
});

reviewRoutes.get("/progress", async (c) => {
  const user = c.get("user");
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(n.status = 'pending') AS pending,
            SUM(n.status = 'approved') AS approved,
            SUM(n.status = 'trashed') AS trashed
       FROM notes n LEFT JOIN submissions s ON s.id = n.submission_id
      WHERE n.assigned_reviewer_id = ? AND (n.submission_id IS NULL OR s.status = 'active')`,
  )
    .bind(user.id)
    .first<{ total: number; pending: number | null; approved: number | null; trashed: number | null }>();
  const s = await getSettings(c.env);
  return c.json({
    total: row?.total ?? 0,
    pending: row?.pending ?? 0,
    approved: row?.approved ?? 0,
    trashed: row?.trashed ?? 0,
    canRestore: s.reviewerCanRestore,
  });
});

reviewRoutes.post("/notes/:id/status", async (c) => {
  const user = c.get("user");
  const body = await readJson(c, statusChange, 4096);
  const id = c.req.param("id");
  const current = await c.env.DB.prepare(
    `SELECT n.status, n.assigned_reviewer_id, s.status AS sub_status FROM notes n
       LEFT JOIN submissions s ON s.id = n.submission_id WHERE n.id = ?`,
  )
    .bind(id)
    .first<{ status: string; assigned_reviewer_id: string | null; sub_status: string | null }>();
  if (!current || current.assigned_reviewer_id !== user.id || current.sub_status === "voided") {
    throw new ApiError(404, "NOT_FOUND", "This note is no longer assigned to you.");
  }
  if (current.status === "trashed" && body.status !== "trashed") {
    const s = await getSettings(c.env);
    if (!s.reviewerCanRestore) throw new ApiError(403, "FORBIDDEN", "Only administrators can restore notes from Trash.");
  }
  const row = await changeNoteStatus(c.env.DB, user, id, body.version, body.status, body.reason, { reviewerId: user.id });
  return c.json(toReviewerNote(row));
});
