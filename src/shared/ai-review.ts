// External AI review: the export payload, the prompt handed to the AI, and the
// strict import format it must return. Shared by the Worker and the admin UI.
import { z } from "zod";

export const AI_FORMAT = "stjb-ai-review-v1";
export const AI_MAX_DECISIONS = 500;
export const AI_REASON_MAX = 200;

export interface AiExportNote {
  id: string;
  teacher: string;
  grade: string | null;
  chars: number;
  flags: string[];
  text: string;
}

export interface AiExport {
  format: typeof AI_FORMAT;
  exportId: string;
  createdAt: string;
  notes: AiExportNote[];
}

export const aiDecision = z.object({
  id: z.string().trim().min(1).max(64),
  decision: z.enum(["approve", "trash", "unsure"]),
  reason: z.string().trim().max(AI_REASON_MAX).optional().default(""),
});

export const aiImport = z.object({
  format: z.literal(AI_FORMAT),
  exportId: z.string().trim().min(1).max(64),
  decisions: z.array(aiDecision).min(1).max(AI_MAX_DECISIONS),
});
export type AiImport = z.infer<typeof aiImport>;

/**
 * Extracts the JSON object from an AI reply. Tolerates ```json fences and short
 * prose before/after, but never guesses: the result must still pass `aiImport`.
 */
export function extractJson(raw: string): unknown {
  const text = raw.replace(/^﻿/, "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1]!.trim() : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object found in the AI reply.");
  return JSON.parse(body.slice(start, end + 1));
}

export function parseAiImport(raw: string): { ok: true; value: AiImport } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = extractJson(raw);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Not valid JSON." };
  }
  const r = aiImport.safeParse(data);
  if (!r.success) {
    const i = r.error.issues[0]!;
    return { ok: false, error: `Wrong format at "${i.path.join(".") || "(root)"}": ${i.message}` };
  }
  return { ok: true, value: r.data };
}

const EXAMPLE = `{
  "format": "${AI_FORMAT}",
  "exportId": "<copy the exportId given above>",
  "decisions": [
    { "id": "note_abc123", "decision": "approve", "reason": "" },
    { "id": "note_def456", "decision": "trash", "reason": "Mocks the teacher's appearance" },
    { "id": "note_ghi789", "decision": "unsure", "reason": "Mentions another student by name" }
  ]
}`;

/** The full instruction text given to an external AI reviewer, followed by the data. */
export function buildAiPrompt(exp: AiExport, batch?: { index: number; total: number }): string {
  const part = batch && batch.total > 1 ? ` (batch ${batch.index} of ${batch.total})` : "";
  return `# Teacher's Day note review${part}

You are reviewing short appreciation notes written anonymously by secondary and junior-college students (ages ~12–18) at St. Johannes Berchmans School, Indonesia, for Teacher's Day. Approved notes are printed and displayed on a public wall at school and given to the teacher.

Notes are in English, Bahasa Indonesia, or a mix. Judge them in the language they are written in.

## Your task

For **every** note in the data below, decide exactly one of:

- **approve** — kind, sincere or light-heartedly funny, and appropriate to print on a school wall. Imperfect grammar, slang, emoji, short-but-genuine notes and affectionate jokes are fine. Approve unless there is a real problem.
- **trash** — must not be printed. Use this for:
  - insults, mockery or sarcasm aimed at the teacher (appearance, age, weight, voice, etc.)
  - sexual, romantic or suggestive content; profanity or slurs (any language)
  - harassment, threats, or content about self-harm
  - naming, identifying or making fun of another student
  - spam, gibberish, keyboard mashing, copy-pasted filler, or text unrelated to thanking a teacher
  - personal data (phone numbers, social media handles, addresses)
- **unsure** — you genuinely can't tell (ambiguous slang, possible inside joke, a name that might be another student). A human will check these. Prefer "unsure" over guessing.

Rules:

1. Do not rewrite, correct or quote the notes. Judge them as they are.
2. Give a short reason (max ${AI_REASON_MAX} characters, English) for every **trash** and **unsure** decision. Leave "reason" as "" for approve.
3. Copy every "id" exactly as given. Include every note exactly once, and don't invent ids.
4. Copy "exportId" exactly: **${exp.exportId}**
5. Reply with **only** the JSON object below — no commentary, no markdown other than an optional \`\`\`json fence.

## Required reply format (exact)

${"```"}json
${EXAMPLE}
${"```"}

- "format" must be exactly "${AI_FORMAT}".
- "decision" must be exactly "approve", "trash" or "unsure" (lower case).
- ${exp.notes.length} decisions are expected in this batch.

## Field guide for the data

- id: note id (copy exactly)
- teacher: who the note is addressed to
- grade: student's grade level (Sec 1–4, JC1–2) or null for council-written notes
- chars: length; flags: automatic hints (e.g. "repetitive_words", "duplicate_elsewhere"), not decisions
- text: the note itself

## Data${part}

${"```"}json
${JSON.stringify(exp, null, 1)}
${"```"}
`;
}

/** Splits an export into batches that each carry the same exportId. */
export function batchExport(exp: AiExport, size: number): AiExport[] {
  if (size <= 0 || exp.notes.length <= size) return [exp];
  const out: AiExport[] = [];
  for (let i = 0; i < exp.notes.length; i += size) out.push({ ...exp, notes: exp.notes.slice(i, i + size) });
  return out;
}
