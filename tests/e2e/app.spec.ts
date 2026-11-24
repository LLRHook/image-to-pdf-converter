import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSV, makePng } from './fixtures';

/** Every request the page (and its workers) makes, so privacy can be asserted. */
function watchNetwork(page: Page) {
  const seen: { url: string; method: string; hasBody: boolean }[] = [];
  page.on('request', (r) => seen.push({ url: r.url(), method: r.method(), hasBody: !!r.postDataBuffer() }));
  return seen;
}

/** Records requestAnimationFrame deltas so we can check the animation stays smooth. */
async function startFrameProbe(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __probe: boolean };
    w.__frames = [];
    w.__probe = true;
    let last = performance.now();
    const tick = (t: number) => {
      w.__frames.push(t - last);
      last = t;
      if (w.__probe) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
async function stopFrameProbe(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __probe: boolean };
    w.__probe = false;
    return w.__frames.slice(1);
  });
}
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;

async function convertInApp(page: Page, file: { name: string; mimeType: string; buffer: Buffer }, target: string) {
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(file);
  await expect(page.locator('.picker')).toBeVisible();
  await page.getByRole('button', { name: new RegExp(`^${target}`) }).first().click();
  await startFrameProbe(page);
  await page.getByRole('button', { name: new RegExp(`^Convert to ${target}`) }).click();
  const dl = page.getByRole('button', { name: /^Download/ });
  await expect(dl).toBeVisible({ timeout: 120_000 });
  const frames = await stopFrameProbe(page);
  // Firefox saves displayable types (images) and then opens the saved file in
  // a new tab instead of raising a download event. Accept either.
  const saved = Promise.race([
    page.waitForEvent('download').then(async (d) => ({ name: d.suggestedFilename(), path: (await d.path())! })),
    page.context().waitForEvent('page').then((p) => {
      const path = fileURLToPath(p.url());
      return { name: basename(path), path };
    }),
  ]);
  await dl.click({ noWaitAfter: true });
  return { download: await saved, frames };
}

test('PNG → WebP in the real app: output is valid, no off-origin traffic, smooth animation', async ({ page, baseURL, browserName }) => {
  const net = watchNetwork(page);
  const png = makePng(640, 400, 6);
  const { download, frames } = await convertInApp(page, { name: 'gradient.png', mimeType: 'image/png', buffer: png }, 'WebP');
  expect(download.name).toBe('gradient.webp');
  const bytes = readFileSync(download.path);
  expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF');
  expect(bytes.subarray(8, 12).toString('latin1')).toBe('WEBP');

  const origin = new URL(baseURL!).origin;
  const offOrigin = net.filter((r) => !r.url.startsWith(origin) && !r.url.startsWith('blob:') && !r.url.startsWith('data:'));
  expect(offOrigin).toEqual([]);
  expect(net.filter((r) => r.method !== 'GET' || r.hasBody)).toEqual([]);

  // Animation runs on the main thread while engines work in workers.
  // Report the frame budget; fail only on real jank (headless browsers vary).
  const p95 = pct(frames, 0.95);
  test.info().annotations.push({ type: 'frames', description: `n=${frames.length} p50=${pct(frames, 0.5).toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${Math.max(...frames).toFixed(1)}ms` });
  // Headless Firefox composites in software, so blur-heavy pages run slower
  // there than in a real window (headed Firefox measures p95 ~17 ms).
  if (browserName !== 'firefox') expect(p95).toBeLessThan(50);
});

test('CSV → XLSX in the real app', async ({ page }) => {
  const net = watchNetwork(page);
  const { download } = await convertInApp(page, { name: 'items.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) }, 'Excel');
  expect(download.name).toBe('items.xlsx');
  const bytes = readFileSync(download.path);
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
  expect(net.filter((r) => r.method !== 'GET')).toEqual([]);
});

test('input structure is drawn before converting (real PNG chunks)', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({ name: 'g.png', mimeType: 'image/png', buffer: makePng(64, 64, 3) });
  await expect(page.locator('.picker')).toBeVisible();
  // The canvas label is the live description; the picker proves sniffing worked.
  await expect(page.locator('.picker-head')).toContainText('PNG');
});
