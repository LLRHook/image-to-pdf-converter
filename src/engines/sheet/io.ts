import type { EngineContext } from '../../core/types';

/** Read a Blob fully, reporting measured progress (bytes read / bytes total). */
export async function readBlob(blob: Blob, ctx: Pick<EngineContext, 'progress' | 'signal'>): Promise<Uint8Array> {
  const total = blob.size;
  const out = new Uint8Array(total);
  const reader = blob.stream().getReader();
  let at = 0;
  for (;;) {
    if (ctx.signal.aborted) throw new Error('Cancelled');
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value, at);
    at += value.byteLength;
    if (total > 0) ctx.progress(at / total);
  }
  if (at !== total) throw new Error('The file could not be read completely.');
  return out;
}

export interface DecodedText {
  text: string;
  encoding: string;
}

/**
 * Bytes -> text. BOMs are honoured (and stripped); otherwise UTF-8, falling
 * back to Windows-1252 for legacy Excel "ANSI" exports that are not valid UTF-8.
 */
export function decodeText(bytes: Uint8Array): DecodedText {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'UTF-8' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'UTF-16LE' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'UTF-16BE' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'Windows-1252' };
  }
}
