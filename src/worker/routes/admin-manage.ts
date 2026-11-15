import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth";
import { ApiError, conflict, csvResponse, notFound, readJson } from "../lib/http";
import { auditStmt, bumpFormVersionStmt, getSettings, isOpen, nowIso, SETTINGS_KEYS, uid } from "../lib/db";
import { decryptCode, encryptCode, hmacHex } from "../lib/crypto";
import { decodeCursor, encodeCursor } from "../lib/notes";
import { syncAccessGroup } from "../lib/access-sync";
import {
  awardCreate,
  awardPatch,
  awardReorder,
  awardWinner,
  classCreate,
  classImport,
  classPatch,
  gradeCreate,
  settingsPatch,
  teacherCreate,
  teacherImport,
  teacherPatch,
  userCreate,
  userPatch,
} from "../../shared/schemas";
import { generateClassCode } from "../../shared/codes";
import { searchKey, teacherDisplayName } from "../../shared/search";

export const adminManage = new Hono<AppEnv>();

const ACTIVE = "(n.submission_id IS NULL OR s.status = 'active')";

// ---------- Overview ----------

adminManage.get("/overview", async (c) => {
  const db = c.env.DB;
  const settings = await getSettings(c.env);
  const [subs, notes, classes, coverage, reviewers, last] = await db.batch([
    db.prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(status='active'),0) AS active, COALESCE(SUM(status='voided'),0) AS voided,
              COALESCE(SUM(status='active' AND over_quota=1),0) AS over_quota FROM submissions`,
    ),
    db.prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(n.status='pending'),0) AS pending, COALESCE(SUM(n.status='approved'),0) AS approved,
              COALESCE(SUM(n.status='trashed'),0) AS trashed,
              COALESCE(SUM(n.status='pending' AND n.assigned_reviewer_id IS NULL),0) AS unassigned,
              COALESCE(SUM(n.source='council'),0) AS council
         FROM notes n LEFT JOIN submissions s ON s.id = n.submission_id WHERE ${ACTIVE}`,
    ),
    db.prepare(
      `SELECT c.id, c.label, g.label AS grade, g.sort_order, c.expected_students, c.soft_quota, c.status,
              COUNT(s.id) AS raw, COALESCE(SUM(s.status='active'),0) AS active, COALESCE(SUM(s.status='voided'),0) AS voided
         FROM classes c JOIN grades g ON g.id = c.grade_id LEFT JOIN submissions s ON s.class_id = c.id
        GROUP BY c.id ORDER BY g.sort_order, c.label`,
    ),
    db.prepare(
      `SELECT t.id, COALESCE(SUM(n.status='approved' AND ${ACTIVE}),0) AS approved
         FROM teachers t LEFT JOIN notes n ON n.teacher_id = t.id LEFT JOIN submissions s ON s.id = n.submission_id
        WHERE t.active = 1 GROUP BY t.id`,
    ),
    db.prepare(
      `SELECT u.id, u.email, COUNT(n.id) AS total, COALESCE(SUM(n.status != 'pending'),0) AS done
         FROM users u JOIN notes n ON n.assigned_reviewer_id = u.id LEFT JOIN submissions s ON s.id = n.submission_id
        WHERE ${ACTIVE} GROUP BY u.id ORDER BY u.email`,
    ),
    db.prepare("SELECT MAX(created_at) AS at FROM submissions"),
  ]);
  const min = settings.minNotesPerTeacher;
  const cov = coverage!.results as { approved: number }[];
  return c.json({
    submissions: subs!.results[0],
    notes: notes!.results[0],
    classes: classes!.results,
    coverage: {
      teachers: cov.length,
      covered: cov.filter((t) => t.approved >= min).length,
      notesNeeded: cov.reduce((a, t) => a + Math.max(0, min - t.approved), 0),
      minimum: min,
    },
    reviewers: reviewers!.results,
    system: {
      open: isOpen(settings),
      submissionsOpen: settings.submissionsOpen,
      opensAt: settings.opensAt,
      closesAt: settings.closesAt,
      lastSubmissionAt: (last!.results[0] as { at: string | null }).at,
      environment: c.env.ENVIRONMENT,
      turnstile: Boolean(c.env.TURNSTILE_SECRET_KEY && c.env.TURNSTILE_SITE_KEY),
      accessSync: Boolean(c.env.CF_API_TOKEN && c.env.ACCESS_GROUP_ID),
      placeholders: [c.env.ACCESS_AUD, c.env.ACCESS_TEAM_DOMAIN, c.env.TURNSTILE_SITE_KEY].some((v) => !v || /REPLACE/i.test(v)),
      serverTime: nowIso(),
    },
  });
});

// ---------- Grades & classes ----------

adminManage.get("/grades", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, label, sort_order AS sortOrder FROM grades ORDER BY sort_order, label").all();
  return c.json(results);
});

adminManage.post("/grades", async (c) => {
  const body = await readJson(c, gradeCreate);
  const id = uid("g");
  const max = await c.env.DB.prepare("SELECT COALESCE(MAX(sort_order),0) AS m FROM grades").first<{ m: number }>();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO grades (id, label, sort_order) VALUES (?, ?, ?)").bind(id, body.label, body.sortOrder ?? (max?.m ?? 0) + 1),
      auditStmt(c.env.DB, c.get("user"), "grade.create", "grade", id, { label: body.label }),
    ]);
  } catch {
    throw conflict("A grade with that name already exists.");
  }
  return c.json({ id }, 201);
});

async function newCode(c: { env: AppEnv["Bindings"] }) {
  for (let i = 0; i < 10; i++) {
    const code = generateClassCode();
    const hash = await hmacHex(c.env, "class-code", code);
    const clash = await c.env.DB.prepare("SELECT 1 FROM classes WHERE code_hash = ?").bind(hash).first();
    if (!clash) return { code, hash, cipher: await encryptCode(c.env, code) };
  }
  throw new ApiError(500, "INTERNAL", "Could not generate a unique code.");
}

adminManage.get("/classes", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.label, c.grade_id AS gradeId, g.label AS grade, c.expected_students AS expectedStudents,
            c.soft_quota AS softQuota, c.status, c.code_rotated_at AS codeRotatedAt, (c.code_hash IS NOT NULL) AS hasCode,
            COUNT(s.id) AS rawSubmissions, COALESCE(SUM(s.status='active'),0) AS activeSubmissions,
            COALESCE(SUM(s.status='voided'),0) AS voidedSubmissions,
            COALESCE(SUM(s.status='active' AND s.over_quota=1),0) AS overQuotaSubmissions
       FROM classes c JOIN grades g ON g.id = c.grade_id LEFT JOIN submissions s ON s.class_id = c.id
      GROUP BY c.id ORDER BY g.sort_order, c.label`,
  ).all();
  return c.json(results);
});

adminManage.post("/classes", async (c) => {
  const user = c.get("user");
  const body = await readJson(c, classCreate);
  const s = await getSettings(c.env);
  const id = uid("cls");
  const { code, hash, cipher } = await newCode(c);
  const now = nowIso();
  const quota = body.softQuota ?? body.expectedStudents + s.defaultQuotaExtra;
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO classes (id, grade_id, label, code_hash, code_cipher, code_rotated_at, expected_students, soft_quota, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).bind(id, body.gradeId, body.label, hash, cipher, now, body.expectedStudents, quota, now, now),
      auditStmt(c.env.DB, user, "class.create", "class", id, { label: body.label, expected: body.expectedStudents, quota }),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw conflict("A class with that name already exists.");
    if (String(e).includes("FOREIGN KEY")) throw new ApiError(400, "VALIDATION", "Unknown grade.");
    throw e;
  }
  return c.json({ id, code }, 201);
});

adminManage.patch("/classes/:id", async (c) => {
  const user = c.get("user");
  const body = await readJson(c, classPatch);
  const id = c.req.param("id");
  const before = await c.env.DB.prepare("SELECT label, grade_id, expected_students, soft_quota, status FROM classes WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
  if (!before) throw notFound("Class not found");
  const sets: string[] = [];
  const args: unknown[] = [];
  const map: Record<string, string> = {
    label: "label",
    gradeId: "grade_id",
    expectedStudents: "expected_students",
    softQuota: "soft_quota",
    status: "status",
  };
  for (const [k, col] of Object.entries(map)) {
    const v = (body as Record<string, unknown>)[k];
    if (v !== undefined) (sets.push(`${col} = ?`), args.push(v));
  }
  if (!sets.length) return c.json({ ok: true });
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE classes SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...args, nowIso(), id),
      auditStmt(c.env.DB, user, "class.update", "class", id, { before, after: body }),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw conflict("A class with that name already exists.");
    throw e;
  }
  return c.json({ ok: true });
});

adminManage.post("/classes/:id/rotate-code", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const exists = await c.env.DB.prepare("SELECT label FROM classes WHERE id = ?").bind(id).first<{ label: string }>();
  if (!exists) throw notFound("Class not found");
  const { code, hash, cipher } = await newCode(c);
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE classes SET code_hash = ?, code_cipher = ?, code_rotated_at = ?, updated_at = ? WHERE id = ?").bind(
      hash,
      cipher,
      now,
      now,
      id,
    ),
    auditStmt(c.env.DB, user, "class.rotate_code", "class", id, { label: exists.label }),
  ]);
  return c.json({ code });
});

adminManage.get("/classes/:id/code", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT code_cipher FROM classes WHERE id = ?").bind(id).first<{ code_cipher: string | null }>();
  if (!row) throw notFound("Class not found");
  const code = row.code_cipher ? await decryptCode(c.env, row.code_cipher) : null;
  if (!code) throw new ApiError(409, "CONFLICT", "This code can't be displayed. Rotate it to issue a new one.");
  await auditStmt(c.env.DB, c.get("user"), "class.view_code", "class", id).run();
  c.header("cache-control", "no-store");
  return c.json({ code });
});

adminManage.post("/classes/import", async (c) => {
  const user = c.get("user");
  const { rows } = await readJson(c, classImport);
  const s = await getSettings(c.env);
  const db = c.env.DB;
  const grades = new Map(
    (await db.prepare("SELECT id, label FROM grades").all<{ id: string; label: string }>()).results.map((g) => [g.label.toLowerCase(), g.id]),
  );
  const existing = new Map(
    (await db.prepare("SELECT id, label FROM classes").all<{ id: string; label: string }>()).results.map((r) => [r.label.toLowerCase(), r.id]),
  );
  const stmts: D1PreparedStatement[] = [];
  let maxOrder = (await db.prepare("SELECT COALESCE(MAX(sort_order),0) AS m FROM grades").first<{ m: number }>())?.m ?? 0;
  const created: { label: string; code: string }[] = [];
  let updated = 0;
  const now = nowIso();
  for (const r of rows) {
    let gid = grades.get(r.grade.toLowerCase());
    if (!gid) {
      gid = uid("g");
      grades.set(r.grade.toLowerCase(), gid);
      stmts.push(db.prepare("INSERT INTO grades (id, label, sort_order) VALUES (?, ?, ?)").bind(gid, r.grade, ++maxOrder));
    }
    const quota = r.softQuota ?? r.expectedStudents + s.defaultQuotaExtra;
    const cid = existing.get(r.label.toLowerCase());
    if (cid) {
      updated++;
      stmts.push(
        db.prepare("UPDATE classes SET grade_id = ?, expected_students = ?, soft_quota = ?, updated_at = ? WHERE id = ?").bind(
          gid,
          r.expectedStudents,
          quota,
          now,
          cid,
        ),
      );
    } else {
      const id = uid("cls");
      existing.set(r.label.toLowerCase(), id);
      const { code, hash, cipher } = await newCode(c);
      created.push({ label: r.label, code });
      stmts.push(
        db.prepare(
          `INSERT INTO classes (id, grade_id, label, code_hash, code_cipher, code_rotated_at, expected_students, soft_quota, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        ).bind(id, gid, r.label, hash, cipher, now, r.expectedStudents, quota, now, now),
      );
    }
  }
  stmts.push(auditStmt(db, user, "class.import", "class", null, { created: created.length, updated }));
  await db.batch(stmts);
  return c.json({ created, updated });
});

// ---------- Teachers ----------

adminManage.get("/teachers", async (c) => {
  const s = await getSettings(c.env);
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.honorific, t.full_name AS fullName, t.active,
            COALESCE(SUM(n.status='approved' AND ${ACTIVE}),0) AS approved,
            COALESCE(SUM(n.status='pending' AND ${ACTIVE}),0) AS pending,
            COALESCE(SUM(n.status='trashed' AND ${ACTIVE}),0) AS trashed,
            COALESCE(SUM(n.source='council' AND n.status='approved'),0) AS council
       FROM teachers t LEFT JOIN notes n ON n.teacher_id = t.id LEFT JOIN submissions s ON s.id = n.submission_id
      GROUP BY t.id ORDER BY t.full_name`,
  ).all<{ approved: number; active: number }>();
  const min = s.minNotesPerTeacher;
  return c.json({
    minimum: min,
    teachers: results.map((t) => ({ ...t, active: t.active === 1, needed: t.active ? Math.max(0, min - t.approved) : 0 })),
  });
});

adminManage.post("/teachers", async (c) => {
  const body = await readJson(c, teacherCreate);
  const key = searchKey(body.honorific, body.fullName);
  const exists = await c.env.DB.prepare("SELECT id FROM teachers WHERE search_name = ?").bind(key).first();
  if (exists) throw conflict("That teacher is already on the roster.");
  const id = uid("t");
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO teachers (id, honorific, full_name, search_name, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
    ).bind(id, body.honorific, body.fullName, searchKey(body.honorific, body.fullName), now, now),
    bumpFormVersionStmt(c.env.DB),
    auditStmt(c.env.DB, c.get("user"), "teacher.create", "teacher", id, body),
  ]);
  return c.json({ id }, 201);
});

adminManage.patch("/teachers/:id", async (c) => {
  const body = await readJson(c, teacherPatch);
  const id = c.req.param("id");
  const before = await c.env.DB.prepare("SELECT honorific, full_name, active FROM teachers WHERE id = ?")
    .bind(id)
    .first<{ honorific: string; full_name: string; active: number }>();
  if (!before) throw notFound("Teacher not found");
  const honorific = body.honorific ?? before.honorific;
  const fullName = body.fullName ?? before.full_name;
  const active = body.active === undefined ? before.active : body.active ? 1 : 0;
  const clash = await c.env.DB.prepare("SELECT id FROM teachers WHERE search_name = ? AND id != ?").bind(searchKey(honorific, fullName), id).first();
  if (clash) throw conflict("Another teacher already has that name.");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE teachers SET honorific = ?, full_name = ?, search_name = ?, active = ?, updated_at = ? WHERE id = ?").bind(
      honorific,
      fullName,
      searchKey(honorific, fullName),
      active,
      nowIso(),
      id,
    ),
    bumpFormVersionStmt(c.env.DB),
    auditStmt(c.env.DB, c.get("user"), "teacher.update", "teacher", id, { before, after: body }),
  ]);
  return c.json({ ok: true });
});

adminManage.post("/teachers/import", async (c) => {
  const { rows } = await readJson(c, teacherImport);
  const db = c.env.DB;
  const existing = new Map(
    (await db.prepare("SELECT id, search_name FROM teachers").all<{ id: string; search_name: string }>()).results.map((t) => [
      t.search_name,
      t.id,
    ]),
  );
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [];
  let created = 0;
  let updated = 0;
  for (const r of rows) {
    const key = searchKey(r.honorific, r.fullName);
    const tid = existing.get(key);
    if (tid) {
      updated++;
      stmts.push(
        db.prepare("UPDATE teachers SET honorific = ?, full_name = ?, updated_at = ? WHERE id = ?").bind(r.honorific, r.fullName, now, tid),
      );
    } else {
      created++;
      const id = uid("t");
      existing.set(key, id);
      stmts.push(
        db
          .prepare("INSERT INTO teachers (id, honorific, full_name, search_name, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
          .bind(id, r.honorific, r.fullName, key, now, now),
      );
    }
  }
  stmts.push(bumpFormVersionStmt(db), auditStmt(db, c.get("user"), "teacher.import", "teacher", null, { created, updated }));
  await db.batch(stmts);
  return c.json({ created, updated });
});

// ---------- Awards ----------

async function awardResults(db: D1Database) {
  const [awards, counts, teachers] = await db.batch([
    db.prepare(
      "SELECT id, name, description, display_order AS displayOrder, active, winner_teacher_id AS winnerTeacherId, winner_note AS winnerNote FROM awards ORDER BY display_order, id",
    ),
    db.prepare(
      `SELECT v.award_id, v.teacher_id, COUNT(*) AS votes FROM votes v JOIN submissions s ON s.id = v.submission_id
        WHERE s.status = 'active' GROUP BY v.award_id, v.teacher_id`,
    ),
    db.prepare("SELECT id, honorific, full_name FROM teachers"),
  ]);
  const tName = new Map(
    (teachers!.results as { id: string; honorific: string; full_name: string }[]).map((t) => [
      t.id,
      teacherDisplayName({ honorific: t.honorific, fullName: t.full_name }),
    ]),
  );
  const byAward = new Map<string, { teacherId: string; votes: number }[]>();
  for (const r of counts!.results as { award_id: string; teacher_id: string; votes: number }[]) {
    if (!byAward.has(r.award_id)) byAward.set(r.award_id, []);
    byAward.get(r.award_id)!.push({ teacherId: r.teacher_id, votes: r.votes });
  }
  const list = (awards!.results as { id: string; name: string; active: number; winnerTeacherId: string | null }[]).map((a) => {
    const rows = (byAward.get(a.id) ?? []).sort((x, y) => y.votes - x.votes || tName.get(x.teacherId)!.localeCompare(tName.get(y.teacherId)!));
    let rank = 0;
    let prev = -1;
    const ranking = rows.map((r, i) => {
      if (r.votes !== prev) (rank = i + 1), (prev = r.votes);
      return { ...r, teacherName: tName.get(r.teacherId) ?? "Unknown", rank };
    });
    const top = ranking.filter((r) => r.rank === 1);
    return {
      ...a,
      active: a.active === 1,
      totalVotes: rows.reduce((s, r) => s + r.votes, 0),
      ranking,
      leaders: top.map((t) => t.teacherId),
      tie: top.length > 1,
      winnerName: a.winnerTeacherId ? tName.get(a.winnerTeacherId) ?? null : null,
    };
  });
  // Teachers leading more than one active award: flagged for the council meeting.
  const leadCount = new Map<string, number>();
  for (const a of list) if (a.active) for (const l of a.leaders) leadCount.set(l, (leadCount.get(l) ?? 0) + 1);
  return list.map((a) => ({ ...a, overlaps: a.leaders.filter((l) => (leadCount.get(l) ?? 0) > 1) }));
}

adminManage.get("/awards", async (c) => c.json(await awardResults(c.env.DB)));

async function votingStarted(db: D1Database) {
  return Boolean(await db.prepare("SELECT 1 FROM votes LIMIT 1").first());
}

adminManage.post("/awards", async (c) => {
  const body = await readJson(c, awardCreate);
  const id = uid("aw");
  const now = nowIso();
  const max = await c.env.DB.prepare("SELECT COALESCE(MAX(display_order),0) AS m FROM awards").first<{ m: number }>();
  const started = await votingStarted(c.env.DB);
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO awards (id, name, description, display_order, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)").bind(
      id,
      body.name,
      body.description,
      (max?.m ?? 0) + 1,
      now,
      now,
    ),
    bumpFormVersionStmt(c.env.DB),
    auditStmt(c.env.DB, c.get("user"), "award.create", "award", id, { ...body, afterVotingStarted: started }),
  ]);
  return c.json({ id, afterVotingStarted: started }, 201);
});

adminManage.patch("/awards/:id", async (c) => {
  const body = await readJson(c, awardPatch);
  const id = c.req.param("id");
  const before = await c.env.DB.prepare("SELECT name, description, active FROM awards WHERE id = ?").bind(id).first<{
    name: string;
    description: string;
    active: number;
  }>();
  if (!before) throw notFound("Award not found");
  const started = await votingStarted(c.env.DB);
  if (started && body.active === false && !body.reason) {
    throw new ApiError(400, "VALIDATION", "Voting has started. Give a reason for deactivating this award.");
  }
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE awards SET name = ?, description = ?, active = ?, updated_at = ? WHERE id = ?").bind(
      body.name ?? before.name,
      body.description ?? before.description,
      body.active === undefined ? before.active : body.active ? 1 : 0,
      nowIso(),
      id,
    ),
    bumpFormVersionStmt(c.env.DB),
    auditStmt(c.env.DB, c.get("user"), "award.update", "award", id, { before, after: body, afterVotingStarted: started }),
  ]);
  return c.json({ ok: true, afterVotingStarted: started });
});

adminManage.post("/awards/reorder", async (c) => {
  const { ids } = await readJson(c, awardReorder);
  const stmts = ids.map((id, i) => c.env.DB.prepare("UPDATE awards SET display_order = ?, updated_at = ? WHERE id = ?").bind(i + 1, nowIso(), id));
  stmts.push(auditStmt(c.env.DB, c.get("user"), "award.reorder", "award", null, { ids }));
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

adminManage.post("/awards/:id/winner", async (c) => {
  const body = await readJson(c, awardWinner);
  const id = c.req.param("id");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE awards SET winner_teacher_id = ?, winner_note = ?, updated_at = ? WHERE id = ?").bind(
      body.teacherId,
      body.note ?? null,
      nowIso(),
      id,
    ),
    auditStmt(c.env.DB, c.get("user"), "award.set_winner", "award", id, body),
  ]);
  return c.json({ ok: true });
});

// ---------- Users ----------

adminManage.get("/users", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.role, u.active, u.is_owner AS isOwner, u.access_sync AS accessSync, u.last_seen_at AS lastSeenAt,
            u.created_at AS createdAt, iu.email AS invitedBy,
            (SELECT COUNT(*) FROM notes n WHERE n.assigned_reviewer_id = u.id AND n.status = 'pending') AS pending,
            (SELECT COUNT(*) FROM notes n WHERE n.assigned_reviewer_id = u.id) AS assigned
       FROM users u LEFT JOIN users iu ON iu.id = u.invited_by ORDER BY u.role, u.email`,
  ).all<{ active: number; isOwner: number }>();
  return c.json({
    users: results.map((u) => ({ ...u, active: u.active === 1, isOwner: u.isOwner === 1 })),
    accessSyncConfigured: Boolean(c.env.CF_API_TOKEN && c.env.ACCESS_GROUP_ID && c.env.CF_ACCOUNT_ID),
  });
});

adminManage.post("/users", async (c) => {
  const user = c.get("user");
  const body = await readJson(c, userCreate);
  const exists = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(body.email).first();
  if (exists) throw conflict("That email is already on the list. Edit the existing entry instead.");
  const id = uid("usr");
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO users (id, email, role, active, is_owner, invited_by, created_at, updated_at) VALUES (?, ?, ?, 1, 0, ?, ?, ?)",
    ).bind(id, body.email, body.role, user.id, now, now),
    auditStmt(c.env.DB, user, "user.invite", "user", id, { email: body.email, role: body.role }),
  ]);
  const sync = await syncAccessGroup(c.env);
  await c.env.DB.prepare("UPDATE users SET access_sync = ? WHERE id = ?").bind(sync, id).run();
  return c.json({ id, accessSync: sync }, 201);
});

adminManage.patch("/users/:id", async (c) => {
  const actor = c.get("user");
  const body = await readJson(c, userPatch);
  const id = c.req.param("id");
  const target = await c.env.DB.prepare("SELECT id, email, role, active, is_owner FROM users WHERE id = ?").bind(id).first<{
    id: string;
    email: string;
    role: string;
    active: number;
    is_owner: number;
  }>();
  if (!target) throw notFound("User not found");
  if (target.id === actor.id) throw new ApiError(403, "FORBIDDEN", "You can't change your own role or access. Ask another administrator.");
  if (target.is_owner && !actor.isOwner) throw new ApiError(403, "FORBIDDEN", "Only the owner can change the owner account.");
  const newRole = body.role ?? target.role;
  const newActive = body.active === undefined ? target.active === 1 : body.active;
  const loses = target.role === "admin" && target.active === 1 && (newRole !== "admin" || !newActive);
  if (loses) {
    const admins = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").first<{ n: number }>();
    if ((admins?.n ?? 0) <= 1) throw new ApiError(409, "LAST_ADMIN", "At least one active administrator must remain.");
  }
  // Guarded update re-checks the admin count atomically.
  const res = await c.env.DB.prepare(
    `UPDATE users SET role = ?, active = ?, updated_at = ? WHERE id = ?
       AND (? = 0 OR (SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1 AND id != ?) >= 1)`,
  )
    .bind(newRole, newActive ? 1 : 0, nowIso(), id, loses ? 1 : 0, id)
    .run();
  if (res.meta.changes === 0) throw new ApiError(409, "LAST_ADMIN", "At least one active administrator must remain.");
  let released = 0;
  if (target.active === 1 && !newActive) {
    // Their pending work goes back to the unassigned queue; reviewed notes keep their history.
    const r = await c.env.DB.prepare(
      "UPDATE notes SET assigned_reviewer_id = NULL, assigned_at = NULL, updated_at = ? WHERE assigned_reviewer_id = ? AND status = 'pending'",
    )
      .bind(nowIso(), id)
      .run();
    released = r.meta.changes;
  }
  await auditStmt(c.env.DB, actor, "user.update", "user", id, {
    email: target.email,
    before: { role: target.role, active: target.active === 1 },
    after: { role: newRole, active: newActive },
    releasedPendingNotes: released,
  }).run();
  const sync = await syncAccessGroup(c.env);
  await c.env.DB.prepare("UPDATE users SET access_sync = ? WHERE id = ?").bind(sync, id).run();
  return c.json({ ok: true, accessSync: sync });
});

// ---------- Settings & audit ----------

adminManage.get("/settings", async (c) => c.json(await getSettings(c.env)));

adminManage.patch("/settings", async (c) => {
  const body = await readJson(c, settingsPatch);
  const before = await getSettings(c.env);
  const stmts: D1PreparedStatement[] = [];
  const now = nowIso();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    const key = SETTINGS_KEYS[k as keyof typeof SETTINGS_KEYS];
    const value = v === null ? "" : String(v);
    stmts.push(
      c.env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      ).bind(key, value, now),
    );
  }
  const opens = body.opensAt === undefined ? before.opensAt : body.opensAt;
  const closes = body.closesAt === undefined ? before.closesAt : body.closesAt;
  if (opens && closes && opens >= closes) {
    throw new ApiError(400, "VALIDATION", "Closing time must be after opening time.");
  }
  if (!stmts.length) return c.json(before);
  stmts.push(auditStmt(c.env.DB, c.get("user"), "settings.update", "settings", null, { before, changes: body }));
  await c.env.DB.batch(stmts);
  return c.json(await getSettings(c.env));
});

const auditQuery = z.object({
  cursor: z.string().max(200).optional(),
  entityType: z.string().max(30).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

adminManage.get("/audit", async (c) => {
  const p = auditQuery.safeParse(c.req.query());
  if (!p.success) throw new ApiError(400, "VALIDATION", "Invalid filters.");
  const where: string[] = [];
  const args: unknown[] = [];
  if (p.data.entityType) (where.push("entity_type = ?"), args.push(p.data.entityType));
  const cur = decodeCursor(p.data.cursor);
  if (cur) (where.push("(created_at, id) < (?, ?)"), args.push(cur.createdAt, cur.id));
  const { results } = await c.env.DB.prepare(
    `SELECT id, actor_email AS actor, action, entity_type AS entityType, entity_id AS entityId, detail, created_at AS createdAt
       FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
  )
    .bind(...args, p.data.limit + 1)
    .all<{ id: string; createdAt: string }>();
  const items = results.slice(0, p.data.limit);
  const last = results.length > p.data.limit ? results[p.data.limit - 1]! : null;
  return c.json({ items, nextCursor: last ? encodeCursor(last.createdAt, last.id) : null });
});

// ---------- Coverage & exports ----------

adminManage.get("/export/awards.csv", async (c) => {
  const list = await awardResults(c.env.DB);
  const rows: (string | number | null)[][] = [["award", "active", "rank", "teacher", "votes", "tie_at_top", "overlap_with_other_award", "recorded_winner"]];
  for (const a of list) {
    for (const r of a.ranking) {
      rows.push([a.name as string, a.active ? "yes" : "no", r.rank, r.teacherName, r.votes, a.tie && r.rank === 1 ? "yes" : "", a.overlaps.includes(r.teacherId) ? "yes" : "", a.winnerName ?? ""]);
    }
    if (!a.ranking.length) rows.push([a.name as string, a.active ? "yes" : "no", "", "", 0, "", "", a.winnerName ?? ""]);
  }
  await auditStmt(c.env.DB, c.get("user"), "export.awards", "award", null).run();
  return csvResponse("award-results.csv", rows);
});

adminManage.get("/export/classes.csv", async (c) => {
  const includeCodes = c.req.query("codes") === "1";
  const { results } = await c.env.DB.prepare(
    `SELECT c.label, g.label AS grade, c.expected_students, c.soft_quota, c.status, c.code_cipher,
            COUNT(s.id) AS raw, COALESCE(SUM(s.status='active'),0) AS active, COALESCE(SUM(s.status='voided'),0) AS voided
       FROM classes c JOIN grades g ON g.id = c.grade_id LEFT JOIN submissions s ON s.class_id = c.id
      GROUP BY c.id ORDER BY g.sort_order, c.label`,
  ).all<Record<string, string | number | null>>();
  const header = ["class", "grade", "expected_students", "soft_quota", "status", "raw_submissions", "active_submissions", "voided_submissions"];
  if (includeCodes) header.push("code");
  const rows: (string | number | null | undefined)[][] = [header];
  for (const r of results) {
    const row = [r.label, r.grade, r.expected_students, r.soft_quota, r.status, r.raw, r.active, r.voided];
    if (includeCodes) row.push(r.code_cipher ? await decryptCode(c.env, r.code_cipher as string) : "");
    rows.push(row);
  }
  await auditStmt(c.env.DB, c.get("user"), "export.classes", "class", null, { includeCodes }).run();
  return csvResponse(includeCodes ? "classes-with-codes.csv" : "classes.csv", rows);
});

adminManage.get("/export/coverage.csv", async (c) => {
  const s = await getSettings(c.env);
  const { results } = await c.env.DB.prepare(
    `SELECT t.honorific, t.full_name, COALESCE(SUM(n.status='approved' AND ${ACTIVE}),0) AS approved,
            COALESCE(SUM(n.status='pending' AND ${ACTIVE}),0) AS pending
       FROM teachers t LEFT JOIN notes n ON n.teacher_id = t.id LEFT JOIN submissions s ON s.id = n.submission_id
      WHERE t.active = 1 GROUP BY t.id ORDER BY t.full_name`,
  ).all<{ honorific: string; full_name: string; approved: number; pending: number }>();
  const rows: (string | number)[][] = [["teacher", "approved", "pending", "additional_needed"]];
  for (const r of results) {
    rows.push([teacherDisplayName({ honorific: r.honorific, fullName: r.full_name }), r.approved, r.pending, Math.max(0, s.minNotesPerTeacher - r.approved)]);
  }
  return csvResponse("teacher-coverage.csv", rows);
});

adminManage.get("/export/notes.csv", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT n.id, t.honorific, t.full_name, COALESCE(n.display_body, n.body) AS body, n.char_count, n.source, n.grade_label
       FROM notes n JOIN teachers t ON t.id = n.teacher_id LEFT JOIN submissions s ON s.id = n.submission_id
      WHERE n.status = 'approved' AND ${ACTIVE} ORDER BY t.full_name, n.created_at`,
  ).all<{ id: string; honorific: string; full_name: string; body: string; char_count: number; source: string; grade_label: string | null }>();
  const rows: (string | number | null)[][] = [["note_id", "teacher", "message", "characters", "source", "grade"]];
  for (const r of results) rows.push([r.id, teacherDisplayName({ honorific: r.honorific, fullName: r.full_name }), r.body, r.char_count, r.source, r.grade_label]);
  await auditStmt(c.env.DB, c.get("user"), "export.notes", "note", null, { count: results.length }).run();
  return csvResponse("approved-notes.csv", rows);
});

adminManage.get("/export/moderation.csv", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT COALESCE(u.email, '(unassigned)') AS reviewer, COUNT(*) AS total, COALESCE(SUM(n.status='pending'),0) AS pending,
            COALESCE(SUM(n.status='approved'),0) AS approved, COALESCE(SUM(n.status='trashed'),0) AS trashed
       FROM notes n LEFT JOIN users u ON u.id = n.assigned_reviewer_id LEFT JOIN submissions s ON s.id = n.submission_id
      WHERE ${ACTIVE} GROUP BY n.assigned_reviewer_id ORDER BY reviewer`,
  ).all<{ reviewer: string; total: number; pending: number; approved: number; trashed: number }>();
  const rows: (string | number)[][] = [["reviewer", "assigned", "pending", "approved", "trashed", "percent_done"]];
  for (const r of results) rows.push([r.reviewer, r.total, r.pending, r.approved, r.trashed, r.total ? Math.round(((r.total - r.pending) / r.total) * 100) : 0]);
  return csvResponse("moderation-progress.csv", rows);
});

adminManage.get("/export/backup.json", async (c) => {
  const tables = ["settings", "grades", "users", "classes", "teachers", "awards", "submissions", "votes", "notes", "note_events", "audit_log"];
  const out: Record<string, unknown[]> = {};
  // One batch = one consistent snapshot. Browser hashes are operational only and omitted.
  const res = await c.env.DB.batch(
    tables.map((t) => c.env.DB.prepare(t === "submissions" ? "SELECT * FROM submissions" : `SELECT * FROM ${t}`)),
  );
  tables.forEach((t, i) => {
    out[t] = (res[i]!.results as Record<string, unknown>[]).map((r) => {
      if (t === "submissions") {
        const { browser_hash: _b, ...rest } = r;
        void _b;
        return rest;
      }
      return r;
    });
  });
  await auditStmt(c.env.DB, c.get("user"), "export.backup", "system", null).run();
  return new Response(JSON.stringify({ exportedAt: nowIso(), format: "stjb-thanks-backup-v1", tables: out }), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="stjb-thanks-backup-${nowIso().slice(0, 10)}.json"`,
      "cache-control": "no-store",
    },
  });
});
