import React, { useState, useCallback } from 'react';
import { convert } from '../../conversion';
import { FORMAT_GROUPS, getOutputFormats } from '../../shared/constants';

export default function FileUpload() {
  const [file, setFile] = useState(null);
  const [inputFormat, setInputFormat] = useState('');
  const [outputFormat, setOutputFormat] = useState('');
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  const handleFile = useCallback((selectedFile) => {
    if (!selectedFile) return;
    setFile(selectedFile);
    const ext = selectedFile.name.split('.').pop().toLowerCase();
    setInputFormat(ext);
    setOutputFormat('');
    setStatus(null);
    setError('');
  }, []);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      setIsDragging(false);
      handleFile(e.dataTransfer.files[0]);
    },
    [handleFile]
  );

  const handleConvert = async () => {
    if (!file || !inputFormat || !outputFormat) return;

    setStatus('converting');
    setError('');

    try {
      const blob = await convert(file, inputFormat, outputFormat);
      const filename = `${file.name.split('.')[0]}.${outputFormat}`;

      if (typeof chrome !== 'undefined' && chrome.downloads) {
        const url = URL.createObjectURL(blob);
        chrome.downloads.download({ url, filename, saveAs: true });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      }

      setStatus('done');
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  };

  const availableOutputFormats = getOutputFormats(inputFormat);

  return (
    <div className="space-y-4">
      {/* Drop zone */}
      <div
        className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
          isDragging
            ? 'border-blue-400 bg-blue-900/20'
            : 'border-gray-600 hover:border-gray-400'
        }`}
        onDragEnter={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setIsDragging(false);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        onClick={() => document.getElementById('file-input').click()}
      >
        <input
          id="file-input"
          type="file"
          className="hidden"
          onChange={(e) => handleFile(e.target.files[0])}
        />
        <svg
          className="mx-auto h-8 w-8 text-gray-400 mb-2"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
          />
        </svg>
        <p className="text-sm text-gray-300">
          {file ? file.name : 'Drop a file or click to upload'}
        </p>
      </div>

      {/* Format selectors */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">
            From
          </label>
          <select
            value={inputFormat}
            onChange={(e) => {
              setInputFormat(e.target.value);
              setOutputFormat('');
            }}
            className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-sm text-white focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="">Select</option>
            {Object.entries(FORMAT_GROUPS).map(([key, group]) => (
              <optgroup key={key} label={group.label}>
                {group.formats.map((fmt) => (
                  <option key={fmt} value={fmt}>
                    {fmt.toUpperCase()}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">
            To
          </label>
          <select
            value={outputFormat}
            onChange={(e) => setOutputFormat(e.target.value)}
            disabled={!inputFormat}
            className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-sm text-white focus:ring-1 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
          >
            <option value="">Select</option>
            {availableOutputFormats.map((fmt) => (
              <option key={fmt} value={fmt}>
                {fmt.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Convert button */}
      <button
        onClick={handleConvert}
        disabled={!file || !inputFormat || !outputFormat || status === 'converting'}
        className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded text-sm font-medium transition-colors"
      >
        {status === 'converting' ? (
          <span className="flex items-center justify-center gap-2">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            Converting...
          </span>
        ) : (
          'Convert'
        )}
      </button>

      {/* Status */}
      {status === 'done' && (
        <p className="text-sm text-green-400 text-center">
          Conversion complete! Check your downloads.
        </p>
      )}
      {status === 'error' && (
        <p className="text-sm text-red-400 text-center">{error}</p>
      )}
    </div>
  );
}
