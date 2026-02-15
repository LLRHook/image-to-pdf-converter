import { imageToPdf } from './imageToPdf';
import { imageToImage } from './imageToImage';
import { textToPdf } from './textToPdf';
import { docxToPdf } from './docxToPdf';
import { spreadsheetToCsv, csvToSpreadsheet } from './spreadsheet';

export async function convert(file, inputFormat, outputFormat) {
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
