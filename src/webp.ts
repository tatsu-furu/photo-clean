import { ascii, concat, setU32, u32 } from './bytes';
import { EMPTY_EXIF, buildOrientationTiff, isTiff, parseExif, removeGpsInPlace } from './exif';
import { scrubXmpGps, xmpHasGps } from './xmp';
import { PhotoError, type Mode, type Report } from './types';

interface Chunk { fourcc: string; start: number; end: number; dataStart: number; dataEnd: number }

function parse(b: Uint8Array): Chunk[] {
  if (b.length < 12 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') throw new PhotoError('broken', 'WebP として読めませんでした。');
  const chunks: Chunk[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const size = u32(b, i + 4, true);
    const dataEnd = i + 8 + size;
    if (dataEnd > b.length) throw new PhotoError('broken', 'WebP が途中で切れています。');
    const end = dataEnd + (size & 1); // 奇数のときは1バイトの詰め物
    chunks.push({ fourcc: ascii(b, i, 4), start: i, end: Math.min(end, b.length), dataStart: i + 8, dataEnd });
    i = end;
  }
  return chunks;
}

const tiffRange = (b: Uint8Array, c: Chunk): [number, number] =>
  ascii(b, c.dataStart, 6) === 'Exif\0\0' ? [c.dataStart + 6, c.dataEnd] : [c.dataStart, c.dataEnd];

export function inspectWebp(b: Uint8Array): Report {
  const report: Report = {
    ...EMPTY_EXIF, format: 'webp', gpsInXmp: false, hasExif: false, hasXmp: false, hasIptc: false, hasComment: false, hasIcc: false,
  };
  for (const c of parse(b)) {
    if (c.fourcc === 'EXIF') {
      report.hasExif = true;
      const [s, e] = tiffRange(b, c);
      if (isTiff(b.subarray(s, e))) Object.assign(report, parseExif(b.subarray(s, e)));
    } else if (c.fourcc === 'XMP ') {
      report.hasXmp = true;
      if (xmpHasGps(b.subarray(c.dataStart, c.dataEnd))) report.gpsInXmp = true;
    } else if (c.fourcc === 'ICCP') report.hasIcc = true;
  }
  return report;
}

export function cleanWebp(input: Uint8Array, mode: Mode): Uint8Array {
  const chunks = parse(input);

  if (mode === 'location') {
    const out = input.slice();
    for (const c of chunks) {
      if (c.fourcc === 'EXIF') {
        const [s, e] = tiffRange(out, c);
        removeGpsInPlace(out.subarray(s, e));
      } else if (c.fourcc === 'XMP ') scrubXmpGps(out.subarray(c.dataStart, c.dataEnd));
    }
    return out;
  }

  let orientation: number | null = null;
  for (const c of chunks) {
    if (c.fourcc === 'EXIF') {
      const [s, e] = tiffRange(input, c);
      orientation = parseExif(input.subarray(s, e)).orientation;
    }
  }
  const parts: Uint8Array[] = [input.slice(0, 12)];
  for (const c of chunks) {
    if (c.fourcc === 'EXIF' || c.fourcc === 'XMP ') continue;
    const bytes = input.slice(c.start, c.end);
    if (c.fourcc === 'VP8X') bytes[8] = (bytes[8]! & ~0x0c) | (orientation !== null ? 0x08 : 0); // EXIF・XMP のフラグを直す
    parts.push(bytes);
  }
  if (orientation !== null) {
    const tiff = buildOrientationTiff(orientation);
    const head = new Uint8Array(8);
    head.set([0x45, 0x58, 0x49, 0x46], 0); // 'EXIF'
    setU32(head, 4, tiff.length, true);
    parts.push(head, tiff);
  }
  const out = concat(parts);
  setU32(out, 4, out.length - 8, true);
  return out;
}
