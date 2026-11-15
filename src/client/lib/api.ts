import type { ApiErrorBody, ErrorCode } from "../../shared/types";

export class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: ErrorCode | "NETWORK",
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
  /** True when we can't know whether the server processed the request. */
  get uncertain() {
    return this.code === "NETWORK" || this.status >= 500 || this.status === 0;
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const { json, timeoutMs = 20_000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "same-origin",
      redirect: "manual",
      ...rest,
      signal: rest.signal ?? ctrl.signal,
      headers: {
        accept: "application/json",
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
        ...rest.headers,
      },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiFailure(0, "NETWORK", "Can't reach the server. Check your connection — nothing you've written is lost.");
  } finally {
    clearTimeout(timer);
  }
  if (res.type === "opaqueredirect") {
    // Cloudflare Access redirects to its login page when the session has expired.
    throw new ApiFailure(401, "UNAUTHENTICATED", "Your session has expired. Reload the page to sign in again.");
  }
  if (res.ok) {
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  let body: ApiErrorBody | null = null;
  try {
    body = (await res.json()) as ApiErrorBody;
  } catch {
    /* non-JSON error (e.g. Access login page) */
  }
  if (res.status === 401 || (!body && (res.status === 403 || res.redirected))) {
    throw new ApiFailure(401, "UNAUTHENTICATED", "Your session has expired. Reload the page to sign in again.");
  }
  throw new ApiFailure(
    res.status,
    body?.error.code ?? "INTERNAL",
    body?.error.message ?? `Request failed (${res.status}).`,
    body?.error.details,
  );
}

export const jakarta = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jakarta",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
export const fmtTime = (iso: string | null | undefined) => (iso ? `${jakarta.format(new Date(iso))} WIB` : "—");

export function randomKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
