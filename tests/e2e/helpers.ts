import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

export async function openHarness(page: Page) {
  await page.goto('/harness.html');
  await page.waitForFunction(() => (window as any).harness?.ready === true);
}

export function b64File(path: string): string {
  return readFileSync(path).toString('base64');
}

export function bytes(b64: string): Buffer {
  return Buffer.from(b64, 'base64');
}

/** Run a conversion in the real browser through the real runner + worker. */
export async function convert(page: Page, args: Record<string, unknown>) {
  return page.evaluate((a) => (window as any).harness.convert(a), args) as Promise<any>;
}
