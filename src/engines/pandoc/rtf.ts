/**
 * pandoc 3.10's RTF reader drops the character that directly follows a
 * `\uN?` escape (`႐?,` reads as "т" without the comma), which corrupts
 * punctuation in every non-ASCII RTF Word writes. Adding a space after the
 * fallback character makes the reader eat the space instead; RTF treats it as
 * the harmless delimiter it is.
 */
export function fixRtfUnicodeSkip(bytes: Uint8Array): Uint8Array {
  const BACKSLASH = 0x5c;
  const parts: Uint8Array[] = [];
  const SPACE = new Uint8Array([0x20]);
  let last = 0;
  const n = bytes.length;
  for (let i = 0; i < n - 3; i++) {
    if (bytes[i] !== BACKSLASH || bytes[i + 1] !== 0x75 /* u */) continue;
    let j = i + 2;
    if (bytes[j] === 0x2d /* - */) j++;
    const digitsStart = j;
    while (j < n && bytes[j]! >= 0x30 && bytes[j]! <= 0x39) j++;
    if (j > digitsStart && bytes[j] === 0x3f /* ? */) {
      parts.push(bytes.subarray(last, j + 1), SPACE);
      last = j + 1;
      i = j;
    }
  }
  if (last === 0) return bytes;
  parts.push(bytes.subarray(last));
  const out = new Uint8Array(parts.reduce((len, p) => len + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
