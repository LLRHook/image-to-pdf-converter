import React from 'react';
import FileUpload from './components/FileUpload';

export default function App() {
  return (
    <div className="w-[380px] bg-gray-900 text-white">
      <div className="p-4">
        <h1 className="text-lg font-bold text-center mb-4">File Converter</h1>
        <FileUpload />
      </div>
    </div>
  );
}
