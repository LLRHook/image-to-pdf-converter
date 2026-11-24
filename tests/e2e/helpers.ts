import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

/**
 * The dev server re-optimises dependencies the first time an engine imports
 * them, and reloads the page when repo files change; either destroys the
 * evaluate context mid-call. Harness calls reopen the page and retry.
 */
const RELOADED =
  /Execution context was destroyed|interrupted by another navigation|not bound in the connection|Target (page|closed)|navigation|harness is undefined/i;
const ATTEMPTS = 4;

/** Run fn; if a reload interrupts it, run recover and try again. */
export async function retryOnReload<T>(fn: () => Promise<T>, recover: () => Promise<unknown>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= ATTEMPTS || !RELOADED.test(String(err))) throw err;
      await recover();
    }
  }
}

export function openHarness(page: Page): Promise<void> {
  return retryOnReload(
    async () => {
      await page.goto('/harness.html');
      await page.waitForFunction(() => (window as any).harness?.ready === true);
    },
    () => page.waitForTimeout(300),
  );
}

/** Run a conversion in the real browser through the real runner + worker. */
export function convert(page: Page, args: Record<string, unknown>): Promise<any> {
  return retryOnReload(
    () => page.evaluate((a) => (window as any).harness.convert(a), args),
    () => openHarness(page),
  );
}

export function b64File(path: string): string {
  return readFileSync(path).toString('base64');
}

export function bytes(b64: string): Buffer {
  return Buffer.from(b64, 'base64');
}

type Ev = { type: string; hop?: number; stage?: string; value?: number; url?: string; loaded?: number; total?: number | null };

/** Stage ids in order, optionally for one hop only. */
export const stageIds = (events: Ev[], hop?: number): string[] =>
  events.filter((e) => e.type === 'stage' && (hop === undefined || e.hop === hop)).map((e) => e.stage!);
export const progressValues = (events: Ev[]): number[] => events.filter((e) => e.type === 'progress').map((e) => e.value!);
export const assetEvents = (events: Ev[]) =>
  events.filter((e) => e.type === 'asset') as { url: string; loaded: number; total: number | null }[];
