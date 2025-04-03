// Default to development API URL
let API_BASE_URL = 'http://localhost:5000';

// If in production (GitHub Pages), use the production API URL
if (process.env.NODE_ENV === 'production') {
  // TODO: Replace this with your actual production backend URL once deployed
  API_BASE_URL = 'https://your-backend-url.com';
}

export const config = {
  API_BASE_URL,
  MAX_FILE_SIZE: 16 * 1024 * 1024, // 16MB in bytes
  SUPPORTED_FORMATS: ['.png', '.jpg', '.jpeg'],
  GITHUB_PAGES_BASE: process.env.PUBLIC_URL || '',
}; 