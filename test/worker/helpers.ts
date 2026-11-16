import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { app } from "../../src/worker/index";
import type { Env } from "../../src/worker/env";

export const LOCAL = "http://localhost";

export type Overrides = Partial<Env> & Record<string, unknown>;

export async function call(
  path: string,
  init: RequestInit & { json?: unknown; as?: string | null; base?: string; env?: Overrides; cookie?: string } = {},
): Promise<Response> {
  const base = init.base ?? LOCAL;
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (!headers.has("origin") && init.method && init.method !== "GET") headers.set("origin", new URL(base).origin);
  if (init.as) headers.set("x-dev-user", init.as);
  if (init.cookie) headers.set("cookie", init.cookie);
  const req = new Request(base + path, {
    method: init.method ?? "GET",
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  const ctx = createExecutionContext();
  const res = await app.fetch(req, { ...(env as unknown as Env), ...(init.env ?? {}) } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export async function json<T = any>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

export const OWNER = "owner@test.dev";

let seeded: Promise<Seed> | null = null;
export interface Seed {
  teachers: { id: string; honorific: string; fullName: string }[];
  awards: { id: string; name: string }[];
  classes: { id: string; label: string; code: string }[];
}

/** Seeds teachers + classes through the admin API (once per test file). */
export function seed(): Promise<Seed> {
  if (!seeded) {
    seeded = (async () => {
      const names = Array.from({ length: 12 }, (_, i) => ({ honorific: i % 2 ? "Mr." : "Ms.", fullName: `Teacher ${String.fromCharCode(65 + i)} Example` }));
      names.push({ honorific: "Ms.", fullName: "Catherine Tan" });
      let r = await call("/api/admin/teachers/import", { method: "POST", json: { rows: names }, as: OWNER });
      if (r.status !== 200) throw new Error(`teacher import ${r.status} ${await r.text()}`);
      r = await call("/api/admin/classes/import", {
        method: "POST",
        as: OWNER,
        json: {
          rows: [
            { label: "Secondary 1A", grade: "Sec 1", expectedStudents: 2, softQuota: 2 },
            { label: "Junior College 2A", grade: "JC2", expectedStudents: 25 },
            { label: "Secondary 4B", grade: "Sec 4", expectedStudents: 25 },
          ],
        },
      });
      const imp = await json<{ created: { label: string; code: string }[] }>(r);
      const classes = await json<{ id: string; label: string }[]>(call("/api/admin/classes", { as: OWNER }));
      await call("/api/admin/settings", { method: "PATCH", json: { submissionsOpen: true }, as: OWNER });
      const form = await json<{ teachers: Seed["teachers"]; awards: Seed["awards"] }>(call("/api/public/form"));
      return {
        teachers: form.teachers,
        awards: form.awards,
        classes: imp.created.map((c) => ({ ...c, id: classes.find((x) => x.label === c.label)!.id })),
      };
    })();
  }
  return seeded;
}

let n = 0;
export function key(): string {
  n++;
  return `k_${Date.now().toString(36)}_${n}_${Math.random().toString(36).slice(2, 10)}`;
}
export function cookie(): string {
  return `stjb_bid=bid${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

export const letter = (i: number, extra = "") =>
  `Thank you for every lesson this year, especially the way you explained things twice without sighing. Letter ${i}. ${extra}`.padEnd(120, ".");

export function submission(s: Seed, opts: { classCode?: string; offset?: number; notes?: { teacherId: string; body: string }[] } = {}) {
  const o = opts.offset ?? 0;
  const t = s.teachers;
  return {
    idempotencyKey: key(),
    classCode: opts.classCode ?? s.classes[1]!.code,
    votes: s.awards.map((a, i) => ({ awardId: a.id, teacherId: t[(i + o) % t.length]!.id })),
    notes:
      opts.notes ??
      [0, 1, 2].map((i) => ({ teacherId: t[(i + 6 + o) % t.length]!.id, body: letter(i, Math.random().toString(36)) })),
  };
}
