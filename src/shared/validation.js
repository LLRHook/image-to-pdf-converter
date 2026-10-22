import { MAX_FILE_SIZE, MAX_IMAGE_PIXELS, MAX_IMAGE_DIMENSION } from './constants.js';

export function validateFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function' || !Number.isFinite(file.size) || file.size < 0) {
    throw new Error('Select a valid file to convert');
  }
  if (file.size === 0) throw new Error('The selected file is empty');
  if (file.size > MAX_FILE_SIZE) throw new Error('Files must be 16 MB or smaller');
}

export function validateImageDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('The image has invalid dimensions');
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
    throw new Error('Image is too large: use at most 32 megapixels and 16384 pixels per side');
  }
}
