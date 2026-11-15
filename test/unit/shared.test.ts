import { describe, expect, it } from "vitest";
import { searchTeachers, searchKey, editDistance, teacherDisplayName } from "../../src/shared/search";
import { countChars, normalizeForCompare, noteProblem, cleanNoteText, lowEffortFlags } from "../../src/shared/text";
import { generateClassCode, isValidClassCode, normalizeClassCode, CODE_ALPHABET } from "../../src/shared/codes";
import { mosaicOrder } from "../../src/shared/shuffle";

const T = [
  { id: "1", honorific: "Ms.", fullName: "Catherine Tan" },
  { id: "2", honorific: "Mr.", fullName: "Budi Santoso" },
  { id: "3", honorific: "Mrs.", fullName: "Dewi Lestari" },
  { id: "4", honorific: "Mr.", fullName: "Tanoto Hartono" },
  { id: "5", honorific: "Bu", fullName: "Siti Rahmawati" },
  { id: "6", honorific: "Ms.", fullName: "Zoë Mårtensson" },
  { id: "7", honorific: "Mr.", fullName: "Mrinal Shah" },
];
const ids = (q: string) => searchTeachers(T, q).map((t) => t.id);

describe("teacher search", () => {
  it("matches first-name prefixes and surnames", () => {
    expect(ids("cath")[0]).toBe("1");
    expect(ids("tan")).toContain("1");
    expect(ids("TAN")[0]).toBe("1"); // exact surname beats prefix of "Tanoto"
    expect(ids("budi s")).toEqual(["2"]);
  });
  it("ignores honorifics in queries and names", () => {
    expect(ids("ms cath")[0]).toBe("1");
    expect(ids("Mrs. Dewi")).toEqual(["3"]);
    // "mr" alone must not filter by title or match "Mrinal" first via the honorific
    expect(ids("mr").length).toBe(T.length);
    expect(ids("bu siti")).toEqual(["5"]);
  });
  it("tolerates typos and accents", () => {
    expect(ids("catherin")[0]).toBe("1");
    expect(ids("cahterine")[0]).toBe("1"); // transposition
    expect(ids("santsoo")).toContain("2");
    expect(ids("zoe")).toEqual(["6"]);
    expect(ids("martensson")).toEqual(["6"]);
  });
  it("returns nothing for unrelated text and everything for empty", () => {
    expect(ids("xyzzy")).toEqual([]);
    expect(ids("").length).toBe(T.length);
  });
  it("search key strips titles and punctuation", () => {
    expect(searchKey("Ms.", "Catherine Tan")).toBe("catherine tan");
    expect(teacherDisplayName({ honorific: "Ms.", fullName: "Catherine Tan" })).toBe("Ms. Catherine Tan");
    expect(editDistance("abcd", "abdc")).toBe(1);
  });
});

describe("note text rules", () => {
  it("counts graphemes, not UTF-16 units", () => {
    expect(countChars("héllo")).toBe(5);
    expect(countChars("👨‍👩‍👧")).toBe(1);
    expect(countChars("🙏🙏")).toBe(2);
    expect(countChars("  terima kasih  ")).toBe(12);
    expect(countChars("ありがとう")).toBe(5);
  });
  it("boundaries are inclusive 100..400", () => {
    expect(noteProblem("a".repeat(99))).toBe("too_short");
    expect(noteProblem("a".repeat(100))).toBeNull();
    expect(noteProblem("a".repeat(400))).toBeNull();
    expect(noteProblem("a".repeat(401))).toBe("too_long");
    expect(noteProblem(" \n\t ")).toBe("empty");
    expect(noteProblem("​".repeat(150))).toBe("empty");
  });
  it("identical detection normalises case, whitespace and Unicode only", () => {
    expect(normalizeForCompare("  Thank  you\n\nMs Tan ")).toBe(normalizeForCompare("thank you ms tan"));
    expect(normalizeForCompare("ﬁne")).toBe(normalizeForCompare("fine")); // NFKC ligature
    expect(normalizeForCompare("Thank you!")).not.toBe(normalizeForCompare("Thank you."));
  });
  it("cleaning preserves paragraphs and strips controls", () => {
    expect(cleanNoteText("Para one\r\n\r\nPara two\u0007")).toBe("Para one\n\nPara two");
  });
  it("low-effort flags are advisory", () => {
    expect(lowEffortFlags("aaaaaaaaaaaaaaaa")).toContain("repeated_characters");
    expect(lowEffortFlags("thanks thanks thanks thanks thanks thanks thanks thanks thanks thanks thanks thanks")).toContain("repetitive_words");
    expect(lowEffortFlags("Thank you for making physics feel possible, and for the patience on Thursdays.")).toEqual([]);
  });
});

describe("class codes", () => {
  it("normalises and validates", () => {
    expect(normalizeClassCode(" k7m-4p ")).toBe("K7M4P");
    expect(isValidClassCode("K7M4P")).toBe(true);
    for (const bad of ["K7M4", "K7M4PP", "O7M4P", "K0M4P", "KIM4P", "K1M4P"]) expect(isValidClassCode(bad)).toBe(false);
  });
  it("generates only unambiguous characters", () => {
    for (let i = 0; i < 500; i++) {
      const c = generateClassCode();
      expect(c).toHaveLength(5);
      for (const ch of c) expect(CODE_ALPHABET).toContain(ch);
    }
    expect(CODE_ALPHABET).not.toMatch(/[O0I1L]/);
  });
});

describe("mosaic shuffle", () => {
  const notes = Array.from({ length: 300 }, (_, i) => ({ id: `n${String(i).padStart(3, "0")}`, teacherId: `t${i % 41}` }));
  it("is a stable permutation for a seed and differs across seeds", () => {
    const a = mosaicOrder(notes, "seed-1").map((n) => n.id);
    const b = mosaicOrder([...notes].reverse(), "seed-1").map((n) => n.id);
    const c = mosaicOrder(notes, "seed-2").map((n) => n.id);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect([...a].sort()).toEqual(notes.map((n) => n.id));
  });
  it("avoids same-teacher neighbours within a page when possible", () => {
    const o = mosaicOrder(notes, "x");
    let clashes = 0;
    for (let i = 0; i < o.length; i++) for (let j = Math.max(0, i - 5); j < i; j++) if (o[j]!.teacherId === o[i]!.teacherId) clashes++;
    expect(clashes).toBe(0);
  });
  it("still returns everything when one teacher dominates", () => {
    const skew = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, teacherId: i < 50 ? "big" : `t${i}` }));
    expect(mosaicOrder(skew, "z")).toHaveLength(60);
  });
});
