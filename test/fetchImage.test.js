import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchImage } from '../src/shared/fetchImage.js';
import { MAX_FILE_SIZE } from '../src/shared/constants.js';

test('checks the HTTP status before trying to convert an error page', async (t) => {
  let canceled = false;
  const body = new ReadableStream({ cancel() { canceled = true; } });
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 404 }));
  await assert.rejects(fetchImage('https://example.com/missing.png'), /HTTP 404/);
  assert.equal(canceled, true);
});

test('rejects an oversized content length without consuming its body', async (t) => {
  let canceled = false;
  const body = new ReadableStream({ cancel() { canceled = true; } });
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { headers: { 'content-length': MAX_FILE_SIZE + 1 } }));
  await assert.rejects(fetchImage('https://example.com/large.png'), /16 MB/);
  assert.equal(canceled, true);
});

test('bounds a chunked response even when the server understates its length', async (t) => {
  let canceled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_FILE_SIZE));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() { canceled = true; },
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { headers: { 'content-length': '1' } }));
  await assert.rejects(fetchImage('https://example.com/large.png'), /16 MB/);
  assert.equal(canceled, true);
});

test('preserves bytes and the response MIME type within the budget', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(Uint8Array.of(1, 2, 3), { headers: { 'content-type': 'image/png' } });
  });
  const blob = await fetchImage('https://example.com/image.png');
  assert.equal(blob.type, 'image/png');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), Uint8Array.of(1, 2, 3));
});

test('rejects empty successful responses', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(''));
  await assert.rejects(fetchImage('https://example.com/empty.png'), /empty/i);
});
