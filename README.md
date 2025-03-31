# Image to PDF Converter

A simple Python script that converts images (PNG, JPEG, etc.) to PDF format.

## Features

- Converts single images to PDF
- Maintains image aspect ratio
- Centers the image on the page
- Supports various image formats (PNG, JPEG, etc.)
- Command-line interface for easy use

## Installation

1. Make sure you have Python 3.6 or higher installed
2. Install the required dependencies:
   ```bash
   pip install -r requirements.txt
   ```

## Usage

Basic usage:
```bash
python image_to_pdf.py path/to/your/image.jpg
```

Specify custom output path:
```bash
python image_to_pdf.py path/to/your/image.jpg -o output.pdf
```

## Supported Image Formats

- PNG
- JPEG/JPG
- BMP
- TIFF
- And other formats supported by Pillow library

## Requirements

- Python 3.6+
- Pillow
- reportlab 