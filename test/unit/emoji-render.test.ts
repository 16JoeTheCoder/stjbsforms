import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildKeepsake } from "../../src/client/pdf/engine";
import { nodeFonts } from "./fonts";

// Renders emoji through the real engine and checks each one leaves ink on the page.
it.skipIf(!existsSync("/usr/bin/pdftoppm"))("draws every supported emoji (no blank glyphs)", async () => {
  const fonts = nodeFonts();
  const dir = mkdtempSync(join(tmpdir(), "emo-"));
  for (const e of ["🙏", "👍", "😊", "❤️", "🎉", "🥰", "📚", "✨"]) {
    const r = await buildKeepsake("T", [{ id: "a", teacherId: "t", teacherName: "T", body: e.repeat(3) }], fonts, { title: "x" });
    const pdf = join(dir, "e.pdf");
    writeFileSync(pdf, r.bytes!);
    const out = execFileSync("pdftotext", [pdf, "-"]).toString();
    expect(out).toContain(e.replace("️", "").slice(0, 2));
    execFileSync("pdftoppm", ["-r", "30", "-gray", "-f", "1", "-l", "1", "-x", "0", "-y", "150", "-W", "250", "-H", "40", pdf, join(dir, "p")]);
    const pgm = execFileSync("sh", ["-c", `ls ${dir}/p*.pgm | head -1`]).toString().trim();
    const buf = execFileSync("cat", [pgm]);
    let dark = 0;
    for (let i = buf.length - 250 * 40; i < buf.length; i++) if (buf[i]! < 100) dark++;
    expect(dark, `emoji ${e} rendered blank`).toBeGreaterThan(5);
  }
});

it.skipIf(!existsSync("/usr/bin/pdftotext"))("keeps word spaces across font switches and kerned text", async () => {
  const t = "✨ Terima kasih, Bu! đẹp. To Teacher, AV We Ty 😊 You";
  const r = await buildKeepsake("T", [{ id: "a", teacherId: "t", teacherName: "T", body: t }], nodeFonts());
  const dir = mkdtempSync(join(tmpdir(), "sp-"));
  writeFileSync(join(dir, "s.pdf"), r.bytes!);
  expect(execFileSync("pdftotext", ["-raw", join(dir, "s.pdf"), "-"]).toString()).toContain(t);
});
