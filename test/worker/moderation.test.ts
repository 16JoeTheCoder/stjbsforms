import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { call, cookie, json, OWNER, seed, submission, type Seed } from "./helpers";

let s: Seed;
const REV = ["mod-r1@test.dev", "mod-r2@test.dev", "mod-r3@test.dev"];
let revIds: string[] = [];

async function newSubmission(offset = 0, classCode?: string) {
  const body = submission(s, { offset, classCode });
  const r = await call("/api/public/submissions", { method: "POST", json: body, cookie: cookie() });
  expect(r.status).toBe(201);
  return (await env.DB.prepare("SELECT id FROM submissions WHERE idempotency_key = ?").bind(body.idempotencyKey).first<{ id: string }>())!.id;
}
const notesOf = (subId: string) =>
  env.DB.prepare("SELECT id, version, status, teacher_id FROM notes WHERE submission_id = ? ORDER BY slot").bind(subId).all<{ id: string; version: number; status: string; teacher_id: string }>();
const setStatus = (id: string, status: string, version: number, as = OWNER, path = "/api/admin/notes") =>
  call(`${path}/${id}/status`, { method: "POST", json: { status, version }, as });

beforeAll(async () => {
  s = await seed();
  for (const e of REV) await call("/api/admin/users", { method: "POST", json: { email: e, role: "reviewer" }, as: OWNER });
  const users = await json<{ users: { id: string; email: string }[] }>(call("/api/admin/users", { as: OWNER }));
  revIds = REV.map((e) => users.users.find((u) => u.email === e)!.id);
});

describe("note moderation", () => {
  it("approve → trash → restore, every step logged", async () => {
    const sub = await newSubmission();
    const [n] = (await notesOf(sub)).results;
    let r = await setStatus(n!.id, "approved", n!.version);
    expect(r.status).toBe(200);
    let v = (await r.json()).version;
    r = await setStatus(n!.id, "trashed", v);
    v = (await r.json()).version;
    r = await setStatus(n!.id, "pending", v);
    expect((await r.json()).status).toBe("pending");
    const ev = await env.DB.prepare("SELECT prev_status, new_status, actor_user_id FROM note_events WHERE note_id = ? AND action = 'status' ORDER BY created_at")
      .bind(n!.id)
      .all<{ prev_status: string; new_status: string; actor_user_id: string }>();
    expect(ev.results.map((e) => `${e.prev_status}>${e.new_status}`)).toEqual(["pending>approved", "approved>trashed", "trashed>pending"]);
    expect(ev.results.every((e) => e.actor_user_id)).toBe(true);
  });

  it("optimistic concurrency: a stale version gets 409 and changes nothing", async () => {
    const sub = await newSubmission(1);
    const [n] = (await notesOf(sub)).results;
    const a = await setStatus(n!.id, "approved", n!.version);
    expect(a.status).toBe(200);
    const b = await setStatus(n!.id, "trashed", n!.version); // second session, stale view
    expect(b.status).toBe(409);
    const row = await env.DB.prepare("SELECT status FROM notes WHERE id = ?").bind(n!.id).first<{ status: string }>();
    expect(row!.status).toBe("approved");
    const ev = await env.DB.prepare("SELECT COUNT(*) n FROM note_events WHERE note_id = ? AND action='status'").bind(n!.id).first<{ n: number }>();
    expect(ev!.n).toBe(1);
  });

  it("two concurrent moderators: exactly one wins", async () => {
    const sub = await newSubmission(2);
    const [n] = (await notesOf(sub)).results;
    const [x, y] = await Promise.all([setStatus(n!.id, "approved", n!.version), setStatus(n!.id, "trashed", n!.version)]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
  });

  it("reviewer moderation is limited to assigned notes and respects restore policy", async () => {
    const sub = await newSubmission(3);
    const notes = (await notesOf(sub)).results;
    await call("/api/admin/assignments/assign", { method: "POST", json: { noteIds: notes.map((n) => n.id), reviewerId: revIds[0] }, as: OWNER });
    let r = await setStatus(notes[0]!.id, "trashed", notes[0]!.version, REV[0], "/api/review/notes");
    expect(r.status).toBe(200);
    const v = (await r.json()).version;
    await call("/api/admin/settings", { method: "PATCH", json: { reviewerCanRestore: false }, as: OWNER });
    r = await setStatus(notes[0]!.id, "pending", v, REV[0], "/api/review/notes");
    expect(r.status).toBe(403);
    await call("/api/admin/settings", { method: "PATCH", json: { reviewerCanRestore: true }, as: OWNER });
    r = await setStatus(notes[0]!.id, "pending", v, REV[0], "/api/review/notes");
    expect(r.status).toBe(200);
    // another reviewer cannot touch it
    r = await setStatus(notes[1]!.id, "approved", notes[1]!.version, REV[1], "/api/review/notes");
    expect(r.status).toBe(404);
    // reassigned mid-review: original reviewer is locked out
    await call("/api/admin/assignments/assign", { method: "POST", json: { noteIds: [notes[2]!.id], reviewerId: revIds[1] }, as: OWNER });
    r = await setStatus(notes[2]!.id, "approved", notes[2]!.version, REV[0], "/api/review/notes");
    expect(r.status).toBe(404);
  });

  it("bulk status changes skip notes already in the target state", async () => {
    const sub = await newSubmission(4);
    const ids = (await notesOf(sub)).results.map((n) => n.id);
    await setStatus(ids[0]!, "approved", 1);
    const r = await json(call("/api/admin/notes/bulk-status", { method: "POST", json: { ids, status: "approved" }, as: OWNER }));
    expect(r.changed).toBe(2);
  });
});

describe("whole-submission void and restore", () => {
  it("voiding excludes votes and notes; restoring brings them back without touching note states", async () => {
    const sub = await newSubmission(5);
    const notes = (await notesOf(sub)).results;
    await setStatus(notes[0]!.id, "approved", notes[0]!.version);
    await setStatus(notes[1]!.id, "trashed", notes[1]!.version);
    const votesFor = async () => {
      const awards = await json<{ id: string; totalVotes: number }[]>(call("/api/admin/awards", { as: OWNER }));
      return awards.reduce((a, x) => a + x.totalVotes, 0);
    };
    const snapCount = async () => (await json<{ notes: { id: string }[] }>(call("/api/admin/print/snapshot", { as: OWNER }))).notes.map((n) => n.id);
    const before = await votesFor();
    expect(await snapCount()).toContain(notes[0]!.id);

    expect((await call(`/api/admin/submissions/${sub}/void`, { method: "POST", json: { reason: "spam" }, as: OWNER })).status).toBe(200);
    expect(await votesFor()).toBe(before - 6);
    expect(await snapCount()).not.toContain(notes[0]!.id);
    const again = await call(`/api/admin/submissions/${sub}/void`, { method: "POST", json: { reason: "spam" }, as: OWNER });
    expect(again.status).toBe(409);

    expect((await call(`/api/admin/submissions/${sub}/restore`, { method: "POST", as: OWNER })).status).toBe(200);
    expect(await votesFor()).toBe(before);
    const after = (await notesOf(sub)).results.map((n) => n.status);
    expect(after).toEqual(["approved", "trashed", "pending"]);
    expect(await snapCount()).toContain(notes[0]!.id);
    const audit = await env.DB.prepare("SELECT action FROM audit_log WHERE entity_id = ? ORDER BY created_at").bind(sub).all<{ action: string }>();
    expect(audit.results.map((a) => a.action)).toEqual(["submission.void", "submission.restore"]);
  });
});

describe("assignment distribution", () => {
  it("distributes evenly, keeps assignments stable and queues new arrivals", async () => {
    // clear existing assignments to make the arithmetic exact
    await env.DB.prepare("UPDATE notes SET assigned_reviewer_id = NULL WHERE status = 'pending'").run();
    for (let i = 0; i < 6; i++) await newSubmission(10 + i);
    const pending = (await env.DB.prepare(
      "SELECT COUNT(*) n FROM notes n LEFT JOIN submissions s ON s.id = n.submission_id WHERE n.status='pending' AND n.assigned_reviewer_id IS NULL AND (n.submission_id IS NULL OR s.status='active')",
    ).first<{ n: number }>())!.n;
    const r = await json(call("/api/admin/assignments/distribute", { method: "POST", json: { reviewerIds: revIds }, as: OWNER }));
    expect(r.assigned).toBe(pending);
    const loads = await env.DB.prepare(
      `SELECT assigned_reviewer_id id, COUNT(*) n FROM notes WHERE status='pending' AND assigned_reviewer_id IN (?,?,?) GROUP BY assigned_reviewer_id`,
    )
      .bind(...revIds)
      .all<{ id: string; n: number }>();
    const counts = loads.results.map((x) => x.n);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);

    const snapshot = await env.DB.prepare("SELECT id, assigned_reviewer_id FROM notes WHERE assigned_reviewer_id IS NOT NULL ORDER BY id").all();
    await newSubmission(30);
    const after = await env.DB.prepare("SELECT id, assigned_reviewer_id FROM notes WHERE id IN (SELECT id FROM notes WHERE assigned_reviewer_id IS NOT NULL) ORDER BY id").all();
    expect(after.results).toEqual(snapshot.results);
    const unassigned = await env.DB.prepare("SELECT COUNT(*) n FROM notes WHERE assigned_reviewer_id IS NULL AND status='pending'").first<{ n: number }>();
    expect(unassigned!.n).toBeGreaterThanOrEqual(3);
  });

  it("never reassigns reviewed notes; rebalance evens pending only", async () => {
    const reviewed = await env.DB.prepare("SELECT id, assigned_reviewer_id FROM notes WHERE assigned_reviewer_id = ? AND status = 'pending' LIMIT 2")
      .bind(revIds[0])
      .all<{ id: string; assigned_reviewer_id: string }>();
    for (const n of reviewed.results) await env.DB.prepare("UPDATE notes SET status='approved' WHERE id = ?").bind(n.id).run();
    // dump everything on reviewer 3, then rebalance
    await env.DB.prepare("UPDATE notes SET assigned_reviewer_id = ? WHERE status='pending' AND assigned_reviewer_id IS NOT NULL").bind(revIds[2]).run();
    await call("/api/admin/assignments/rebalance", { method: "POST", json: { reviewerIds: revIds }, as: OWNER });
    for (const n of reviewed.results) {
      const row = await env.DB.prepare("SELECT assigned_reviewer_id FROM notes WHERE id = ?").bind(n.id).first<{ assigned_reviewer_id: string }>();
      expect(row!.assigned_reviewer_id).toBe(revIds[0]);
    }
    const loads = await env.DB.prepare(
      `SELECT assigned_reviewer_id id, COUNT(*) n FROM notes WHERE status='pending' AND assigned_reviewer_id IN (?,?,?) GROUP BY assigned_reviewer_id`,
    )
      .bind(...revIds)
      .all<{ n: number }>();
    const counts = loads.results.map((x) => x.n);
    expect(counts.length).toBe(3);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });
});

describe("results, coverage and council notes", () => {
  it("award rankings count only active submissions and flag ties", async () => {
    const awards = await json<{ id: string; ranking: { teacherId: string; votes: number; rank: number }[]; totalVotes: number }[]>(call("/api/admin/awards", { as: OWNER }));
    const dbTotal = await env.DB.prepare("SELECT COUNT(*) n FROM votes v JOIN submissions s ON s.id=v.submission_id WHERE s.status='active'").first<{ n: number }>();
    expect(awards.reduce((a, x) => a + x.totalVotes, 0)).toBe(dbTotal!.n);
    for (const a of awards) for (let i = 1; i < a.ranking.length; i++) expect(a.ranking[i]!.votes).toBeLessThanOrEqual(a.ranking[i - 1]!.votes);
  });

  it("renaming an award keeps its votes and is audited", async () => {
    const a = s.awards[0]!;
    const before = (await json<{ id: string; totalVotes: number }[]>(call("/api/admin/awards", { as: OWNER }))).find((x) => x.id === a.id)!.totalVotes;
    await call(`/api/admin/awards/${a.id}`, { method: "PATCH", json: { name: "Most Likely to Nap During Marking" }, as: OWNER });
    const after = (await json<{ id: string; name: string; totalVotes: number }[]>(call("/api/admin/awards", { as: OWNER }))).find((x) => x.id === a.id)!;
    expect(after.name).toBe("Most Likely to Nap During Marking");
    expect(after.totalVotes).toBe(before);
    const log = await env.DB.prepare("SELECT detail FROM audit_log WHERE action='award.update' AND entity_id = ?").bind(a.id).first<{ detail: string }>();
    expect(JSON.parse(log!.detail).afterVotingStarted).toBe(true);
  });

  it("renaming a teacher keeps their notes", async () => {
    const t = s.teachers.find((x) => x.fullName === "Catherine Tan")!;
    const n0 = await env.DB.prepare("SELECT COUNT(*) n FROM notes WHERE teacher_id = ?").bind(t.id).first<{ n: number }>();
    await call(`/api/admin/teachers/${t.id}`, { method: "PATCH", json: { fullName: "Catherine Tan-Wijaya" }, as: OWNER });
    const n1 = await env.DB.prepare("SELECT COUNT(*) n FROM notes WHERE teacher_id = ?").bind(t.id).first<{ n: number }>();
    expect(n1!.n).toBe(n0!.n);
  });

  it("coverage = max(0, min - approved active notes); council notes count", async () => {
    const t = s.teachers[12]!;
    const before = (await json<{ teachers: { id: string; approved: number; needed: number }[] }>(call("/api/admin/teachers", { as: OWNER }))).teachers.find((x) => x.id === t.id)!;
    expect(before.needed).toBe(Math.max(0, 3 - before.approved));
    const r = await call("/api/admin/notes/council", {
      method: "POST",
      json: { teacherId: t.id, approve: true, body: "From all of us in the student council: thank you for the patience, the jokes, and the extra sessions after school." },
      as: OWNER,
    });
    expect(r.status).toBe(201);
    const after = (await json<{ teachers: { id: string; approved: number; needed: number }[] }>(call("/api/admin/teachers", { as: OWNER }))).teachers.find((x) => x.id === t.id)!;
    expect(after.approved).toBe(before.approved + 1);
    expect(after.needed).toBe(Math.max(0, 3 - after.approved));
    const short = await call("/api/admin/notes/council", { method: "POST", json: { teacherId: t.id, body: "Too short" }, as: OWNER });
    expect(short.status).toBe(400);
  });

  it("print snapshot excludes trashed, pending and voided content and leaks no metadata", async () => {
    const snap = await json<{ notes: Record<string, unknown>[] }>(call("/api/admin/print/snapshot", { as: OWNER }));
    const ids = snap.notes.map((n) => n.id as string);
    const expected = await env.DB.prepare(
      `SELECT n.id FROM notes n JOIN teachers t ON t.id=n.teacher_id LEFT JOIN submissions s ON s.id=n.submission_id
        WHERE n.status='approved' AND (n.submission_id IS NULL OR s.status='active') AND t.active=1 ORDER BY n.id`,
    ).all<{ id: string }>();
    expect(ids).toEqual(expected.results.map((r) => r.id));
    for (const n of snap.notes) expect(Object.keys(n).sort()).toEqual(["body", "id", "source", "teacherId", "teacherName"]);
  });

  it("CSV exports neutralise formula injection", async () => {
    const t = s.teachers[0]!;
    await call("/api/admin/notes/council", {
      method: "POST",
      json: { teacherId: t.id, approve: true, body: "=HYPERLINK(\"http://x\") " + "thanks for everything you do, really, from the bottom of our hearts and minds".repeat(2) },
      as: OWNER,
    });
    const csv = await (await call("/api/admin/export/notes.csv", { as: OWNER })).text();
    expect(csv).toContain("'=HYPERLINK");
  });
});
