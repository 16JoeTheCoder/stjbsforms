import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { buildKeepsake, buildMosaic, printText, slug, type PrintNoteInput } from "../../src/client/pdf/engine";
import { nodeFonts } from "./fonts";

const fonts = nodeFonts();
const LONG_NAME = "Ms. Ursula Maria Fransiska Wijayakusuma-Tjandrawinata";
const words = "Thank you for being patient with us, for every extra explanation, and for believing we could do it. ";
const note = (i: number, body?: string, teacher = `Teacher ${i % 41}`): PrintNoteInput => ({
  id: `n${String(i).padStart(4, "0")}`,
  teacherId: `t${i % 41}`,
  teacherName: teacher,
  body: body ?? (words.repeat(4).slice(0, 100 + ((i * 37) % 300))),
});

describe("A4 mosaic", () => {
  it("puts six notes per page and includes every note exactly once", async () => {
    const notes = Array.from({ length: 61 }, (_, i) => note(i));
    const r = await buildMosaic(notes, fonts, { seed: "s" });
    expect(r.problems).toEqual([]);
    expect(r.pages).toBe(11);
    expect(new Set(r.order).size).toBe(61);
    expect([...r.order].sort()).toEqual(notes.map((n) => n.id).sort());
    const doc = await PDFDocument.load(r.bytes!);
    expect(doc.getPageCount()).toBe(11);
    const [w, h] = [doc.getPage(0).getWidth(), doc.getPage(0).getHeight()];
    expect(Math.round(w)).toBe(595);
    expect(Math.round(h)).toBe(842);
  });

  it("fits 400-character messages with long teacher names and paragraphs", async () => {
    const body400 = (words.repeat(5)).slice(0, 400);
    const paras = "Dear teacher,\n\nThank you.\n\n" + words.repeat(3).slice(0, 300) + "\n\nWith love";
    const r = await buildMosaic([note(1, body400, LONG_NAME), note(2, paras, LONG_NAME)], fonts, { seed: "x" });
    expect(r.problems).toEqual([]);
    expect(r.minSizeUsed).toBeGreaterThanOrEqual(8.5);
  });

  it("handles Indonesian, accents, Vietnamese and emoji", async () => {
    const r = await buildMosaic(
      [note(1, "Terima kasih banyak, Bu! Anda guru terbaik. Café, naïve, Zoë, Tiếng Việt, đẹp quá. 😊🙏❤️👍 " + words)],
      fonts,
      { seed: "x" },
    );
    expect(r.problems).toEqual([]);
  });

  it("reports (never drops) characters the fonts can't render", async () => {
    const r = await buildMosaic([note(1, "ありがとうございます " + words), note(2)], fonts, { seed: "x" });
    expect(r.bytes).toBeNull();
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]!.kind).toBe("unsupported_characters");
  });

  it("reports notes that cannot fit instead of clipping", async () => {
    const r = await buildMosaic([note(1, Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"))], fonts, { seed: "x" });
    expect(r.bytes).toBeNull();
    expect(r.problems[0]!.kind).toBe("does_not_fit");
  });

  it("is deterministic for a seed", async () => {
    const notes = Array.from({ length: 30 }, (_, i) => note(i));
    const a = await buildMosaic(notes, fonts, { seed: "same", dryRun: true });
    const b = await buildMosaic([...notes].reverse(), fonts, { seed: "same", dryRun: true });
    expect(a.order).toEqual(b.order);
  });

  it("collapses runs of blank lines but keeps paragraphs", () => {
    expect(printText("a\n\n\n\n\nb\r\nc")).toBe("a\n\nb\nc");
  });

  it("does not print metadata: text content is only greetings, messages and sheet labels", async () => {
    const r = await buildMosaic([note(1, "UNIQUEBODY " + words, "Ms. Catherine Tan")], fonts, { seed: "x", title: "TD" });
    const raw = Buffer.from(r.bytes!).toString("latin1");
    // font subsets embed text as glyph ids; ensure no plain-text ids leak into the content
    expect(raw).not.toContain("n0001");
    expect(raw).not.toContain("t1");
  });
});

describe("keepsakes", () => {
  it("builds a multi-page keepsake with all notes for one teacher", async () => {
    const notes = Array.from({ length: 18 }, (_, i) => note(i, words.repeat(4).slice(0, 380), "Ms. Catherine Tan"));
    const r = await buildKeepsake("Ms. Catherine Tan", notes, fonts);
    expect(r.problems).toEqual([]);
    const doc = await PDFDocument.load(r.bytes!);
    expect(doc.getPageCount()).toBeGreaterThan(1);
    expect(doc.getTitle()).toContain("Catherine Tan");
  });
  it("slugifies file names safely", () => {
    expect(slug("Ms. Zoë Mårtensson / JC")).toBe("ms-zoe-martensson-jc");
  });
});
