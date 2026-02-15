export async function textToPdf(file) {
  const text = await file.text();
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF();

  const lines = text.split('\n');
  let y = 10;
  const lineHeight = 7;

  for (const line of lines) {
    if (y > 280) {
      doc.addPage();
      y = 10;
    }
    doc.text(line, 10, y);
    y += lineHeight;
  }

  return doc.output('blob');
}
