import { MAX_FILE_SIZE } from './constants.js';
import { validateFile } from './validation.js';

export async function fetchImage(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Failed to fetch image (HTTP ${response.status})`);
  }
  if (Number(response.headers.get('content-length')) > MAX_FILE_SIZE) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Files must be 16 MB or smaller');
  }
  if (!response.body) throw new Error('The image response is empty');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_SIZE) throw new Error('Files must be 16 MB or smaller');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const blob = new Blob(chunks, { type: response.headers.get('content-type') || '' });
  validateFile(blob);
  return blob;
}
