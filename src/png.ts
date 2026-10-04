import { ascii, concat, crc32, setU32, u32 } from './bytes';
import { EMPTY_EXIF, buildOrientationTiff, isTiff, parseExif, removeGpsInPlace } from './exif';
import { scrubXmpGps, xmpHasGps } from './xmp';
import { PhotoError, type Mode, type Report } from './types';

interface Chunk { type: string; start: number; end: number; dataStart: number; dataEnd: number }

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function parse(b: Uint8Array): Chunk[] {
  if (b.length < 8 || SIG.some((v, i) => b[i] !== v)) throw new PhotoError('broken', 'PNG として読めませんでした。');
  const chunks: Chunk[] = [];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = u32(b, i, false);
    const end = i + 12 + len;
    if (end > b.length) throw new PhotoError('broken', 'PNG が途中で切れています。');
    chunks.push({ type: ascii(b, i + 4, 4), start: i, end, dataStart: i + 8, dataEnd: i + 8 + len });
    i = end;
    if (chunks[chunks.length - 1]!.type === 'IEND') break;
  }
  return chunks;
}

/** iTXt の本文（XMP など）の位置。圧縮されていれば compressed。 */
function itxt(b: Uint8Array, c: Chunk): { keyword: string; textStart: number; compressed: boolean } | null {
  let p = c.dataStart;
  while (p < c.dataEnd && b[p] !== 0) p++;
  if (p + 3 > c.dataEnd) return null;
  const keyword = ascii(b, c.dataStart, p - c.dataStart);
  const compressed = b[p + 1] === 1;
  p += 3;
  while (p < c.dataEnd && b[p] !== 0) p++; // 言語タグ
  p++;
  while (p < c.dataEnd && b[p] !== 0) p++; // 翻訳されたキーワード
  p++;
  return { keyword, textStart: Math.min(p, c.dataEnd), compressed };
}

const keywordOf = (b: Uint8Array, c: Chunk): string => {
  let p = c.dataStart;
  while (p < c.dataEnd && b[p] !== 0) p++;
  return ascii(b, c.dataStart, p - c.dataStart);
};

/** eXIf の中身（"Exif\0\0" が付いていることもある）の TIFF の位置。 */
const tiffRange = (b: Uint8Array, c: Chunk): [number, number] =>
  ascii(b, c.dataStart, 6) === 'Exif\0\0' ? [c.dataStart + 6, c.dataEnd] : [c.dataStart, c.dataEnd];

function rewriteCrc(b: Uint8Array, c: Chunk): void {
  setU32(b, c.dataEnd, crc32(b.subarray(c.start + 4, c.dataEnd)), false);
}

export function inspectPng(b: Uint8Array): Report {
  const report: Report = {
    ...EMPTY_EXIF, format: 'png', gpsInXmp: false, hasExif: false, hasXmp: false, hasIptc: false, hasComment: false, hasIcc: false,
  };
  for (const c of parse(b)) {
    if (c.type === 'eXIf') {
      report.hasExif = true;
      const [s, e] = tiffRange(b, c);
      if (isTiff(b.subarray(s, e))) Object.assign(report, parseExif(b.subarray(s, e)));
    } else if (c.type === 'iTXt') {
      const t = itxt(b, c);
      if (t?.keyword === 'XML:com.adobe.xmp') {
        report.hasXmp = true;
        // 圧縮されているときは中を読めないので、位置情報の有無が分からない（消すときはチャンクごと外す）
        if (t.compressed || xmpHasGps(b.subarray(t.textStart, c.dataEnd))) report.gpsInXmp ||= !t.compressed;
      } else report.hasComment = true;
    } else if (c.type === 'tEXt' || c.type === 'zTXt') {
      if (/^Raw profile type/i.test(keywordOf(b, c))) report.hasExif = true;
      else report.hasComment = true;
    } else if (c.type === 'iCCP') report.hasIcc = true;
  }
  return report;
}

function chunkBytes(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  setU32(out, 0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  setU32(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
  return out;
}

export function cleanPng(input: Uint8Array, mode: Mode): Uint8Array {
  const chunks = parse(input);

  if (mode === 'location') {
    const out = input.slice();
    const drop = new Set<Chunk>();
    for (const c of chunks) {
      if (c.type === 'eXIf') {
        const [s, e] = tiffRange(out, c);
        if (removeGpsInPlace(out.subarray(s, e))) rewriteCrc(out, c);
      } else if (c.type === 'iTXt') {
        const t = itxt(out, c);
        if (t?.keyword === 'XML:com.adobe.xmp') {
          if (t.compressed) drop.add(c); // 圧縮された XMP は中を直せないので、チャンクごと外す
          else if (scrubXmpGps(out.subarray(t.textStart, c.dataEnd))) rewriteCrc(out, c);
        }
      } else if ((c.type === 'tEXt' || c.type === 'zTXt') && /^Raw profile type/i.test(keywordOf(out, c))) drop.add(c);
    }
    if (drop.size === 0) return out;
    return concat([out.subarray(0, 8), ...chunks.filter((c) => !drop.has(c)).map((c) => out.subarray(c.start, c.end))]);
  }

  // すべて消す：メタデータのチャンクを外し、向きがあれば最小の eXIf だけ書く
  let orientation: number | null = null;
  for (const c of chunks) {
    if (c.type === 'eXIf') {
      const [s, e] = tiffRange(input, c);
      orientation = parseExif(input.subarray(s, e)).orientation;
    }
  }
  const META = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);
  const parts: Uint8Array[] = [input.subarray(0, 8)];
  let inserted = orientation === null;
  for (const c of chunks) {
    if (!inserted && c.type === 'IDAT') { parts.push(chunkBytes('eXIf', buildOrientationTiff(orientation!))); inserted = true; }
    if (!META.has(c.type)) parts.push(input.subarray(c.start, c.end));
  }
  return concat(parts);
}
