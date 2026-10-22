import test from 'node:test';
import assert from 'node:assert/strict';
import { convert } from '../src/conversion/index.js';
import { MAX_FILE_SIZE } from '../src/shared/constants.js';

test('the public conversion dispatcher rejects oversized documents before reading', async () => {
  const file = { size: MAX_FILE_SIZE + 1, arrayBuffer() { throw new Error('must not read'); } };
  for (const format of ['txt', 'docx', 'csv', 'xlsx', 'png']) {
    await assert.rejects(convert(file, format, 'pdf'), /16 MB/);
  }
});

test('the public conversion dispatcher explains missing and unsupported formats', async () => {
  const file = new Blob(['input']);
  await assert.rejects(convert(file, null, undefined), /Select both/);
  await assert.rejects(convert(file, 'exe', 'pdf'), /EXE to PDF is not supported/);
  await assert.rejects(convert(null, 'png', 'pdf'), /valid file/);
});
