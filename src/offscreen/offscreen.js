import { MSG } from '../shared/messaging.js';
import { fetchImage } from '../shared/fetchImage.js';
import { imageToImage } from '../conversion/imageToImage.js';
import { imageToPdf } from '../conversion/imageToPdf.js';

const downloadUrls = new Set();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.target !== 'offscreen') return;
  if (message.type === MSG.RELEASE_DOWNLOAD) {
    if (downloadUrls.delete(message.url)) URL.revokeObjectURL(message.url);
    sendResponse({ released: true });
    return;
  }
  if (![MSG.CONVERT_IMAGE, MSG.DOWNLOAD_BLOB].includes(message.type)) return;
  prepareDownload(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message }));
  return true;
});

async function prepareDownload(message) {
  let blob;
  if (message.type === MSG.DOWNLOAD_BLOB) {
    // Copy into the offscreen document so closing the popup cannot invalidate
    // a download that is still waiting for the save dialog or disk write.
    if (!message.url?.startsWith(`blob:${chrome.runtime.getURL('')}`)) {
      throw new Error('Invalid download source');
    }
    const response = await fetch(message.url);
    if (!response.ok) throw new Error('Failed to read converted file');
    blob = await response.blob();
  } else {
    if (!['pdf', 'png', 'jpg', 'jpeg'].includes(message.outputFormat)) {
      throw new Error('The selected image output format is not supported');
    }
    const image = await fetchImage(message.srcUrl);
    blob = message.outputFormat === 'pdf'
      ? await imageToPdf(image)
      : await imageToImage(image, message.outputFormat);
  }
  const url = URL.createObjectURL(blob);
  downloadUrls.add(url);
  return { url };
}
