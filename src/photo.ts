import { ascii } from './bytes';
import { cleanJpeg, inspectJpeg } from './jpeg';
import { cleanPng, inspectPng } from './png';
import { cleanWebp, inspectWebp } from './webp';
import { PhotoError, hasLocation, type Mode, type Report } from './types';

export type Detected = 'jpeg' | 'png' | 'webp' | 'heic' | 'unknown';

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif']);

/** 拡張子ではなく、ファイルの先頭のバイトで形式を判定する。 */
export function detectFormat(b: Uint8Array): Detected {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'png';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp' && HEIC_BRANDS.has(ascii(b, 8, 4))) return 'heic';
  return 'unknown';
}

function supported(b: Uint8Array): 'jpeg' | 'png' | 'webp' {
  const f = detectFormat(b);
  if (f === 'heic') throw new PhotoError('heic', 'HEIC（iPhone の標準形式）には対応していません。iPhone の設定で「互換性優先」にするか、共有のときに JPEG で書き出してください。');
  if (f === 'unknown') throw new PhotoError('unsupported', 'JPEG・PNG・WebP の写真だけ対応しています。');
  return f;
}

export function inspect(b: Uint8Array): Report {
  const f = supported(b);
  return f === 'jpeg' ? inspectJpeg(b) : f === 'png' ? inspectPng(b) : inspectWebp(b);
}

export interface CleanResult { bytes: Uint8Array; before: Report; after: Report }

/** 消して、もう一度読み直し、位置情報が残っていないことを確かめる。 */
export function clean(b: Uint8Array, mode: Mode): CleanResult {
  const f = supported(b);
  const before = inspect(b);
  const bytes = f === 'jpeg' ? cleanJpeg(b, mode) : f === 'png' ? cleanPng(b, mode) : cleanWebp(b, mode);
  const after = inspect(bytes);
  if (hasLocation(after)) throw new PhotoError('broken', '位置情報を消しきれませんでした。この写真は保存しません。');
  return { bytes, before, after };
}

export { hasLocation };
