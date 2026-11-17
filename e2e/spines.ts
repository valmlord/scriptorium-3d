import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Finding a spine on the canvas, which more than one scenario needs.
 *
 * The scene is WebGL, so there is no element to click: a volume is found by
 * asking the application what the pointer is over, which is the cursor the
 * controls set (`src/app/controls.ts`). `docs/testing.md` §6 rules out pixel
 * comparison, and this is not one — it reads a state the application set,
 * through the same pointer a reader uses.
 */

/** Where to look for a spine: a grid over the middle of the canvas. */
const SCAN_COLUMNS = 9;
const SCAN_ROWS = 7;

/** The cursor the controls set over a volume. */
export const CURSOR_OVER_VOLUME = 'pointer';

/** A point on the canvas. */
export interface CanvasPoint {
  x: number;
  y: number;
}

/** The cursor the canvas is showing, or `missing` if there is no canvas. */
export function cursorOnCanvas(page: Page): Promise<string> {
  return page.evaluate(() => {
    const canvas = document.getElementById('canvas');
    return canvas instanceof HTMLCanvasElement ? canvas.style.cursor : 'missing';
  });
}

/** Every point of a scan over the canvas where the pointer is over a volume. */
export function pointsOverVolumes(page: Page): Promise<CanvasPoint[]> {
  return scanForVolumes(page, false);
}

/**
 * The first point of the scan that is over a volume.
 *
 * Stops there, which is the difference that matters to the suite's running
 * time: the full scan is 63 pointer moves and 63 round trips to the page, and
 * every scenario that only needs *a* book pays it otherwise.
 */
export async function findVolume(page: Page): Promise<CanvasPoint | null> {
  const [first] = await scanForVolumes(page, true);
  return first ?? null;
}

/** Click the first volume the scan finds, which descends the whole ladder. */
export async function clickFirstVolume(page: Page): Promise<void> {
  const target = await findVolume(page);
  expect(target).not.toBeNull();
  if (target === null) {
    return;
  }
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  await page.mouse.up();
}

async function scanForVolumes(
  page: Page,
  stopAtFirst: boolean
): Promise<CanvasPoint[]> {
  const canvas = page.locator('canvas#canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) {
    return [];
  }

  const found: CanvasPoint[] = [];
  for (let column = 1; column <= SCAN_COLUMNS; column += 1) {
    for (let row = 1; row <= SCAN_ROWS; row += 1) {
      const x = box.x + (box.width * column) / (SCAN_COLUMNS + 1);
      const y = box.y + (box.height * row) / (SCAN_ROWS + 1);
      await page.mouse.move(x, y);
      if ((await cursorOnCanvas(page)) !== CURSOR_OVER_VOLUME) {
        continue;
      }
      found.push({ x, y });
      if (stopAtFirst) {
        return found;
      }
    }
  }
  return found;
}
