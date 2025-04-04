import React, { useState } from 'react';
import FileUpload from './components/FileUpload';
import './App.css';

function App() {
  const [error, setError] = useState(null);
  const [isConverting, setIsConverting] = useState(false);
  const [pdfInfo, setPdfInfo] = useState(null);

  const handleConversionStart = () => {
    setIsConverting(true);
    setError(null);
    setPdfInfo(null);
  };

  const handleConversionComplete = (pdfUrl, filename) => {
    setIsConverting(false);
    setPdfInfo({ url: pdfUrl, filename });
  };

  const handleError = (errorMessage) => {
    setError(errorMessage);
    setIsConverting(false);
    setPdfInfo(null);
  };

  const handleDownload = () => {
    if (pdfInfo) {
      const link = document.createElement('a');
      link.href = pdfInfo.url;
      link.download = pdfInfo.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>Image to PDF Converter</h1>
        <p>Convert your images to PDF right in your browser</p>
      </header>
      
      <main className="App-main">
        {error && <div className="error-message">{error}</div>}
        
        <FileUpload
          onConversionStart={handleConversionStart}
          onConversionComplete={handleConversionComplete}
          onError={handleError}
        />
        
        {isConverting && (
          <div className="conversion-status">
            Converting your image...
          </div>
        )}

        {pdfInfo && (
          <div className="conversion-status">
            <p>Conversion complete!</p>
            <button
              onClick={handleDownload}
              className="download-button"
            >
              Download PDF
            </button>
          </div>
        )}
      </main>

      <footer className="App-footer">
        <p>All processing happens in your browser - no files are uploaded to any server</p>
      </footer>
    </div>
  );
}

export default App;
