import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import type { ErrorCode } from "../../shared/types";

export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: ErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const bad = (msg: string, details?: unknown) => new ApiError(400, "VALIDATION", msg, details);
export const notFound = (what = "Not found") => new ApiError(404, "NOT_FOUND", what);
export const forbidden = (msg = "You do not have permission to do that.") => new ApiError(403, "FORBIDDEN", msg);
export const conflict = (msg: string, details?: unknown) => new ApiError(409, "CONFLICT", msg, details);

export const MAX_BODY_BYTES = 256 * 1024;

/** Reads and validates a JSON body with a hard size bound. */
export async function readJson<T extends z.ZodTypeAny>(c: Context, schema: T, maxBytes = MAX_BODY_BYTES): Promise<z.infer<T>> {
  const ct = c.req.header("content-type") ?? "";
  if (!ct.toLowerCase().startsWith("application/json")) {
    throw new ApiError(415 as ContentfulStatusCode, "BAD_REQUEST", "Expected application/json");
  }
  const len = Number(c.req.header("content-length") ?? "0");
  if (len > maxBytes) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request is too large.");
  // Stream with a hard cap so chunked bodies without Content-Length can't exhaust memory.
  const reader = c.req.raw.body?.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request is too large.");
      }
      parts.push(value);
    }
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const p of parts) (buf.set(p, off), (off += p.byteLength));
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new ApiError(400, "BAD_REQUEST", "Malformed JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw bad("Some fields are invalid.", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  return parsed.data;
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return Response.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      { status: err.status },
    );
  }
  // Never echo internals; log only the error class/message (no request bodies).
  console.error("unhandled", err instanceof Error ? `${err.name}: ${err.message}` : "unknown");
  return Response.json({ error: { code: "INTERNAL", message: "Something went wrong on our side." } }, { status: 500 });
}

export function csvResponse(filename: string, rows: (string | number | null | undefined)[][]): Response {
  const esc = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? "" : String(v);
    // Neutralise spreadsheet formula injection
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
