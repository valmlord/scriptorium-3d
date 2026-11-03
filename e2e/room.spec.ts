import { expect, test } from '@playwright/test';
import { installWebGLProbe, readWebGLProbe } from './webgl-probe';

/**
 * M4's end-to-end scenario: the room reaches the screen, and the 640 spines
 * reach it as one draw call.
 *
 * The roadmap's gate for M4 is "60 fps on the reference machine, one draw call
 * for the spines, no per-frame allocation". The draw call is the half of it
 * that a browser can answer, and this is where it is answered — in a real
 * WebGL context, by counting the GL's own calls. The allocation half is
 * counted in `src/engine/__tests__/frame-allocation.test.ts`; the frame rate
 * is not claimed, because no machine in CI is the reference machine.
 */

/** 4 walls * 5 shelves * 32 volumes. Restated here because the page cannot be asked. */
const SPINES_PER_ROOM = 640;

/**
 * The instance counts a room can legitimately issue: the four wall panels, the
 * twenty shelf boards, the 640 spines and the two lamp globes. Which of them
 * appear in a given frame depends on frustum culling — the lamps hang behind
 * the camera for most of the turn — so the assertion is over the set, not over
 * a fixed length.
 */
const LEGITIMATE_INSTANCE_COUNTS = [4, 20, 640, 2];

/** Those four, plus the floor plate and the ceiling plate. */
const MAX_DRAW_CALLS = 6;

/** Frames to let pass before reading the probe. */
const FRAMES = 6;

/** Frames read as settled, skipping anything the first frame does differently. */
const SETTLED_FROM = 3;

test('the 640 spines of a room are drawn in one instanced call', async ({ page }) => {
  await installWebGLProbe(page);

  await page.goto('/');
  const report = await readWebGLProbe(page, FRAMES);

  const settled = report.frames.slice(SETTLED_FROM);
  expect(settled.length).toBeGreaterThan(0);

  for (const frame of settled) {
    const spineCalls = frame.instanced.filter((count) => count === SPINES_PER_ROOM);

    // The claim: 640 volumes, one draw call. Not 640 calls, and not two.
    expect(spineCalls).toHaveLength(1);
    // And the rest of the room with it, so that a regression into per-mesh
    // drawing anywhere in the room shows up here rather than only in a frame
    // time somebody has to notice.
    for (const instanceCount of frame.instanced) {
      expect(LEGITIMATE_INSTANCE_COUNTS).toContain(instanceCount);
    }
    expect(frame.instanced.length + frame.plain).toBeLessThanOrEqual(MAX_DRAW_CALLS);
  }
});

test('the room is on the screen, not a blank canvas', async ({ page }) => {
  await installWebGLProbe(page);

  await page.goto('/');
  const report = await readWebGLProbe(page, FRAMES);

  const pixels = report.pixels;
  expect(pixels).not.toBeNull();
  if (pixels === null) {
    return;
  }

  expect(pixels.sampled).toBeGreaterThan(100_000);
  // A blank canvas has exactly one colour in it. A lit room of coloured
  // bindings under exponential fog has thousands, on any driver.
  expect(pixels.distinctColors).toBeGreaterThan(1_000);
  // And the room fills the view rather than being a few pixels in a corner.
  expect(pixels.nonBackgroundRatio).toBeGreaterThan(0.5);
});
