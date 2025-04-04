import { PDFDocument } from 'pdf-lib';
import imageCompression from 'browser-image-compression';

export async function convertImageToPDF(imageFile) {
  try {
    // Compress the image if it's too large
    const compressedFile = await imageCompression(imageFile, {
      maxSizeMB: 1,
      maxWidthOrHeight: 2048,
      useWebWorker: true
    });

    // Convert the compressed image to a base64 string
    const reader = new FileReader();
    const imageDataPromise = new Promise((resolve, reject) => {
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(compressedFile);
    });
    const imageData = await imageDataPromise;

    // Create a new PDF document
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([612, 792]); // Standard US Letter size

    // Embed the image
    let image;
    if (imageFile.type === 'image/jpeg') {
      image = await pdfDoc.embedJpg(imageData);
    } else if (imageFile.type === 'image/png') {
      image = await pdfDoc.embedPng(imageData);
    } else {
      throw new Error('Unsupported image format');
    }

    // Calculate dimensions to fit the page while maintaining aspect ratio
    const { width, height } = image.scale(1);
    const pageWidth = page.getWidth();
    const pageHeight = page.getHeight();
    
    const scale = Math.min(
      pageWidth / width,
      pageHeight / height
    );

    const scaledWidth = width * scale;
    const scaledHeight = height * scale;

    // Center the image on the page
    const x = (pageWidth - scaledWidth) / 2;
    const y = (pageHeight - scaledHeight) / 2;

    // Draw the image
    page.drawImage(image, {
      x,
      y,
      width: scaledWidth,
      height: scaledHeight,
    });

    // Save the PDF
    const pdfBytes = await pdfDoc.save();
    return new Blob([pdfBytes], { type: 'application/pdf' });
  } catch (error) {
    console.error('Error converting image to PDF:', error);
    throw error;
  }
} 