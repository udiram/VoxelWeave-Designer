import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const evidenceDir = path.resolve(process.cwd(), 'test-results/visual-evidence');
mkdirSync(evidenceDir, { recursive: true });

const noRelease = async (page: import('@playwright/test').Page) => {
  await page.route('**/api/releases/latest', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'no_release', release: null })
  }));
};

const mockedRelease = async (page: import('@playwright/test').Page) => {
  await page.route('**/api/releases/latest', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      release: {
        tag: 'development-12',
        prerelease: true,
        channel: 'development-prerelease',
        sourceRevision: 'abc1234',
        publishedAt: '2026-08-04T12:00:00Z',
        artifacts: [{
          name: 'VoxelWeave-Designer-arm64.dmg',
          architecture: 'Apple Silicon',
          size: '284.6 MB',
          sha256: 'a'.repeat(64),
          downloadPath: '/download/development-12/VoxelWeave-Designer-arm64.dmg'
        }],
        checks: [
          { id: 'unit-integration', status: 'reported', detail: 'Reported in release notes' },
          { id: 'desktop-e2e', status: 'reported', detail: 'Reported in release notes' },
          { id: 'accessibility', status: 'reported', detail: 'Reported in release notes' },
          { id: 'architecture', status: 'reported', detail: 'Apple Silicon artifact is present' },
          { id: 'release-checksum', status: 'reported', detail: 'SHA-256 is present for at least one artifact' }
        ]
      }
    })
  }));
};

test('homepage renders an honest no-release state and primary navigation', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await noRelease(page);
  await page.goto('/');

  await expect(page).toHaveTitle(/VoxelWeave Designer/);
  await expect(page.getByRole('heading', { name: 'Design CT phantoms from source volume to scan-back.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'One project. Six accountable workspaces.' })).toBeVisible();
  await expect(page.getByText('No public Apple Silicon build is published yet.')).toBeVisible();
  await expect(page.locator('[data-download-cta]').first()).toHaveAttribute('href', '#evidence');
  await expect(page.locator('[data-release-download-cta]')).toHaveAttribute('href', 'https://github.com/udiram/VoxelWeave-Designer');
  await expect(page.locator('[data-release-download-cta]')).toContainText('View source on GitHub');
  await expect(page.locator('img[alt*="DICOM workspace"]')).toHaveCount(1);
  expect(consoleErrors).toEqual([]);

  await page.getByRole('link', { name: 'Documentation' }).first().click();
  await expect(page).toHaveURL(/\/documentation\/$/);
  await expect(page.getByRole('heading', { name: 'Documentation for an inspectable fabrication workflow.' })).toBeVisible();
});

test('mobile navigation opens and routes to documentation', async ({ page }) => {
  await noRelease(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const menuButton = page.getByRole('button', { name: 'Open navigation menu' });
  await menuButton.click();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Documentation' }).click();
  await expect(page).toHaveURL(/\/documentation\/$/);
});

test('mocked release renders artifact receipt, checks, checksum, and verified download path', async ({ page }) => {
  await mockedRelease(page);
  await page.goto('/');

  await expect(page.locator('[data-release-table]')).toBeVisible();
  const row = page.locator('[data-release-rows] tr').first();
  await expect(row).toContainText('VoxelWeave-Designer-arm64.dmg');
  await expect(row).toContainText('Apple Silicon');
  await expect(row).toContainText('284.6 MB');
  await expect(row.locator('code')).toHaveText('a'.repeat(64));
  await expect(row.getByRole('link', { name: /Download VoxelWeave/ })).toHaveAttribute('href', '/download/development-12/VoxelWeave-Designer-arm64.dmg');
  await expect(page.locator('[data-release-tag]')).toHaveText('development-12');
  await expect(page.locator('[data-release-channel]')).toContainText('Development prerelease · not signed or notarized');
  await expect(page.locator('[data-check-id="release-checksum"]')).toHaveAttribute('data-status', 'reported');
  await expect(page.locator('[data-download-cta]').first()).toHaveAttribute('href', '/download/development-12/VoxelWeave-Designer-arm64.dmg');
  await expect(page.locator('[data-download-cta]').first()).toContainText('Download development build');
});

test('responsive widths keep the document inside the viewport', async ({ page }) => {
  await noRelease(page);
  for (const width of [1536, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Design CT phantoms from source volume to scan-back.' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `document overflow at ${width}px`).toBeLessThanOrEqual(1);
  }
});

test('accessible homepage has no serious or critical axe violations', async ({ page }) => {
  await noRelease(page);
  await page.goto('/');
  const results = await new AxeBuilder({ page }).analyze();
  const seriousOrCritical = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
  expect(seriousOrCritical).toEqual([]);
});

test('captures accepted section and mobile visual evidence', async ({ page }) => {
  await noRelease(page);
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.goto('/');
  await expect(page.locator('[data-release-empty]')).toBeVisible();
  await page.locator('.hero').screenshot({ path: path.join(evidenceDir, 'hero-1536.png') });
  await page.locator('#workflow').screenshot({ path: path.join(evidenceDir, 'workflow-1536.png') });
  await page.locator('#evidence').screenshot({ path: path.join(evidenceDir, 'release-1536.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator('[data-release-empty]')).toBeVisible();
  await page.screenshot({ path: path.join(evidenceDir, 'full-page-mobile-390.png'), fullPage: true });
});
