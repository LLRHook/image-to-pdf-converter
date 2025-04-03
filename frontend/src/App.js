import React, { useState } from 'react';
import FileUpload from './components/FileUpload';
import ConversionStatus from './components/ConversionStatus';
import './App.css';

function App() {
  const [uploadedFilename, setUploadedFilename] = useState(null);
  const [error, setError] = useState(null);

  const handleUploadSuccess = (filename) => {
    setUploadedFilename(filename);
    setError(null);
  };

  const handleError = (errorMessage) => {
    setError(errorMessage);
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>Image to PDF Converter</h1>
        <p>Upload an image and convert it to PDF</p>
      </header>
      
      <main className="App-main">
        {error && <div className="global-error">{error}</div>}
        
        <FileUpload
          onUploadSuccess={handleUploadSuccess}
          onError={handleError}
        />
        
        {uploadedFilename && (
          <ConversionStatus
            filename={uploadedFilename}
            onError={handleError}
          />
        )}
      </main>
    </div>
  );
}

export default App;
