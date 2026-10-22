import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';

const png = await readFile(new URL('../public/icons/icon16.png', import.meta.url));
let serial = 0;

async function setup(t) {
  let listener;
  const blobs = new Map();
  const revoked = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: {
    id: 'test', getURL: (path) => `chrome-extension://test/${path}`,
    onMessage: { addListener(fn) { listener = fn; } },
  } } });
  t.after(() => original ? Object.defineProperty(globalThis, 'chrome', original) : delete globalThis.chrome);
  t.mock.method(globalThis, 'fetch', async () => new Response(png, { headers: { 'content-type': 'application/octet-stream' } }));
  t.mock.method(URL, 'createObjectURL', (blob) => {
    const url = `blob:chrome-extension://test/output-${blobs.size}`;
    blobs.set(url, blob);
    return url;
  });
  t.mock.method(URL, 'revokeObjectURL', (url) => revoked.push(url));
  await import(`../src/offscreen/offscreen.js?test=${++serial}`);
  const request = (message) => new Promise((resolve) => listener({ target: 'offscreen', ...message }, { id: 'test' }, resolve));
  return { request, listener, blobs, revoked };
}

test('offscreen conversion produces a valid PDF and retains it until explicit download cleanup', async (t) => {
  const { request, blobs, revoked } = await setup(t);
  const result = await request({ type: 'convert-image', srcUrl: 'https://example.com/image.png', outputFormat: 'pdf' });
  assert.ok(result.url?.startsWith('blob:chrome-extension://test/'));
  const pdf = await PDFDocument.load(await blobs.get(result.url).arrayBuffer());
  assert.equal(pdf.getPage(0).getWidth(), 16);
  assert.equal(revoked.length, 0);
  await request({ type: 'release-download', url: result.url });
  await request({ type: 'release-download', url: result.url });
  assert.deepEqual(revoked, [result.url]);
});

test('popup output is copied into an offscreen-owned blob', async (t) => {
  const { request, blobs, revoked } = await setup(t);
  const result = await request({ type: 'download-blob', url: 'blob:chrome-extension://test/popup' });
  assert.deepEqual(new Uint8Array(await blobs.get(result.url).arrayBuffer()), new Uint8Array(png));
  await request({ type: 'release-download', url: 'blob:unowned' });
  assert.equal(revoked.length, 0);
  await request({ type: 'release-download', url: result.url });
  assert.deepEqual(revoked, [result.url]);
});

test('offscreen rejects unsupported conversions and foreign blob sources', async (t) => {
  const { request, listener, blobs } = await setup(t);
  assert.match((await request({ type: 'convert-image', outputFormat: 'tiff' })).error, /not supported/);
  assert.match((await request({ type: 'download-blob', url: 'https://example.com/file' })).error, /Invalid download source/);
  let responded = false;
  assert.equal(listener({ target: 'offscreen', type: 'convert-image' }, { id: 'other' }, () => { responded = true; }), undefined);
  assert.equal(responded, false);
  assert.equal(blobs.size, 0);
});
