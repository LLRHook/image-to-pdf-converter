/** Test fixtures for the document engines: generated here, never committed as binaries. */
import { testContext } from '../../core/testing';
import { loadPandoc, type PandocInstance } from './pandoc';
import { makePng } from './test-support/png';

export { makePng };

export const SAMPLE_MD = `---
title: Quarterly report
author: Ada Lovelace
---

# Overview

The **quarterly** report covers _three_ regions: north, south and west.[^1]

## Numbers

| Region | Revenue |
|--------|---------|
| North  | 120     |
| South  | 95      |

- first item
- second item

1. alpha
2. beta

![Company logo](logo.png)

Math: $E = mc^2$ and a link to [example](https://example.com/page).

[^1]: A footnote about regions.
`;

export const SAMPLE_MD_NO_IMAGE = SAMPLE_MD.replace('![Company logo](logo.png)\n\n', '');

export const SAMPLE_PNG = makePng(24, 16, [200, 40, 40]);

/** A pandoc instance for building fixtures with the very engine under test. */
export async function fixturePandoc(): Promise<PandocInstance> {
  return loadPandoc(testContext());
}

/** Build a binary document (docx/odt/epub) from markdown, with the sample image attached. */
export async function buildBinary(p: PandocInstance, to: 'docx' | 'odt' | 'epub' | 'rtf', md = SAMPLE_MD): Promise<Uint8Array> {
  const r = await p.convert(
    { from: 'gfm', to: to === 'epub' ? 'epub3' : to, standalone: true, 'output-file': 'o.bin' },
    md,
    { 'logo.png': new Blob([SAMPLE_PNG as Uint8Array<ArrayBuffer>]) },
  );
  const out = r.files['o.bin'] ?? r.stdout;
  if (typeof out === 'string') return new TextEncoder().encode(out);
  return new Uint8Array(await (out as Blob).arrayBuffer());
}

export async function buildSources(p: PandocInstance, md = SAMPLE_MD): Promise<Record<string, Uint8Array>> {
  const enc = new TextEncoder();
  const text = async (to: string) => {
    const r = await p.convert(
      { from: 'gfm', to, standalone: true, 'embed-resources': to === 'html5' ? true : undefined },
      md,
      { 'logo.png': new Blob([SAMPLE_PNG as Uint8Array<ArrayBuffer>]) },
    );
    return enc.encode(r.stdout);
  };
  return {
    docx: await buildBinary(p, 'docx', md),
    odt: await buildBinary(p, 'odt', md),
    epub: await buildBinary(p, 'epub', md),
    rtf: await buildBinary(p, 'rtf', md),
    md: enc.encode(md.replace('logo.png', `data:image/png;base64,${Buffer.from(SAMPLE_PNG).toString('base64')}`)),
    html: await text('html5'),
    tex: await text('latex'),
    txt: await text('plain'),
  };
}
