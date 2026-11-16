import type { Env } from "./env";

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/** "2026-11-16T14:30" style label in Jakarta time (WIB, UTC+7), plus the date folder. */
export function wibStamp(when: Date): { day: string; label: string } {
  const iso = new Date(when.getTime() + WIB_OFFSET_MS).toISOString();
  return { day: iso.slice(0, 10), label: `${iso.slice(0, 10)}_${iso.slice(11, 16).replace(":", "")}-WIB` };
}

/**
 * Dumps every application table to one JSON file in the private R2 bucket (binding BACKUPS).
 * Runs from the Worker's cron triggers. Read-only on D1; the tables are read in one batch.
 */
export async function runBackup(env: Env, when: Date): Promise<string> {
  if (!env.BACKUPS) throw new Error("BACKUPS R2 binding is not configured");

  const { results: tables } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all<{ name: string }>();

  const names = tables.map((t) => t.name).filter((n) => !n.startsWith("_cf_") && n !== "d1_migrations");
  const reads = await env.DB.batch(names.map((n) => env.DB.prepare(`SELECT * FROM "${n.replace(/"/g, '""')}"`)));

  const data: Record<string, unknown[]> = {};
  names.forEach((n, i) => {
    data[n] = reads[i]?.results ?? [];
  });

  const { day, label } = wibStamp(when);
  const key = `backups/${day}/stjb-thanks-${label}.json`;
  const counts = Object.fromEntries(names.map((n) => [n, (data[n] ?? []).length]));
  await env.BACKUPS.put(key, JSON.stringify({ takenAt: when.toISOString(), environment: env.ENVIRONMENT, counts, data }), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { takenAt: when.toISOString() },
  });
  console.log(`backup ok ${key}`, JSON.stringify(counts));
  return key;
}
