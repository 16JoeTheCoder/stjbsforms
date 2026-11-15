import { useCallback, useEffect, useRef, useState } from "react";
import { randomKey } from "../lib/api";
import type { ClassAccessResult, SubmissionReceipt } from "../../shared/types";

export type Stage = "class" | "awards" | "letters" | "review" | "done";

export interface Letter {
  teacherId: string | null;
  body: string;
}

export interface Draft {
  v: 1;
  stage: Stage;
  classCode: string;
  classAccess: ClassAccessResult | null;
  awards: Record<string, string>; // awardId -> teacherId
  letters: [Letter, Letter, Letter];
  idempotencyKey: string;
  /** Set right before sending; cleared only once the outcome is known. */
  pendingSubmit: boolean;
  receipt: SubmissionReceipt | null;
  updatedAt: string;
}

export const DRAFT_KEY = "stjb.thanks.draft.v1";

export function emptyDraft(): Draft {
  return {
    v: 1,
    stage: "class",
    classCode: "",
    classAccess: null,
    awards: {},
    letters: [
      { teacherId: null, body: "" },
      { teacherId: null, body: "" },
      { teacherId: null, body: "" },
    ],
    idempotencyKey: randomKey(),
    pendingSubmit: false,
    receipt: null,
    updatedAt: new Date().toISOString(),
  };
}

export function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return emptyDraft();
    const d = JSON.parse(raw) as Partial<Draft>;
    if (d.v !== 1 || !Array.isArray(d.letters) || d.letters.length !== 3 || typeof d.idempotencyKey !== "string") {
      return emptyDraft();
    }
    return { ...emptyDraft(), ...d } as Draft;
  } catch {
    return emptyDraft();
  }
}

export function saveDraft(d: Draft): boolean {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...d, updatedAt: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Draft state persisted to localStorage: debounced while typing, flushed
 * synchronously on stage changes, tab hide and page unload.
 */
export function useDraft() {
  const [draft, setDraft] = useState<Draft>(loadDraft);
  const [storageOk, setStorageOk] = useState(true);
  const latest = useRef(draft);
  const timer = useRef<number | null>(null);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setStorageOk(saveDraft(latest.current));
  }, []);

  const update = useCallback(
    (fn: (d: Draft) => Draft, opts: { immediate?: boolean } = {}) => {
      setDraft((prev) => {
        const next = fn(prev);
        latest.current = next;
        return next;
      });
      if (opts.immediate) {
        // run after state settles in this tick
        queueMicrotask(flush);
      } else {
        if (timer.current) clearTimeout(timer.current);
        timer.current = window.setTimeout(flush, 400);
      }
    },
    [flush],
  );

  useEffect(() => {
    const onHide = () => flush();
    const onVis = () => document.visibilityState === "hidden" && flush();
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onHide);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [flush]);

  const reset = useCallback(() => {
    clearDraft();
    const d = emptyDraft();
    latest.current = d;
    setDraft(d);
  }, []);

  return { draft, update, flush, reset, storageOk };
}
