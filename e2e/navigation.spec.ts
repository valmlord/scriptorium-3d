import { expect, test } from '@playwright/test';
import {
  hookAddress,
  hookFramesRefusal,
  hookIsInstalled,
  hookLevel,
  hookRig,
  waitForIdle,
} from './debug-hook';
import {
  CURSOR_OVER_VOLUME,
  clickFirstVolume,
  cursorOnCanvas,
  findVolume,
} from './spines';

/**
 * M5's end-to-end scenario: the room is a place you move through.
 *
 * Nothing here waits on a duration. Every step waits on `waitForIdle()` from
 * the debug hook, which is exactly why that hook exists (`docs/testing.md`
 * §7) — a `waitForTimeout(2000)` would pass on a machine that is fast enough
 * and fail on a loaded CI runner, and both outcomes would say nothing about
 * the camera.
 *
 * The suite runs against `npm run build:e2e`: the production pipeline in test
 * mode, which keeps the hook. What the production bundle contains is asserted
 * in `src/__tests__/production-bundle.test.ts`, because a browser cannot be
 * asked about a build it is not running.
 */

/** The top of the frame at the room's vantage is ceiling, not shelf. */
const CEILING_FRACTION = 0.04;

test('the debug hook answers where the application is', async ({ page }) => {
  await page.goto('/');
  await waitForIdle(page);

  expect(await hookIsInstalled(page)).toBe(true);
  expect(await hookLevel(page)).toBe('room');
  expect(await hookAddress(page)).toBeNull();

  const rig = await hookRig(page);
  // The room's own vantage: standing on the far side of the room, which is a
  // negative radial, at the height of someone looking at a wall.
  expect(rig.radial).toBeLessThan(0);
  expect(rig.height).toBeGreaterThan(1);
  expect(rig.lateral).toBe(0);
});

test('the hook refuses to report a frame budget it has not measured', async ({
  page,
}) => {
  await page.goto('/');

  // M10 collects frame timings. Until then this says so rather than reporting
  // zeros, which would make a budget assertion pass against nothing.
  expect(await hookFramesRefusal(page)).toMatch(/M10/);
});

test('the pointer tells a volume from the fabric of the room', async ({ page }) => {
  await page.goto('/');
  await waitForIdle(page);
  const canvas = page.locator('canvas#canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();

  const overVolume = await findVolume(page);

  expect(overVolume).not.toBeNull();
  // And the ceiling is not a book: a hover that answered "yes" everywhere
  // would pass the assertion above and mean nothing.
  await page.mouse.move(
    (box?.x ?? 0) + (box?.width ?? 0) / 2,
    (box?.y ?? 0) + (box?.height ?? 0) * CEILING_FRACTION
  );
  expect(await cursorOnCanvas(page)).not.toBe(CURSOR_OVER_VOLUME);
});

test('clicking a volume flies to it, and Escape flies back', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(error.toString());
  });

  await page.goto('/');
  await waitForIdle(page);
  await clickFirstVolume(page);
  await waitForIdle(page);

  // One click from the room level descends the whole ladder: the wall, then
  // the shelf, then the book, as one flight.
  expect(await hookLevel(page)).toBe('book');
  const address = await hookAddress(page);
  expect(address).not.toBeNull();
  expect(address?.page).toBe(0);

  const atBook = await hookRig(page);
  expect(atBook.radial).toBeGreaterThan(1);

  await page.keyboard.press('Escape');
  await waitForIdle(page);
  expect(await hookLevel(page)).toBe('shelf');

  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await waitForIdle(page);

  // Back where it started, and the room's vantage is a place rather than
  // wherever the camera happened to end up.
  expect(await hookLevel(page)).toBe('room');
  expect(await hookAddress(page)).toBeNull();
  const atRoom = await hookRig(page);
  expect(atRoom.radial).toBeLessThan(0);
  expect(consoleErrors).toEqual([]);
});
