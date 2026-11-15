import type { Context, MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "./env";
import { ApiError } from "./lib/http";
import { nowIso, uid } from "./lib/db";
import type { Role } from "../shared/types";

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  isOwner: boolean;
}

export type AppEnv = { Bindings: Env; Variables: { user: AuthUser } };

let jwks: { domain: string; get: JWTVerifyGetKey } | null = null;
let jwksOverride: JWTVerifyGetKey | null = null;

/** Test hook: lets integration tests verify tokens signed by a local key. */
export function __setJwksForTests(get: JWTVerifyGetKey | null) {
  jwksOverride = get;
}

function getJwks(domain: string): JWTVerifyGetKey {
  if (jwksOverride) return jwksOverride;
  if (!jwks || jwks.domain !== domain) {
    jwks = { domain, get: createRemoteJWKSet(new URL(`${domain}/cdn-cgi/access/certs`), { cacheMaxAge: 10 * 60_000 }) };
  }
  return jwks.get;
}

export const isDev = (env: Env) => env.ENVIRONMENT === "development";

function hostOf(c: Context): string {
  return new URL(c.req.url).hostname.toLowerCase();
}

export function isLocalHost(host: string) {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** True when this request arrived on the staff hostname (or localhost in dev). */
export function onStaffHost(c: Context<AppEnv>): boolean {
  const host = hostOf(c);
  if (c.env.ADMIN_HOST && host === c.env.ADMIN_HOST.toLowerCase()) return true;
  return isDev(c.env) && isLocalHost(host);
}

/** Verifies the Cloudflare Access JWT and returns the verified email, or null. */
export async function verifiedEmail(c: Context<AppEnv>): Promise<string | null> {
  const env = c.env;
  const token = c.req.header("cf-access-jwt-assertion");
  if (token) {
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
      throw new ApiError(503, "CONFIG", "Cloudflare Access is not configured on this deployment.");
    }
    const issuer = env.ACCESS_TEAM_DOMAIN.replace(/\/+$/, "");
    try {
      const { payload } = await jwtVerify(token, getJwks(issuer), {
        issuer,
        audience: env.ACCESS_AUD,
        algorithms: ["RS256"],
        clockTolerance: 30,
      });
      const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
      return email || null;
    } catch {
      return null;
    }
  }
  if (isDev(env) && isLocalHost(hostOf(c))) {
    const devEmail = c.req.header("x-dev-user") ?? env.DEV_USER_EMAIL;
    return devEmail ? devEmail.trim().toLowerCase() : null;
  }
  return null;
}

interface UserRow {
  id: string;
  email: string;
  role: Role;
  active: number;
  is_owner: number;
  last_seen_at: string | null;
}

async function loadUser(env: Env, email: string): Promise<UserRow | null> {
  let row = await env.DB.prepare("SELECT id, email, role, active, is_owner, last_seen_at FROM users WHERE email = ?")
    .bind(email)
    .first<UserRow>();
  const owner = env.OWNER_EMAIL?.trim().toLowerCase();
  if (!row && owner && email === owner) {
    // Bootstrap: the configured owner becomes the first administrator.
    const now = nowIso();
    await env.DB.prepare(
      `INSERT INTO users (id, email, role, active, is_owner, access_sync, created_at, updated_at)
       VALUES (?, ?, 'admin', 1, 1, 'bootstrap', ?, ?) ON CONFLICT(email) DO NOTHING`,
    )
      .bind(uid("usr"), email, now, now)
      .run();
    row = await env.DB.prepare("SELECT id, email, role, active, is_owner, last_seen_at FROM users WHERE email = ?")
      .bind(email)
      .first<UserRow>();
  }
  return row;
}

/** Requires: staff hostname + verified Access identity + active D1 user with one of `roles`. */
export function requireRole(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!onStaffHost(c)) throw new ApiError(404, "NOT_FOUND", "Not found");
    const email = await verifiedEmail(c);
    if (!email) throw new ApiError(401, "UNAUTHENTICATED", "Your sign-in has expired. Reload the page to sign in again.");
    const row = await loadUser(c.env, email);
    if (!row || !row.active) {
      throw new ApiError(403, "FORBIDDEN", "This email address does not have access. Ask an administrator to invite you.");
    }
    if (!roles.includes(row.role)) throw new ApiError(403, "FORBIDDEN", "You do not have permission to do that.");
    c.set("user", { id: row.id, email: row.email, role: row.role, isOwner: row.is_owner === 1 });
    const stale = !row.last_seen_at || Date.now() - Date.parse(row.last_seen_at) > 5 * 60_000;
    if (stale) {
      c.executionCtx?.waitUntil?.(
        c.env.DB.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").bind(nowIso(), row.id).run().then(() => undefined),
      );
    }
    await next();
  };
}

/**
 * CSRF defence for state-changing requests: Origin (or Sec-Fetch-Site) must be
 * same-origin. Access cookies are sent cross-site, so this matters.
 */
export const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = c.req.method;
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") {
    const origin = c.req.header("origin");
    const self = new URL(c.req.url).origin;
    const site = c.req.header("sec-fetch-site");
    const ok = origin ? origin === self : site ? site === "same-origin" : false;
    if (!ok) throw new ApiError(403, "FORBIDDEN", "Cross-site request blocked.");
  }
  await next();
};
