// Class access codes: five characters, no ambiguous glyphs (O, 0, I, 1, L).
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 5;

/** Uppercases and strips spaces/dashes. Ambiguous characters are left as-is
 * so they fail validation instead of being silently mapped to another code. */
export function normalizeClassCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, "");
}

export function isValidClassCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return false;
  return true;
}

export function generateClassCode(): string {
  const out: string[] = [];
  const buf = new Uint32Array(CODE_LENGTH * 2);
  while (out.length < CODE_LENGTH) {
    crypto.getRandomValues(buf);
    for (const v of buf) {
      // rejection sampling to avoid modulo bias
      const limit = Math.floor(0xffffffff / CODE_ALPHABET.length) * CODE_ALPHABET.length;
      if (v < limit) out.push(CODE_ALPHABET[v % CODE_ALPHABET.length]!);
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out.join("");
}

export function generateReceiptCode(): string {
  const a = generateClassCode();
  const b = generateClassCode().slice(0, 3);
  return `${a.slice(0, 4)}-${a.slice(4)}${b}`;
}
