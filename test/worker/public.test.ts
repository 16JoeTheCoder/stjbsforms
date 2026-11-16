import { describe, expect, it, beforeAll } from "vitest";
import { env } from "cloudflare:workers";
import { call, cookie, json, key, letter, OWNER, seed, submission, type Seed } from "./helpers";

let s: Seed;
beforeAll(async () => {
  s = await seed();
});

const submit = (body: unknown, c = cookie(), extra: Parameters<typeof call>[1] = {}) =>
  call("/api/public/submissions", { method: "POST", json: body, cookie: c, ...extra });

describe("class access", () => {
  it("accepts a valid code case-insensitively and returns the class", async () => {
    const r = await call("/api/public/class-access", { method: "POST", json: { code: s.classes[1]!.code.toLowerCase() } });
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ classLabel: "Junior College 2A", gradeLabel: "JC2" });
  });
  it("rejects malformed and ambiguous codes", async () => {
    for (const code of ["ABCD", "ABCDEF", "O0I1L", "K7M4"]) {
      const r = await call("/api/public/class-access", { method: "POST", json: { code } });
      expect(r.status).toBe(400);
      expect((await json(r)).error.code).toBe("INVALID_CODE");
    }
  });
  it("rejects unknown codes without leaking the class list", async () => {
    const r = await call("/api/public/class-access", { method: "POST", json: { code: "ZZZZZ" } });
    expect(r.status).toBe(404);
    const body = await r.text();
    expect(body).not.toContain("Secondary");
  });
  it("public form exposes teachers and awards but no results", async () => {
    const f = await json(call("/api/public/form"));
    expect(f.teachers.length).toBe(13);
    expect(f.awards.length).toBe(6);
    expect(JSON.stringify(f)).not.toMatch(/votes|rank/i);
  });
});

describe("submission validation", () => {
  it("accepts a complete submission and stores 6 votes + 3 notes atomically", async () => {
    const body = submission(s);
    const r = await submit(body);
    expect(r.status).toBe(201);
    const sub = await env.DB.prepare("SELECT id FROM submissions WHERE idempotency_key = ?").bind(body.idempotencyKey).first<{ id: string }>();
    const v = await env.DB.prepare("SELECT COUNT(*) n FROM votes WHERE submission_id = ?").bind(sub!.id).first<{ n: number }>();
    const n = await env.DB.prepare("SELECT COUNT(*) n FROM notes WHERE submission_id = ?").bind(sub!.id).first<{ n: number }>();
    expect(v!.n).toBe(6);
    expect(n!.n).toBe(3);
  });

  it("accepts up to 10 letters and rejects 2 or 11", async () => {
    const make = (n: number) =>
      submission(s, {
        notes: Array.from({ length: n }, (_, i) => ({ teacherId: s.teachers[i % s.teachers.length]!.id, body: letter(i, Math.random().toString(36)) })),
      });
    expect(s.teachers.length).toBeGreaterThanOrEqual(10);
    const ten = make(10);
    expect((await submit(ten)).status).toBe(201);
    const sub = await env.DB.prepare("SELECT id FROM submissions WHERE idempotency_key = ?").bind(ten.idempotencyKey).first<{ id: string }>();
    const n = await env.DB.prepare("SELECT COUNT(*) n, MAX(slot) m FROM notes WHERE submission_id = ?").bind(sub!.id).first<{ n: number; m: number }>();
    expect(n).toMatchObject({ n: 10, m: 10 });
    expect((await submit(make(2))).status).toBe(400);
    expect((await submit(make(11))).status).toBe(400);
  });

  it("rejects the same teacher for two awards", async () => {
    const body = submission(s);
    body.votes[1]!.teacherId = body.votes[0]!.teacherId;
    const r = await submit(body);
    expect(r.status).toBe(400);
    expect((await json(r)).error.details.field).toBe("votes");
  });

  it("rejects a missing award (incomplete ballot)", async () => {
    const body = submission(s);
    body.votes.pop();
    const r = await submit(body);
    expect(r.status).toBe(409);
    expect((await json(r)).error.code).toBe("STALE_FORM");
  });

  it("rejects duplicate letter recipients", async () => {
    const body = submission(s);
    body.notes[1]!.teacherId = body.notes[0]!.teacherId;
    expect((await submit(body)).status).toBe(400);
  });

  it("allows a teacher to receive an award vote and a letter in the same submission", async () => {
    const body = submission(s);
    body.notes[0]!.teacherId = body.votes[0]!.teacherId;
    expect((await submit(body)).status).toBe(201);
  });

  it("enforces 100–400 characters (graphemes) and rejects whitespace-only", async () => {
    const make = (b: string) => {
      const body = submission(s);
      body.notes[0]!.body = b;
      return body;
    };
    expect((await submit(make("a".repeat(99)))).status).toBe(400);
    expect((await submit(make("   \n\t  "))).status).toBe(400);
    expect((await submit(make("b".repeat(401)))).status).toBe(400);
    expect((await submit(make("c".repeat(100)))).status).toBe(201);
    expect((await submit(make("d".repeat(400)))).status).toBe(201);
    // 100 emoji = 100 characters even though they are 200 UTF-16 units
    expect((await submit(make("🙏".repeat(100)))).status).toBe(201);
    // family emoji is one grapheme: 400 of them is still valid
    expect((await submit(make("👨‍👩‍👧".repeat(400)))).status).toBe(201);
  });

  it("rejects identical letters after normalisation", async () => {
    const body = submission(s);
    body.notes[1]!.body = "  " + body.notes[0]!.body.toUpperCase().replace(/ /g, "   ") + "\n";
    const r = await submit(body);
    expect(r.status).toBe(400);
    expect((await json(r)).error.details.problem).toBe("identical");
  });

  it("accepts similar but not identical letters", async () => {
    const body = submission(s);
    body.notes = body.notes.map((n, i) => ({ ...n, body: letter(1, `difference ${i}`) }));
    expect((await submit(body)).status).toBe(201);
  });

  it("rejects unknown teacher ids", async () => {
    const body = submission(s);
    body.notes[0]!.teacherId = "t_doesnotexist";
    const r = await submit(body);
    expect(r.status).toBe(409);
  });

  it("bounds request size", async () => {
    const r = await call("/api/public/submissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ junk: "x".repeat(70 * 1024) }),
    });
    expect(r.status).toBe(413);
  });

  it("requires a same-origin Origin header for writes", async () => {
    const r = await call("/api/public/submissions", { method: "POST", json: submission(s), headers: { origin: "https://evil.example" } });
    expect(r.status).toBe(403);
  });
});

describe("idempotency and browser restriction", () => {
  it("returns the original receipt when the same key is retried (lost response)", async () => {
    const body = submission(s);
    const c = cookie();
    const a = await json(submit(body, c));
    const b = await json(submit(body, c));
    expect(b.receiptCode).toBe(a.receiptCode);
    expect(b.duplicate).toBe(true);
    const n = await env.DB.prepare("SELECT COUNT(*) n FROM submissions WHERE idempotency_key = ?").bind(body.idempotencyKey).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("handles a double-click burst with one write", async () => {
    const body = submission(s);
    const c = cookie();
    const rs = await Promise.all(Array.from({ length: 5 }, () => submit(body, c)));
    const codes = new Set(await Promise.all(rs.map(async (r) => (await json(r)).receiptCode)));
    expect(codes.size).toBe(1);
    const sub = await env.DB.prepare("SELECT id FROM submissions WHERE idempotency_key = ?").bind(body.idempotencyKey).all();
    expect(sub.results.length).toBe(1);
    const votes = await env.DB.prepare("SELECT COUNT(*) n FROM votes v JOIN submissions s ON s.id = v.submission_id WHERE s.idempotency_key = ?")
      .bind(body.idempotencyKey)
      .first<{ n: number }>();
    expect(votes!.n).toBe(6);
  });

  it("blocks a second, different submission from the same browser", async () => {
    const c = cookie();
    expect((await submit(submission(s), c)).status).toBe(201);
    const r = await submit(submission(s), c);
    expect(r.status).toBe(409);
    const e = await json(r);
    expect(e.error.code).toBe("ALREADY_SUBMITTED");
    expect(e.error.details.receiptCode).toBeTruthy();
  });

  it("receipt lookup reports found/not found", async () => {
    const body = submission(s);
    await submit(body);
    expect((await call(`/api/public/submissions/${body.idempotencyKey}`)).status).toBe(200);
    expect((await call(`/api/public/submissions/${key()}`)).status).toBe(404);
  });
});

describe("event state and class state", () => {
  it("flags over-quota submissions but still accepts them", async () => {
    const small = s.classes.find((c) => c.label === "Secondary 1A")!;
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await submit(submission(s, { classCode: small.code, offset: i })));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const rows = await env.DB.prepare("SELECT over_quota FROM submissions WHERE class_id = ? ORDER BY created_at").bind(small.id).all<{ over_quota: number }>();
    expect(rows.results.map((r) => r.over_quota)).toEqual([0, 0, 1, 1]);
  });

  it("rejects submissions while closed and accepts again once reopened", async () => {
    await call("/api/admin/settings", { method: "PATCH", json: { submissionsOpen: false }, as: OWNER });
    const body = submission(s);
    const c = cookie();
    const r = await submit(body, c);
    expect(r.status).toBe(403);
    expect((await json(r)).error.code).toBe("SUBMISSIONS_CLOSED");
    await call("/api/admin/settings", { method: "PATCH", json: { submissionsOpen: true }, as: OWNER });
    expect((await submit(body, c)).status).toBe(201);
  });

  it("respects closing time", async () => {
    await call("/api/admin/settings", { method: "PATCH", json: { closesAt: new Date(Date.now() - 60_000).toISOString() }, as: OWNER });
    expect((await submit(submission(s))).status).toBe(403);
    await call("/api/admin/settings", { method: "PATCH", json: { closesAt: null }, as: OWNER });
    expect((await submit(submission(s))).status).toBe(201);
  });

  it("paused class: code recognised but submission refused", async () => {
    const c = s.classes.find((x) => x.label === "Secondary 4B")!;
    await call(`/api/admin/classes/${c.id}`, { method: "PATCH", json: { status: "paused" }, as: OWNER });
    const r = await submit(submission(s, { classCode: c.code }));
    expect((await json(r)).error.code).toBe("CLASS_PAUSED");
    await call(`/api/admin/classes/${c.id}`, { method: "PATCH", json: { status: "active" }, as: OWNER });
  });

  it("rotated code: old code fails with CODE_CHANGED when class id is known", async () => {
    const c = s.classes.find((x) => x.label === "Secondary 4B")!;
    const rot = await json<{ code: string }>(call(`/api/admin/classes/${c.id}/rotate-code`, { method: "POST", as: OWNER }));
    const body = { ...submission(s, { classCode: c.code }), classId: c.id };
    const r = await submit(body);
    expect((await json(r)).error.code).toBe("CODE_CHANGED");
    const ok = await submit({ ...body, idempotencyKey: key(), classCode: rot.code });
    expect(ok.status).toBe(201);
    c.code = rot.code;
  });

  it("disabled class code is rejected", async () => {
    const c = s.classes.find((x) => x.label === "Secondary 4B")!;
    await call(`/api/admin/classes/${c.id}`, { method: "PATCH", json: { status: "disabled" }, as: OWNER });
    const r = await call("/api/public/class-access", { method: "POST", json: { code: c.code } });
    expect(r.status).toBe(404);
    await call(`/api/admin/classes/${c.id}`, { method: "PATCH", json: { status: "active" }, as: OWNER });
  });

  it("verifies Turnstile when a secret is configured", async () => {
    const r = await submit(submission(s), cookie(), { env: { TURNSTILE_SECRET_KEY: "2x0000000000000000000000000000000AA" } });
    expect(r.status).toBe(400);
    expect((await json(r)).error.code).toBe("TURNSTILE_FAILED");
  });
});
