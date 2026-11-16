import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runBackup, wibStamp } from "../../src/worker/backup";
import type { Env } from "../../src/worker/env";

describe("scheduled backup", () => {
  it("labels files in Jakarta time", () => {
    expect(wibStamp(new Date("2026-11-16T07:30:00Z"))).toEqual({ day: "2026-11-16", label: "2026-11-16_1430-WIB" });
    expect(wibStamp(new Date("2026-11-16T18:00:00Z")).day).toBe("2026-11-17");
  });

  it("writes every table to R2", async () => {
    const e = env as unknown as Env;
    const key = await runBackup(e, new Date("2026-11-16T07:30:00Z"));
    expect(key).toBe("backups/2026-11-16/stjb-thanks-2026-11-16_1430-WIB.json");
    const obj = await e.BACKUPS!.get(key);
    const body = (await obj!.json()) as { counts: Record<string, number>; data: Record<string, unknown[]> };
    for (const t of ["submissions", "votes", "teachers", "users", "audit_log"]) expect(body.data).toHaveProperty(t);
    expect(body.data).not.toHaveProperty("d1_migrations");
  });
});
