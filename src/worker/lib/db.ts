import type { Env } from "../env";

export const nowIso = () => new Date().toISOString();

export function uid(prefix: string): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  let s = "";
  for (const x of b) s += x.toString(36).padStart(2, "0");
  return `${prefix}_${s}`;
}

export interface Actor {
  id: string;
  email: string;
}

export function auditStmt(
  db: D1Database,
  actor: Actor | null,
  action: string,
  entityType: string,
  entityId: string | null,
  detail: Record<string, unknown> = {},
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log (id, actor_user_id, actor_email, action, entity_type, entity_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(uid("au"), actor?.id ?? null, actor?.email ?? null, action, entityType, entityId, JSON.stringify(detail), nowIso());
}

export interface Settings {
  submissionsOpen: boolean;
  opensAt: string | null;
  closesAt: string | null;
  reviewerCanRestore: boolean;
  minNotesPerTeacher: number;
  printSeed: string;
  showCouncilLabel: boolean;
  defaultQuotaExtra: number;
  formVersion: string;
}

export const SETTINGS_KEYS: Record<keyof Settings, string> = {
  submissionsOpen: "submissions_open",
  opensAt: "opens_at",
  closesAt: "closes_at",
  reviewerCanRestore: "reviewer_can_restore",
  minNotesPerTeacher: "min_notes_per_teacher",
  printSeed: "print_seed",
  showCouncilLabel: "show_council_label",
  defaultQuotaExtra: "default_quota_extra",
  formVersion: "form_version",
};

export async function getSettings(env: Env): Promise<Settings> {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const m = new Map(results.map((r) => [r.key, r.value]));
  return {
    submissionsOpen: m.get("submissions_open") === "true",
    opensAt: m.get("opens_at") || null,
    closesAt: m.get("closes_at") || null,
    reviewerCanRestore: m.get("reviewer_can_restore") !== "false",
    minNotesPerTeacher: Number(m.get("min_notes_per_teacher") ?? "3"),
    printSeed: m.get("print_seed") ?? "teachers-day",
    showCouncilLabel: m.get("show_council_label") === "true",
    defaultQuotaExtra: Number(m.get("default_quota_extra") ?? "5"),
    formVersion: m.get("form_version") ?? "1",
  };
}

export function isOpen(s: Settings, now = new Date()): boolean {
  if (!s.submissionsOpen) return false;
  if (s.opensAt && now < new Date(s.opensAt)) return false;
  if (s.closesAt && now >= new Date(s.closesAt)) return false;
  return true;
}

export function bumpFormVersionStmt(db: D1Database): D1PreparedStatement {
  return db.prepare(
    "UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = ? WHERE key = 'form_version'",
  ).bind(nowIso());
}

/** Splits an id list into chunks that respect D1's bound-parameter limit. */
export function chunk<T>(arr: T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

export function parseFlags(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
