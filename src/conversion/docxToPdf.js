export async function docxToPdf(file) {
  const mammoth = await import('mammoth');
  const { jsPDF } = await import('jspdf');

  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer });

  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = result.value;

  const doc = new jsPDF();
  let y = 10;
  const lineHeight = 7;
  const maxWidth = 190;

  const paragraphs = tempDiv.querySelectorAll('p');
  for (const paragraph of paragraphs) {
    const text = paragraph.textContent.trim();
    if (!text) continue;

    const splitLines = doc.splitTextToSize(text, maxWidth);
    for (const line of splitLines) {
      if (y > 280) {
        doc.addPage();
        y = 10;
      }
      doc.text(line, 10, y);
      y += lineHeight;
    }
    y += lineHeight;
  }

  return doc.output('blob');
}
