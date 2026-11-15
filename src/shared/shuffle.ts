// Deterministic, seed-based shuffling for the print mosaic.

function hashSeed(seed: string): number {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seeded Fisher–Yates followed by a de-clustering pass that tries to keep
 * notes for the same teacher at least `window` positions apart. Input order
 * is normalised by id first, so the output depends only on (seed, set of notes).
 * Never adds or drops items.
 */
export function mosaicOrder<T extends { id: string; teacherId: string }>(
  items: T[],
  seed: string,
  window = 6,
): T[] {
  const arr = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rand = mulberry32(hashSeed(seed));
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  for (let i = 1; i < arr.length; i++) {
    const recent = new Set<string>();
    for (let k = Math.max(0, i - window + 1); k < i; k++) recent.add(arr[k]!.teacherId);
    if (!recent.has(arr[i]!.teacherId)) continue;
    for (let j = i + 1; j < arr.length; j++) {
      if (!recent.has(arr[j]!.teacherId)) {
        const [moved] = arr.splice(j, 1);
        arr.splice(i, 0, moved!);
        break;
      }
    }
  }
  return arr;
}
