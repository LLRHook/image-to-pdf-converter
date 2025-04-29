import React, { useState } from 'react';
import './FileUpload.css';

const FileUpload = () => {
  const [inputFormat, setInputFormat] = useState('');
  const [outputFormat, setOutputFormat] = useState('');
  const [file, setFile] = useState(null);

  // Group similar formats together
  const formatGroups = {
    'document': {
      label: 'Document Formats',
      formats: ['doc', 'docx', 'pdf', 'txt']
    },
    'spreadsheet': {
      label: 'Spreadsheet Formats',
      formats: ['xls', 'xlsx', 'csv', 'google-sheets']
    },
    'image': {
      label: 'Image Formats',
      formats: ['png', 'jpg', 'jpeg', 'pdf']
    }
  };

  const handleFileChange = (event) => {
    setFile(event.target.files[0]);
  };

  const handleConvert = () => {
    if (!file || !inputFormat || !outputFormat) {
      alert('Please select a file and both formats.');
      return;
    }
    // Placeholder for conversion logic
    alert(`Converting ${file.name} from ${inputFormat} to ${outputFormat}`);
  };

  // Get available output formats based on input format
  const getOutputFormats = () => {
    if (!inputFormat) return [];
    
    // Special case for PNG to PDF
    if (inputFormat === 'png') {
      return ['pdf'];
    }

    // For other formats, return formats from the same group
    for (const group of Object.values(formatGroups)) {
      if (group.formats.includes(inputFormat)) {
        return group.formats.filter(format => format !== inputFormat);
      }
    }
    return [];
  };

  return (
    <div className="file-upload">
      <h2>File Converter</h2>
      <div className="dropdowns">
        <label>
          Input Format:
          <select value={inputFormat} onChange={(e) => {
            setInputFormat(e.target.value);
            setOutputFormat(''); // Reset output format when input changes
          }}>
            <option value="">Select Format</option>
            {Object.entries(formatGroups).map(([key, group]) => (
              <optgroup key={key} label={group.label}>
                {group.formats.map(format => (
                  <option key={format} value={format}>{format.toUpperCase()}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          Output Format:
          <select 
            value={outputFormat} 
            onChange={(e) => setOutputFormat(e.target.value)}
            disabled={!inputFormat}
          >
            <option value="">Select Format</option>
            {getOutputFormats().map(format => (
              <option key={format} value={format}>{format.toUpperCase()}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="file-input">
        <input type="file" onChange={handleFileChange} />
      </div>
      <button onClick={handleConvert}>Convert</button>
    </div>
  );
};

export default FileUpload; 