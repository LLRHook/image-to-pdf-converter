import React, { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import axios from 'axios';
import { config } from '../config';
import './FileUpload.css';

const FileUpload = ({ onUploadSuccess, onError }) => {
  const [isUploading, setIsUploading] = useState(false);

  const onDrop = useCallback(async (acceptedFiles) => {
    if (acceptedFiles.length === 0) return;

    const file = acceptedFiles[0];
    const formData = new FormData();
    formData.append('file', file);

    setIsUploading(true);
    try {
      const response = await axios.post(`${config.API_BASE_URL}/api/upload`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        withCredentials: false,
        timeout: 10000, // 10 second timeout
      });
      onUploadSuccess(response.data.filename);
    } catch (error) {
      console.error('Upload error:', error);
      if (error.code === 'ECONNREFUSED') {
        onError('Could not connect to the server. Please ensure the backend server is running.');
      } else if (error.code === 'ETIMEDOUT') {
        onError('Connection timed out. Please try again.');
      } else {
        onError(error.response?.data?.error || 'Upload failed. Please try again.');
      }
    } finally {
      setIsUploading(false);
    }
  }, [onUploadSuccess, onError]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/*': config.SUPPORTED_FORMATS
    },
    maxFiles: 1,
    maxSize: config.MAX_FILE_SIZE
  });

  return (
    <div className="file-upload-container">
      <div
        {...getRootProps()}
        className={`dropzone ${isDragActive ? 'active' : ''} ${isUploading ? 'uploading' : ''}`}
      >
        <input {...getInputProps()} />
        {isUploading ? (
          <p>Uploading...</p>
        ) : isDragActive ? (
          <p>Drop the image here ...</p>
        ) : (
          <div>
            <p>Drag 'n' drop an image here, or click to select one</p>
            <p className="file-info">
              Supported formats: {config.SUPPORTED_FORMATS.join(', ')} (max {config.MAX_FILE_SIZE / 1024 / 1024}MB)
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default FileUpload; 