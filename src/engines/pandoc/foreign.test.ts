/** Documents NOT written by pandoc: the readers must cope with what Word, LibreOffice and EPUB tools produce. */
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { blobOf, bytesOf, testContext } from '../../core/testing';
import type { FormatId } from '../../core/formats';
import engine from './engine';
import {
  FOREIGN, FOREIGN_HTML, FOREIGN_MD, FOREIGN_PNG, FOREIGN_TEX, FOREIGN_TXT,
  foreignDocx, foreignEpub, foreignOdt, foreignRtf,
} from './test-support/office';

const dec = new TextDecoder();
const enc = new TextEncoder();

const SOURCES: Record<string, { data: Uint8Array; image: boolean; table: boolean; heading: boolean }> = {
  docx: { data: foreignDocx(), image: true, table: true, heading: true },
  odt: { data: foreignOdt(), image: true, table: true, heading: true },
  epub: { data: foreignEpub(), image: true, table: true, heading: true },
  rtf: { data: foreignRtf(), image: false, table: false, heading: false },
  html: { data: enc.encode(FOREIGN_HTML), image: true, table: true, heading: true },
  tex: { data: enc.encode(FOREIGN_TEX), image: false, table: true, heading: true },
  md: { data: enc.encode(FOREIGN_MD), image: false, table: true, heading: true },
  txt: { data: enc.encode(FOREIGN_TXT), image: false, table: false, heading: false },
};

async function run(from: FormatId, to: FormatId, data: Uint8Array) {
  const ctx = testContext();
  const res = await engine.convert({ input: blobOf(data), name: `foreign.${from}`, from, to, options: {} }, ctx);
  return { ctx, res, bytes: await bytesOf(res.output) };
}

describe.each(Object.entries(SOURCES))('foreign %s', (from, spec) => {
  it('-> md keeps title, emphasis, table, Cyrillic and the original image bytes', async () => {
    const { res, bytes, ctx } = await run(from as FormatId, 'md', spec.data);
    let md: string;
    if (spec.image) {
      expect(res.ext).toBe('zip');
      const z = unzipSync(bytes);
      md = dec.decode(z['foreign.md']!);
      const media = Object.entries(z).filter(([n]) => n.startsWith('media/'));
      expect(media.length).toBe(1);
      expect(Array.from(media[0]![1])).toEqual(Array.from(FOREIGN_PNG)); // byte-identical
      expect(md).toContain(media[0]![0]);
    } else {
      expect(res.ext).toBe('md');
      md = dec.decode(bytes);
    }
    expect(md).toContain(FOREIGN.title);
    expect(md).toContain(FOREIGN.cyrillic);
    if (from !== 'txt') expect(md).toContain(FOREIGN.bold);
    if (spec.heading) expect(md).toMatch(/^#+ +Quarterly Report/m);
    if (spec.table) {
      for (const c of FOREIGN.cells) expect(md).toContain(c);
      expect(md).toMatch(/\|\s*Region\s*\|\s*Sales\s*\|/);
    }
    if (from !== 'txt' && from !== 'rtf') expect(md).toContain('**Revenue grew**');
    const facts = ctx.factsSeen[0]!;
    expect(facts).toMatchObject({ kind: 'document', images: spec.image ? 1 : 0, tables: spec.table ? 1 : 0 });
  });

  it('-> docx is a valid package a second time around', async () => {
    const { bytes } = await run(from as FormatId, 'docx', spec.data);
    const z = unzipSync(bytes);
    const doc = dec.decode(z['word/document.xml']!);
    expect(doc).toContain(FOREIGN.title);
    expect(doc).toContain(FOREIGN.cyrillic);
    expect(Object.keys(z).filter((n) => n.startsWith('word/media/')).length).toBe(spec.image ? 1 : 0);
  });
});
