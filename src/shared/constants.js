export const MAX_FILE_SIZE = 16 * 1024 * 1024; // 16 MB

export const FORMAT_GROUPS = {
  document: {
    label: 'Documents',
    formats: ['txt', 'docx'],
  },
  spreadsheet: {
    label: 'Spreadsheets',
    formats: ['xlsx', 'csv'],
  },
  image: {
    label: 'Images',
    formats: ['png', 'jpg', 'jpeg'],
  },
};

export function getOutputFormats(inputFormat) {
  if (!inputFormat) return [];

  if (['png', 'jpg', 'jpeg'].includes(inputFormat)) {
    return ['png', 'jpg', 'jpeg', 'pdf'].filter((f) => f !== inputFormat);
  }

  if (['txt', 'docx'].includes(inputFormat)) {
    return ['pdf'];
  }

  if (['xlsx', 'xls'].includes(inputFormat)) {
    return ['csv'];
  }

  if (inputFormat === 'csv') {
    return ['xlsx'];
  }

  return [];
}
