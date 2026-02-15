import { imageToPdf } from '../conversion/imageToPdf';
import { MSG } from '../shared/messaging';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'convert-parent',
    title: 'Convert image to...',
    contexts: ['image'],
  });

  chrome.contextMenus.create({
    id: 'convert-pdf',
    parentId: 'convert-parent',
    title: 'PDF',
    contexts: ['image'],
  });

  chrome.contextMenus.create({
    id: 'convert-png',
    parentId: 'convert-parent',
    title: 'PNG',
    contexts: ['image'],
  });

  chrome.contextMenus.create({
    id: 'convert-jpg',
    parentId: 'convert-parent',
    title: 'JPG',
    contexts: ['image'],
  });
});

const FORMAT_MAP = {
  'convert-pdf': 'pdf',
  'convert-png': 'png',
  'convert-jpg': 'jpg',
};

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (!info.srcUrl) return;

  const outputFormat = FORMAT_MAP[info.menuItemId];
  if (!outputFormat) return;

  try {
    const response = await fetch(info.srcUrl);
    const blob = await response.blob();

    if (outputFormat === 'pdf') {
      const pdfBlob = await imageToPdf(blob);
      downloadBlob(pdfBlob, 'converted.pdf');
    } else {
      await ensureOffscreenDocument();
      const arrayBuffer = await blob.arrayBuffer();

      const result = await chrome.runtime.sendMessage({
        type: MSG.CONVERT_IMAGE,
        imageData: Array.from(new Uint8Array(arrayBuffer)),
        mimeType: blob.type,
        outputFormat,
      });

      if (result.error) {
        throw new Error(result.error);
      }

      const convertedBlob = new Blob(
        [new Uint8Array(result.data)],
        { type: `image/${outputFormat === 'jpg' ? 'jpeg' : outputFormat}` }
      );
      downloadBlob(convertedBlob, `converted.${outputFormat}`);
    }
  } catch (err) {
    console.error('Context menu conversion failed:', err);
  }
});

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    URL.revokeObjectURL(url);
  });
}

let creatingOffscreen;
async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length > 0) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['CANVAS'],
    justification: 'Image format conversion using Canvas API',
  });
  await creatingOffscreen;
  creatingOffscreen = null;
}
