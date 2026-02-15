export async function spreadsheetToCsv(file) {
  const XLSX = await import('xlsx');
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const csv = XLSX.utils.sheet_to_csv(firstSheet);
  return new Blob([csv], { type: 'text/csv' });
}

export async function csvToSpreadsheet(file, outputFormat) {
  const XLSX = await import('xlsx');
  const text = await file.text();
  const workbook = XLSX.read(text, { type: 'string' });
  const buffer = XLSX.write(workbook, { bookType: outputFormat, type: 'array' });
  return new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
