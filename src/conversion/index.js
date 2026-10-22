import { imageToPdf } from './imageToPdf.js';
import { imageToImage } from './imageToImage.js';
import { textToPdf } from './textToPdf.js';
import { docxToPdf } from './docxToPdf.js';
import { spreadsheetToCsv, csvToSpreadsheet } from './spreadsheet.js';
import { validateFile } from '../shared/validation.js';

export async function convert(file, inputFormat, outputFormat) {
  validateFile(file);
  if (typeof inputFormat !== 'string' || typeof outputFormat !== 'string' || !inputFormat || !outputFormat) {
    throw new Error('Select both input and output formats');
  }
  if (['png', 'jpg', 'jpeg'].includes(inputFormat) && outputFormat === 'pdf') {
    return imageToPdf(file);
  }

  if (['png', 'jpg', 'jpeg'].includes(inputFormat) && ['png', 'jpg', 'jpeg'].includes(outputFormat)) {
    return imageToImage(file, outputFormat);
  }

  if (inputFormat === 'txt' && outputFormat === 'pdf') {
    return textToPdf(file);
  }

  if (inputFormat === 'docx' && outputFormat === 'pdf') {
    return docxToPdf(file);
  }

  if (['xlsx', 'xls', 'csv'].includes(inputFormat) && outputFormat === 'csv') {
    return spreadsheetToCsv(file);
  }

  if (inputFormat === 'csv' && ['xlsx', 'xls'].includes(outputFormat)) {
    return csvToSpreadsheet(file, outputFormat);
  }

  throw new Error(`Conversion from ${inputFormat.toUpperCase()} to ${outputFormat.toUpperCase()} is not supported`);
}
