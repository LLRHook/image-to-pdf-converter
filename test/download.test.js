import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadBlob, outputFilename } from '../src/shared/download.js';

test('preserves all filename segments except the final extension', () => {
  assert.equal(outputFilename('report.final.v2.PNG', 'pdf'), 'report.final.v2.pdf');
  assert.equal(outputFilename('notes', 'pdf'), 'notes.pdf');
  assert.equal(outputFilename('.png', 'pdf'), 'converted.pdf');
  assert.equal(outputFilename('a/b:c.png', 'jpg'), 'a_b_c.jpg');
});

for (const failure of [false, true]) {
  test(`popup blob URL is revoked after download ${failure ? 'failure' : 'acceptance'}`, async (t) => {
    const revoked = [];
    const original = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
      runtime: { id: 'test', async sendMessage(message) {
        assert.equal(message.target, 'background');
        assert.equal(revoked.length, 0);
        return failure ? { error: 'Save canceled' } : { downloadId: 42 };
      } },
    } });
    t.after(() => original ? Object.defineProperty(globalThis, 'chrome', original) : delete globalThis.chrome);
    t.mock.method(URL, 'createObjectURL', () => 'blob:popup');
    t.mock.method(URL, 'revokeObjectURL', (url) => revoked.push(url));
    const promise = downloadBlob(new Blob(['pdf']), 'report.pdf');
    if (failure) await assert.rejects(promise, /Save canceled/);
    else await promise;
    assert.deepEqual(revoked, ['blob:popup']);
  });
}
