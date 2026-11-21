import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Finding a spine on the canvas, which more than one scenario needs.
 *
 * The scene is WebGL, so there is no element to click: a volume is found by
 * asking the application what the pointer is over, which is the cursor the
 * controls set (`src/app/controls.ts`). `docs/testing.md` §6 rules out pixel
 * comparison, and this is not one: it reads a state the application set.
 * `findVolume` and `clickFirstVolume` move the pointer a reader moves;
 * `clickFirstVolumeInPage` dispatches the controls' `pointermove` and `click`
 * inside the page instead, and `cursorOnCanvas` moves nothing, it only reads
 * the cursor.
 */

/** Where to look for a spine: a grid over the middle of the canvas. */
const SCAN_COLUMNS = 9;
const SCAN_ROWS = 7;

/** A point of the scan, as fractions of the canvas's width and height. */
interface ScanFraction {
  x: number;
  y: number;
}

/**
 * The scan's points in the order they are tried, column by column. Both scans
 * read this one list, so they try the same points in the same order.
 */
function scanGrid(): ScanFraction[] {
  const points: ScanFraction[] = [];
  for (let column = 1; column <= SCAN_COLUMNS; column += 1) {
    for (let row = 1; row <= SCAN_ROWS; row += 1) {
      points.push({ x: column / (SCAN_COLUMNS + 1), y: row / (SCAN_ROWS + 1) });
    }
  }
  return points;
}

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

/**
 * The first point of a scan over the canvas that is over a volume.
 *
 * It stops there, and that is what keeps the scan off the clock (#54). A
 * browser that draws this scene without a GPU (headless Chromium uses
 * SwiftShader even on a machine that has one) makes every round trip to the
 * page wait on its render loop, so a pointer move or a cursor read costs
 * whatever software rendering costs on that machine at that moment. The whole
 * grid is 63 of each, so a scan that did not stop was 126 such round trips,
 * raced against the fixed test timeout, and lost it whenever the machine was
 * slow enough. Stopping at the first hit makes the number of round trips a
 * property of the room's layout instead of the machine's speed: when #54 was
 * measured, the first point of the grid was already over a volume at the
 * opening vantage. The measurements, and the machines they were taken on, are
 * in the pull request that closed #54.
 */
export async function findVolume(page: Page): Promise<CanvasPoint | null> {
  const [first] = await scanForVolumes(page);
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

/**
 * `clickFirstVolume` in one round trip, after a wait for idle: the same grid,
 * scanned in the same order and stopped at the same first point over a
 * volume, and a click there, all dispatched inside the page.
 *
 * `clickFirstVolume` costs six round trips when the first point is over a
 * volume and two more for each point that is not, and a caller's wait for
 * idle before it one more; here they are one, and on a slow CI runner each
 * costs about 0.8 s (#69). The wait comes first so that a caller can follow
 * `page.goto` directly.
 *
 * The controls receive what the browser would have given them: a
 * `pointermove` on the canvas at each point and a `click` on it at the
 * volume. Of the four listeners `src/app/controls.ts` registers, those reach
 * the canvas's `pointermove` and `click` handlers, the two the scan needs; the
 * canvas's third, `pointerleave`, only resets the cursor; the fourth,
 * `keydown` on `window`, hears none of these events; none reads `isTrusted`.
 * A point where another element is on top of the canvas is skipped: a real
 * pointer there reaches that element, and the canvas's `pointerleave` resets
 * its cursor.
 */
export async function clickFirstVolumeInPage(page: Page): Promise<void> {
  const isClicked = await page.evaluate(
    async (scan: { points: ScanFraction[]; cursorOverVolume: string }) => {
      const hook = window.__scriptorium;
      const canvas = document.getElementById('canvas');
      if (hook === undefined || !(canvas instanceof HTMLCanvasElement)) {
        throw new Error('the canvas or the debug hook is missing');
      }
      await hook.waitForIdle();
      const box = canvas.getBoundingClientRect();
      for (const point of scan.points) {
        const x = box.x + box.width * point.x;
        const y = box.y + box.height * point.y;
        if (document.elementFromPoint(x, y) !== canvas) {
          continue;
        }
        const at = { clientX: x, clientY: y, bubbles: true, cancelable: true };
        canvas.dispatchEvent(new PointerEvent('pointermove', at));
        if (canvas.style.cursor !== scan.cursorOverVolume) {
          continue;
        }
        canvas.dispatchEvent(new MouseEvent('click', { ...at, button: 0 }));
        return true;
      }
      return false;
    },
    { points: scanGrid(), cursorOverVolume: CURSOR_OVER_VOLUME }
  );
  expect(isClicked, 'no point of the 9 x 7 scan was over a volume').toBe(true);
}

async function scanForVolumes(page: Page): Promise<CanvasPoint[]> {
  const canvas = page.locator('canvas#canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) {
    return [];
  }

  const found: CanvasPoint[] = [];
  for (const point of scanGrid()) {
    const x = box.x + box.width * point.x;
    const y = box.y + box.height * point.y;
    await page.mouse.move(x, y);
    if ((await cursorOnCanvas(page)) !== CURSOR_OVER_VOLUME) {
      continue;
    }
    found.push({ x, y });
    return found;
  }
  return found;
}
