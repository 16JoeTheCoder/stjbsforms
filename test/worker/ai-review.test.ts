import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { call, cookie, json, OWNER, seed, submission, type Seed } from "./helpers";
import { AI_FORMAT, buildAiPrompt, parseAiImport, type AiExport } from "../../src/shared/ai-review";

let s: Seed;
beforeAll(async () => {
  s = await seed();
  for (let i = 0; i < 4; i++) {
    const r = await call("/api/public/submissions", { method: "POST", json: submission(s, { offset: 40 + i }), cookie: cookie() });
    expect(r.status).toBe(201);
  }
});

const exportNotes = () => json<AiExport>(call("/api/admin/ai-review/exports", { method: "POST", json: {}, as: OWNER }));
const importRaw = (raw: string, apply = false) => call("/api/admin/ai-review/import", { method: "POST", json: { raw, apply }, as: OWNER });

describe("AI review export", () => {
  it("exports pending notes with only reviewer-safe fields and records versions", async () => {
    const exp = await exportNotes();
    expect(exp.format).toBe(AI_FORMAT);
    expect(exp.notes.length).toBeGreaterThan(0);
    for (const n of exp.notes) expect(Object.keys(n).sort()).toEqual(["chars", "flags", "grade", "id", "teacher", "text"]);
    const row = await env.DB.prepare("SELECT note_count FROM ai_review_exports WHERE id = ?").bind(exp.exportId).first<{ note_count: number }>();
    expect(row!.note_count).toBe(exp.notes.length);
  });

  it("prompt tells the AI the exact format, the exportId and includes the data", async () => {
    const exp = await exportNotes();
    const p = buildAiPrompt(exp);
    expect(p).toContain(`"format": "${AI_FORMAT}"`);
    expect(p).toContain(exp.exportId);
    expect(p).toContain(exp.notes[0]!.id);
    expect(p).toMatch(/approve.*trash.*unsure/s);
  });

  it("is admin-only", async () => {
    await call("/api/admin/users", { method: "POST", json: { email: "ai-rev@test.dev", role: "reviewer" }, as: OWNER });
    const r = await call("/api/admin/ai-review/exports", { method: "POST", json: {}, as: "ai-rev@test.dev" });
    expect(r.status).toBe(403);
  });
});

describe("AI review import", () => {
  it("parses fenced replies and rejects wrong formats", () => {
    const ok = parseAiImport('Sure!\n```json\n{"format":"stjb-ai-review-v1","exportId":"x","decisions":[{"id":"a","decision":"approve"}]}\n```');
    expect(ok.ok).toBe(true);
    expect(parseAiImport('{"format":"v2","exportId":"x","decisions":[]}').ok).toBe(false);
    expect(parseAiImport('{"format":"stjb-ai-review-v1","exportId":"x","decisions":[{"id":"a","decision":"APPROVE"}]}').ok).toBe(false);
    expect(parseAiImport("no json here").ok).toBe(false);
  });

  it("previews without changing anything, then applies approve/trash/unsure with history", async () => {
    const exp = await exportNotes();
    const [a, t, u, ...rest] = exp.notes;
    const reply = {
      format: AI_FORMAT,
      exportId: exp.exportId,
      decisions: [
        { id: a!.id, decision: "approve", reason: "" },
        { id: t!.id, decision: "trash", reason: "Mocks the teacher" },
        { id: u!.id, decision: "unsure", reason: "Names another student?" },
        { id: a!.id, decision: "trash", reason: "dup" },
        { id: "note_not_real", decision: "approve" },
      ],
    };
    const raw = "```json\n" + JSON.stringify(reply) + "\n```";
    const preview = await json(importRaw(raw));
    expect(preview).toMatchObject({ applied: false, approve: 1, trash: 1, unsure: 1 });
    expect(preview.skipped.map((x: { reason: string }) => x.reason).sort()).toEqual(["duplicate", "not_in_export"]);
    expect(preview.notInThisFile).toBe(rest.length);
    const still = await env.DB.prepare("SELECT status FROM notes WHERE id = ?").bind(a!.id).first<{ status: string }>();
    expect(still!.status).toBe("pending");

    const res = await json(importRaw(raw, true));
    expect(res.result).toMatchObject({ approved: 1, trashed: 1, unsure: 1, skippedAtApply: 0 });
    const rows = await env.DB.prepare(`SELECT id, status, status_reason, flags FROM notes WHERE id IN (?, ?, ?)`)
      .bind(a!.id, t!.id, u!.id)
      .all<{ id: string; status: string; status_reason: string | null; flags: string }>();
    const by = new Map(rows.results.map((r) => [r.id, r]));
    expect(by.get(a!.id)!.status).toBe("approved");
    expect(by.get(t!.id)!.status).toBe("trashed");
    expect(by.get(t!.id)!.status_reason).toBe("AI review: Mocks the teacher");
    expect(by.get(u!.id)!.status).toBe("pending");
    expect(JSON.parse(by.get(u!.id)!.flags)).toContain("ai_unsure");
    const ev = await env.DB.prepare("SELECT action, detail FROM note_events WHERE note_id = ?").bind(t!.id).first<{ action: string; detail: string }>();
    expect(ev!.action).toBe("status");
    expect(JSON.parse(ev!.detail).source).toBe("ai_import");
    const audit = await env.DB.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'ai_review.import'").first<{ n: number }>();
    expect(audit!.n).toBeGreaterThan(0);

    // Re-importing the same file changes nothing: everything is already reviewed/flagged.
    const again = await json(importRaw(raw));
    expect(again.approve + again.trash).toBe(0);
  });

  it("skips notes that a human changed after the export", async () => {
    const exp = await exportNotes();
    const n = exp.notes[0]!;
    const v = await env.DB.prepare("SELECT version FROM notes WHERE id = ?").bind(n.id).first<{ version: number }>();
    // a human approves then sends it back to pending (version moves on)
    await call(`/api/admin/notes/${n.id}/status`, { method: "POST", json: { status: "approved", version: v!.version }, as: OWNER });
    await call(`/api/admin/notes/${n.id}/status`, { method: "POST", json: { status: "pending", version: v!.version + 1 }, as: OWNER });
    const raw = JSON.stringify({ format: AI_FORMAT, exportId: exp.exportId, decisions: [{ id: n.id, decision: "trash", reason: "x" }] });
    const preview = await json(importRaw(raw));
    expect(preview.skipped).toEqual([{ id: n.id, reason: "changed_since_export" }]);
    expect((await importRaw(raw, true)).status).toBe(409);
  });

  it("rejects unknown exports and malformed replies with a clear message", async () => {
    const r = await importRaw(JSON.stringify({ format: AI_FORMAT, exportId: "aix_nope", decisions: [{ id: "x", decision: "approve" }] }));
    expect(r.status).toBe(404);
    const bad = await importRaw('{"decisions": "oops"}');
    expect(bad.status).toBe(400);
    expect((await json(bad)).error.message).toMatch(/expected format/);
  });
});
