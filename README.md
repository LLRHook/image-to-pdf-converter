# Image to PDF Converter

A web application that converts images to PDF files, built with React and Flask.

## Project Structure

```
image-to-pdf-converter/
├── frontend/           # React application
│   ├── public/        # Static files
│   ├── src/          # React source code
│   └── package.json  # Frontend dependencies
└── backend/          # Flask application
    ├── app.py        # Flask application
    ├── image_to_pdf.py  # Image to PDF conversion logic
    └── requirements.txt # Backend dependencies
```

## Setup Instructions

### Backend Setup
1. Navigate to the backend directory:
   ```bash
   cd backend
   ```
2. Create a virtual environment:
   ```bash
   python -m venv venv
   ```
3. Activate the virtual environment:
   - Windows: `venv\Scripts\activate`
   - Unix/MacOS: `source venv/bin/activate`
4. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
5. Run the Flask server:
   ```bash
   python app.py
   ```

### Frontend Setup
1. Navigate to the frontend directory:
   ```bash
   cd frontend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the development server:
   ```bash
   npm start
   ```

## Development
- Backend runs on http://localhost:5000
- Frontend runs on http://localhost:3000

## License
MIT 