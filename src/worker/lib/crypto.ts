import type { Env } from "../env";
import { ApiError } from "./http";

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

function secret(env: Env): string {
  const s = env.APP_SECRET;
  if (!s || s.length < 32) {
    if (env.ENVIRONMENT === "development") return "dev-only-insecure-secret-change-me-0123456789";
    throw new ApiError(503, "CONFIG", "Server is not configured (APP_SECRET).");
  }
  return s;
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function hmacKey(env: Env, purpose: string): Promise<CryptoKey> {
  const k = `${purpose}:${secret(env)}`;
  let p = keyCache.get(k);
  if (!p) {
    p = crypto.subtle.importKey("raw", enc.encode(k), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keyCache.set(k, p);
  }
  return p;
}

export async function hmacHex(env: Env, purpose: string, value: string): Promise<string> {
  const key = await hmacKey(env, purpose);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(value)));
}

async function aesKey(env: Env): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`code-cipher:${secret(env)}`));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptCode(env: Env, code: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), enc.encode(code));
  return `${toB64(iv)}.${toB64(ct)}`;
}

export async function decryptCode(env: Env, cipher: string): Promise<string | null> {
  try {
    const [iv, ct] = cipher.split(".");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv!) }, await aesKey(env), fromB64(ct!));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

export function randomToken(bytes = 24): string {
  return toB64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
