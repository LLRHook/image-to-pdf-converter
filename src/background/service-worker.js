import { MSG } from '../shared/messaging.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'convert-parent', title: 'Convert image to...', contexts: ['image'] });
  for (const [format, title] of Object.entries({ pdf: 'PDF', png: 'PNG', jpg: 'JPG' })) {
    chrome.contextMenus.create({
      id: `convert-${format}`, parentId: 'convert-parent', title, contexts: ['image'],
    });
  }
});

const FORMAT_MAP = { 'convert-pdf': 'pdf', 'convert-png': 'png', 'convert-jpg': 'jpg' };

chrome.contextMenus.onClicked.addListener(async (info) => {
  const outputFormat = FORMAT_MAP[info.menuItemId];
  if (!info.srcUrl || !outputFormat) return;
  try {
    await startDownload({
      type: MSG.CONVERT_IMAGE,
      srcUrl: info.srcUrl,
      outputFormat,
      filename: `converted.${outputFormat}`,
    });
  } catch (error) {
    console.error('Context menu conversion failed:', error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.target !== 'background' || message.type !== MSG.DOWNLOAD_BLOB) return;
  startDownload(message)
    .then((downloadId) => sendResponse({ downloadId }))
    .catch((error) => sendResponse({ error: error.message }));
  return true;
});

async function releaseDownload(url) {
  await chrome.runtime.sendMessage({ target: 'offscreen', type: MSG.RELEASE_DOWNLOAD, url });
}

// Search the item rather than retaining an in-memory id-to-URL map: the service
// worker may restart while a save dialog or a download is still in progress.
chrome.downloads.onChanged.addListener(async ({ id, state }) => {
  if (!['complete', 'interrupted'].includes(state?.current)) return;
  try {
    const [item] = await chrome.downloads.search({ id });
    if (item?.byExtensionId === chrome.runtime.id && item.url.startsWith('blob:')) {
      await releaseDownload(item.url);
    }
  } catch (error) {
    console.error('Download resource cleanup failed:', error);
  }
});

async function startDownload(message) {
  await ensureOffscreenDocument();
  const result = await chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
  if (result?.error) throw new Error(result.error);
  if (!result?.url?.startsWith('blob:')) throw new Error('No converted file was returned');
  try {
    return await chrome.downloads.download({ url: result.url, filename: message.filename, saveAs: true });
  } catch (error) {
    await releaseDownload(result.url).catch(() => {});
    throw error;
  }
}

let creatingOffscreen;
async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length > 0) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Convert images and own blob URLs until downloads finish',
    });
  }
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}
