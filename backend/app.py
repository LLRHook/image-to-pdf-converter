from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
import os
from werkzeug.utils import secure_filename
from image_to_pdf import convert_image_to_pdf
import uuid
import logging

# Configure logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "http://localhost:3000"}})

# Configuration
UPLOAD_FOLDER = 'uploads'
OUTPUT_FOLDER = 'outputs'
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg'}

# Create necessary directories
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['OUTPUT_FOLDER'] = OUTPUT_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB max file size

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

@app.route('/api/health', methods=['GET'])
def health_check():
    return jsonify({"status": "healthy"})

@app.route('/api/upload', methods=['POST'])
def upload_file():
    logger.debug('Upload endpoint called')
    if 'file' not in request.files:
        logger.error('No file part in request')
        return jsonify({"error": "No file part"}), 400
    
    file = request.files['file']
    if file.filename == '':
        logger.error('No selected file')
        return jsonify({"error": "No selected file"}), 400
    
    if file and allowed_file(file.filename):
        # Generate unique filename
        unique_id = str(uuid.uuid4())
        filename = secure_filename(file.filename)
        file_extension = filename.rsplit('.', 1)[1].lower()
        new_filename = f"{unique_id}.{file_extension}"
        
        # Save the file
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], new_filename)
        file.save(file_path)
        logger.info(f'File saved successfully: {new_filename}')
        
        return jsonify({
            "message": "File uploaded successfully",
            "filename": new_filename
        }), 200
    
    logger.error('File type not allowed')
    return jsonify({"error": "File type not allowed"}), 400

@app.route('/api/convert', methods=['POST'])
def convert_to_pdf():
    logger.debug('Convert endpoint called')
    data = request.get_json()
    if not data or 'filename' not in data:
        logger.error('No filename provided')
        return jsonify({"error": "No filename provided"}), 400
    
    filename = data['filename']
    input_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    
    if not os.path.exists(input_path):
        logger.error(f'File not found: {filename}')
        return jsonify({"error": "File not found"}), 404
    
    # Generate output filename
    output_filename = f"{os.path.splitext(filename)[0]}.pdf"
    output_path = os.path.join(app.config['OUTPUT_FOLDER'], output_filename)
    
    try:
        convert_image_to_pdf(input_path, output_path)
        logger.info(f'Conversion successful: {output_filename}')
        return jsonify({
            "message": "Conversion successful",
            "pdf_filename": output_filename
        }), 200
    except Exception as e:
        logger.error(f'Conversion failed: {str(e)}')
        return jsonify({"error": str(e)}), 500

@app.route('/api/download/<filename>', methods=['GET'])
def download_pdf(filename):
    logger.debug(f'Download endpoint called for file: {filename}')
    file_path = os.path.join(app.config['OUTPUT_FOLDER'], filename)
    if not os.path.exists(file_path):
        logger.error(f'File not found: {filename}')
        return jsonify({"error": "File not found"}), 404
    
    return send_file(file_path, as_attachment=True)

if __name__ == '__main__':
    logger.info('Starting Flask server...')
    app.run(debug=True, host='0.0.0.0', port=5000) 