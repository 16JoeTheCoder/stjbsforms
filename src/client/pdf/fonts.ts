// Browser font loader for the print engine. Fonts come from @fontsource packages
// (bundled by Vite as static assets) and are embedded + subset into each PDF.
import latinReg from "@fontsource/newsreader/files/newsreader-latin-400-normal.woff?url";
import latinExtReg from "@fontsource/newsreader/files/newsreader-latin-ext-400-normal.woff?url";
import vietReg from "@fontsource/newsreader/files/newsreader-vietnamese-400-normal.woff?url";
import latinIta from "@fontsource/newsreader/files/newsreader-latin-400-italic.woff?url";
import latinExtIta from "@fontsource/newsreader/files/newsreader-latin-ext-400-italic.woff?url";
import vietIta from "@fontsource/newsreader/files/newsreader-vietnamese-400-italic.woff?url";
import type { FontSet } from "./engine";

const emojiUrls = import.meta.glob("/node_modules/@fontsource/noto-emoji/files/noto-emoji-*-400-normal.woff", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

async function get(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Font failed to load (${r.status})`);
  return new Uint8Array(await r.arrayBuffer());
}

let cache: Promise<FontSet> | null = null;
export function loadFonts(): Promise<FontSet> {
  if (!cache) {
    cache = (async () => {
      const emoji = Object.keys(emojiUrls)
        .sort()
        .map((k) => emojiUrls[k]!);
      const [regular, italic, emo] = await Promise.all([
        Promise.all([latinReg, latinExtReg, vietReg].map(get)),
        Promise.all([latinIta, latinExtIta, vietIta].map(get)),
        Promise.all(emoji.map(get)),
      ]);
      return { regular: [...regular, ...emo], italic };
    })().catch((e) => {
      cache = null;
      throw e;
    });
  }
  return cache;
}
