import test from 'node:test';
import assert from 'node:assert/strict';
import { imageToImage } from '../src/conversion/imageToImage.js';

function mockCanvas(t, options = {}) {
  const calls = [];
  const exceptions = [];
  const canvas = {
    width: 0, height: 0,
    getContext() {
      if (options.noContext) return null;
      return {
        set fillStyle(value) { calls.push(['fillStyle', value]); },
        fillRect(...args) { calls.push(['fillRect', ...args]); },
        drawImage() { calls.push(['drawImage']); },
      };
    },
    toBlob(callback, type) {
      if (options.throwOnEncode) throw new Error('Encoder failed');
      queueMicrotask(() => callback(options.nullBlob ? null : new Blob(['image'], { type: options.fallbackType || type })));
    },
  };
  class FakeImage {
    width = 2;
    height = 2;
    naturalWidth = 2;
    naturalHeight = 2;
    set src(value) {
      if (!value) return;
      queueMicrotask(() => {
        try {
          if (options.invalidImage) this.onerror?.();
          else this.onload?.();
        } catch (error) { exceptions.push(error); }
      });
    }
    removeAttribute() {}
  }
  class FakeFileReader {
    readAsDataURL() {
      this.result = 'data:image/png;base64,aW1hZ2U=';
      queueMicrotask(() => this.onload?.());
    }
  }
  for (const [name, value] of Object.entries({
    Image: FakeImage,
    FileReader: FakeFileReader,
    document: { createElement: () => canvas },
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
  }
  const revoked = [];
  t.mock.method(URL, 'createObjectURL', () => 'blob:test-image');
  t.mock.method(URL, 'revokeObjectURL', (url) => revoked.push(url));
  return { canvas, calls, exceptions, revoked };
}

test('rejects unsupported output formats before decoding', async () => {
  await assert.rejects(imageToImage(new Blob(['image']), 'tiff'), /not supported/i);
});

test('JPEG conversion paints transparency white and frees decoded resources', async (t) => {
  const env = mockCanvas(t);
  const blob = await imageToImage(new Blob(['image']), 'jpg');
  assert.equal(blob.type, 'image/jpeg');
  assert.deepEqual(env.calls, [
    ['fillStyle', '#ffffff'], ['fillRect', 0, 0, 2, 2], ['drawImage'],
  ]);
  assert.deepEqual(env.revoked, ['blob:test-image']);
  assert.equal(env.canvas.width, 0);
  assert.equal(env.canvas.height, 0);
});

for (const options of [{ noContext: true }, { throwOnEncode: true }]) {
  test(`canvas failure settles the conversion instead of hanging: ${JSON.stringify(options)}`, async (t) => {
    const env = mockCanvas(t, options);
    const result = await Promise.race([
      imageToImage(new Blob(['image']), 'png').then(() => 'resolved', () => 'rejected'),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 50)),
    ]);
    assert.equal(result, 'rejected');
    assert.equal(env.exceptions.length, 0);
    assert.deepEqual(env.revoked, ['blob:test-image']);
    assert.equal(env.canvas.width, 0);
  });
}

test('a failed image decode releases its object URL', async (t) => {
  const env = mockCanvas(t, { invalidImage: true });
  await assert.rejects(imageToImage(new Blob(['image']), 'png'), /load image/i);
  assert.deepEqual(env.revoked, ['blob:test-image']);
});

for (const options of [{ nullBlob: true }, { fallbackType: 'image/png' }]) {
  test(`rejects a failed or substituted JPEG encoding: ${JSON.stringify(options)}`, async (t) => {
    const env = mockCanvas(t, options);
    await assert.rejects(imageToImage(new Blob(['image']), 'jpeg'), /Canvas conversion failed/);
    assert.deepEqual(env.revoked, ['blob:test-image']);
    assert.equal(env.canvas.width, 0);
  });
}
