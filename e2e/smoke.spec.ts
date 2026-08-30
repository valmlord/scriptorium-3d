import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('app boots with valid WebGL context and no console errors', async ({ page }) => {
  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    } else if (message.type() === 'warning') {
      consoleWarnings.push(message.text());
    }
  });

  page.on('pageerror', (error) => {
    consoleErrors.push(error.toString());
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Check that the app loaded
  const canvas = page.locator('canvas#canvas');
  await expect(canvas).toBeVisible();

  // Verify WebGL context exists by checking a simple WebGL property
  const hasWebGL = await page.evaluate(() => {
    const canvas = document.getElementById('canvas') as HTMLCanvasElement;
    if (!canvas) return false;
    const gl = canvas.getContext('webgl') || canvas.getContext('webgl2');
    return gl !== null;
  });

  expect(hasWebGL).toBe(true);

  // Verify no errors or warnings were logged
  expect(consoleErrors).toHaveLength(0);
  expect(consoleWarnings).toHaveLength(0);
});

test('page has no critical accessibility violations', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const results = await new AxeBuilder({ page }).analyze();
  const critical = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious'
  );
  expect(critical).toHaveLength(0);
});
