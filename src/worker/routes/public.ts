import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../auth";
import { isDev } from "../auth";
import type { Env } from "../env";
import { ApiError, readJson } from "../lib/http";
import { getSettings, isOpen, nowIso, uid } from "../lib/db";
import { hmacHex, randomToken, sha256Hex } from "../lib/crypto";
import { classAccessInput, idempotencyKey, submissionInput } from "../../shared/schemas";
import { isValidClassCode, normalizeClassCode, generateReceiptCode } from "../../shared/codes";
import { cleanNoteText, countChars, lowEffortFlags, normalizeForCompare, noteProblem } from "../../shared/text";
import type { ClassAccessResult, PublicConfig, PublicFormData, SubmissionReceipt } from "../../shared/types";

export const BROWSER_COOKIE = "__Host-stjb_bid";
const BROWSER_COOKIE_DEV = "stjb_bid";

export const publicRoutes = new Hono<AppEnv>();

function cookieName(c: Context<AppEnv>) {
  // __Host- cookies require HTTPS; local http dev uses a plain name.
  return new URL(c.req.url).protocol === "https:" ? BROWSER_COOKIE : BROWSER_COOKIE_DEV;
}

/** Returns the browser id, issuing a persistent HttpOnly cookie if needed. */
function browserId(c: Context<AppEnv>, issue: boolean): string | null {
  const name = cookieName(c);
  const existing = getCookie(c, name);
  if (existing && /^[A-Za-z0-9_-]{20,64}$/.test(existing)) return existing;
  if (!issue) return null;
  const v = randomToken(24);
  setCookie(c, name, v, {
    httpOnly: true,
    secure: name === BROWSER_COOKIE,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 180,
  });
  return v;
}

async function limit(c: Context<AppEnv>, binding: RateLimit | undefined, key: string): Promise<void> {
  if (!binding) {
    if (isDev(c.env)) return;
    // Fail closed: a missing binding means a misconfigured deployment.
    throw new ApiError(503, "CONFIG", "Server is not configured (rate limiter).");
  }
  const { success } = await binding.limit({ key });
  if (!success) throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Wait a minute and try again.");
}

function networkKey(c: Context<AppEnv>, scope: string) {
  // Used only as an ephemeral rate-limit key; never stored.
  return `${scope}:${c.req.header("cf-connecting-ip") ?? "local"}`;
}

publicRoutes.get("/config", async (c) => {
  browserId(c, true);
  const s = await getSettings(c.env);
  const body: PublicConfig = {
    surface: c.env.ADMIN_HOST && new URL(c.req.url).hostname === c.env.ADMIN_HOST.toLowerCase() ? "staff" : "student",
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY || null,
    open: isOpen(s),
    opensAt: s.opensAt,
    closesAt: s.closesAt,
    formVersion: s.formVersion,
  };
  c.header("cache-control", "no-store");
  return c.json(body);
});

publicRoutes.get("/form", async (c) => {
  const db = c.env.DB;
  const [teachers, awards, s] = await Promise.all([
    db.prepare("SELECT id, honorific, full_name AS fullName FROM teachers WHERE active = 1 ORDER BY full_name").all<{
      id: string;
      honorific: string;
      fullName: string;
    }>(),
    db.prepare("SELECT id, name, description FROM awards WHERE active = 1 ORDER BY display_order, id").all<{
      id: string;
      name: string;
      description: string;
    }>(),
    getSettings(c.env),
  ]);
  const body: PublicFormData = { teachers: teachers.results, awards: awards.results, formVersion: s.formVersion };
  c.header("cache-control", "public, max-age=30");
  return c.json(body);
});

interface ClassRow {
  id: string;
  label: string;
  status: "active" | "paused" | "disabled";
  grade_id: string;
  grade_label: string;
  soft_quota: number;
}

async function classByCode(env: Env, code: string): Promise<ClassRow | null> {
  const hash = await hmacHex(env, "class-code", code);
  return env.DB.prepare(
    `SELECT c.id, c.label, c.status, c.grade_id, g.label AS grade_label, c.soft_quota
       FROM classes c JOIN grades g ON g.id = c.grade_id WHERE c.code_hash = ?`,
  )
    .bind(hash)
    .first<ClassRow>();
}

/**
 * Code-guessing defence that never counts legitimate successes: every *failed*
 * lookup is counted against a global budget; once exhausted, this isolate answers
 * all lookups (valid or not) with 429 for a minute, so guesses yield no signal.
 */
let codeGateUntil = 0;
async function recordCodeMiss(c: Context<AppEnv>) {
  const b = c.env.CODE_MISS_LIMITER;
  if (!b) return;
  const { success } = await b.limit({ key: "class-code-miss" });
  if (!success) codeGateUntil = Date.now() + 60_000;
}
function codeGate() {
  if (Date.now() < codeGateUntil) throw new ApiError(429, "RATE_LIMITED", "Too many attempts right now. Wait a minute and try again.");
}

publicRoutes.post("/class-access", async (c) => {
  codeGate();
  const bid = browserId(c, true)!;
  await limit(c, c.env.NETWORK_LIMITER, networkKey(c, "code"));
  await limit(c, c.env.BROWSER_LIMITER, `code:${bid}`);
  const { code: raw } = await readJson(c, classAccessInput, 2048);
  const code = normalizeClassCode(raw);
  if (!isValidClassCode(code)) {
    throw new ApiError(400, "INVALID_CODE", "Class codes are 5 letters or numbers. Check the code and try again.");
  }
  const cls = await classByCode(c.env, code);
  if (!cls) await recordCodeMiss(c);
  if (!cls || cls.status === "disabled") {
    throw new ApiError(404, "INVALID_CODE", "We couldn't find that class code. Check it with your class representative.");
  }
  if (cls.status === "paused") {
    throw new ApiError(403, "CLASS_PAUSED", "Submissions for this class are paused right now. Please try again later.");
  }
  const body: ClassAccessResult = { classId: cls.id, classLabel: cls.label, gradeLabel: cls.grade_label };
  return c.json(body);
});

async function receiptByKey(env: Env, key: string): Promise<SubmissionReceipt | null> {
  const row = await env.DB.prepare("SELECT receipt_code, created_at FROM submissions WHERE idempotency_key = ?")
    .bind(key)
    .first<{ receipt_code: string; created_at: string }>();
  return row ? { receiptCode: row.receipt_code, submittedAt: row.created_at } : null;
}

publicRoutes.get("/submissions/:key", async (c) => {
  const key = idempotencyKey.safeParse(c.req.param("key"));
  if (!key.success) throw new ApiError(400, "BAD_REQUEST", "Invalid key.");
  await limit(c, c.env.BROWSER_LIMITER, `receipt:${browserId(c, true)}`);
  const r = await receiptByKey(c.env, key.data);
  c.header("cache-control", "no-store");
  if (!r) return c.json({ found: false }, 404);
  return c.json({ found: true, ...r });
});

async function verifyTurnstile(c: Context<AppEnv>, token: string, idem: string): Promise<void> {
  const env = c.env;
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if (isDev(env)) return; // local development without a Turnstile secret
    throw new ApiError(503, "CONFIG", "Verification is not configured. Please tell the student council.");
  }
  if (!token) throw new ApiError(400, "TURNSTILE_FAILED", "Please complete the verification check and submit again.");
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  form.append("idempotency_key", crypto.randomUUID());
  const ip = c.req.header("cf-connecting-ip");
  if (ip) form.append("remoteip", ip);
  let outcome: { success: boolean; action?: string; hostname?: string; "error-codes"?: string[] };
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    outcome = await res.json();
  } catch {
    throw new ApiError(503, "TURNSTILE_FAILED", "We couldn't verify the check just now. Your answers are saved — try again.");
  }
  // Cloudflare's documented test secrets don't return real action/hostname; never honoured in production.
  const testKey = env.ENVIRONMENT !== "production" && /^[123]x0{20,}/.test(secret);
  const hostOk = testKey || (Boolean(env.PUBLIC_HOST) && outcome.hostname === env.PUBLIC_HOST);
  const actionOk = testKey || outcome.action === "submit";
  if (!outcome.success || !hostOk || !actionOk) {
    void idem;
    throw new ApiError(400, "TURNSTILE_FAILED", "The verification check expired or failed. Complete it again and resubmit.");
  }
}

function isUniqueError(e: unknown, column: string): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("UNIQUE") && msg.includes(column);
}

publicRoutes.post("/submissions", async (c) => {
  const env = c.env;
  const bid = browserId(c, true)!;
  await limit(c, env.NETWORK_LIMITER, networkKey(c, "submit"));
  await limit(c, env.BROWSER_LIMITER, `submit:${bid}`);
  const input = await readJson(c, submissionInput, 64 * 1024);

  // 1. Idempotent replay: same key -> same result, regardless of current state.
  const prior = await receiptByKey(env, input.idempotencyKey);
  if (prior) return c.json({ ...prior, duplicate: true } satisfies SubmissionReceipt);

  // 2. One submission per browser (best effort).
  const browserHash = await hmacHex(env, "browser", bid);
  const sameBrowser = await env.DB.prepare("SELECT receipt_code, created_at, idempotency_key FROM submissions WHERE browser_hash = ?")
    .bind(browserHash)
    .first<{ receipt_code: string; created_at: string; idempotency_key: string }>();
  if (sameBrowser && sameBrowser.idempotency_key === input.idempotencyKey) {
    // A concurrent retry of this very submission committed first.
    return c.json({ receiptCode: sameBrowser.receipt_code, submittedAt: sameBrowser.created_at, duplicate: true } satisfies SubmissionReceipt);
  }
  if (sameBrowser) {
    throw new ApiError(409, "ALREADY_SUBMITTED", "This browser has already sent a response.", {
      receiptCode: sameBrowser.receipt_code,
      submittedAt: sameBrowser.created_at,
    });
  }

  // 3. Event window
  const settings = await getSettings(env);
  if (!isOpen(settings)) {
    throw new ApiError(403, "SUBMISSIONS_CLOSED", "Submissions are closed right now. Your answers are saved on this device.");
  }

  // 4. Class
  codeGate();
  const code = normalizeClassCode(input.classCode);
  const cls = isValidClassCode(code) ? await classByCode(env, code) : null;
  if (!cls) await recordCodeMiss(c);
  if (!cls || (input.classId && cls.id !== input.classId)) {
    const known = input.classId
      ? await env.DB.prepare("SELECT status FROM classes WHERE id = ?").bind(input.classId).first<{ status: string }>()
      : null;
    if (known && known.status !== "disabled") {
      throw new ApiError(409, "CODE_CHANGED", "Your class code has changed. Enter the new code — your answers are kept.");
    }
    throw new ApiError(404, "INVALID_CODE", "That class code is no longer valid. Enter a current code — your answers are kept.");
  }
  if (cls.status === "disabled") throw new ApiError(404, "INVALID_CODE", "That class code is no longer valid.");
  if (cls.status === "paused") {
    throw new ApiError(403, "CLASS_PAUSED", "Submissions for your class are paused. Your answers are saved — try again later.");
  }

  // 5. Votes: exactly one per active award, all distinct active teachers.
  const [awardsRes, teachersRes] = await Promise.all([
    env.DB.prepare("SELECT id FROM awards WHERE active = 1").all<{ id: string }>(),
    env.DB.prepare("SELECT id FROM teachers WHERE active = 1").all<{ id: string }>(),
  ]);
  const activeAwards = new Set(awardsRes.results.map((r) => r.id));
  const activeTeachers = new Set(teachersRes.results.map((r) => r.id));
  const voteAwards = new Set(input.votes.map((v) => v.awardId));
  const awardsMatch =
    voteAwards.size === input.votes.length &&
    voteAwards.size === activeAwards.size &&
    [...voteAwards].every((a) => activeAwards.has(a));
  if (!awardsMatch) {
    throw new ApiError(409, "STALE_FORM", "The award list was updated. Review your choices and submit again.");
  }
  const voteTeachers = input.votes.map((v) => v.teacherId);
  if (new Set(voteTeachers).size !== voteTeachers.length) {
    throw new ApiError(400, "VALIDATION", "Choose a different teacher for each award.", { field: "votes" });
  }
  const badTeacher = [...voteTeachers, ...input.notes.map((n) => n.teacherId)].find((t) => !activeTeachers.has(t));
  if (badTeacher) {
    throw new ApiError(409, "STALE_FORM", "One of the teachers you picked is no longer on the list. Choose again.", {
      teacherId: badTeacher,
    });
  }

  // 6. Notes
  const noteTeachers = input.notes.map((n) => n.teacherId);
  if (new Set(noteTeachers).size !== noteTeachers.length) {
    throw new ApiError(400, "VALIDATION", "Each letter must go to a different teacher.", { field: "notes" });
  }
  const cleaned = input.notes.map((n, i) => {
    const body = cleanNoteText(n.body);
    const problem = noteProblem(body);
    if (problem) {
      const msg =
        problem === "empty"
          ? `Letter ${i + 1} is empty.`
          : problem === "too_short"
            ? `Letter ${i + 1} needs at least 100 characters.`
            : `Letter ${i + 1} is over 400 characters.`;
      throw new ApiError(400, "VALIDATION", msg, { field: `notes.${i}`, problem });
    }
    return { teacherId: n.teacherId, body, chars: countChars(body), norm: normalizeForCompare(body) };
  });
  if (new Set(cleaned.map((n) => n.norm)).size !== cleaned.length) {
    throw new ApiError(400, "VALIDATION", "Each letter must be different. Two of your letters are identical.", {
      field: "notes",
      problem: "identical",
    });
  }
  const hashes = await Promise.all(cleaned.map((n) => sha256Hex(n.norm)));
  const seen = await env.DB.prepare(`SELECT DISTINCT body_hash FROM notes WHERE body_hash IN (${hashes.map(() => "?").join(", ")})`)
    .bind(...hashes)
    .all<{ body_hash: string }>();
  const seenSet = new Set(seen.results.map((r) => r.body_hash));

  // 7. Turnstile (last, so validation errors don't burn a token)
  await verifyTurnstile(c, input.turnstileToken ?? "", input.idempotencyKey);

  // 8. Atomic write
  const now = nowIso();
  const subId = uid("sub");
  const receipt = generateReceiptCode();
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO submissions (id, idempotency_key, browser_hash, class_id, grade_id, grade_label, receipt_code,
                                class_position, over_quota, form_version, created_at)
       SELECT ?, ?, ?, c.id, c.grade_id, g.label, ?,
              (SELECT COUNT(*) + 1 FROM submissions s WHERE s.class_id = c.id AND s.status = 'active'),
              CASE WHEN (SELECT COUNT(*) + 1 FROM submissions s WHERE s.class_id = c.id AND s.status = 'active') > c.soft_quota
                   THEN 1 ELSE 0 END,
              ?, ?
         FROM classes c JOIN grades g ON g.id = c.grade_id WHERE c.id = ?`,
    ).bind(subId, input.idempotencyKey, browserHash, receipt, settings.formVersion, now, cls.id),
  ];
  for (const v of input.votes) {
    stmts.push(
      env.DB.prepare("INSERT INTO votes (submission_id, award_id, teacher_id) VALUES (?, ?, ?)").bind(subId, v.awardId, v.teacherId),
    );
  }
  cleaned.forEach((n, i) => {
    const flags = lowEffortFlags(n.body);
    if (seenSet.has(hashes[i]!)) flags.push("duplicate_elsewhere");
    stmts.push(
      env.DB.prepare(
        `INSERT INTO notes (id, submission_id, slot, teacher_id, source, body, body_hash, char_count, grade_label, class_id,
                            status, flags, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'student', ?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?)`,
      ).bind(uid("note"), subId, i + 1, n.teacherId, n.body, hashes[i], n.chars, cls.grade_label, cls.id, JSON.stringify(flags), now, now),
    );
  });

  try {
    await env.DB.batch(stmts);
  } catch (e) {
    if (isUniqueError(e, "submissions.")) {
      // Lost a race with a concurrent retry of the same submission: return its receipt.
      const r = await receiptByKey(env, input.idempotencyKey);
      if (r) return c.json({ ...r, duplicate: true } satisfies SubmissionReceipt);
    }
    if (isUniqueError(e, "browser_hash")) {
      const prev = await env.DB.prepare("SELECT receipt_code, created_at FROM submissions WHERE browser_hash = ?")
        .bind(browserHash)
        .first<{ receipt_code: string; created_at: string }>();
      throw new ApiError(409, "ALREADY_SUBMITTED", "This browser has already sent a response.", prev ? { receiptCode: prev.receipt_code, submittedAt: prev.created_at } : undefined);
    }
    throw e;
  }
  const body: SubmissionReceipt = { receiptCode: receipt, submittedAt: now };
  return c.json(body, 201);
});
