import React, { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { convertImageToPDF } from '../utils/pdfConverter';
import './FileUpload.css';

const FileUpload = ({ onConversionStart, onConversionComplete, onError }) => {
  const [isConverting, setIsConverting] = useState(false);

  const onDrop = useCallback(async (acceptedFiles) => {
    if (acceptedFiles.length === 0) return;

    const file = acceptedFiles[0];
    setIsConverting(true);
    onConversionStart();

    try {
      const pdfBlob = await convertImageToPDF(file);
      
      // Create a download URL for the PDF
      const pdfUrl = URL.createObjectURL(pdfBlob);
      onConversionComplete(pdfUrl, `converted-${file.name.split('.')[0]}.pdf`);
    } catch (error) {
      console.error('Conversion error:', error);
      onError(error.message || 'Failed to convert image to PDF');
    } finally {
      setIsConverting(false);
    }
  }, [onConversionStart, onConversionComplete, onError]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/*': ['.png', '.jpg', '.jpeg']
    },
    maxFiles: 1,
    maxSize: 50 * 1024 * 1024 // 50MB max file size
  });

  return (
    <div className="file-upload-container">
      <div
        {...getRootProps()}
        className={`dropzone ${isDragActive ? 'active' : ''} ${isConverting ? 'converting' : ''}`}
      >
        <input {...getInputProps()} />
        {isConverting ? (
          <p>Converting image to PDF...</p>
        ) : isDragActive ? (
          <p>Drop the image here ...</p>
        ) : (
          <div>
            <p>Drag 'n' drop an image here, or click to select one</p>
            <p className="file-info">
              Supported formats: PNG, JPG, JPEG (max 50MB)
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default FileUpload; 