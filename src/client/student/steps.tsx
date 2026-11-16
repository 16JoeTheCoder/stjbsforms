import { useMemo, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Lock, PencilLine, Plus, Trash2 } from "lucide-react";
import clsx from "clsx";
import { api, ApiFailure, fmtTime } from "../lib/api";
import { activeLetters, type Draft, type Stage } from "./draft";
import { MAX_LETTERS, MIN_LETTERS } from "../../shared/schemas";
import { TeacherPicker } from "../components/TeacherPicker";
import { Turnstile } from "../components/Turnstile";
import { Banner, ConfirmDialog, Spinner } from "../components/ui";
import { CODE_LENGTH, isValidClassCode, normalizeClassCode } from "../../shared/codes";
import { countChars, normalizeForCompare, NOTE_MAX_CHARS, NOTE_MIN_CHARS, noteProblem } from "../../shared/text";
import { teacherDisplayName } from "../../shared/search";
import type { ClassAccessResult, PublicFormData } from "../../shared/types";
import type { SubmitIssue } from "./StudentApp";

type Update = (fn: (d: Draft) => Draft, opts?: { immediate?: boolean }) => void;

function StepHeading({ title, lead }: { title: string; lead?: string }) {
  return (
    <div className="mb-7">
      <h1 className="font-serif text-[32px] leading-[1.1] tracking-[-0.01em] sm:text-[40px]">{title}</h1>
      {lead ? <p className="mt-3 max-w-[60ch] text-[16px] text-ink-2">{lead}</p> : null}
    </div>
  );
}

function NavRow({ back, next, nextLabel }: { back?: () => void; next: () => void; nextLabel: string; nextDisabled?: boolean }) {
  return (
    <div className="sticky bottom-0 z-20 -mx-4 mt-10 flex items-center justify-between gap-3 border-t border-line bg-paper/95 px-4 py-3 backdrop-blur-sm supports-[backdrop-filter]:bg-paper/85">
      {back ? (
        <button type="button" className="btn-ghost -ml-3" onClick={back}>
          <ArrowLeft aria-hidden className="size-4" /> Back
        </button>
      ) : (
        <span />
      )}
      <button type="button" className="btn-primary" onClick={next}>
        {nextLabel} <ArrowRight aria-hidden className="size-4" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- Class

export function ClassStep({ draft, update, onDone }: { draft: Draft; update: Update; onDone: () => void }) {
  const [code, setCode] = useState(draft.classCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<ClassAccessResult | null>(draft.classAccess);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const norm = normalizeClassCode(code);
    if (!isValidClassCode(norm)) {
      setError(
        norm.length !== CODE_LENGTH
          ? "Class codes are exactly 5 characters."
          : "That code has a character class codes don't use (like O, 0, I or 1). Check it again.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<ClassAccessResult>("/api/public/class-access", { method: "POST", json: { code: norm } });
      setFound(r);
      update((d) => ({ ...d, classCode: norm, classAccess: r }), { immediate: true });
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const hasProgress = Object.keys(draft.awards).length > 0 || draft.letters.some((l) => l.body.trim());

  if (found) {
    return (
      <section>
        <StepHeading title="Is this your class?" />
        <div className="card p-6">
          <p className="text-sm text-muted">Class</p>
          <p className="mt-1 text-[28px] font-semibold leading-tight tracking-[-0.01em]">{found.classLabel}</p>
          <p className="mt-1 text-ink-2">{found.gradeLabel}</p>
        </div>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <button type="button" className="btn-primary" onClick={onDone}>
            {hasProgress ? "Yes, continue where I left off" : "Yes, start"} <ArrowRight aria-hidden className="size-4" />
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              setFound(null);
              setCode("");
              update((d) => ({ ...d, classAccess: null }), { immediate: true });
            }}
          >
            No, enter a different code
          </button>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="mb-8 pt-4 sm:pt-10">
        <h1 className="font-serif text-[44px] leading-[1.02] tracking-[-0.02em] sm:text-[64px]">
          Thank your
          <br />
          teachers.
        </h1>
        <p className="mt-5 max-w-[46ch] text-[17px] text-ink-2">
          Vote in six light-hearted awards and write three short letters (more if you like). It takes about 15 minutes, and your name isn't collected.
        </p>
      </div>
      {hasProgress ? (
        <Banner tone="info" className="mb-5" title="Your answers are still here">
          Enter your class code again to pick up where you left off.
        </Banner>
      ) : null}
      <form onSubmit={submit} noValidate className="max-w-sm">
        <label htmlFor="class-code" className="label mb-1.5">
          Class code
        </label>
        <input
          id="class-code"
          value={code}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase().slice(0, 7));
            setError(null);
          }}
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          placeholder="• • • • •"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "class-code-error" : "class-code-hint"}
          className={clsx("field h-14 text-center font-semibold uppercase tracking-[0.35em] text-[22px] tabular", error && "border-bad")}
        />
        {error ? (
          <p id="class-code-error" className="mt-2 text-sm font-medium text-bad" role="alert">
            {error}
          </p>
        ) : (
          <p id="class-code-hint" className="hint mt-2">
            5 characters, from your class representative or form teacher.
          </p>
        )}
        <button type="submit" className="btn-primary mt-5 w-full sm:w-auto" disabled={busy}>
          {busy ? <Spinner /> : null} Continue
        </button>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------- Awards

export function AwardsStep({ draft, form, update, go }: { draft: Draft; form: PublicFormData; update: Update; go: (s: Stage) => void }) {
  const [tried, setTried] = useState(false);
  const chosen = form.awards.filter((a) => draft.awards[a.id]).length;
  const used = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of form.awards) {
      const t = draft.awards[a.id];
      if (t) m.set(t, a.name);
    }
    return m;
  }, [draft.awards, form.awards]);

  const next = () => {
    if (chosen < form.awards.length) {
      setTried(true);
      const first = form.awards.find((a) => !draft.awards[a.id]);
      if (first) document.getElementById(`award-${first.id}-input`)?.focus();
      return;
    }
    go("letters");
  };

  return (
    <section>
      <StepHeading
        title="The awards"
        lead="Pick a different teacher for each award. It's all in good fun — results stay with the student council."
      />
      <Banner tone="info" className="mb-5" title="Your response is anonymous">
        Your name isn't saved — only what you write and who you pick for each award.
      </Banner>
      <p className="mb-4 text-sm font-medium text-ink-2 tabular" aria-live="polite">
        {chosen} of {form.awards.length} chosen
      </p>
      <ol className="space-y-3">
        {form.awards.map((a, i) => {
          const value = draft.awards[a.id] ?? null;
          const others = new Map(used);
          if (value) others.delete(value);
          const missing = tried && !value;
          return (
            <li key={a.id} className={clsx("card p-4 sm:p-5", missing && "border-bad")}>
              <div className="mb-3 flex gap-3">
                <span className="tabular mt-0.5 text-sm font-semibold text-muted">{i + 1}</span>
                <div>
                  <h2 className="text-[17px] font-semibold leading-snug">{a.name}</h2>
                  {a.description ? <p className="mt-0.5 text-sm text-ink-2">{a.description}</p> : null}
                </div>
              </div>
              <TeacherPicker
                id={`award-${a.id}`}
                label={a.name}
                hideLabel
                teachers={form.teachers}
                value={value}
                unavailable={others}
                invalid={missing}
                describedBy={missing ? `award-${a.id}-err` : undefined}
                onChange={(tid) =>
                  update((d) => {
                    const awards = { ...d.awards };
                    if (tid) awards[a.id] = tid;
                    else delete awards[a.id];
                    return { ...d, awards };
                  }, { immediate: true })
                }
              />
              {missing ? (
                <p id={`award-${a.id}-err`} className="mt-2 text-sm font-medium text-bad">
                  Choose a teacher for this award.
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      <NavRow back={() => go("class")} next={next} nextLabel="Next: letters" nextDisabled={chosen < form.awards.length} />
    </section>
  );
}

// ---------------------------------------------------------------- Letters

const PROMPTS = [
  "Tell them about something they did that made a difference.",
  "Is there a lesson or moment from class you still remember?",
  "What would you like them to know about how they've helped you?",
];

function Counter({ text, id }: { text: string; id: string }) {
  const n = countChars(text);
  const short = n < NOTE_MIN_CHARS;
  const over = n > NOTE_MAX_CHARS;
  return (
    <p id={id} className="mt-2 flex items-center justify-between text-sm tabular" aria-live="polite">
      <span className={clsx(over ? "font-medium text-bad" : short ? "text-muted" : "text-ok")}>
        {over
          ? `${n - NOTE_MAX_CHARS} over the limit`
          : short
            ? n === 0
              ? `At least ${NOTE_MIN_CHARS} characters`
              : `${NOTE_MIN_CHARS - n} more to go`
            : "Looks good"}
      </span>
      <span className={clsx(over ? "font-semibold text-bad" : "text-ink-2")}>
        {n} / {NOTE_MAX_CHARS} characters
      </span>
    </p>
  );
}

export function letterIssues(draft: Draft): string[] {
  const out: string[] = [];
  const active = activeLetters(draft);
  const ids = active.map(({ letter }) => letter.teacherId);
  active.forEach(({ letter: l, index: i }) => {
    if (!l.teacherId) out.push(`Letter ${i + 1}: choose a teacher.`);
    const p = noteProblem(l.body);
    if (p === "empty") out.push(`Letter ${i + 1}: write your message.`);
    if (p === "too_short") out.push(`Letter ${i + 1}: needs at least ${NOTE_MIN_CHARS} characters.`);
    if (p === "too_long") out.push(`Letter ${i + 1}: is over ${NOTE_MAX_CHARS} characters.`);
  });
  if (ids.every(Boolean) && new Set(ids).size !== ids.length) out.push("Each letter needs a different teacher.");
  const norms = active.map(({ letter }) => normalizeForCompare(letter.body)).filter(Boolean);
  if (new Set(norms).size !== norms.length) out.push("Two of your letters are identical. Make each one personal.");
  return out;
}

export function LettersStep({ draft, form, update, go }: { draft: Draft; form: PublicFormData; update: Update; go: (s: Stage) => void }) {
  const [tried, setTried] = useState(false);
  const issues = letterIssues(draft);
  const norms = draft.letters.map((l) => normalizeForCompare(l.body));

  const setLetter = (i: number, patch: Partial<Draft["letters"][number]>, immediate = false) =>
    update((d) => {
      const letters = d.letters.map((l, j) => (j === i ? { ...l, ...patch } : l));
      return { ...d, letters };
    }, { immediate });
  const addLetter = () =>
    update((d) => (d.letters.length >= MAX_LETTERS ? d : { ...d, letters: [...d.letters, { teacherId: null, body: "" }] }), { immediate: true });
  const removeLetter = (i: number) =>
    update((d) => ({ ...d, letters: d.letters.filter((_, j) => j !== i) }), { immediate: true });

  return (
    <section>
      <StepHeading
        title="Three letters"
        lead={`Write to three different teachers. Want to thank more? Add up to ${MAX_LETTERS - MIN_LETTERS} extra letters below. Each letter will be printed and put up on the appreciation wall.`}
      />
      <p className="mb-6 flex gap-2 text-sm text-ink-2">
        <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>Your name isn't collected. If you sign your letter or mention details about yourself, your teacher may know it's from you.</span>
      </p>
      <div className="space-y-5">
        {draft.letters.map((l, i) => {
          const others = new Map<string, string>();
          draft.letters.forEach((o, j) => j !== i && o.teacherId && others.set(o.teacherId, `Letter ${j + 1}`));
          const teacher = form.teachers.find((t) => t.id === l.teacherId);
          const problem = noteProblem(l.body);
          const dup = norms[i] && norms.some((n, j) => j !== i && n === norms[i]);
          const optional = i >= MIN_LETTERS;
          const blank = optional && !l.teacherId && !l.body.trim();
          const showErr = tried && !blank && (problem || !l.teacherId || dup);
          return (
            <article key={i} className={clsx("card p-4 sm:p-6", showErr && "border-bad")} aria-labelledby={`letter-${i}-title`}>
              <div className="mb-3 flex items-center justify-between">
                <h2 id={`letter-${i}-title`} className="text-sm font-semibold text-muted">
                  {optional ? `Letter ${i + 1} (optional)` : `Letter ${i + 1} of ${MIN_LETTERS}`}
                </h2>
                {optional ? (
                  <button type="button" className="btn-ghost btn-sm" onClick={() => removeLetter(i)} aria-label={`Remove letter ${i + 1}`}>
                    <Trash2 aria-hidden className="size-4" /> Remove
                  </button>
                ) : null}
              </div>
              <TeacherPicker
                id={`letter-${i}-to`}
                label="To"
                teachers={form.teachers}
                value={l.teacherId}
                unavailable={others}
                invalid={tried && !blank && !l.teacherId}
                onChange={(tid) => setLetter(i, { teacherId: tid }, true)}
              />
              <div className="mt-5">
                <label htmlFor={`letter-${i}-body`} className="label">
                  Your message
                </label>
                <p className="hint mt-0.5 mb-2">{PROMPTS[i % PROMPTS.length]}</p>
                <div className="rounded-xl border border-line-strong bg-card transition-[border-color,box-shadow] duration-150 focus-within:border-ink focus-within:ring-2 focus-within:ring-ink/15">
                  <p aria-hidden className="px-4 pt-3.5 font-serif text-[17px] italic text-ink-2">
                    Dear {teacher ? teacherDisplayName(teacher) : "…"},
                  </p>
                  <textarea
                    id={`letter-${i}-body`}
                    value={l.body}
                    onChange={(e) => setLetter(i, { body: e.target.value })}
                    rows={7}
                    maxLength={1200}
                    aria-describedby={`letter-${i}-count`}
                    aria-invalid={tried && Boolean(problem || dup) ? true : undefined}
                    className="block w-full resize-y rounded-b-xl bg-transparent px-4 pt-1 pb-4 font-serif text-[17px] leading-[1.6] text-ink [field-sizing:content] min-h-[11rem] focus:outline-none"
                  />
                </div>
                <Counter text={l.body} id={`letter-${i}-count`} />
                {dup ? <p className="mt-1 text-sm font-medium text-bad">This letter is identical to another one.</p> : null}
              </div>
            </article>
          );
        })}
      </div>
      {draft.letters.length < MAX_LETTERS ? (
        <button type="button" className="btn-ghost mt-5" onClick={addLetter}>
          <Plus aria-hidden className="size-4" /> Write another letter (optional)
        </button>
      ) : (
        <p className="mt-5 text-sm text-muted">You've reached the maximum of {MAX_LETTERS} letters.</p>
      )}
      {tried && issues.length ? (
        <Banner tone="bad" title="A few things to finish" className="mt-6">
          <ul className="list-disc pl-5">
            {issues.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      <NavRow
        back={() => go("awards")}
        next={() => {
          if (issues.length) {
            setTried(true);
            return;
          }
          go("review");
        }}
        nextLabel="Review"
        nextDisabled={issues.length > 0}
      />
    </section>
  );
}

// ---------------------------------------------------------------- Review

export function ReviewStep(props: {
  draft: Draft;
  form: PublicFormData;
  go: (s: Stage) => void;
  siteKey: string | null;
  open: boolean;
  sending: boolean;
  checking: boolean;
  issue: SubmitIssue | null;
  onSubmit: (token: string | null) => void;
  onCheckAgain: () => void;
  turnstileReset: number;
}) {
  const { draft, form, go, siteKey, open, sending, checking, issue } = props;
  const [token, setToken] = useState<string | null>(null);
  const [tsError, setTsError] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const tName = (id: string | null | undefined) => {
    const t = form.teachers.find((x) => x.id === id);
    return t ? teacherDisplayName(t) : "—";
  };
  const missingAwards = form.awards.some((a) => !draft.awards[a.id]);
  const issues = letterIssues(draft);
  const ready = !missingAwards && issues.length === 0 && Boolean(draft.classAccess);
  const needsToken = Boolean(siteKey);
  const canSubmit = ready && open && (!needsToken || token) && !sending && !draft.pendingSubmit;

  return (
    <section>
      <StepHeading title="Check and send" lead="Make sure everything looks right. You won't be able to edit after sending." />

      {issue ? (
        <Banner
          tone={issue.tone}
          title={issue.title}
          className="mb-6"
          action={
            issue.goto ? (
              <button className="btn-outline btn-sm" onClick={() => go(issue.goto!)}>
                Go to {issue.goto === "class" ? "class code" : issue.goto}
              </button>
            ) : draft.pendingSubmit ? (
              <button className="btn-outline btn-sm" onClick={props.onCheckAgain} disabled={checking}>
                {checking ? <Spinner /> : null} Check again
              </button>
            ) : null
          }
        >
          {issue.body}
        </Banner>
      ) : null}

      <div className="card divide-y divide-line">
        <div className="flex items-center justify-between gap-3 p-4 sm:px-6">
          <div>
            <p className="text-sm text-muted">Class</p>
            <p className="font-semibold">{draft.classAccess ? `${draft.classAccess.classLabel} · ${draft.classAccess.gradeLabel}` : "Not set"}</p>
          </div>
          <button className="btn-ghost btn-sm" onClick={() => go("class")}>
            <PencilLine aria-hidden className="size-4" /> Change
          </button>
        </div>
        <div className="p-4 sm:px-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">Awards</h2>
            <button className="btn-ghost btn-sm" onClick={() => go("awards")}>
              <PencilLine aria-hidden className="size-4" /> Edit
            </button>
          </div>
          <dl className="space-y-2.5">
            {form.awards.map((a) => (
              <div key={a.id} className="grid gap-0.5 sm:grid-cols-[1fr_auto] sm:gap-4">
                <dt className="text-sm text-ink-2">{a.name}</dt>
                <dd className={clsx("font-medium", !draft.awards[a.id] && "text-bad")}>{draft.awards[a.id] ? tName(draft.awards[a.id]) : "Not chosen"}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="p-4 sm:px-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">Letters</h2>
            <button className="btn-ghost btn-sm" onClick={() => go("letters")}>
              <PencilLine aria-hidden className="size-4" /> Edit
            </button>
          </div>
          <div className="space-y-4">
            {activeLetters(draft).map(({ letter: l, index: i }) => (
              <figure key={i} className="rounded-xl bg-paper px-4 py-3.5">
                <p className="font-serif text-[16px] italic text-ink-2">Dear {tName(l.teacherId)},</p>
                <blockquote className="mt-1 whitespace-pre-wrap break-words font-serif text-[16px] leading-[1.6]">{l.body.trim()}</blockquote>
                <figcaption className="mt-2 text-xs text-muted tabular">{countChars(l.body)} characters</figcaption>
              </figure>
            ))}
          </div>
        </div>
      </div>

      {!ready ? (
        <Banner tone="bad" title="Something still needs your attention" className="mt-6">
          {missingAwards ? "Choose a teacher for every award. " : ""}
          {issues[0] ?? ""}
          {!draft.classAccess ? "Enter your class code." : ""}
        </Banner>
      ) : null}

      <div className="mt-8">
        {needsToken && siteKey ? (
          <div className="mb-4">
            <Turnstile siteKey={siteKey} onToken={setToken} onError={() => setTsError(true)} resetSignal={props.turnstileReset} />
            {tsError ? <p className="mt-1 text-sm text-bad">The verification check couldn't load. Reload the page — your answers are saved.</p> : null}
          </div>
        ) : null}
        <button
          type="button"
          className="btn-fire h-12 w-full text-base sm:w-auto sm:px-8"
          disabled={!canSubmit}
          onClick={() => setConfirm(true)}
        >
          {sending ? <Spinner /> : null}
          {sending ? "Sending…" : "Submit my response"}
        </button>
        {!open ? <p className="hint mt-2">Submissions aren't open right now.</p> : null}
        {needsToken && !token && ready && open ? <p className="hint mt-2">Complete the verification check above to submit.</p> : null}
      </div>
      <div className="mt-6">
        <button className="btn-ghost -ml-3" onClick={() => go("letters")}>
          <ArrowLeft aria-hidden className="size-4" /> Back
        </button>
      </div>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Submit your response?"
        description="Are you sure you want to submit? You won't be able to edit this response afterward."
        confirmLabel="Yes, submit"
        cancelLabel="Keep editing"
        tone="fire"
        busy={sending}
        onConfirm={() => {
          setConfirm(false);
          props.onSubmit(token);
        }}
      />
    </section>
  );
}

// ---------------------------------------------------------------- Done

export function DoneStep({ draft, form, onClear }: { draft: Draft; form: PublicFormData | null; onClear: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const r = draft.receipt!;
  const earlier = Boolean(draft.receiptIsEarlier);
  const tName = (id: string | null) => {
    const t = form?.teachers.find((x) => x.id === id);
    return t ? teacherDisplayName(t) : "your teacher";
  };
  return (
    <section className="pt-4 sm:pt-10">
      <h1 className="font-serif text-[44px] leading-[1.02] tracking-[-0.02em] sm:text-[60px]">
        {earlier ? "Already sent from this browser." : "Thank you."}
      </h1>
      <p className="mt-4 max-w-[50ch] text-[17px] text-ink-2">
        {earlier
          ? "A response was already sent from this browser, so this one was not sent. Only one response per browser is accepted. If someone else used this device, they can submit from their own phone or browser."
          : "Your response was received. Your letters will be reviewed and printed for the appreciation wall."}
      </p>
      <div className="card mt-8 grid gap-4 p-5 sm:grid-cols-2 sm:p-6">
        <div>
          <p className="text-sm text-muted">{earlier ? "Earlier receipt" : "Receipt"}</p>
          <p className="mt-0.5 text-[22px] font-semibold tracking-[0.06em] tabular">{r.receiptCode}</p>
        </div>
        <div>
          <p className="text-sm text-muted">Received</p>
          <p className="mt-0.5 font-medium">{fmtTime(r.submittedAt)}</p>
        </div>
      </div>
      {draft.letters.some((l) => l.body) ? (
        <details className="group mt-6">
          <summary className="btn-ghost -ml-3 cursor-pointer list-none">{earlier ? "View your unsent letters" : "View what you sent"}</summary>
          <div className="mt-3 space-y-3">
            {activeLetters(draft).map(({ letter: l, index: i }) => (
              <figure key={i} className="card px-4 py-3.5">
                <p className="font-serif italic text-ink-2">Dear {tName(l.teacherId)},</p>
                <blockquote className="mt-1 whitespace-pre-wrap break-words font-serif leading-[1.6]">{l.body.trim()}</blockquote>
              </figure>
            ))}
          </div>
        </details>
      ) : null}
      <div className="mt-10 border-t border-line pt-6">
        <p className="text-sm text-ink-2">A copy of your answers is kept on this device. On a shared computer, you can remove it.</p>
        <button className="btn-outline btn-sm mt-3" onClick={() => setConfirm(true)}>
          Remove saved copy from this device
        </button>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Remove the saved copy?"
        description="This only clears this device. Your submitted response stays with the student council. This browser still can't submit again."
        confirmLabel="Remove"
        tone="danger"
        onConfirm={() => {
          setConfirm(false);
          onClear();
        }}
      />
    </section>
  );
}
