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

  // The engine's renderer holds a `webgl2` context on this canvas, so asking
  // for `webgl2` hands back that same context and creates nothing.
  //
  // This asked for `webgl` first until M4. Nothing drew then, so the request
  // created a fresh WebGL 1 context and the assertion passed. Now that the
  // engine owns the canvas, a request for a different context type is refused
  // and fires `webglcontextcreationerror` on the canvas — where the renderer's
  // own listener is still attached, so the probe made the application log
  // `THREE.WebGLRenderer: A WebGL context could not be created` and failed the
  // console assertion below. The probe has to ask for what the engine uses.
  const hasWebGL = await page.evaluate(() => {
    const canvas = document.getElementById('canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    return canvas.getContext('webgl2') !== null;
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
