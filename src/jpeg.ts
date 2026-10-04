import { concat, startsWith, u16 } from './bytes';
import { EMPTY_EXIF, buildOrientationTiff, parseExif, removeGpsInPlace } from './exif';
import { scrubXmpGps, xmpHasGps } from './xmp';
import { PhotoError, type Mode, type Report } from './types';

interface Segment { marker: number; start: number; end: number }

const XMP_NS = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_EXT_NS = 'http://ns.adobe.com/xmp/extension/\0';

/** SOS（画像データの始まり）の手前まで、セグメントを順に読む。 */
function parse(b: Uint8Array): { segments: Segment[]; sos: number } {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new PhotoError('broken', 'JPEG として読めませんでした。');
  const segments: Segment[] = [];
  let i = 2;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) throw new PhotoError('broken', 'JPEG の構造が壊れています。');
    while (b[i + 1] === 0xff) i++; // 詰め物
    const marker = b[i + 1]!;
    if (marker === 0xda) return { segments, sos: i };
    if (marker === 0xd9) return { segments, sos: i };
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { segments.push({ marker, start: i, end: i + 2 }); i += 2; continue; }
    if (i + 4 > b.length) throw new PhotoError('broken', 'JPEG が途中で切れています。');
    const end = i + 2 + u16(b, i + 2, false);
    if (end > b.length || end < i + 4) throw new PhotoError('broken', 'JPEG の構造が壊れています。');
    segments.push({ marker, start: i, end });
    i = end;
  }
  throw new PhotoError('broken', 'JPEG の画像データが見つかりません。');
}

const payload = (s: Segment): number => s.start + 4;
const isExif = (b: Uint8Array, s: Segment): boolean => s.marker === 0xe1 && startsWith(b, payload(s), 'Exif\0\0');
const isXmp = (b: Uint8Array, s: Segment): boolean => s.marker === 0xe1 && (startsWith(b, payload(s), XMP_NS) || startsWith(b, payload(s), XMP_EXT_NS));
const isIptc = (s: Segment): boolean => s.marker === 0xed;
const isIcc = (b: Uint8Array, s: Segment): boolean => s.marker === 0xe2 && startsWith(b, payload(s), 'ICC_PROFILE\0');

export function inspectJpeg(b: Uint8Array): Report {
  const { segments } = parse(b);
  const report: Report = {
    ...EMPTY_EXIF, format: 'jpeg', gpsInXmp: false, hasExif: false, hasXmp: false, hasIptc: false, hasComment: false, hasIcc: false,
  };
  for (const s of segments) {
    if (isExif(b, s) && !report.hasExif) {
      report.hasExif = true;
      Object.assign(report, parseExif(b.subarray(payload(s) + 6, s.end)));
    } else if (isXmp(b, s)) {
      report.hasXmp = true;
      if (xmpHasGps(b.subarray(payload(s), s.end))) report.gpsInXmp = true;
    } else if (isIptc(s)) report.hasIptc = true;
    else if (s.marker === 0xfe) report.hasComment = true;
    else if (isIcc(b, s)) report.hasIcc = true;
  }
  return report;
}

/** 画像データの終わり（最初の EOI の次）。見つからなければ末尾。 */
function imageEnd(b: Uint8Array, sos: number): number {
  for (let i = sos + 2; i + 1 < b.length; i++) if (b[i] === 0xff && b[i + 1] === 0xd9) return i + 2;
  return b.length;
}

export function cleanJpeg(input: Uint8Array, mode: Mode): Uint8Array {
  const { segments, sos } = parse(input);

  if (mode === 'location') {
    // 大きさも位置も変えず、GPS の部分だけをその場で消す（画像データは1バイトも触らない）
    const out = input.slice();
    for (const s of segments) {
      if (isExif(out, s)) removeGpsInPlace(out.subarray(payload(s) + 6, s.end));
      else if (isXmp(out, s)) scrubXmpGps(out.subarray(payload(s), s.end));
    }
    return out;
  }

  // すべて消す：EXIF・XMP・IPTC・コメントなどを外し、向き（と ICC・JFIF など）だけ残す
  let orientation: number | null = null;
  for (const s of segments) {
    if (isExif(input, s)) { orientation = parseExif(input.subarray(payload(s) + 6, s.end)).orientation; break; }
  }
  const keep = (s: Segment): boolean => {
    if (s.marker === 0xfe) return false; // コメント
    if (s.marker >= 0xe0 && s.marker <= 0xef) {
      if (s.marker === 0xe0) return true; // JFIF
      if (isIcc(input, s)) return true; // 色の情報
      if (s.marker === 0xee) return true; // Adobe（色の変換に必要）
      return false; // EXIF・XMP・IPTC・MPF など
    }
    return true; // 画像の復元に必要なもの
  };

  const parts: Uint8Array[] = [input.subarray(0, 2)];
  let inserted = orientation === null;
  const insertOrientation = (): void => {
    if (inserted || orientation === null) return;
    const tiff = buildOrientationTiff(orientation);
    const seg = new Uint8Array(4 + 6 + tiff.length);
    seg.set([0xff, 0xe1], 0);
    seg[2] = ((2 + 6 + tiff.length) >> 8) & 255;
    seg[3] = (2 + 6 + tiff.length) & 255;
    seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
    seg.set(tiff, 10);
    parts.push(seg);
    inserted = true;
  };
  for (const s of segments) {
    if (s.marker !== 0xe0) insertOrientation(); // JFIF（APP0）の次に置く
    if (keep(s)) parts.push(input.subarray(s.start, s.end));
  }
  insertOrientation();
  // 画像データは、最初の EOI までをそのまま。そのあとに付いたもの（MPF の副画像など）は付けない。
  parts.push(input.subarray(sos, imageEnd(input, sos)));
  return concat(parts);
}
