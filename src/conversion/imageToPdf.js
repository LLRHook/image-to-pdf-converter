import { PDFDocument } from 'pdf-lib';

export async function imageToPdf(file) {
  const arrayBuffer = await file.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);

  const pdfDoc = await PDFDocument.create();

  const type = file.type || inferMimeType(file.name);
  let image;
  if (type === 'image/jpeg' || type === 'image/jpg') {
    image = await pdfDoc.embedJpg(uint8Array);
  } else if (type === 'image/png') {
    image = await pdfDoc.embedPng(uint8Array);
  } else {
    throw new Error(`Unsupported image type: ${type}`);
  }

  const { width, height } = image.scale(1);
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

function inferMimeType(filename) {
  if (!filename) return 'application/octet-stream';
  const ext = filename.split('.').pop().toLowerCase();
  const types = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
  return types[ext] || 'application/octet-stream';
}
