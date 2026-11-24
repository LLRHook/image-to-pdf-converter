import { test, expect } from '@playwright/test';
import { openHarness } from './helpers';

test('harness loads with zero external requests', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://localhost')) external.push(r.url());
  });
  await openHarness(page);
  expect(external).toEqual([]);
});
