// Text helpers shared by the browser and the Worker so that limits and
// duplicate detection behave identically on both sides.

export const NOTE_MIN_CHARS = 100;
export const NOTE_MAX_CHARS = 400;
/** Hard ceiling on raw input length (UTF-16 units) before any processing. */
export const NOTE_RAW_MAX = 4000;

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/**
 * Cleans a note for storage: NFC, unix newlines, tabs to spaces, strips
 * control/invisible formatting characters (keeps ZWJ/variation selectors so
 * emoji survive), trims surrounding whitespace and trailing spaces per line.
 * Paragraphs and punctuation are preserved.
 */
export function cleanNoteText(input: string): string {
  return input
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    // C0/C1 controls except \n
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, "")
    // bidi overrides / isolates and BOM; keep ZWJ (200D) and ZWNJ (200C)
    .replace(/[​‎‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/[  ]+\n/g, "\n")
    .trim();
}

/** Counts user-perceived characters (grapheme clusters) of cleaned text. */
export function countChars(text: string): number {
  const t = cleanNoteText(text);
  if (!t) return 0;
  if (segmenter) {
    let n = 0;
    for (const _ of segmenter.segment(t)) n++;
    return n;
  }
  return Array.from(t).length;
}

/**
 * Deterministic normalisation used only for identical-message detection:
 * NFKC, lower case, all whitespace runs collapsed, trimmed.
 */
export function normalizeForCompare(text: string): string {
  return cleanNoteText(text).normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

export function isBlank(text: string): boolean {
  return cleanNoteText(text).replace(/\s/gu, "").length === 0;
}

/** Heuristic, never used to reject: flags repetitive or low-effort text. */
export function lowEffortFlags(text: string): string[] {
  const flags: string[] = [];
  const t = normalizeForCompare(text);
  if (/(.)\1{9,}/u.test(t)) flags.push("repeated_characters");
  const words = t.split(" ").filter((w) => w.length > 0);
  if (words.length >= 12) {
    const unique = new Set(words).size;
    if (unique / words.length < 0.35) flags.push("repetitive_words");
  }
  return flags;
}

export type NoteProblem = "empty" | "too_short" | "too_long";

export function noteProblem(text: string): NoteProblem | null {
  if (isBlank(text)) return "empty";
  const n = countChars(text);
  if (n < NOTE_MIN_CHARS) return "too_short";
  if (n > NOTE_MAX_CHARS) return "too_long";
  return null;
}
