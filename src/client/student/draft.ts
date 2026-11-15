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
  /** True when the receipt belongs to an earlier response from this browser, not this draft. */
  receiptIsEarlier?: boolean;
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
      keepUnreadable(raw);
      return emptyDraft();
    }
    return { ...emptyDraft(), ...d } as Draft;
  } catch {
    try {
      keepUnreadable(localStorage.getItem(DRAFT_KEY));
    } catch {
      /* ignore */
    }
    return emptyDraft();
  }
}

/** Never silently destroy a draft we can't read: park it under a backup key first. */
function keepUnreadable(raw: string | null) {
  if (!raw) return;
  try {
    localStorage.setItem(`${DRAFT_KEY}.unreadable.${Date.now()}`, raw);
  } catch {
    /* ignore */
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
  const [syncedFromOtherTab, setSyncedFromOtherTab] = useState(false);
  const latest = useRef(draft);
  const timer = useRef<number | null>(null);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    latest.current = { ...latest.current, updatedAt: new Date().toISOString() };
    setStorageOk(saveDraft(latest.current));
  }, []);

  const update = useCallback(
    (fn: (d: Draft) => Draft, opts: { immediate?: boolean } = {}) => {
      // Apply to the ref synchronously so an immediate flush always writes the new state.
      const next = fn(latest.current);
      latest.current = next;
      setDraft(next);
      if (opts.immediate) {
        flush();
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
    // Another tab saved a newer draft: adopt it instead of overwriting it later.
    const onStorage = (e: StorageEvent) => {
      // Never discard this tab's own unsaved typing.
      if (e.key !== DRAFT_KEY || !e.newValue || timer.current) return;
      const other = loadDraft();
      if (other.updatedAt > latest.current.updatedAt || other.receipt) {
        latest.current = other;
        setDraft(other);
        setSyncedFromOtherTab(true);
      }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onHide);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("storage", onStorage);
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

  return { draft, update, flush, reset, storageOk, syncedFromOtherTab };
}
