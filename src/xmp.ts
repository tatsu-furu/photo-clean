/** XMP（XML）の中の位置情報（exif:GPS…）を、長さを変えずに空白で消す。 */

const ATTR = /\s+[A-Za-z0-9_]+:GPS[A-Za-z]+\s*=\s*(?:"[^"]*"|'[^']*')/g;
const ELEMENT = /<([A-Za-z0-9_]+):GPS([A-Za-z]+)\b[^>]*>[\s\S]*?<\/\1:GPS\2\s*>/g;
const SELF = /<[A-Za-z0-9_]+:GPS[A-Za-z]+\b[^>]*\/>/g;
const ANY = /[A-Za-z0-9_]+:GPS[A-Za-z]+/;

const toLatin1 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
};

export function xmpHasGps(b: Uint8Array): boolean {
  return ANY.test(toLatin1(b));
}

/** その場で書き換える。変更があれば true。 */
export function scrubXmpGps(b: Uint8Array): boolean {
  const before = toLatin1(b);
  const blank = (m: string): string => ' '.repeat(m.length);
  const after = before.replace(ATTR, blank).replace(SELF, blank).replace(ELEMENT, blank);
  if (after === before) return false;
  for (let i = 0; i < after.length; i++) b[i] = after.charCodeAt(i);
  return true;
}
