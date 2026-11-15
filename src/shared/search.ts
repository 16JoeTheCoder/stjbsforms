// Teacher search: case-insensitive, accent-insensitive, honorific-agnostic,
// partial and typo tolerant. Pure and synchronous: ~41 teachers are searched
// in the browser on every keystroke.

export const HONORIFICS = new Set([
  "mr", "mrs", "ms", "miss", "mdm", "madam", "mx", "dr", "prof", "sir",
  "sr", "br", "fr", "rev", "pak", "bapak", "bu", "ibu", "bpk", "cikgu",
]);

export interface SearchableTeacher {
  id: string;
  honorific: string;
  fullName: string;
}

export function foldText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function nameTokens(s: string): string[] {
  return foldText(s)
    .split(" ")
    .filter((t) => t.length > 0 && !HONORIFICS.has(t));
}

/** Search key stored server-side (teachers.search_name). */
export function searchKey(honorific: string, fullName: string): string {
  return nameTokens(`${honorific} ${fullName}`).join(" ");
}

/** Optimal string alignment distance (Damerau-Levenshtein with adjacent swaps). */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = [];
  for (let i = 0; i <= a.length; i++) d.push([i]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

function tokenScore(q: string, t: string): number {
  if (t === q) return 100;
  if (t.startsWith(q)) return 80 - Math.min(10, t.length - q.length);
  if (q.length >= 3 && t.includes(q)) return 45;
  if (q.length >= 4) {
    const allowed = q.length >= 7 ? 2 : 1;
    const dist = Math.min(
      editDistance(q, t, allowed),
      editDistance(q, t.slice(0, q.length), allowed),
      editDistance(q, t.slice(0, q.length + 1), allowed),
    );
    if (dist <= allowed) return 30 - dist * 5;
  }
  return 0;
}

export interface SearchResult<T> {
  item: T;
  score: number;
}

export function searchTeachers<T extends SearchableTeacher>(teachers: T[], query: string): T[] {
  const qTokens = nameTokens(query);
  const sorted = [...teachers].sort((a, b) => a.fullName.localeCompare(b.fullName));
  if (qTokens.length === 0) {
    // Empty query, or only an honorific ("ms"): list everyone; teachers with a
    // matching honorific first, without letting the title drive ranking further.
    const raw = foldText(query);
    if (!raw) return sorted;
    const hon = (t: T) => (foldText(t.honorific).startsWith(raw) ? 0 : 1);
    return sorted.sort((a, b) => hon(a) - hon(b));
  }
  const results: SearchResult<T>[] = [];
  for (const t of sorted) {
    const tTokens = nameTokens(t.fullName);
    let total = 0;
    let ok = true;
    for (const q of qTokens) {
      let best = 0;
      for (const tt of tTokens) best = Math.max(best, tokenScore(q, tt));
      if (best === 0) {
        ok = false;
        break;
      }
      total += best;
    }
    if (!ok) continue;
    // Whole-phrase prefix bonus ("cath ta" -> "catherine tan")
    const joined = tTokens.join(" ");
    if (joined.startsWith(qTokens.join(" "))) total += 15;
    results.push({ item: t, score: total });
  }
  results.sort((a, b) => b.score - a.score || a.item.fullName.localeCompare(b.item.fullName));
  return results.map((r) => r.item);
}

export function teacherDisplayName(t: { honorific: string; fullName: string }): string {
  return t.honorific ? `${t.honorific} ${t.fullName}` : t.fullName;
}
