import { unzlibSync } from "fflate";

/**
 * Converts a WOFF 1.0 font into a plain TrueType/OpenType (sfnt) file.
 * pdf-lib's subsetter mis-renders some glyphs when fed WOFF directly, so fonts
 * are unwrapped to sfnt before embedding. Non-WOFF input is returned as-is.
 */
export function woffToSfnt(input: Uint8Array): Uint8Array {
  const dv = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (dv.getUint32(0) !== 0x774f4646) return input; // 'wOFF'
  const flavor = dv.getUint32(4);
  const numTables = dv.getUint16(12);
  const tables: { tag: number; checksum: number; data: Uint8Array }[] = [];
  for (let i = 0; i < numTables; i++) {
    const e = 44 + i * 20;
    const tag = dv.getUint32(e);
    const offset = dv.getUint32(e + 4);
    const compLength = dv.getUint32(e + 8);
    const origLength = dv.getUint32(e + 12);
    const checksum = dv.getUint32(e + 16);
    const raw = input.subarray(offset, offset + compLength);
    const data = compLength < origLength ? unzlibSync(raw) : raw;
    if (data.length !== origLength) throw new Error("Corrupt WOFF table");
    tables.push({ tag, checksum, data });
  }
  tables.sort((a, b) => a.tag - b.tag);
  const headerLen = 12 + numTables * 16;
  let total = headerLen;
  for (const t of tables) total += (t.data.length + 3) & ~3;
  const out = new Uint8Array(total);
  const ov = new DataView(out.buffer);
  let es = 0;
  while (1 << (es + 1) <= numTables) es++;
  const searchRange = (1 << es) * 16;
  ov.setUint32(0, flavor);
  ov.setUint16(4, numTables);
  ov.setUint16(6, searchRange);
  ov.setUint16(8, es);
  ov.setUint16(10, numTables * 16 - searchRange);
  let off = headerLen;
  tables.forEach((t, i) => {
    const d = 12 + i * 16;
    ov.setUint32(d, t.tag);
    ov.setUint32(d + 4, t.checksum);
    ov.setUint32(d + 8, off);
    ov.setUint32(d + 12, t.data.length);
    out.set(t.data, off);
    off += (t.data.length + 3) & ~3;
  });
  return out;
}
