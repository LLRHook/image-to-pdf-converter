# Image to PDF Converter

A web-based tool that converts images to PDF files directly in your browser. No server required - all processing happens locally on your device!

## Features

- Convert images (PNG, JPEG) to PDF
- Client-side processing - no files are uploaded to any server
- Maintains image aspect ratio and quality
- Automatic image compression for large files
- Mobile-friendly interface
- Drag and drop support
- Works offline once loaded

## Live Demo

Visit [https://LLRHook.github.io/image-to-pdf-converter](https://LLRHook.github.io/image-to-pdf-converter)

## How It Works

1. Select or drag & drop an image
2. The image is processed entirely in your browser:
   - Large images are automatically compressed
   - The image is converted to PDF format
   - The PDF is centered and scaled to fit the page
3. Download your converted PDF

## Technical Details

- Built with React for the frontend
- Uses `pdf-lib` for PDF generation
- Uses `browser-image-compression` for handling large images
- All processing happens client-side for privacy and speed

## Development Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/LLRHook/image-to-pdf-converter.git
   cd image-to-pdf-converter
   ```

2. Install dependencies:
   ```bash
   cd frontend
   npm install
   ```

3. Start the development server:
   ```bash
   npm start
   ```

4. Open [http://localhost:3000](http://localhost:3000) in your browser

## Building for Production

1. Build the project:
   ```bash
   cd frontend
   npm run build
   ```

2. The build files will be in the `frontend/build` directory

## Deployment

This project is configured for GitHub Pages deployment. To deploy:

1. Update the `homepage` field in `frontend/package.json` with your GitHub Pages URL
2. Push your changes to GitHub
3. GitHub Actions will automatically build and deploy your site

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Privacy

This application processes all files locally in your web browser. No images or data are ever uploaded to any server.

## License

MIT License - feel free to use this project for personal or commercial purposes.

## Support

If you encounter any issues or have questions, please open an issue on GitHub. 