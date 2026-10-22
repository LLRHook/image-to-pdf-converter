import { validateFile, validateImageDimensions } from '../shared/validation.js';
import { isPng, preparePng } from './png.js';

export async function imageToImage(file, outputFormat) {
  if (!['png', 'jpg', 'jpeg'].includes(outputFormat)) {
    throw new Error(`Image output format ${outputFormat || '(missing)'} is not supported`);
  }
  validateFile(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Bound PNG decoding before the browser allocates its pixel buffers.
  if (isPng(bytes)) await preparePng(bytes);

  const url = URL.createObjectURL(file);
  let img;
  let canvas;
  try {
    img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Failed to load image: the file may be damaged or unsupported'));
      img.src = url;
    });
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    validateImageDimensions(width, height);

    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Unable to create an image conversion canvas');
    const mimeType = outputFormat === 'png' ? 'image/png' : 'image/jpeg';
    if (mimeType === 'image/jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(img, 0, 0);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob || blob.type !== mimeType) reject(new Error('Canvas conversion failed for the selected format'));
        else resolve(blob);
      }, mimeType, 1.0);
    });
  } finally {
    if (img) {
      img.onload = null;
      img.onerror = null;
      img.removeAttribute('src');
    }
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    URL.revokeObjectURL(url);
  }
}
