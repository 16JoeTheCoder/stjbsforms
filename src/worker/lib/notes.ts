import type { NoteStatus } from "../../shared/schemas";
import type { AdminNote, ReviewerNote } from "../../shared/types";
import { teacherDisplayName } from "../../shared/search";
import { ApiError } from "./http";
import { nowIso, parseFlags, type Actor } from "./db";

export const NOTE_SELECT = `
  SELECT n.id, n.teacher_id, t.honorific, t.full_name, n.body, n.display_body, n.char_count, n.grade_label,
         n.status, n.status_reason, n.version, n.flags, n.created_at, n.source, n.class_id, cl.label AS class_label,
         n.submission_id, s.status AS submission_status, COALESCE(s.over_quota, 0) AS over_quota,
         n.assigned_reviewer_id, ru.email AS reviewer_email, rb.email AS reviewed_by_email, n.reviewed_at
    FROM notes n
    JOIN teachers t ON t.id = n.teacher_id
    LEFT JOIN submissions s ON s.id = n.submission_id
    LEFT JOIN classes cl ON cl.id = n.class_id
    LEFT JOIN users ru ON ru.id = n.assigned_reviewer_id
    LEFT JOIN users rb ON rb.id = n.reviewed_by`;

export interface NoteRow {
  id: string;
  teacher_id: string;
  honorific: string;
  full_name: string;
  body: string;
  display_body: string | null;
  char_count: number;
  grade_label: string | null;
  status: NoteStatus;
  status_reason: string | null;
  version: number;
  flags: string;
  created_at: string;
  source: "student" | "council";
  class_id: string | null;
  class_label: string | null;
  submission_id: string | null;
  submission_status: "active" | "voided" | null;
  over_quota: number;
  assigned_reviewer_id: string | null;
  reviewer_email: string | null;
  reviewed_by_email: string | null;
  reviewed_at: string | null;
}

function noteFlags(r: NoteRow): string[] {
  const f = parseFlags(r.flags);
  if (r.over_quota) f.push("over_quota");
  if (r.submission_status === "voided") f.push("submission_voided");
  if (r.char_count < 130) f.push("short");
  return f;
}

/** Reviewer projection: no class, no submission linkage, no reviewer identities. */
export function toReviewerNote(r: NoteRow): ReviewerNote {
  return {
    id: r.id,
    teacherId: r.teacher_id,
    teacherName: teacherDisplayName({ honorific: r.honorific, fullName: r.full_name }),
    body: r.display_body ?? r.body,
    charCount: r.char_count,
    gradeLabel: r.grade_label,
    status: r.status,
    version: r.version,
    flags: noteFlags(r).filter((f) => f !== "over_quota" && f !== "submission_voided"),
    createdAt: r.created_at,
    statusReason: r.status_reason,
  };
}

export function toAdminNote(r: NoteRow): AdminNote {
  return {
    ...toReviewerNote(r),
    flags: noteFlags(r),
    originalBody: r.body,
    displayBody: r.display_body,
    source: r.source,
    classId: r.class_id,
    classLabel: r.class_label,
    submissionId: r.submission_id,
    submissionStatus: r.submission_status,
    overQuota: r.over_quota === 1,
    reviewerId: r.assigned_reviewer_id,
    reviewerEmail: r.reviewer_email,
    reviewedByEmail: r.reviewed_by_email,
    reviewedAt: r.reviewed_at,
  };
}

export function encodeCursor(createdAt: string, id: string): string {
  return btoa(`${createdAt}|${id}`);
}
export function decodeCursor(c: string | undefined): { createdAt: string; id: string } | null {
  if (!c) return null;
  try {
    const [createdAt, id] = atob(c).split("|");
    if (!createdAt || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Optimistic-concurrency status change. The event row and the update are in
 * one transactional batch guarded by the same predicate, so a log entry exists
 * if and only if the update happened.
 */
export async function changeNoteStatus(
  db: D1Database,
  actor: Actor,
  noteId: string,
  version: number,
  status: NoteStatus,
  reason: string | undefined,
  scope: { reviewerId?: string } = {},
): Promise<NoteRow> {
  const now = nowIso();
  const guard = `id = ? AND version = ? AND status != ?${scope.reviewerId ? " AND assigned_reviewer_id = ?" : ""}`;
  const guardArgs: unknown[] = [noteId, version, status, ...(scope.reviewerId ? [scope.reviewerId] : [])];
  const [, upd] = await db.batch([
    db
      .prepare(
        `INSERT INTO note_events (id, note_id, actor_user_id, action, prev_status, new_status, detail, created_at)
         SELECT 'nev_' || lower(hex(randomblob(10))), id, ?, 'status', status, ?, ?, ? FROM notes WHERE ${guard}`,
      )
      .bind(actor.id, status, reason ? JSON.stringify({ reason }) : null, now, ...guardArgs),
    db
      .prepare(
        `UPDATE notes SET status = ?, status_reason = ?, reviewed_by = ?, reviewed_at = ?, version = version + 1, updated_at = ?
          WHERE ${guard}`,
      )
      .bind(status, reason ?? null, actor.id, now, now, ...guardArgs),
  ]);
  const row = await db.prepare(`${NOTE_SELECT} WHERE n.id = ?`).bind(noteId).first<NoteRow>();
  if (!row || (scope.reviewerId && row.assigned_reviewer_id !== scope.reviewerId)) {
    throw new ApiError(404, "NOT_FOUND", "This note is no longer assigned to you.");
  }
  if ((upd?.meta.changes ?? 0) === 0 && row.status !== status) {
    throw new ApiError(409, "CONFLICT", "Someone else changed this note. The latest version is shown.", {
      current: row.version,
    });
  }
  return row;
}
