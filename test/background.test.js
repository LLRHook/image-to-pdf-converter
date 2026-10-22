import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const png = await readFile(new URL('../public/icons/icon16.png', import.meta.url));
let serial = 0;

async function setup(t, options = {}) {
  const events = { messages: [], downloads: [], created: [], errors: [] };
  const listeners = {};
  let documentExists = false;
  let attempts = 0;
  const chrome = {
    runtime: {
      id: 'test',
      onInstalled: { addListener() {} },
      onMessage: { addListener(fn) { listeners.message = fn; } },
      getURL: (path) => `chrome-extension://test/${path}`,
      getContexts: async () => documentExists ? [{}] : [],
      async sendMessage(message) {
        events.messages.push(message);
        return { url: 'blob:chrome-extension://test/converted' };
      },
    },
    contextMenus: {
      create() {},
      onClicked: { addListener(fn) { listeners.click = fn; } },
    },
    offscreen: {
      async createDocument(spec) {
        events.created.push(spec);
        if (spec.reasons.some((reason) => reason !== 'BLOBS')) throw new Error('Invalid offscreen reason');
        if (options.failFirstCreate && attempts++ === 0) throw new Error('Temporary offscreen failure');
        documentExists = true;
      },
    },
    downloads: {
      async download(spec) {
        if (options.failDownload) throw new Error('Download canceled');
        events.downloads.push(spec);
        return 42;
      },
      onChanged: { addListener(fn) { listeners.changed = fn; } },
      search: async () => [{ url: 'blob:chrome-extension://test/converted', byExtensionId: 'test' }],
    },
  };
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', { value: chrome, configurable: true });
  t.after(() => originalChrome ? Object.defineProperty(globalThis, 'chrome', originalChrome) : delete globalThis.chrome);
  t.mock.method(globalThis, 'fetch', async () => new Response(png, { headers: { 'content-type': 'image/png' } }));
  t.mock.method(console, 'error', (...args) => events.errors.push(args));
  const createURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  Object.defineProperty(URL, 'createObjectURL', { value: undefined, configurable: true });
  t.after(() => Object.defineProperty(URL, 'createObjectURL', createURL));
  await import(`../src/background/service-worker.js?test=${++serial}`);
  return { events, listeners };
}

for (const format of ['pdf', 'png', 'jpg']) {
  test(`context-menu ${format} downloads without service-worker object URLs`, async (t) => {
    const { events, listeners } = await setup(t);
    await listeners.click({ srcUrl: 'https://example.com/image.png', menuItemId: `convert-${format}` });
    assert.equal(events.errors.length, 0);
    assert.equal(events.downloads.length, 1);
    assert.equal(events.downloads[0].filename, `converted.${format}`);
    assert.deepEqual(events.created[0].reasons, ['BLOBS']);
  });
}

test('a failed offscreen creation can be retried', async (t) => {
  const { events, listeners } = await setup(t, { failFirstCreate: true });
  const info = { srcUrl: 'https://example.com/image.png', menuItemId: 'convert-png' };
  await listeners.click(info);
  await listeners.click(info);
  assert.equal(events.created.length, 2);
  assert.equal(events.downloads.length, 1);
});

test('simultaneous context clicks share one offscreen creation', async (t) => {
  const { events, listeners } = await setup(t);
  await Promise.all(['png', 'jpg', 'pdf'].map((format) => listeners.click({
    srcUrl: 'https://example.com/image.png', menuItemId: `convert-${format}`,
  })));
  assert.equal(events.created.length, 1);
  assert.equal(events.downloads.length, 3);
});

for (const state of ['complete', 'interrupted']) {
  test(`download ${state} releases its offscreen blob, including after a worker restart`, async (t) => {
    const { events, listeners } = await setup(t);
    await listeners.changed({ id: 42, state: { current: state } });
    assert.deepEqual(events.messages, [{
      target: 'offscreen', type: 'release-download', url: 'blob:chrome-extension://test/converted',
    }]);
    assert.equal(events.created.length, 0);
  });
}

test('a canceled download start releases its converted blob', async (t) => {
  const { events, listeners } = await setup(t, { failDownload: true });
  await listeners.click({ srcUrl: 'https://example.com/image.png', menuItemId: 'convert-pdf' });
  assert.equal(events.errors.length, 1);
  assert.equal(events.messages.at(-1).type, 'release-download');
});

test('popup download requests report the actual download ID', async (t) => {
  const { events, listeners } = await setup(t);
  const response = await new Promise((resolve) => {
    const keepAlive = listeners.message({
      target: 'background', type: 'download-blob', url: 'blob:chrome-extension://test/popup', filename: 'report.v2.pdf',
    }, { id: 'test' }, resolve);
    assert.equal(keepAlive, true);
  });
  assert.deepEqual(response, { downloadId: 42 });
  assert.equal(events.downloads[0].filename, 'report.v2.pdf');
});
