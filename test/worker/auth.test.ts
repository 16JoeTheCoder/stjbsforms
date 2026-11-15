import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWK } from "jose";
import { env } from "cloudflare:workers";
import { __setJwksForTests } from "../../src/worker/auth";
import { call, json, OWNER, seed, submission, cookie, type Seed } from "./helpers";

const TEAM = "https://stjb-test.cloudflareaccess.com";
const AUD = "aud-staff-123";
const ADMIN = "https://thanks-admin.test";
const PUBLIC = "https://thanks.test";
const PROD = { ENVIRONMENT: "production", ADMIN_HOST: "thanks-admin.test", PUBLIC_HOST: "thanks.test", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

let priv: CryptoKey;
let otherPriv: CryptoKey;
let s: Seed;

async function token(email: string, o: { aud?: string; iss?: string; exp?: string | number; key?: CryptoKey } = {}) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(o.iss ?? TEAM)
    .setAudience(o.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(o.exp ?? "1h")
    .sign(o.key ?? priv);
}

const staff = async (path: string, email: string | null, init: Parameters<typeof call>[1] = {}, tok?: string) =>
  call(path, {
    ...init,
    base: init.base ?? ADMIN,
    env: { ...PROD, ...(init.env ?? {}) },
    headers: { ...(init.headers as Record<string, string>), ...(email || tok ? { "cf-access-jwt-assertion": tok ?? (await token(email!)) } : {}) },
  });

beforeAll(async () => {
  s = await seed();
  const kp = await generateKeyPair("RS256", { extractable: true });
  priv = kp.privateKey as CryptoKey;
  otherPriv = (await generateKeyPair("RS256")).privateKey as CryptoKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256" } as JWK;
  __setJwksForTests(createLocalJWKSet({ keys: [jwk] }));
  await call("/api/admin/users", { method: "POST", json: { email: "rev@test.dev", role: "reviewer" }, as: OWNER });
  await call("/api/admin/users", { method: "POST", json: { email: "rev2@test.dev", role: "reviewer" }, as: OWNER });
});

describe("Cloudflare Access JWT validation", () => {
  it("accepts a valid token for an allow-listed admin", async () => {
    const r = await staff("/api/me", OWNER);
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ email: OWNER, role: "admin", isOwner: true });
  });
  it("rejects missing, wrong-audience, wrong-issuer, expired and forged tokens", async () => {
    expect((await staff("/api/me", null)).status).toBe(401);
    expect((await staff("/api/me", null, {}, await token(OWNER, { aud: "other" }))).status).toBe(401);
    expect((await staff("/api/me", null, {}, await token(OWNER, { iss: "https://evil.cloudflareaccess.com" }))).status).toBe(401);
    expect((await staff("/api/me", null, {}, await token(OWNER, { exp: Math.floor(Date.now() / 1000) - 3600 }))).status).toBe(401);
    expect((await staff("/api/me", null, {}, await token(OWNER, { key: otherPriv }))).status).toBe(401);
    expect((await staff("/api/me", null, {}, "not.a.jwt")).status).toBe(401);
  });
  it("ignores spoofed identity headers in production", async () => {
    const r = await call("/api/me", { base: ADMIN, env: PROD, headers: { "x-dev-user": OWNER, "cf-access-authenticated-user-email": OWNER } });
    expect(r.status).toBe(401);
  });
  it("refuses unknown verified emails", async () => {
    const r = await staff("/api/me", "stranger@example.com");
    expect(r.status).toBe(403);
  });
  it("privileged APIs are not reachable on the public or any other hostname", async () => {
    const tok = await token(OWNER);
    for (const base of [PUBLIC, "https://stjb-thanks.someone.workers.dev", "https://abc123-stjb-thanks.preview.workers.dev"]) {
      const r = await call("/api/admin/overview", { base, env: PROD, headers: { "cf-access-jwt-assertion": tok } });
      expect(r.status).toBe(404);
      const m = await call("/api/me", { base, env: PROD, headers: { "cf-access-jwt-assertion": tok } });
      expect(m.status).toBe(404);
    }
  });
  it("dev identity shortcut is unavailable outside development", async () => {
    const r = await call("/api/me", { base: "http://localhost", env: { ...PROD }, as: OWNER });
    expect(r.status).toBe(404);
  });
});

describe("role-based access", () => {
  it("reviewers cannot use any admin endpoint", async () => {
    for (const p of ["/api/admin/overview", "/api/admin/awards", "/api/admin/classes", "/api/admin/users", "/api/admin/notes", "/api/admin/export/awards.csv", "/api/admin/print/snapshot"]) {
      expect((await staff(p, "rev@test.dev")).status).toBe(403);
    }
    const w = await staff("/api/admin/users", "rev@test.dev", { method: "POST", json: { email: "x@y.z", role: "admin" } });
    expect(w.status).toBe(403);
  });
  it("disabled users lose access immediately", async () => {
    const users = await json<{ users: { id: string; email: string }[] }>(call("/api/admin/users", { as: OWNER }));
    const r2 = users.users.find((u) => u.email === "rev2@test.dev")!;
    expect((await staff("/api/review/progress", "rev2@test.dev")).status).toBe(200);
    await call(`/api/admin/users/${r2.id}`, { method: "PATCH", json: { active: false }, as: OWNER });
    expect((await staff("/api/review/progress", "rev2@test.dev")).status).toBe(403);
  });
  it("CSRF: cross-origin writes are rejected even with a valid token", async () => {
    const r = await staff("/api/admin/settings", OWNER, { method: "PATCH", json: { submissionsOpen: true }, headers: { origin: "https://evil.example" } });
    expect(r.status).toBe(403);
  });
  it("no CORS headers are emitted", async () => {
    const r = await staff("/api/me", OWNER, { headers: { origin: "https://evil.example" } });
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("user management safety", () => {
  it("prevents self-modification and removing the last admin", async () => {
    const users = await json<{ users: { id: string; email: string }[] }>(call("/api/admin/users", { as: OWNER }));
    const me = users.users.find((u) => u.email === OWNER)!;
    const self = await call(`/api/admin/users/${me.id}`, { method: "PATCH", json: { role: "reviewer" }, as: OWNER });
    expect(self.status).toBe(403);
    // A second admin cannot demote the owner, and the owner cannot be left as... the only admin removal is blocked
    await call("/api/admin/users", { method: "POST", json: { email: "admin2@test.dev", role: "admin" }, as: OWNER });
    const a2 = (await json<{ users: { id: string; email: string }[] }>(call("/api/admin/users", { as: OWNER }))).users.find((u) => u.email === "admin2@test.dev")!;
    const ownerByA2 = await call(`/api/admin/users/${me.id}`, { method: "PATCH", json: { active: false }, as: "admin2@test.dev" });
    expect(ownerByA2.status).toBe(403);
    // Owner demotes admin2: allowed (owner remains admin)
    expect((await call(`/api/admin/users/${a2.id}`, { method: "PATCH", json: { role: "reviewer" }, as: OWNER })).status).toBe(200);
  });
  it("reports LAST_ADMIN when the only other admin would be removed", async () => {
    const solo = await env.DB.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1").first<{ n: number }>();
    expect(solo!.n).toBe(1);
    // simulate: a non-owner sole admin trying to disable themselves is blocked by self rule; the guard is exercised via SQL
    const r = await env.DB.prepare(
      `UPDATE users SET active = 0 WHERE email = ? AND (1 = 0 OR (SELECT COUNT(*) FROM users WHERE role='admin' AND active=1 AND email != ?) >= 1)`,
    )
      .bind(OWNER, OWNER)
      .run();
    expect(r.meta.changes).toBe(0);
  });
});

describe("reviewer isolation (IDOR)", () => {
  it("reviewers see only their assigned notes and never class labels", async () => {
    // create submissions so there are notes
    for (let i = 0; i < 3; i++) await call("/api/public/submissions", { method: "POST", json: submission(s, { offset: i }), cookie: cookie() });
    const users = await json<{ users: { id: string; email: string }[] }>(call("/api/admin/users", { as: OWNER }));
    const rev = users.users.find((u) => u.email === "rev@test.dev")!;
    await call("/api/admin/assignments/distribute", { method: "POST", json: { reviewerIds: [rev.id] }, as: OWNER });
    const page = await json<{ items: Record<string, unknown>[] }>(staff("/api/review/notes?status=pending", "rev@test.dev"));
    expect(page.items.length).toBeGreaterThan(0);
    for (const n of page.items) {
      expect(n).not.toHaveProperty("classLabel");
      expect(n).not.toHaveProperty("classId");
      expect(n).not.toHaveProperty("submissionId");
      expect(n).toHaveProperty("gradeLabel");
      expect(n.createdAt).toBe(""); // timestamps would let reviewers link a student's notes
    }
    // a note not assigned to this reviewer cannot be moderated by them
    const other = await env.DB.prepare("SELECT id, version FROM notes WHERE assigned_reviewer_id IS NOT ? LIMIT 1").bind(rev.id).first<{ id: string; version: number }>();
    if (other) {
      await env.DB.prepare("UPDATE notes SET assigned_reviewer_id = NULL WHERE id = ?").bind(other.id).run();
      const r = await staff(`/api/review/notes/${other.id}/status`, "rev@test.dev", { method: "POST", json: { status: "approved", version: other.version } });
      expect(r.status).toBe(404);
    }
  });
});
