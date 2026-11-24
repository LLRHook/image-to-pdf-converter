/**
 * Hand-built "foreign" documents: written the way Word, LibreOffice and EPUB
 * toolchains write them, NOT by pandoc, so the readers are tested against
 * input they did not produce themselves. Pure (fflate only): usable from both
 * Vitest and Playwright.
 */
import { strToU8, zipSync, type Zippable } from 'fflate';
import { makePng } from './png';

export const FOREIGN_PNG = makePng(40, 24, [200, 40, 40]);

/** What every foreign fixture contains, for assertions. */
export const FOREIGN = {
  title: 'Quarterly Report',
  bold: 'Revenue grew',
  rest: ' by 12% over the prior year.',
  cyrillic: 'Привет, мир',
  cells: ['Region', 'Sales', 'North', '120'],
  alt: 'Red logo',
} as const;

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';

export function foreignDocx(): Uint8Array {
  const cell = (t: string) => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
  const [h1, h2, c1, c2] = FOREIGN.cells;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${FOREIGN.title}</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${FOREIGN.bold}</w:t></w:r><w:r><w:t xml:space="preserve">${FOREIGN.rest}</w:t></w:r></w:p>
<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>
<w:tr>${cell(h1)}${cell(h2)}</w:tr><w:tr>${cell(c1)}${cell(c2)}</w:tr></w:tbl>
<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="952500" cy="571500"/><wp:docPr id="1" name="Picture 1" descr="${FOREIGN.alt}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId3"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="571500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
<w:p><w:r><w:t>${FOREIGN.cyrillic}</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>
</w:styles>`;
  const files: Zippable = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    'word/_rels/document.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`),
    'word/document.xml': strToU8(document),
    'word/styles.xml': strToU8(styles),
    'word/media/image1.png': [FOREIGN_PNG, { level: 0 }],
  };
  return zipSync(files);
}

export function foreignOdt(): Uint8Array {
  const [h1, h2, c1, c2] = FOREIGN.cells;
  const cell = (t: string) => `<table:table-cell office:value-type="string"><text:p>${t}</text:p></table:table-cell>`;
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.3">
<office:automatic-styles><style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style></office:automatic-styles>
<office:body><office:text>
<text:h text:outline-level="1">${FOREIGN.title}</text:h>
<text:p><text:span text:style-name="T1">${FOREIGN.bold}</text:span>${FOREIGN.rest}</text:p>
<table:table table:name="T"><table:table-column table:number-columns-repeated="2"/>
<table:table-row>${cell(h1)}${cell(h2)}</table:table-row><table:table-row>${cell(c1)}${cell(c2)}</table:table-row></table:table>
<text:p><draw:frame draw:name="img" text:anchor-type="as-char" svg:width="2.6cm" svg:height="1.6cm"><draw:image xlink:href="Pictures/logo.png" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/><svg:desc>${FOREIGN.alt}</svg:desc></draw:frame></text:p>
<text:p>${FOREIGN.cyrillic}</text:p>
</office:text></office:body></office:document-content>`;
  const files: Zippable = {
    mimetype: [strToU8('application/vnd.oasis.opendocument.text'), { level: 0 }],
    'content.xml': strToU8(content),
    'styles.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" office:version="1.3"><office:styles><style:default-style style:family="paragraph"/></office:styles></office:document-styles>`),
    'Pictures/logo.png': [FOREIGN_PNG, { level: 0 }],
    'META-INF/manifest.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="Pictures/logo.png" manifest:media-type="image/png"/></manifest:manifest>`),
  };
  return zipSync(files);
}

export function foreignEpub(): Uint8Array {
  const [h1, h2, c1, c2] = FOREIGN.cells;
  const chapter = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${FOREIGN.title}</title></head><body>
<h1>${FOREIGN.title}</h1>
<p><b>${FOREIGN.bold}</b>${FOREIGN.rest}</p>
<table><thead><tr><th>${h1}</th><th>${h2}</th></tr></thead><tbody><tr><td>${c1}</td><td>${c2}</td></tr></tbody></table>
<p><img src="images/logo.png" alt="${FOREIGN.alt}"/></p>
<p>${FOREIGN.cyrillic}</p>
</body></html>`;
  const files: Zippable = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
    'OEBPS/content.opf': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:12345678-1234-1234-1234-123456789abc</dc:identifier><dc:title>${FOREIGN.title}</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/><item id="img" href="images/logo.png" media-type="image/png"/></manifest>
<spine><itemref idref="c1"/></spine></package>`),
    'OEBPS/nav.xhtml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="chapter1.xhtml">${FOREIGN.title}</a></li></ol></nav></body></html>`),
    'OEBPS/chapter1.xhtml': strToU8(chapter),
    'OEBPS/images/logo.png': [FOREIGN_PNG, { level: 0 }],
  };
  return zipSync(files);
}

export function foreignRtf(): Uint8Array {
  // Cyrillic as RTF unicode escapes, the way Word writes them.
  const cyr = [...FOREIGN.cyrillic].map((c) => (/[^\x20-\x7e]/.test(c) ? `\\u${c.charCodeAt(0)}?` : c)).join('');
  return strToU8(
    `{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fswiss Arial;}}\\viewkind4\\uc1\\pard\\b\\fs32 ${FOREIGN.title}\\b0\\fs24\\par\n` +
      `\\pard\\b ${FOREIGN.bold}\\b0 ${FOREIGN.rest}\\par\n\\pard ${cyr}\\par\n}`,
  );
}

export const FOREIGN_MD = `# ${FOREIGN.title}\n\n**${FOREIGN.bold}**${FOREIGN.rest}\n\n| ${FOREIGN.cells[0]} | ${FOREIGN.cells[1]} |\n|---|---|\n| ${FOREIGN.cells[2]} | ${FOREIGN.cells[3]} |\n\n${FOREIGN.cyrillic}\n`;

export const FOREIGN_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>${FOREIGN.title}</title></head><body>
<h1>${FOREIGN.title}</h1><p><b>${FOREIGN.bold}</b>${FOREIGN.rest}</p>
<table><tr><th>${FOREIGN.cells[0]}</th><th>${FOREIGN.cells[1]}</th></tr><tr><td>${FOREIGN.cells[2]}</td><td>${FOREIGN.cells[3]}</td></tr></table>
<p><img alt="${FOREIGN.alt}" src="data:image/png;base64,${Buffer.from(FOREIGN_PNG).toString('base64')}"></p>
<p>${FOREIGN.cyrillic}</p></body></html>`;

export const FOREIGN_TEX = `\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\\begin{document}\n\\section{${FOREIGN.title}}\n\\textbf{${FOREIGN.bold}}${FOREIGN.rest}\n\n\\begin{tabular}{ll}\n${FOREIGN.cells[0]} & ${FOREIGN.cells[1]} \\\\\n${FOREIGN.cells[2]} & ${FOREIGN.cells[3]} \\\\\n\\end{tabular}\n\n${FOREIGN.cyrillic}\n\\end{document}\n`;

export const FOREIGN_TXT = `${FOREIGN.title}\n\n${FOREIGN.bold}${FOREIGN.rest}\n\n${FOREIGN.cells[0]}  ${FOREIGN.cells[1]}\n${FOREIGN.cells[2]}  ${FOREIGN.cells[3]}\n\n${FOREIGN.cyrillic}\n`;
