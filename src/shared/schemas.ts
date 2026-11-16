import { z } from "zod";
import { CODE_LENGTH } from "./codes";
import { NOTE_RAW_MAX } from "./text";

/** Required letters, and the most a student may write in total. */
export const MIN_LETTERS = 3;
export const MAX_LETTERS = 10;

export const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
export const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

export const classAccessInput = z.object({
  code: z.string().min(1).max(20),
});

export const submissionInput = z.object({
  idempotencyKey,
  classCode: z.string().min(CODE_LENGTH).max(20),
  classId: id.optional(),
  turnstileToken: z.string().max(4096).optional().default(""),
  votes: z
    .array(z.object({ awardId: id, teacherId: id }))
    .min(1)
    .max(30),
  notes: z
    .array(z.object({ teacherId: id, body: z.string().max(NOTE_RAW_MAX) }))
    .min(MIN_LETTERS)
    .max(MAX_LETTERS),
});
export type SubmissionInput = z.infer<typeof submissionInput>;

export const noteStatus = z.enum(["pending", "approved", "trashed"]);
export type NoteStatus = z.infer<typeof noteStatus>;

export const statusChange = z.object({
  status: noteStatus,
  version: z.number().int().min(1),
  reason: z.string().trim().max(300).optional(),
});

export const bulkStatusChange = z.object({
  ids: z.array(id).min(1).max(200),
  status: noteStatus,
  reason: z.string().trim().max(300).optional(),
});

export const role = z.enum(["admin", "reviewer"]);

export const userCreate = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role,
});
export const userPatch = z.object({
  role: role.optional(),
  active: z.boolean().optional(),
});

const label = z.string().trim().min(1).max(80);

export const classCreate = z.object({
  label,
  gradeId: id,
  expectedStudents: z.number().int().min(0).max(500),
  softQuota: z.number().int().min(0).max(1000).optional(),
});
export const classPatch = z.object({
  label: label.optional(),
  gradeId: id.optional(),
  expectedStudents: z.number().int().min(0).max(500).optional(),
  softQuota: z.number().int().min(0).max(1000).optional(),
  status: z.enum(["active", "paused", "disabled"]).optional(),
});
export const classImport = z.object({
  rows: z
    .array(
      z.object({
        label,
        grade: z.string().trim().min(1).max(20),
        expectedStudents: z.number().int().min(0).max(500),
        softQuota: z.number().int().min(0).max(1000).optional(),
      }),
    )
    .min(1)
    .max(300),
});

export const gradeCreate = z.object({ label: z.string().trim().min(1).max(20), sortOrder: z.number().int().optional() });

const honorific = z.string().trim().max(20);
const fullName = z.string().trim().min(2).max(100);
export const teacherCreate = z.object({ honorific, fullName });
export const teacherPatch = z.object({
  honorific: honorific.optional(),
  fullName: fullName.optional(),
  active: z.boolean().optional(),
});
export const teacherImport = z.object({
  rows: z.array(z.object({ honorific, fullName })).min(1).max(300),
});

export const awardCreate = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(300).optional().default(""),
});
export const awardPatch = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(300).optional(),
  active: z.boolean().optional(),
  reason: z.string().trim().max(300).optional(),
});
export const awardReorder = z.object({ ids: z.array(id).min(1).max(50) });
export const awardWinner = z.object({
  teacherId: id.nullable(),
  note: z.string().trim().max(300).optional(),
});

export const councilNote = z.object({
  teacherId: id,
  body: z.string().max(NOTE_RAW_MAX),
  approve: z.boolean().optional().default(false),
});
export const displayEdit = z.object({
  displayBody: z.string().max(NOTE_RAW_MAX).nullable(),
  version: z.number().int().min(1),
});

export const distribute = z.object({ reviewerIds: z.array(id).min(1).max(100) });
export const manualAssign = z.object({
  noteIds: z.array(id).min(1).max(500),
  reviewerId: id.nullable(),
  includeReviewed: z.boolean().optional().default(false),
});
export const rebalance = z.object({ reviewerIds: z.array(id).min(1).max(100) });

export const voidInput = z.object({ reason: z.string().trim().min(3).max(300) });

export const settingsPatch = z.object({
  submissionsOpen: z.boolean().optional(),
  opensAt: z.string().datetime().nullable().optional(),
  closesAt: z.string().datetime().nullable().optional(),
  reviewerCanRestore: z.boolean().optional(),
  minNotesPerTeacher: z.number().int().min(0).max(20).optional(),
  printSeed: z.string().trim().min(1).max(60).optional(),
  showCouncilLabel: z.boolean().optional(),
  defaultQuotaExtra: z.number().int().min(0).max(100).optional(),
});
