import { PDFDocument } from 'pdf-lib';
import { validateFile, validateImageDimensions } from '../shared/validation.js';
import { isPng, preparePng } from './png.js';

export async function imageToPdf(file) {
  validateFile(file);
  const arrayBuffer = await file.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);

  const pdfDoc = await PDFDocument.create();

  let image;
  if (isPng(uint8Array)) {
    const png = await preparePng(uint8Array);
    try {
      image = await pdfDoc.embedPng(png);
    } catch {
      throw new Error('Invalid or corrupted PNG image');
    }
  } else if (uint8Array[0] === 0xff && uint8Array[1] === 0xd8) {
    try {
      image = await pdfDoc.embedJpg(uint8Array);
    } catch {
      throw new Error('Invalid or corrupted JPEG image');
    }
  } else {
    throw new Error('Unsupported image data: use a PNG or JPEG image');
  }

  const { width, height } = image.scale(1);
  validateImageDimensions(width, height);
  const maxWidth = 595; // A4 width in points
  const maxHeight = 842; // A4 height in points
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  const pageWidth = width * scale;
  const pageHeight = height * scale;

  const page = pdfDoc.addPage([pageWidth, pageHeight]);
  page.drawImage(image, {
    x: 0,
    y: 0,
    width: pageWidth,
    height: pageHeight,
  });

  const pdfBytes = await pdfDoc.save();
  return new Blob([pdfBytes], { type: 'application/pdf' });
}
