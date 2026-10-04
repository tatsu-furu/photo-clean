export const ascii = (b: Uint8Array, start: number, len: number): string => {
  let s = '';
  for (let i = start; i < start + len && i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
};

export const startsWith = (b: Uint8Array, off: number, text: string): boolean => ascii(b, off, text.length) === text;

export const u16 = (b: Uint8Array, o: number, le: boolean): number => (le ? b[o]! | (b[o + 1]! << 8) : (b[o]! << 8) | b[o + 1]!);

export const u32 = (b: Uint8Array, o: number, le: boolean): number =>
  (le
    ? b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)
    : (b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

export function setU16(b: Uint8Array, o: number, v: number, le: boolean): void {
  if (le) { b[o] = v & 255; b[o + 1] = (v >> 8) & 255; } else { b[o] = (v >> 8) & 255; b[o + 1] = v & 255; }
}

export function setU32(b: Uint8Array, o: number, v: number, le: boolean): void {
  if (le) { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; }
  else { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; }
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const bytesOf = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0) & 255);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(b: Uint8Array, init = 0): number {
  let c = ~init >>> 0;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 255]! ^ (c >>> 8);
  return ~c >>> 0;
}
