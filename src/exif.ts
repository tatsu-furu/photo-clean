import { ascii, setU16, setU32, u16, u32 } from './bytes';

/** TIFF（EXIF の本体）の読み書き。書き換えは「その場で」行い、ファイルの大きさと各値の位置は変えない。 */

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

export interface ExifInfo {
  gps: { lat: number; lon: number; alt: number | null } | null;
  /** GPS の情報の入れ物（IFD）があるか。座標がなくても true になりうる。 */
  hasGpsIfd: boolean;
  dateTime: string | null;
  make: string | null;
  model: string | null;
  lens: string | null;
  software: string | null;
  orientation: number | null;
  hasMakerNote: boolean;
}

export const EMPTY_EXIF: ExifInfo = {
  gps: null, hasGpsIfd: false, dateTime: null, make: null, model: null, lens: null, software: null, orientation: null, hasMakerNote: false,
};

interface Entry { tag: number; type: number; count: number; entryOff: number; valueOff: number; size: number }

/** "II*\0" か "MM\0*" で始まるか。 */
export function isTiff(t: Uint8Array): boolean {
  if (t.length < 8) return false;
  const le = t[0] === 0x49 && t[1] === 0x49;
  const be = t[0] === 0x4d && t[1] === 0x4d;
  return (le || be) && u16(t, 2, le) === 42;
}

const isLE = (t: Uint8Array): boolean => t[0] === 0x49;

function readIfd(t: Uint8Array, off: number): { entries: Entry[]; tableOff: number } | null {
  const le = isLE(t);
  if (off < 8 || off + 2 > t.length) return null;
  const n = u16(t, off, le);
  if (n > 2000 || off + 2 + n * 12 > t.length) return null;
  const entries: Entry[] = [];
  for (let i = 0; i < n; i++) {
    const e = off + 2 + i * 12;
    const type = u16(t, e + 2, le);
    const count = u32(t, e + 4, le);
    const size = (TYPE_SIZE[type] ?? 0) * count;
    const valueOff = size <= 4 ? e + 8 : u32(t, e + 8, le);
    entries.push({ tag: u16(t, e, le), type, count, entryOff: e, valueOff, size });
  }
  return { entries, tableOff: off };
}

const valid = (t: Uint8Array, e: Entry): boolean => e.size > 0 && e.valueOff + e.size <= t.length;

function readAscii(t: Uint8Array, e: Entry): string | null {
  if (e.type !== 2 || !valid(t, e)) return null;
  const s = ascii(t, e.valueOff, e.size).split('\0')[0]!.trim();
  return s || null;
}

function readRationals(t: Uint8Array, e: Entry): number[] | null {
  if (e.type !== 5 || !valid(t, e)) return null;
  const le = isLE(t);
  const out: number[] = [];
  for (let i = 0; i < e.count; i++) {
    const num = u32(t, e.valueOff + i * 8, le);
    const den = u32(t, e.valueOff + i * 8 + 4, le);
    out.push(den === 0 ? 0 : num / den);
  }
  return out;
}

const dms = (v: number[] | null, ref: string | null): number | null => {
  if (!v || v.length < 3 || !ref) return null;
  const deg = v[0]! + v[1]! / 60 + v[2]! / 3600;
  return ref === 'S' || ref === 'W' ? -deg : deg;
};

export function parseExif(t: Uint8Array): ExifInfo {
  const info: ExifInfo = { ...EMPTY_EXIF };
  if (!isTiff(t)) return info;
  const le = isLE(t);
  const ifd0 = readIfd(t, u32(t, 4, le));
  if (!ifd0) return info;
  let exifPtr = 0;
  let gpsPtr = 0;
  for (const e of ifd0.entries) {
    if (e.tag === 0x010f) info.make = readAscii(t, e);
    else if (e.tag === 0x0110) info.model = readAscii(t, e);
    else if (e.tag === 0x0131) info.software = readAscii(t, e);
    else if (e.tag === 0x0132) info.dateTime ??= readAscii(t, e);
    else if (e.tag === 0x0112 && e.type === 3 && e.count === 1) {
      const o = u16(t, e.entryOff + 8, le);
      if (o >= 1 && o <= 8) info.orientation = o;
    } else if (e.tag === 0x8769) exifPtr = u32(t, e.entryOff + 8, le);
    else if (e.tag === 0x8825) gpsPtr = u32(t, e.entryOff + 8, le);
  }
  if (exifPtr) {
    const ifd = readIfd(t, exifPtr);
    for (const e of ifd?.entries ?? []) {
      if (e.tag === 0x9003) info.dateTime = readAscii(t, e) ?? info.dateTime;
      else if (e.tag === 0xa434) info.lens = readAscii(t, e);
      else if (e.tag === 0x927c) info.hasMakerNote = true;
    }
  }
  if (gpsPtr) {
    info.hasGpsIfd = true;
    const ifd = readIfd(t, gpsPtr);
    const by = new Map((ifd?.entries ?? []).map((e) => [e.tag, e] as const));
    const str = (tag: number): string | null => { const e = by.get(tag); return e ? readAscii(t, e) : null; };
    const rat = (tag: number): number[] | null => { const e = by.get(tag); return e ? readRationals(t, e) : null; };
    const lat = dms(rat(2), str(1));
    const lon = dms(rat(4), str(3));
    if (lat !== null && lon !== null) {
      const alt = rat(6)?.[0] ?? null;
      const below = by.get(5) && by.get(5)!.size > 0 ? t[by.get(5)!.entryOff + 8] === 1 : false;
      info.gps = { lat, lon, alt: alt === null ? null : below ? -alt : alt };
    }
  }
  return info;
}

/**
 * GPS の情報を、その場で消す。
 * - IFD0 の GPS への入り口（0x8825）を取り除く（後ろの項目を詰めて、個数を1つ減らす）。
 * - GPS の入れ物と、そこから指していた値の領域を 0 で埋める。
 * ほかの値の位置は一切動かさないので、MakerNote などの内部の位置もずれない。
 * 変更したら true。
 */
export function removeGpsInPlace(t: Uint8Array): boolean {
  if (!isTiff(t)) return false;
  const le = isLE(t);
  const ifd0Off = u32(t, 4, le);
  const ifd0 = readIfd(t, ifd0Off);
  if (!ifd0) return false;
  const idx = ifd0.entries.findIndex((e) => e.tag === 0x8825);
  if (idx < 0) return false;
  const gpsOff = u32(t, ifd0.entries[idx]!.entryOff + 8, le);

  const gps = readIfd(t, gpsOff);
  if (gps) {
    for (const e of gps.entries) if (e.size > 4 && valid(t, e)) t.fill(0, e.valueOff, e.valueOff + e.size);
    t.fill(0, gpsOff, Math.min(t.length, gpsOff + 2 + gps.entries.length * 12 + 4));
  }

  const n = ifd0.entries.length;
  const table = ifd0Off + 2;
  const next = u32(t, table + n * 12, le);
  t.copyWithin(table + idx * 12, table + (idx + 1) * 12, table + n * 12); // 後ろの項目を1つ前へ
  setU32(t, table + (n - 1) * 12, next, le); // 次の IFD への印を、詰めた分だけ前へ
  t.fill(0, table + (n - 1) * 12 + 4, table + n * 12 + 4); // あいた12バイト
  setU16(t, ifd0Off, n - 1, le);
  return true;
}

/** 向き（Orientation）だけを持つ最小の TIFF。 */
export function buildOrientationTiff(orientation: number): Uint8Array {
  const t = new Uint8Array(26);
  t.set([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08], 0); // MM, 42, IFD0 は 8
  setU16(t, 8, 1, false); // 項目は1つ
  setU16(t, 10, 0x0112, false);
  setU16(t, 12, 3, false); // SHORT
  setU32(t, 14, 1, false);
  setU16(t, 18, orientation, false);
  // 次の IFD はなし（残りは 0）
  return t;
}
