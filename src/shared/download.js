import { MSG } from './messaging.js';

export function outputFilename(name, format) {
  const stem = name.replace(/\.[^.]*$/, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
  return `${stem || 'converted'}.${format}`;
}

export async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
    try {
      const result = await chrome.runtime.sendMessage({ target: 'background', type: MSG.DOWNLOAD_BLOB, url, filename });
      if (result?.error) throw new Error(result.error);
      if (!Number.isInteger(result?.downloadId)) throw new Error('The download could not be started');
    } finally {
      URL.revokeObjectURL(url);
    }
  } else {
    const anchor = document.createElement('a');
    try {
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
    } finally {
      anchor.remove();
      // Give the browser time to consume the URL after the click event.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
}
