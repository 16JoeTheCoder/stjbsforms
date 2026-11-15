// API response types shared by Worker and client.
import type { NoteStatus } from "./schemas";

export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_CODE"
  | "CLASS_PAUSED"
  | "CODE_CHANGED"
  | "SUBMISSIONS_CLOSED"
  | "ALREADY_SUBMITTED"
  | "TURNSTILE_FAILED"
  | "STALE_FORM"
  | "LAST_ADMIN"
  | "CONFIG"
  | "INTERNAL";

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export interface PublicTeacher {
  id: string;
  honorific: string;
  fullName: string;
}
export interface PublicAward {
  id: string;
  name: string;
  description: string;
}
export interface PublicConfig {
  surface: "student" | "staff";
  turnstileSiteKey: string | null;
  open: boolean;
  opensAt: string | null;
  closesAt: string | null;
  formVersion: string;
}
export interface PublicFormData {
  teachers: PublicTeacher[];
  awards: PublicAward[];
  formVersion: string;
}
export interface ClassAccessResult {
  classId: string;
  classLabel: string;
  gradeLabel: string;
}
export interface SubmissionReceipt {
  receiptCode: string;
  submittedAt: string;
  duplicate?: boolean;
}

export type Role = "admin" | "reviewer";
export interface Me {
  id: string;
  email: string;
  role: Role;
  isOwner: boolean;
  logoutUrl: string;
}

export interface ReviewerNote {
  id: string;
  teacherName: string;
  teacherId: string;
  body: string;
  charCount: number;
  gradeLabel: string | null;
  status: NoteStatus;
  version: number;
  flags: string[];
  createdAt: string;
  statusReason: string | null;
}

export interface AdminNote extends ReviewerNote {
  originalBody: string;
  displayBody: string | null;
  source: "student" | "council";
  classId: string | null;
  classLabel: string | null;
  submissionId: string | null;
  submissionStatus: "active" | "voided" | null;
  overQuota: boolean;
  reviewerId: string | null;
  reviewerEmail: string | null;
  reviewedByEmail: string | null;
  reviewedAt: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

export interface PrintNote {
  id: string;
  teacherId: string;
  teacherName: string;
  body: string;
  source: "student" | "council";
}
export interface PrintSnapshot {
  snapshotAt: string;
  seed: string;
  showCouncilLabel: boolean;
  notes: PrintNote[];
  teachers: { id: string; name: string; active: boolean }[];
}
