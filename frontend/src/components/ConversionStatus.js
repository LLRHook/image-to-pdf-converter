import React, { useState } from 'react';
import axios from 'axios';
import { config } from '../config';
import './ConversionStatus.css';

const ConversionStatus = ({ filename, onError }) => {
  const [isConverting, setIsConverting] = useState(false);
  const [pdfFilename, setPdfFilename] = useState(null);
  const [error, setError] = useState(null);

  const handleConvert = async () => {
    setIsConverting(true);
    setError(null);
    try {
      const response = await axios.post(`${config.API_BASE_URL}/api/convert`, {
        filename: filename
      }, {
        timeout: 30000, // 30 second timeout for conversion
        withCredentials: false
      });
      setPdfFilename(response.data.pdf_filename);
    } catch (error) {
      console.error('Conversion error:', error);
      if (error.code === 'ECONNREFUSED') {
        const errorMsg = 'Could not connect to the server. Please ensure the backend server is running.';
        setError(errorMsg);
        onError(errorMsg);
      } else if (error.code === 'ETIMEDOUT') {
        const errorMsg = 'Conversion timed out. Please try again with a smaller image.';
        setError(errorMsg);
        onError(errorMsg);
      } else {
        const errorMsg = error.response?.data?.error || 'Conversion failed. Please try again.';
        setError(errorMsg);
        onError(errorMsg);
      }
    } finally {
      setIsConverting(false);
    }
  };

  const handleDownload = async () => {
    if (pdfFilename) {
      try {
        const response = await axios.get(`${config.API_BASE_URL}/api/download/${pdfFilename}`, {
          responseType: 'blob',
          timeout: 10000,
          withCredentials: false
        });
        
        const url = window.URL.createObjectURL(new Blob([response.data]));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', `converted-${pdfFilename}`);
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(url);
      } catch (error) {
        console.error('Download error:', error);
        const errorMsg = 'Failed to download the PDF. Please try again.';
        setError(errorMsg);
        onError(errorMsg);
      }
    }
  };

  return (
    <div className="conversion-status">
      {error && <div className="error-message">{error}</div>}
      
      <button
        onClick={handleConvert}
        disabled={isConverting || !filename}
        className="convert-button"
      >
        {isConverting ? 'Converting...' : 'Convert to PDF'}
      </button>

      {pdfFilename && (
        <button
          onClick={handleDownload}
          className="download-button"
        >
          Download PDF
        </button>
      )}
    </div>
  );
};

export default ConversionStatus; 