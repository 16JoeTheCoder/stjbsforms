// Print engine: lays out appreciation notes on A4 with embedded, subset fonts
// (vector text). Pure apart from pdf-lib; runs in the browser and in Vitest.
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { mosaicOrder } from "../../shared/shuffle";
import { woffToSfnt } from "./woff";

export interface FontSet {
  /** Regular body faces in fallback order (e.g. latin, latin-ext, vietnamese, emoji subsets...). */
  regular: Uint8Array[];
  /** Italic faces for the salutation, same coverage order as `regular` where available. */
  italic: Uint8Array[];
}

export interface PrintNoteInput {
  id: string;
  teacherId: string;
  teacherName: string;
  body: string;
  source?: "student" | "council";
}

export interface LayoutProblem {
  noteId: string;
  teacherName: string;
  kind: "unsupported_characters" | "does_not_fit";
  detail: string;
}

interface FKFont {
  hasGlyphForCodePoint(cp: number): boolean;
  layout(text: string): { glyphs: { advanceWidth: number }[] };
  unitsPerEm: number;
  familyName?: string;
}

/** One font file: measured with fontkit, embedded into the PDF only if actually used. */
/** Advance exactly as pdf-lib draws it: glyph advances without GPOS kerning. */
function advance(fk: FKFont, text: string, size: number): number {
  let w = 0;
  for (const g of fk.layout(text).glyphs) w += g.advanceWidth;
  return (w / fk.unitsPerEm) * size;
}

class Face {
  pdf: PDFFont | null = null;
  readonly fk: FKFont;
  constructor(readonly bytes: Uint8Array) {
    this.fk = fontkit.create(bytes) as unknown as FKFont;
  }
  /**
   * Emoji faces are embedded whole: pdf-lib's subsetter drops some of their glyphs
   * (they render as blank gaps). Text faces are subset to keep files small.
   */
  get full() {
    return /emoji/i.test(this.fk.familyName ?? "");
  }
}

const A4: [number, number] = [595.28, 841.89];
const INK = rgb(0.051, 0.055, 0.063);
const GREY = rgb(0.42, 0.42, 0.44);
const RULE = rgb(0.72, 0.71, 0.68);
const FIRE = rgb(1, 0.357, 0.122);

const IGNORABLE = new Set([0x200d, 0xfe0e, 0xfe0f, 0x200c, 0x0a]);
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Text normalisation for print only: unix newlines, at most one blank line between paragraphs. */
export function printText(body: string): string {
  return body
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface Run {
  font: number;
  text: string;
}

class Typesetter {
  private widthCache = new Map<string, number>();
  private fk: FKFont[];
  constructor(private faces: Face[]) {
    this.fk = faces.map((f) => f.fk);
  }

  /** Embeds every face needed to draw `texts` (call before draw). */
  async embedFor(doc: PDFDocument, texts: string[]) {
    const need = new Set<number>();
    for (const t of texts) for (const r of this.runs(t)) if (r.text) need.add(r.font);
    for (const i of need) {
      const f = this.faces[i]!;
      if (!f.pdf) f.pdf = await doc.embedFont(f.bytes, { subset: !f.full });
    }
  }

  /** Index of the first font that covers every non-ignorable code point of the grapheme, or -1. */
  fontFor(g: string): number {
    const cps = [...g].map((c) => c.codePointAt(0)!).filter((cp) => !IGNORABLE.has(cp));
    if (cps.length === 0) return 0;
    for (let i = 0; i < this.fk.length; i++) if (cps.every((cp) => this.fk[i]!.hasGlyphForCodePoint(cp))) return i;
    return -1;
  }

  runs(text: string): Run[] {
    const out: Run[] = [];
    for (const { segment } of segmenter.segment(text)) {
      let f = this.fontFor(segment);
      if (f < 0) f = 0;
      // Strip joiners/selectors the chosen font can't draw, so they never render as boxes.
      const fk = this.fk[f]!;
      const g = [...segment].filter((c) => !IGNORABLE.has(c.codePointAt(0)!) || fk.hasGlyphForCodePoint(c.codePointAt(0)!)).join("");
      const last = out[out.length - 1];
      if (last && last.font === f) last.text += g;
      else out.push({ font: f, text: g });
    }
    return out;
  }

  unsupported(text: string): string[] {
    const bad = new Set<string>();
    for (const { segment } of segmenter.segment(text)) if (this.fontFor(segment) < 0) bad.add(segment);
    return [...bad];
  }

  width(text: string, size: number): number {
    const key = `${size}|${text}`;
    let w = this.widthCache.get(key);
    if (w === undefined) {
      w = this.runs(text).reduce((a, r) => {
        const fk = this.fk[r.font]!;
        return a + (r.text ? advance(fk, r.text, size) : 0);
      }, 0);
      this.widthCache.set(key, w);
    }
    return w;
  }

  /** Greedy word wrap; words wider than the line are broken between graphemes. */
  wrap(text: string, size: number, maxWidth: number): string[] {
    const lines: string[] = [];
    for (const para of text.split("\n")) {
      if (para.trim() === "") {
        lines.push("");
        continue;
      }
      const words = para.split(/(\s+)/).filter((w) => w.length);
      let line = "";
      for (const w of words) {
        const candidate = line + w;
        if (this.width(candidate.trimEnd(), size) <= maxWidth) {
          line = candidate;
          continue;
        }
        if (line.trim()) lines.push(line.trimEnd());
        line = "";
        if (/^\s+$/.test(w)) continue;
        if (this.width(w, size) <= maxWidth) {
          line = w;
          continue;
        }
        let chunk = "";
        for (const { segment } of segmenter.segment(w)) {
          if (this.width(chunk + segment, size) > maxWidth && chunk) {
            lines.push(chunk);
            chunk = segment;
          } else chunk += segment;
        }
        line = chunk;
      }
      if (line.trim()) lines.push(line.trimEnd());
    }
    return lines;
  }

  draw(page: PDFPage, text: string, x: number, y: number, size: number, color = INK) {
    let cx = x;
    for (const r of this.runs(text)) {
      if (!r.text) continue;
      const face = this.faces[r.font]!;
      if (!face.pdf) throw new Error("Font not embedded before drawing");
      page.drawText(r.text, { x: cx, y, size, font: face.pdf, color });
      cx += advance(face.fk, r.text, size);
    }
  }
}

const sfntCache = new WeakMap<Uint8Array, Uint8Array>();
const sfnt = (b: Uint8Array) => {
  let v = sfntCache.get(b);
  if (!v) sfntCache.set(b, (v = woffToSfnt(b)));
  return v;
};

async function setup(input: FontSet) {
  const fonts = { regular: input.regular.map(sfnt), italic: input.italic.map(sfnt) };
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const reg = fonts.regular.map((b) => new Face(b));
  const ita = fonts.italic.map((b) => new Face(b));
  // Italic chain falls back to the regular extended/emoji faces after its own.
  const body = new Typesetter(reg);
  const salutation = new Typesetter([...ita, ...reg]);
  return { doc, body, salutation };
}

// ---------------------------------------------------------------- Mosaic

export const MOSAIC = {
  margin: 34,
  gutter: 14,
  footer: 18,
  pad: 20,
  cols: 2,
  rows: 3,
  sizes: [11, 10.75, 10.5, 10.25, 10, 9.75, 9.5, 9.25, 9, 8.75, 8.5],
  leading: 1.42,
};

export interface MosaicResult {
  bytes: Uint8Array | null;
  pages: number;
  order: string[];
  problems: LayoutProblem[];
  minSizeUsed: number;
}

export async function buildMosaic(
  notes: PrintNoteInput[],
  fonts: FontSet,
  opts: { seed: string; title?: string; councilLabel?: boolean; dryRun?: boolean },
): Promise<MosaicResult> {
  const { doc, body, salutation } = await setup(fonts);
  const ordered = mosaicOrder(notes, opts.seed);
  const [W, H] = A4;
  const m = MOSAIC;
  const cardW = (W - 2 * m.margin - (m.cols - 1) * m.gutter) / m.cols;
  const cardH = (H - 2 * m.margin - m.footer - (m.rows - 1) * m.gutter) / m.rows;
  const innerW = cardW - 2 * m.pad;
  const innerH = cardH - 2 * m.pad - 6; // 6pt reserved for the accent rule
  const problems: LayoutProblem[] = [];
  let minSizeUsed = m.sizes[0]!;

  type Laid = { note: PrintNoteInput; size: number; head: string[]; lines: string[] };
  const laid: Laid[] = [];
  for (const note of ordered) {
    const text = printText(note.body);
    const greeting = `Dear ${note.teacherName},`;
    const bad = [...body.unsupported(text), ...salutation.unsupported(greeting)];
    if (bad.length) {
      problems.push({ noteId: note.id, teacherName: note.teacherName, kind: "unsupported_characters", detail: bad.join(" ") });
      continue;
    }
    let fit: Laid | null = null;
    for (const size of m.sizes) {
      const head = salutation.wrap(greeting, size + 0.5, innerW);
      const lines = body.wrap(text, size, innerW);
      const lead = size * m.leading;
      const footer = opts.councilLabel && note.source === "council" ? lead : 0;
      const h = head.length * (size + 0.5) * m.leading + size * 0.5 + lines.reduce((a, l) => a + (l ? lead : lead * 0.55), 0) + footer;
      if (h <= innerH) {
        fit = { note, size, head, lines };
        break;
      }
    }
    if (!fit) {
      problems.push({
        noteId: note.id,
        teacherName: note.teacherName,
        kind: "does_not_fit",
        detail: `Needs more space than a card allows at ${m.sizes[m.sizes.length - 1]}pt. Shorten line breaks or edit the print text.`,
      });
      continue;
    }
    minSizeUsed = Math.min(minSizeUsed, fit.size);
    laid.push(fit);
  }

  const perPage = m.cols * m.rows;
  const pages = Math.ceil(laid.length / perPage);
  if (problems.length || opts.dryRun) {
    return { bytes: null, pages, order: laid.map((l) => l.note.id), problems, minSizeUsed };
  }

  doc.setTitle(opts.title ?? "Teacher's Day appreciation wall");
  doc.setCreator("STJB Thanks");
  await body.embedFor(doc, [
    ...laid.flatMap((l) => l.lines),
    "— from the Student Council",
    `${opts.title ?? "Teacher's Day"}  ·  sheet 0123456789 of`,
  ]);
  await salutation.embedFor(doc, laid.flatMap((l) => l.head));
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage(A4);
    for (let i = 0; i < perPage; i++) {
      const item = laid[p * perPage + i];
      if (!item) break;
      const col = i % m.cols;
      const row = Math.floor(i / m.cols);
      const x = m.margin + col * (cardW + m.gutter);
      const top = H - m.margin - row * (cardH + m.gutter);
      // card frame (rounded, hairline)
      const r = 8;
      page.drawSvgPath(
        `M ${r} 0 H ${cardW - r} Q ${cardW} 0 ${cardW} ${r} V ${cardH - r} Q ${cardW} ${cardH} ${cardW - r} ${cardH} H ${r} Q 0 ${cardH} 0 ${cardH - r} V ${r} Q 0 0 ${r} 0 Z`,
        { x, y: top, borderColor: RULE, borderWidth: 0.6 },
      );
      page.drawRectangle({ x: x + m.pad, y: top - m.pad - 2, width: 16, height: 2, color: FIRE });
      const s = item.size;
      let y = top - m.pad - 6 - (s + 0.5);
      for (const h of item.head) {
        salutation.draw(page, h, x + m.pad, y, s + 0.5, INK);
        y -= (s + 0.5) * m.leading;
      }
      y -= s * 0.5;
      for (const l of item.lines) {
        if (l) body.draw(page, l, x + m.pad, y, s);
        y -= l ? s * m.leading : s * m.leading * 0.55;
      }
      if (opts.councilLabel && item.note.source === "council") {
        body.draw(page, "— from the Student Council", x + m.pad, y, s - 1, GREY);
      }
    }
    const label = `${opts.title ?? "Teacher's Day"}  ·  sheet ${p + 1} of ${pages}`;
    const lw = body.width(label, 7);
    body.draw(page, label, (W - lw) / 2, m.margin * 0.55, 7, GREY);
  }
  const bytes = await doc.save();
  return { bytes, pages, order: laid.map((l) => l.note.id), problems, minSizeUsed };
}

// ---------------------------------------------------------------- Keepsake

export interface KeepsakeResult {
  bytes: Uint8Array | null;
  pages: number;
  problems: LayoutProblem[];
}

export async function buildKeepsake(
  teacherName: string,
  notes: PrintNoteInput[],
  fonts: FontSet,
  opts: { title?: string; councilLabel?: boolean } = {},
): Promise<KeepsakeResult> {
  const { doc, body, salutation } = await setup(fonts);
  const [W, H] = A4;
  const margin = 60;
  const width = W - 2 * margin;
  const size = 11.5;
  const lead = size * 1.5;
  const problems: LayoutProblem[] = [];
  const items: string[][] = [];
  // Stable order: by id (creation-independent, no author signal).
  for (const n of [...notes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const text = printText(n.body);
    const bad = body.unsupported(text);
    if (bad.length) {
      problems.push({ noteId: n.id, teacherName, kind: "unsupported_characters", detail: bad.join(" ") });
      continue;
    }
    const lines = body.wrap(text, size, width);
    if (opts.councilLabel && n.source === "council") lines.push("", "— from the Student Council");
    items.push(lines);
  }
  const titleBad = salutation.unsupported(teacherName);
  if (titleBad.length) problems.push({ noteId: "-", teacherName, kind: "unsupported_characters", detail: titleBad.join(" ") });
  if (problems.length) return { bytes: null, pages: 0, problems };

  doc.setTitle(`${opts.title ?? "Teacher's Day"} — ${teacherName}`);
  doc.setCreator("STJB Thanks");
  await body.embedFor(doc, [
    ...items.flat(),
    opts.title ?? "Happy Teacher's Day",
    "0123456789 / message messages from your students",
  ]);
  await salutation.embedFor(doc, [`for ${teacherName}`]);
  let page = doc.addPage(A4);
  let y = H - margin - 34;
  body.draw(page, opts.title ?? "Happy Teacher's Day", margin, y, 30);
  y -= 34;
  for (const l of salutation.wrap(`for ${teacherName}`, 20, width)) {
    salutation.draw(page, l, margin, y, 20, INK);
    y -= 26;
  }
  page.drawRectangle({ x: margin, y: y + 4, width: 28, height: 2.5, color: FIRE });
  y -= 22;
  body.draw(page, `${items.length} message${items.length === 1 ? "" : "s"} from your students`, margin, y, 10, GREY);
  y -= 34;
  let pageCount = 1;
  for (const lines of items) {
    const h = lines.reduce((a, l) => a + (l ? lead : lead * 0.55), 0);
    if (y - h < margin + 10) {
      page = doc.addPage(A4);
      pageCount++;
      y = H - margin;
    }
    for (const l of lines) {
      if (l) body.draw(page, l, margin, y, size, l.startsWith("— from the Student Council") ? GREY : INK);
      y -= l ? lead : lead * 0.55;
    }
    y -= 10;
    page.drawLine({ start: { x: margin, y: y + 4 }, end: { x: margin + 40, y: y + 4 }, thickness: 0.6, color: RULE });
    y -= 16;
  }
  const all = doc.getPages();
  all.forEach((pg, i) => {
    const t = `${i + 1} / ${all.length}`;
    body.draw(pg, t, (W - body.width(t, 8)) / 2, margin / 2, 8, GREY);
  });
  const bytes = await doc.save();
  return { bytes, pages: pageCount, problems };
}

export function slug(s: string): string {
  return (
    s
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "teacher"
  );
}
