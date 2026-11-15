import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { CheckCircle2, XCircle } from "lucide-react";
import { api, ApiFailure } from "../lib/api";

type Toast = { id: number; tone: "ok" | "bad"; text: string };
const ToastCtx = createContext<(tone: Toast["tone"], text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast["tone"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "bad" ? 8000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={clsx(
              "pointer-events-auto flex max-w-lg items-start gap-2 rounded-xl px-4 py-3 text-sm shadow-[var(--shadow-lift)]",
              t.tone === "ok" ? "bg-ink text-paper" : "bg-bad text-white",
            )}
          >
            {t.tone === "ok" ? <CheckCircle2 aria-hidden className="mt-px size-4 shrink-0" /> : <XCircle aria-hidden className="mt-px size-4 shrink-0" />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/** POST/PATCH helper that toasts errors and invalidates the given query keys. */
export function useAction<TVars, TRes = unknown>(
  fn: (v: TVars) => Promise<TRes>,
  opts: { invalidate?: string[][]; success?: string | ((r: TRes) => string); onSuccess?: (r: TRes, v: TVars) => void } = {},
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r, v) => {
      for (const k of opts.invalidate ?? []) void qc.invalidateQueries({ queryKey: k });
      const msg = typeof opts.success === "function" ? opts.success(r) : opts.success;
      if (msg) toast("ok", msg);
      opts.onSuccess?.(r, v);
    },
    onError: (e) => toast("bad", e instanceof ApiFailure ? e.message : "Something went wrong."),
  });
}

export const post = <T,>(path: string, json?: unknown) => api<T>(path, { method: "POST", json: json ?? {} });
export const patch = <T,>(path: string, json: unknown) => api<T>(path, { method: "PATCH", json });

export function PageHeader({ title, lead, actions }: { title: string; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.015em]">{title}</h1>
        {lead ? <p className="mt-1 max-w-[70ch] text-[15px] text-ink-2">{lead}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "warn" | "bad" | "ok" }) {
  return (
    <div className="rounded-xl border border-line bg-card px-4 py-3">
      <p className="text-[13px] text-muted">{label}</p>
      <p
        className={clsx(
          "mt-0.5 text-[24px] font-semibold tabular leading-tight",
          tone === "warn" && "text-warn",
          tone === "bad" && "text-bad",
          tone === "ok" && "text-ok",
        )}
      >
        {value}
      </p>
      {sub ? <p className="mt-0.5 text-xs text-muted">{sub}</p> : null}
    </div>
  );
}

export function Meter({ value, max, label }: { value: number; max: number; label?: string }) {
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-2" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-paper-2">
        <div className="h-full rounded-full bg-ink transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-10 text-right text-xs tabular text-ink-2">{pct}%</span>
    </div>
  );
}

export function StatusChip({ status }: { status: string }) {
  return (
    <span
      className={clsx(
        "chip",
        status === "approved" && "bg-ok-soft text-ok",
        status === "pending" && "bg-paper-2 text-ink-2",
        status === "trashed" && "bg-bad-soft text-bad",
        status === "voided" && "bg-bad-soft text-bad",
        status === "active" && "bg-ok-soft text-ok",
        status === "paused" && "bg-warn-soft text-warn",
        status === "disabled" && "bg-paper-2 text-muted",
      )}
    >
      {status === "trashed" ? "Trash" : status[0]!.toUpperCase() + status.slice(1)}
    </span>
  );
}

export const FLAG_LABEL: Record<string, string> = {
  over_quota: "Over quota",
  submission_voided: "Voided",
  short: "Short",
  repeated_characters: "Repeated chars",
  repetitive_words: "Repetitive",
  duplicate_elsewhere: "Duplicate text",
};

export function Flags({ flags }: { flags: string[] }) {
  if (!flags.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <span key={f} className={clsx("chip", f === "short" ? "bg-paper-2 text-ink-2" : "bg-warn-soft text-warn")}>
          {FLAG_LABEL[f] ?? f}
        </span>
      ))}
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong px-6 py-12 text-center">
      <p className="font-semibold">{title}</p>
      {children ? <div className="mx-auto mt-1 max-w-[50ch] text-sm text-ink-2">{children}</div> : null}
    </div>
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  const { label, className, ...rest } = props;
  return (
    <label className="flex flex-col gap-1 text-[13px] font-medium text-ink-2">
      {label}
      <select {...rest} className={clsx("h-10 rounded-lg border border-line-strong bg-card px-2.5 text-sm text-ink focus:border-ink focus:outline-none", className)} />
    </label>
  );
}

/** Parses simple CSV (quoted fields supported). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  const t = text.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (q) {
      if (ch === '"' && t[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") (row.push(cur), (cur = ""));
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && t[i + 1] === "\n") i++;
      row.push(cur);
      cur = "";
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}
