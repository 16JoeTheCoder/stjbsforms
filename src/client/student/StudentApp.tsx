import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CloudOff } from "lucide-react";
import clsx from "clsx";
import { api, ApiFailure, fmtTime } from "../lib/api";
import { useDraft, type Draft, type Stage } from "./draft";
import { ClassStep, AwardsStep, LettersStep, ReviewStep, DoneStep } from "./steps";
import { Banner, Spinner } from "../components/ui";
import type { PublicConfig, PublicFormData, SubmissionReceipt } from "../../shared/types";

const FORM_CACHE = "stjb.thanks.form.v1";

function cachedForm(): PublicFormData | null {
  try {
    const raw = localStorage.getItem(FORM_CACHE);
    return raw ? (JSON.parse(raw) as PublicFormData) : null;
  } catch {
    return null;
  }
}

/** Drops selections that no longer exist on the roster; letter text is never removed. */
function prune(d: Draft, form: PublicFormData): { draft: Draft; changed: boolean } {
  const teacherIds = new Set(form.teachers.map((t) => t.id));
  const awardIds = new Set(form.awards.map((a) => a.id));
  let changed = false;
  const awards: Record<string, string> = {};
  for (const [a, t] of Object.entries(d.awards)) {
    if (awardIds.has(a) && teacherIds.has(t)) awards[a] = t;
    else changed = true;
  }
  const letters = d.letters.map((l) => {
    if (l.teacherId && !teacherIds.has(l.teacherId)) {
      changed = true;
      return { ...l, teacherId: null };
    }
    return l;
  }) as Draft["letters"];
  return { draft: changed ? { ...d, awards, letters } : d, changed };
}

const STEPS: { stage: Stage; label: string }[] = [
  { stage: "class", label: "Class" },
  { stage: "awards", label: "Awards" },
  { stage: "letters", label: "Letters" },
  { stage: "review", label: "Review" },
];

export type SubmitIssue = { tone: "warn" | "bad"; title: string; body?: string; goto?: Stage };

export function StudentApp() {
  const { draft, update, reset, storageOk, syncedFromOtherTab } = useDraft();
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [form, setForm] = useState<PublicFormData | null>(cachedForm);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [issue, setIssue] = useState<SubmitIssue | null>(null);
  const [turnstileReset, setTurnstileReset] = useState(0);
  const inFlight = useRef(false);

  const loadForm = useCallback(async () => {
    try {
      const [cfg, f] = await Promise.all([
        api<PublicConfig>("/api/public/config"),
        api<PublicFormData>("/api/public/form", { cache: "no-store" }),
      ]);
      setConfig(cfg);
      setForm(f);
      setLoadError(null);
      try {
        localStorage.setItem(FORM_CACHE, JSON.stringify(f));
      } catch {
        /* ignore */
      }
      update((d) => {
        if (d.receipt) return d;
        const r = prune(d, f);
        if (r.changed) setNotice("The teacher or award list was updated, so some choices were cleared. Your letters are kept.");
        return r.draft;
      }, { immediate: true });
      return f;
    } catch (e) {
      setLoadError(e instanceof ApiFailure ? e.message : "Couldn't load the form.");
      return null;
    }
  }, [update]);

  const finish = useCallback(
    (receipt: SubmissionReceipt, earlier = false) => {
      update((d) => ({ ...d, receipt, receiptIsEarlier: earlier, pendingSubmit: false, stage: "done" }), {
        immediate: true,
      });
      setIssue(null);
      window.scrollTo({ top: 0 });
    },
    [update],
  );

  /** Resolves an uncertain outcome by asking the server whether this key was committed. */
  const checkOutcome = useCallback(
    async (key: string): Promise<"found" | "absent" | "unknown"> => {
      setChecking(true);
      try {
        const r = await api<{ found: true } & SubmissionReceipt>(`/api/public/submissions/${encodeURIComponent(key)}`);
        finish(r);
        return "found";
      } catch (e) {
        if (e instanceof ApiFailure && e.status === 404) {
          update((d) => ({ ...d, pendingSubmit: false }), { immediate: true });
          return "absent";
        }
        return "unknown";
      } finally {
        setChecking(false);
      }
    },
    [finish, update],
  );

  useEffect(() => {
    void loadForm();
    if (draft.pendingSubmit && !draft.receipt) {
      void checkOutcome(draft.idempotencyKey).then((r) => {
        if (r === "unknown") {
          setIssue({
            tone: "warn",
            title: "We couldn't confirm whether your response was sent",
            body: "Your answers are safe on this device. Reconnect, then press “Check again”.",
          });
        } else if (r === "absent") {
          setIssue({ tone: "warn", title: "Your last attempt didn't go through", body: "Nothing was sent. You can submit again." });
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const go = useCallback(
    (stage: Stage) => {
      update((d) => ({ ...d, stage }), { immediate: true });
      requestAnimationFrame(() => window.scrollTo({ top: 0 }));
    },
    [update],
  );

  const submit = useCallback(
    async (turnstileToken: string | null) => {
      if (inFlight.current || !form) return;
      inFlight.current = true;
      setSending(true);
      setIssue(null);
      update((d) => ({ ...d, pendingSubmit: true }), { immediate: true });
      const d = draft;
      const payload = {
        idempotencyKey: d.idempotencyKey,
        classCode: d.classCode,
        classId: d.classAccess?.classId,
        turnstileToken: turnstileToken ?? "",
        votes: form.awards.map((a) => ({ awardId: a.id, teacherId: d.awards[a.id]! })),
        notes: d.letters.map((l) => ({ teacherId: l.teacherId!, body: l.body })),
      };
      try {
        const r = await api<SubmissionReceipt>("/api/public/submissions", { method: "POST", json: payload, timeoutMs: 30_000 });
        finish(r);
      } catch (e) {
        const err = e instanceof ApiFailure ? e : new ApiFailure(0, "NETWORK", "Network error");
        if (err.uncertain) {
          const r = await checkOutcome(d.idempotencyKey);
          if (r === "unknown") {
            setIssue({
              tone: "warn",
              title: "We couldn't confirm whether your response was sent",
              body: "Your answers are safe on this device. When you're back online, press “Check again” — we'll never send it twice.",
            });
          } else if (r === "absent") {
            setIssue({ tone: "bad", title: "Your response wasn't sent", body: "Check your connection and press Submit again." });
            setTurnstileReset((n) => n + 1);
          }
        } else {
          update((x) => ({ ...x, pendingSubmit: false }), { immediate: true });
          setTurnstileReset((n) => n + 1);
          switch (err.code) {
            case "ALREADY_SUBMITTED": {
              const det = err.details as { receiptCode?: string; submittedAt?: string } | undefined;
              if (det?.receiptCode && det.submittedAt) finish({ receiptCode: det.receiptCode, submittedAt: det.submittedAt }, true);
              else setIssue({ tone: "warn", title: "This browser has already sent a response" });
              break;
            }
            case "INVALID_CODE":
            case "CODE_CHANGED":
              update((x) => ({ ...x, classAccess: null }), { immediate: true });
              setIssue({ tone: "warn", title: "Class code needed", body: err.message, goto: "class" });
              break;
            case "STALE_FORM":
              await loadForm();
              setIssue({ tone: "warn", title: "The form was updated", body: err.message, goto: "awards" });
              break;
            case "VALIDATION": {
              const field = (err.details as { field?: string } | undefined)?.field ?? "";
              setIssue({ tone: "bad", title: "Please fix this first", body: err.message, goto: field.startsWith("votes") ? "awards" : "letters" });
              break;
            }
            case "SUBMISSIONS_CLOSED":
            case "CLASS_PAUSED":
              void loadForm();
              setIssue({ tone: "warn", title: "Not accepting responses right now", body: err.message });
              break;
            default:
              setIssue({ tone: "bad", title: "Couldn't submit", body: err.message });
          }
        }
      } finally {
        inFlight.current = false;
        setSending(false);
      }
    },
    [draft, form, update, finish, checkOutcome, loadForm],
  );

  const stageIndex = STEPS.findIndex((s) => s.stage === draft.stage);
  const closedMsg = useMemo(() => {
    if (!config || config.open) return null;
    if (config.opensAt && new Date(config.opensAt) > new Date()) return `Submissions open ${fmtTime(config.opensAt)}. You can start writing now — it's saved on this device.`;
    return "Submissions are closed right now. Anything you've written stays saved on this device.";
  }, [config]);

  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-2xl items-center justify-between px-4 pt-5 pb-2">
        <p className="text-[13px] font-semibold tracking-wide text-ink">
          STJB <span className="text-muted">· Teacher's Day</span>
        </p>
        {draft.stage !== "class" && draft.stage !== "done" ? (
          <p className="flex items-center gap-1.5 text-[13px] text-muted" aria-live="polite">
            {storageOk ? (
              <>
                <Check aria-hidden className="size-3.5" /> Saved on this device
              </>
            ) : (
              <>
                <CloudOff aria-hidden className="size-3.5" /> Can't save on this device
              </>
            )}
          </p>
        ) : null}
      </header>

      {stageIndex >= 0 && draft.stage !== "class" ? (
        <nav aria-label="Progress" className="mx-auto max-w-2xl px-4 pt-2">
          <ol className="flex gap-1.5">
            {STEPS.map((s, i) => (
              <li key={s.stage} className="flex-1">
                <div className={clsx("h-1 rounded-full", i <= stageIndex ? "bg-fire" : "bg-line")} />
                <span
                  className={clsx("mt-1.5 block text-[12px]", i === stageIndex ? "font-semibold text-ink" : "text-muted")}
                  aria-current={i === stageIndex ? "step" : undefined}
                >
                  {s.label}
                </span>
              </li>
            ))}
          </ol>
        </nav>
      ) : null}

      <main className="mx-auto max-w-2xl px-4 pt-6 pb-24">
        {loadError && !form ? (
          <Banner tone="bad" title="Couldn't load the form" action={<button className="btn-outline btn-sm" onClick={() => void loadForm()}>Try again</button>}>
            {loadError}
          </Banner>
        ) : null}
        {closedMsg && draft.stage !== "done" ? <Banner tone="warn" className="mb-5">{closedMsg}</Banner> : null}
        {!storageOk ? (
          <Banner tone="warn" className="mb-5" title="This browser isn't saving your progress">
            Private browsing or full storage can block saving. Keep this tab open until you submit.
          </Banner>
        ) : null}
        {syncedFromOtherTab && draft.stage !== "done" ? (
          <Banner tone="info" className="mb-5">
            Updated with changes you made in another tab.
          </Banner>
        ) : null}
        {notice ? (
          <Banner tone="info" className="mb-5" action={<button className="btn-ghost btn-sm -ml-2" onClick={() => setNotice(null)}>Dismiss</button>}>
            {notice}
          </Banner>
        ) : null}
        {issue && draft.stage !== "review" && draft.stage !== "done" ? (
          <Banner tone={issue.tone} title={issue.title} className="mb-5">
            {issue.body}
          </Banner>
        ) : null}

        {!form && !loadError ? (
          <div className="flex items-center gap-2 py-16 text-muted">
            <Spinner /> Loading…
          </div>
        ) : null}

        {form && draft.stage === "class" ? <ClassStep draft={draft} update={update} onDone={() => go("awards")} /> : null}
        {form && draft.stage === "awards" ? <AwardsStep draft={draft} form={form} update={update} go={go} /> : null}
        {form && draft.stage === "letters" ? <LettersStep draft={draft} form={form} update={update} go={go} /> : null}
        {form && draft.stage === "review" ? (
          <ReviewStep
            draft={draft}
            form={form}
            go={go}
            siteKey={config?.turnstileSiteKey ?? null}
            open={config?.open ?? false}
            sending={sending}
            checking={checking}
            issue={issue}
            onSubmit={submit}
            onCheckAgain={() => void checkOutcome(draft.idempotencyKey).then((r) => r === "unknown" || setIssue(null))}
            turnstileReset={turnstileReset}
          />
        ) : null}
        {draft.stage === "done" && draft.receipt ? <DoneStep draft={draft} form={form} onClear={reset} /> : null}
      </main>
    </div>
  );
}
