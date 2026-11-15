import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FontSet } from "../../src/client/pdf/engine";

const NR = join(process.cwd(), "node_modules/@fontsource/newsreader/files");
const EMO = join(process.cwd(), "node_modules/@fontsource/noto-emoji/files");
const f = (dir: string, n: string) => new Uint8Array(readFileSync(join(dir, n)));

export function nodeFonts(): FontSet {
  const emoji = readdirSync(EMO)
    .filter((n) => /^noto-emoji-.*-400-normal\.woff$/.test(n))
    .sort()
    .map((n) => f(EMO, n));
  return {
    regular: ["latin", "latin-ext", "vietnamese"].map((s) => f(NR, `newsreader-${s}-400-normal.woff`)).concat(emoji),
    italic: ["latin", "latin-ext", "vietnamese"].map((s) => f(NR, `newsreader-${s}-400-italic.woff`)),
  };
}
