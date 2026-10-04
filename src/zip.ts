import { concat, crc32, setU16, setU32 } from './bytes';

export interface ZipEntry { name: string; data: Uint8Array }

/** 圧縮しない（保存のみ）zip。写真はすでに圧縮されているので、これで十分。 */
export function makeZip(entries: readonly ZipEntry[], date = new Date()): Uint8Array {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = (Math.max(0, date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = new Uint8Array(30 + name.length);
    setU32(local, 0, 0x04034b50, true);
    setU16(local, 4, 20, true);
    setU16(local, 6, 0x0800, true); // 名前は UTF-8
    setU16(local, 10, dosTime, true);
    setU16(local, 12, dosDate, true);
    setU32(local, 14, crc, true);
    setU32(local, 18, e.data.length, true);
    setU32(local, 22, e.data.length, true);
    setU16(local, 26, name.length, true);
    local.set(name, 30);
    locals.push(local, e.data);

    const central = new Uint8Array(46 + name.length);
    setU32(central, 0, 0x02014b50, true);
    setU16(central, 4, 20, true);
    setU16(central, 6, 20, true);
    setU16(central, 8, 0x0800, true);
    setU16(central, 12, dosTime, true);
    setU16(central, 14, dosDate, true);
    setU32(central, 16, crc, true);
    setU32(central, 20, e.data.length, true);
    setU32(central, 24, e.data.length, true);
    setU16(central, 28, name.length, true);
    setU32(central, 42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length + e.data.length;
  }
  const dir = concat(centrals);
  const end = new Uint8Array(22);
  setU32(end, 0, 0x06054b50, true);
  setU16(end, 8, entries.length, true);
  setU16(end, 10, entries.length, true);
  setU32(end, 12, dir.length, true);
  setU32(end, 16, offset, true);
  return concat([...locals, dir, end]);
}
