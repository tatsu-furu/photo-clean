import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { crc32, setU16, setU32 } from '../src/bytes';
import { buildOrientationTiff, parseExif, removeGpsInPlace } from '../src/exif';
import { clean, detectFormat, inspect } from '../src/photo';
import { PhotoError, hasLocation } from '../src/types';
import { makeZip } from '../src/zip';
import { scrubXmpGps, xmpHasGps } from '../src/xmp';

const load = (n: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const text = (b: Uint8Array): string => Buffer.from(b).toString('latin1');

/** JPEG の SOS（画像データの始まり）の位置。 */
function sosOffset(b: Uint8Array): number {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i + 1] === 0xda) return i;
    i += 2 + ((b[i + 2]! << 8) | b[i + 3]!);
  }
  throw new Error('SOS がありません');
}

describe('形式の判定', () => {
  it('先頭のバイトで判定する', () => {
    expect(detectFormat(load('exif-gps.jpg'))).toBe('jpeg');
    expect(detectFormat(load('exif-gps.png'))).toBe('png');
    expect(detectFormat(load('exif-gps.webp'))).toBe('webp');
    expect(detectFormat(load('fake.heic'))).toBe('heic');
    expect(detectFormat(new Uint8Array([1, 2, 3]))).toBe('unknown');
  });

  it('HEIC を選ぶと、分かりやすい案内つきで断る', () => {
    try { inspect(load('fake.heic')); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(PhotoError);
      expect((e as PhotoError).code).toBe('heic');
      expect((e as PhotoError).message).toContain('互換性優先');
    }
  });

  it('壊れたファイルは、落ちずに分かる形で断る', () => {
    const j = load('exif-gps.jpg');
    expect(() => inspect(j.subarray(0, 40))).toThrow(PhotoError);
    expect(() => inspect(new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x00]))).toThrow(PhotoError);
    expect(() => inspect(new Uint8Array(0))).toThrow(PhotoError);
  });
});

describe('JPEG', () => {
  it('中身を読み取れる（場所・日時・機種・向き・XMP）', () => {
    const r = inspect(load('exif-xmp.jpg'));
    expect(r.gps?.lat).toBeCloseTo(35 + 10 / 60 + 30 / 3600, 5);
    expect(r.gps?.lon).toBeCloseTo(135 + 20 / 60 + 15 / 3600, 5);
    expect(r.gps?.alt).toBeCloseTo(12.5, 3);
    expect(r).toMatchObject({ make: 'AcmeCam', model: 'Test Model 1', software: 'TestSoft 1.0', dateTime: '2026:01:02 03:04:05', lens: 'Test Lens 35mm', orientation: 6, hasMakerNote: true });
    expect(r).toMatchObject({ hasExif: true, hasXmp: true, gpsInXmp: true, hasIptc: true, hasComment: true, hasIcc: true });
    expect(hasLocation(r)).toBe(true);
  });

  it('位置情報だけ消す：GPS が消え、日時・機種・向きは残る。大きさも画像データも変わらない', () => {
    const src = load('exif-xmp.jpg');
    const { bytes, after } = clean(src, 'location');
    expect(hasLocation(after)).toBe(false);
    expect(after).toMatchObject({ gps: null, hasGpsIfd: false, gpsInXmp: false, make: 'AcmeCam', dateTime: '2026:01:02 03:04:05', orientation: 6, hasMakerNote: true, hasXmp: true, hasIptc: true });
    expect(bytes.length).toBe(src.length);
    const s = sosOffset(src);
    expect(sosOffset(bytes)).toBe(s);
    expect(Buffer.compare(Buffer.from(bytes.subarray(s)), Buffer.from(src.subarray(s)))).toBe(0); // 画像データはバイト単位で一致
  });

  it('位置情報だけ消す：GPS の数値が、ファイルの中に残らない', () => {
    const { bytes } = clean(load('exif-gps.jpg'), 'location');
    expect(text(bytes)).not.toContain('GPSLatitude');
    // 緯度の分子 35/1 を表す 00 00 00 23 00 00 00 01 が GPS の値として残っていない
    expect(Buffer.from(bytes).includes(Buffer.from([0, 0, 0, 0x23, 0, 0, 0, 1]))).toBe(false);
  });

  it('すべて消す：メタデータは消え、向きと ICC だけ残る。画像データは一致する', () => {
    const src = load('exif-xmp.jpg');
    const { bytes, after } = clean(src, 'all');
    expect(after).toMatchObject({ gps: null, make: null, model: null, software: null, dateTime: null, lens: null, hasMakerNote: false, hasXmp: false, hasIptc: false, hasComment: false });
    expect(after.orientation).toBe(6);
    expect(after.hasIcc).toBe(true);
    expect(bytes.length).toBeLessThan(src.length);
    const a = sosOffset(src);
    const b = sosOffset(bytes);
    expect(Buffer.compare(Buffer.from(bytes.subarray(b)), Buffer.from(src.subarray(a)))).toBe(0);
    expect(text(bytes)).not.toContain('TestSoft');
    expect(text(bytes)).not.toContain('AcmeCam');
  });

  it('メタデータがない写真は、そのまま通る', () => {
    const src = load('plain.jpg');
    const r = clean(src, 'location');
    expect(Buffer.compare(Buffer.from(r.bytes), Buffer.from(src))).toBe(0);
    const all = clean(src, 'all');
    expect(all.after.orientation).toBeNull();
  });

  it('元のデータは書き換えない', () => {
    const src = load('exif-gps.jpg');
    const copy = src.slice();
    clean(src, 'location');
    clean(src, 'all');
    expect(Buffer.compare(Buffer.from(src), Buffer.from(copy))).toBe(0);
  });
});

describe('PNG', () => {
  it('読み取り・位置情報だけ消す・すべて消す', () => {
    const src = load('exif-gps.png');
    const r = inspect(src);
    expect(r).toMatchObject({ format: 'png', hasExif: true, hasXmp: true, gpsInXmp: true, orientation: 6, make: 'AcmeCam' });
    expect(r.gps?.lat).toBeCloseTo(35.175, 3);

    const loc = clean(src, 'location');
    expect(hasLocation(loc.after)).toBe(false);
    expect(loc.after).toMatchObject({ make: 'AcmeCam', orientation: 6, hasXmp: true });
    expect(loc.bytes.length).toBe(src.length);

    const all = clean(src, 'all');
    expect(all.after).toMatchObject({ make: null, hasXmp: false, hasComment: false, orientation: 6, hasIcc: true });
  });

  it('書き換えたチャンクの CRC が正しい', () => {
    for (const mode of ['location', 'all'] as const) {
      const b = clean(load('exif-gps.png'), mode).bytes;
      let i = 8;
      while (i + 12 <= b.length) {
        const len = ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
        const stored = ((b[i + 8 + len]! << 24) | (b[i + 9 + len]! << 16) | (b[i + 10 + len]! << 8) | b[i + 11 + len]!) >>> 0;
        expect(crc32(b.subarray(i + 4, i + 8 + len))).toBe(stored);
        i += 12 + len;
      }
      expect(i).toBe(b.length);
    }
  });
});

describe('WebP', () => {
  it('読み取り・位置情報だけ消す・すべて消す', () => {
    const src = load('exif-gps.webp');
    const r = inspect(src);
    expect(r).toMatchObject({ format: 'webp', hasExif: true, hasXmp: true, gpsInXmp: true, orientation: 6, hasIcc: true });

    const loc = clean(src, 'location');
    expect(hasLocation(loc.after)).toBe(false);
    expect(loc.after).toMatchObject({ make: 'AcmeCam', orientation: 6 });
    expect(loc.bytes.length).toBe(src.length);

    const all = clean(src, 'all');
    expect(all.after).toMatchObject({ make: null, hasXmp: false, orientation: 6, hasIcc: true });
    const b = all.bytes;
    // RIFF の大きさが合っている
    expect(((b[4]! | (b[5]! << 8) | (b[6]! << 16) | (b[7]! << 24)) >>> 0)).toBe(b.length - 8);
    expect(text(b)).not.toContain('TestSoft');
  });
});

describe('TIFF（EXIF の本体）', () => {
  /** 指定のバイト順で、IFD0（Make・Orientation・GPS への入り口）と GPS の入れ物を作る。 */
  function buildTiff(le: boolean) {
    const t = new Uint8Array(200);
    t.set(le ? [0x49, 0x49] : [0x4d, 0x4d], 0);
    setU16(t, 2, 42, le); setU32(t, 4, 8, le);
    const entry = (o: number, tag: number, type: number, count: number, value: number): void => {
      setU16(t, o, tag, le); setU16(t, o + 2, type, le); setU32(t, o + 4, count, le);
      if (type === 3) setU16(t, o + 8, value, le); else setU32(t, o + 8, value, le);
    };
    setU16(t, 8, 3, le);
    entry(10, 0x010f, 2, 6, 100);          // Make は 100 番地に "Acme\0\0"
    entry(22, 0x0112, 3, 1, 6);            // Orientation = 6
    entry(34, 0x8825, 4, 1, 120);          // GPS は 120 番地
    setU32(t, 46, 0, le);                  // 次の IFD なし
    t.set([0x41, 0x63, 0x6d, 0x65, 0, 0], 100);
    setU16(t, 120, 4, le);                 // GPS の項目は4つ
    entry(122, 1, 2, 2, 0); t[130] = 0x4e; t[131] = 0;  // 'N'
    entry(134, 2, 5, 3, 160);              // 緯度（3つの分数）
    entry(146, 3, 2, 2, 0); t[154] = 0x45; t[155] = 0;  // 'E'
    entry(158, 4, 5, 3, 160 + 0);
    setU32(t, 170, 0, le);
    // 緯度の値：35/1, 10/1, 30/1（160 番地から 24 バイトのはずが、IFD の続きと重ならない位置に置き直す）
    return { t, le };
  }

  for (const le of [true, false]) {
    it(`${le ? 'リトルエンディアン' : 'ビッグエンディアン'}：GPS を消しても、ほかの項目と位置は動かない`, () => {
      const { t } = buildTiff(le);
      expect(parseExif(t)).toMatchObject({ make: 'Acme', orientation: 6, hasGpsIfd: true });
      expect(removeGpsInPlace(t)).toBe(true);
      expect(parseExif(t)).toMatchObject({ make: 'Acme', orientation: 6, hasGpsIfd: false, gps: null });
      expect(removeGpsInPlace(t)).toBe(false); // 2回目は何もしない
      expect(t.subarray(120, 180).every((v) => v === 0)).toBe(true); // GPS の領域は 0
    });
  }

  it('向きだけの最小の TIFF を読める', () => {
    for (const o of [1, 3, 6, 8]) expect(parseExif(buildOrientationTiff(o)).orientation).toBe(o);
  });

  it('壊れた TIFF でも落ちない', () => {
    const t = new Uint8Array(30).fill(0xff);
    expect(parseExif(t)).toMatchObject({ gps: null });
    expect(removeGpsInPlace(t)).toBe(false);
    expect(parseExif(new Uint8Array([0x49, 0x49, 42, 0, 0xff, 0xff, 0xff, 0x7f])).gps).toBeNull();
  });
});

describe('XMP', () => {
  const sample = '<rdf:Description exif:GPSLatitude="35,10.5N" xmp:Rating="3"><exif:GPSAltitude>25/2</exif:GPSAltitude><exif:GPSMapDatum/></rdf:Description>';
  it('位置情報だけを、長さを変えずに空白にする', () => {
    const b = new Uint8Array(Buffer.from(sample, 'latin1'));
    expect(xmpHasGps(b)).toBe(true);
    expect(scrubXmpGps(b)).toBe(true);
    const out = Buffer.from(b).toString('latin1');
    expect(out.length).toBe(sample.length);
    expect(out).not.toMatch(/GPS/);
    expect(out).toContain('xmp:Rating="3"');
    expect(xmpHasGps(b)).toBe(false);
  });
});

describe('zip とチェックサム', () => {
  it('CRC32 の既知の値', () => {
    expect(crc32(new Uint8Array(Buffer.from('123456789')))).toBe(0xcbf43926);
  });

  it('作った zip を読み戻すと、名前と中身が一致する（日本語の名前も）', () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = load('exif-gps.jpg');
    const zip = makeZip([{ name: '写真 1.jpg', data: a }, { name: 'b.jpg', data: b }]);
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(dv.getUint32(zip.length - 22, true)).toBe(0x06054b50);
    expect(dv.getUint16(zip.length - 22 + 10, true)).toBe(2);
    let off = dv.getUint32(zip.length - 22 + 16, true);
    const names: string[] = [];
    const datas: Uint8Array[] = [];
    for (let i = 0; i < 2; i++) {
      expect(dv.getUint32(off, true)).toBe(0x02014b50);
      const size = dv.getUint32(off + 24, true);
      const nameLen = dv.getUint16(off + 28, true);
      const local = dv.getUint32(off + 42, true);
      names.push(new TextDecoder().decode(zip.subarray(off + 46, off + 46 + nameLen)));
      const ln = dv.getUint16(local + 26, true);
      const start = local + 30 + ln;
      const data = zip.subarray(start, start + size);
      expect(crc32(data)).toBe(dv.getUint32(off + 16, true));
      datas.push(data);
      off += 46 + nameLen;
    }
    expect(names).toEqual(['写真 1.jpg', 'b.jpg']);
    expect(Buffer.compare(Buffer.from(datas[0]!), Buffer.from(a))).toBe(0);
    expect(Buffer.compare(Buffer.from(datas[1]!), Buffer.from(b))).toBe(0);
  });
});
