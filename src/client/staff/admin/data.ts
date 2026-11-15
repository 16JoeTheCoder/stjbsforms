import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";

export interface TeacherRow {
  id: string;
  honorific: string;
  fullName: string;
  active: boolean;
  approved: number;
  pending: number;
  trashed: number;
  council: number;
  needed: number;
}
export interface ClassRow {
  id: string;
  label: string;
  gradeId: string;
  grade: string;
  expectedStudents: number;
  softQuota: number;
  status: "active" | "paused" | "disabled";
  codeRotatedAt: string | null;
  hasCode: number;
  rawSubmissions: number;
  activeSubmissions: number;
  voidedSubmissions: number;
  overQuotaSubmissions: number;
}
export interface UserRow {
  id: string;
  email: string;
  role: "admin" | "reviewer";
  active: boolean;
  isOwner: boolean;
  accessSync: string;
  lastSeenAt: string | null;
  createdAt: string;
  invitedBy: string | null;
  pending: number;
  assigned: number;
}
export interface Grade {
  id: string;
  label: string;
  sortOrder: number;
}

export const useTeachers = () =>
  useQuery({ queryKey: ["teachers"], queryFn: () => api<{ minimum: number; teachers: TeacherRow[] }>("/api/admin/teachers") });
export const useClasses = () => useQuery({ queryKey: ["classes"], queryFn: () => api<ClassRow[]>("/api/admin/classes"), refetchInterval: 20_000 });
export const useUsers = () =>
  useQuery({ queryKey: ["users"], queryFn: () => api<{ users: UserRow[]; accessSyncConfigured: boolean }>("/api/admin/users") });
export const useGrades = () => useQuery({ queryKey: ["grades"], queryFn: () => api<Grade[]>("/api/admin/grades") });

export const teacherName = (t: { honorific: string; fullName: string }) => (t.honorific ? `${t.honorific} ${t.fullName}` : t.fullName);
