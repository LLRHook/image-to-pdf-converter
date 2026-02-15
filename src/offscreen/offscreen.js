import { MSG } from '../shared/messaging';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === MSG.CONVERT_IMAGE) {
    handleImageConversion(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

async function handleImageConversion({ imageData, mimeType, outputFormat }) {
  const uint8Array = new Uint8Array(imageData);
  const blob = new Blob([uint8Array], { type: mimeType });
  const dataUrl = await blobToDataURL(blob);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const outMime = `image/${outputFormat === 'jpg' ? 'jpeg' : outputFormat}`;
      canvas.toBlob(
        async (convertedBlob) => {
          if (!convertedBlob) {
            reject(new Error('Canvas conversion failed'));
            return;
          }
          const buffer = await convertedBlob.arrayBuffer();
          resolve({ data: Array.from(new Uint8Array(buffer)) });
        },
        outMime,
        1.0
      );
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = dataUrl;
  });
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
