import os
from PIL import Image
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
import argparse

def convert_image_to_pdf(image_path, output_path=None):
    """
    Convert a single image to PDF.
    
    Args:
        image_path (str): Path to the input image
        output_path (str, optional): Path for the output PDF. If not provided,
                will use the same name as input with .pdf extension
    """
    # If no output path is specified, create one from the input path
    if output_path is None:
        output_path = os.path.splitext(image_path)[0] + '.pdf'
    
    # Open the image
    img = Image.open(image_path)
    
    # Get image dimensions
    img_width, img_height = img.size
    
    # Create PDF
    c = canvas.Canvas(output_path, pagesize=letter)
    
    # Calculate scaling to fit the image on the page
    page_width, page_height = letter
    scale = min(page_width/img_width, page_height/img_height)
    
    # Calculate position to center the image
    x = (page_width - img_width * scale) / 2
    y = (page_height - img_height * scale) / 2
    
    # Draw the image
    c.drawImage(image_path, x, y, width=img_width * scale, height=img_height * scale)
    c.save()
    
    print(f"Successfully converted {image_path} to {output_path}")

def main():
    parser = argparse.ArgumentParser(description='Convert image to PDF')
    parser.add_argument('image_path', help='Path to the input image')
    parser.add_argument('--output', '-o', help='Path for the output PDF (optional)')
    
    args = parser.parse_args()
    
    if not os.path.exists(args.image_path):
        print(f"Error: Image file '{args.image_path}' does not exist.")
        return
    
    convert_image_to_pdf(args.image_path, args.output)

if __name__ == '__main__':
    main() 