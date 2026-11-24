/**
 * Cheap structural checks on the input before any wasm is downloaded: is it
 * really the format it claims, and is a ZIP container free of obvious bombs.
 * Only the ZIP central directory is read; nothing is inflated.
 */
import { unzipSync } from 'fflate';
import type { FormatId } from '../../core/formats';
import { LIMITS, formatBytes } from './limits';

const ZIP_MAGIC = [0x50, 0x4b];

export interface ZipListing {
  names: string[];
  totalBytes: number;
}

export function listZip(bytes: Uint8Array): ZipListing {
  const names: string[] = [];
  let total = 0;
  let tooBig: string | undefined;
  try {
    unzipSync(bytes, {
      filter(f) {
        names.push(f.name);
        total += f.originalSize;
        if (f.originalSize > LIMITS.zipEntryBytes) tooBig ??= f.name;
        if (names.length > LIMITS.zipEntries) throw new Error('zip-entries');
        return false;
      },
    });
  } catch (e) {
    if ((e as Error).message === 'zip-entries') {
      throw new Error(`This file contains more than ${LIMITS.zipEntries.toLocaleString('en')} parts, which is more than this tool will unpack.`);
    }
    throw new Error('This file is not a valid ZIP-based document (it may be damaged or a different format).');
  }
  if (tooBig) throw new Error(`"${tooBig}" inside this file expands beyond ${formatBytes(LIMITS.zipEntryBytes)}; refusing to unpack it.`);
  if (total > LIMITS.zipUncompressedBytes) {
    throw new Error(`This file expands to ${formatBytes(total)} when unpacked, above the ${formatBytes(LIMITS.zipUncompressedBytes)} limit.`);
  }
  return { names, totalBytes: total };
}

function startsWithRtf(bytes: Uint8Array): boolean {
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length && i < 64 && (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x09)) i++;
  const head = new TextDecoder('latin1').decode(bytes.subarray(i, i + 5));
  return head === '{\\rtf';
}

/** Throws a user-readable error when `bytes` clearly is not `format`. */
export function assertContainer(format: FormatId, bytes: Uint8Array): void {
  if (bytes.length === 0) throw new Error('This file is empty.');
  switch (format) {
    case 'docx': {
      requireZip(bytes, 'DOCX');
      const { names } = listZip(bytes);
      if (!names.includes('word/document.xml') && !names.some((n) => /^word\/document[^/]*\.xml$/.test(n))) {
        throw new Error('This ZIP file is not a Word document (word/document.xml is missing).');
      }
      return;
    }
    case 'odt': {
      requireZip(bytes, 'ODT');
      const { names } = listZip(bytes);
      if (!names.includes('content.xml')) throw new Error('This ZIP file is not an OpenDocument file (content.xml is missing).');
      return;
    }
    case 'epub': {
      requireZip(bytes, 'EPUB');
      const { names } = listZip(bytes);
      if (!names.includes('META-INF/container.xml')) throw new Error('This ZIP file is not an EPUB (META-INF/container.xml is missing).');
      return;
    }
    case 'rtf':
      if (!startsWithRtf(bytes)) throw new Error('This file is not RTF: it does not start with "{\\rtf".');
      return;
    default:
  }
}

function requireZip(bytes: Uint8Array, label: string): void {
  if (bytes[0] !== ZIP_MAGIC[0] || bytes[1] !== ZIP_MAGIC[1]) {
    throw new Error(`This file is not a ${label} document: it is not a ZIP container. Old binary formats such as .doc are not supported.`);
  }
}
