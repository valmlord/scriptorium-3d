import type { Page } from '@playwright/test';

/**
 * A probe installed in the page before the app loads, which counts WebGL draw
 * calls and reads the drawing buffer back.
 *
 * Why this rather than `renderer.info.render.calls`: reaching the renderer
 * from a test needs `window.__scriptorium`, and that debug hook is M5's
 * (`docs/testing.md` §7). Counting the GL calls themselves needs nothing from
 * the application at all — and it is a level below three.js' own bookkeeping,
 * so it cannot agree with the renderer about a draw call that did not happen.
 *
 * Why the pixels are read inside the animation callback: a WebGL drawing
 * buffer is cleared once the frame is composited unless `preserveDrawingBuffer`
 * is set, so `toDataURL` after the fact is unreliable. Wrapping
 * `requestAnimationFrame` and reading immediately after the application's own
 * callback returns puts the read in the same task as the draw, where the
 * buffer is still there, and needs no renderer option changed for the test.
 *
 * This is not a pixel-diff screenshot, which `docs/testing.md` §6 rules out:
 * nothing here is compared against a stored image. It asks one question a
 * state assertion cannot — did anything reach the screen — and answers it with
 * a count of distinct colours, which does not move with the driver.
 */

/** One drawn frame's worth of draw calls, in the order the GL received them. */
export interface FrameDrawCalls {
  /** `instanceCount` of each instanced draw call. */
  instanced: number[];
  /** How many non-instanced draw calls the frame issued. */
  plain: number;
}

/** What the drawing buffer held, summarised so it survives a driver change. */
export interface PixelSummary {
  /** Pixels read. */
  sampled: number;
  /** How many distinct RGB triples appeared among them. */
  distinctColors: number;
  /** The fraction that were not the most common colour. */
  nonBackgroundRatio: number;
  /** The most common colour, as `r,g,b`. */
  dominantColor: string;
}

/** What the probe collected. */
export interface ProbeReport {
  frames: FrameDrawCalls[];
  pixels: PixelSummary | null;
}

declare global {
  interface Window {
    __webglProbe?: ProbeReport;
  }
}

/** The frame the pixels are read on. Early, but past any first-frame warm-up. */
const PIXEL_FRAME = 3;

/**
 * Install the probe. Must be called before the page navigates, so that it is
 * in place before the application's module script runs.
 */
export async function installWebGLProbe(page: Page): Promise<void> {
  await page.addInitScript((pixelFrame: number) => {
    const report: ProbeReport = { frames: [], pixels: null };
    window.__webglProbe = report;

    let current: FrameDrawCalls | null = null;
    let context: WebGL2RenderingContext | null = null;

    const summarise = (gl: WebGL2RenderingContext): PixelSummary => {
      const width = gl.drawingBufferWidth;
      const height = gl.drawingBufferHeight;
      const buffer = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);

      const counts = new Map<string, number>();
      for (let offset = 0; offset < buffer.length; offset += 4) {
        const key = `${String(buffer[offset])},${String(buffer[offset + 1])},${String(buffer[offset + 2])}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }

      let dominantColor = '';
      let dominantCount = 0;
      for (const [key, count] of counts) {
        if (count > dominantCount) {
          dominantColor = key;
          dominantCount = count;
        }
      }
      const sampled = width * height;
      return {
        sampled,
        distinctColors: counts.size,
        nonBackgroundRatio: (sampled - dominantCount) / sampled,
        dominantColor,
      };
    };

    const wrapContext = (gl: WebGL2RenderingContext): void => {
      context = gl;
      const instanced = gl.drawElementsInstanced.bind(gl);
      const instancedArrays = gl.drawArraysInstanced.bind(gl);
      const elements = gl.drawElements.bind(gl);
      const arrays = gl.drawArrays.bind(gl);

      gl.drawElementsInstanced = (mode, count, type, offset, instanceCount) => {
        current?.instanced.push(instanceCount);
        instanced(mode, count, type, offset, instanceCount);
      };
      gl.drawArraysInstanced = (mode, first, count, instanceCount) => {
        current?.instanced.push(instanceCount);
        instancedArrays(mode, first, count, instanceCount);
      };
      gl.drawElements = (mode, count, type, offset) => {
        if (current !== null) {
          current.plain += 1;
        }
        elements(mode, count, type, offset);
      };
      gl.drawArrays = (mode, first, count) => {
        if (current !== null) {
          current.plain += 1;
        }
        arrays(mode, first, count);
      };
    };

    // Patched on the prototype, so the probe catches whichever canvas the
    // application chooses rather than one the test had to find first.
    type AnyGetContext = (
      this: HTMLCanvasElement,
      contextId: string,
      options?: unknown
    ) => RenderingContext | null;
    const prototype = HTMLCanvasElement.prototype as unknown as {
      getContext: AnyGetContext;
    };
    const originalGetContext = prototype.getContext;
    prototype.getContext = function patched(contextId, options) {
      const result = originalGetContext.call(this, contextId, options);
      if (contextId === 'webgl2' && result !== null && context === null) {
        wrapContext(result as WebGL2RenderingContext);
      }
      return result;
    };

    const originalRequestFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
      originalRequestFrame((time) => {
        const frame: FrameDrawCalls = { instanced: [], plain: 0 };
        current = frame;
        try {
          callback(time);
        } finally {
          current = null;
        }
        // Only a callback that drew something is a frame. Playwright's own
        // `waitForFunction` polls through `requestAnimationFrame` by default,
        // and those callbacks would otherwise be counted as frames in which
        // the renderer mysteriously drew nothing.
        if (frame.instanced.length === 0 && frame.plain === 0) {
          return;
        }
        report.frames.push(frame);
        // Read inside the callback, where the buffer the frame just drew into
        // has not been composited away yet.
        if (report.frames.length === pixelFrame && context !== null) {
          report.pixels = summarise(context);
        }
      });
  }, PIXEL_FRAME);
}

/**
 * Wait until the probe has seen `frames` frames, then return what it holds.
 * Waiting on the frame count rather than on a duration: `docs/testing.md` §7
 * rejects a test that sleeps on a fixed number of milliseconds.
 */
export async function readWebGLProbe(page: Page, frames: number): Promise<ProbeReport> {
  await page.waitForFunction(
    (wanted: number) => (window.__webglProbe?.frames.length ?? 0) >= wanted,
    frames,
    // Polled on a timer rather than on the default `requestAnimationFrame`,
    // so that waiting for frames does not add frames of its own.
    { polling: 50 }
  );
  const report = await page.evaluate(() => window.__webglProbe);
  if (report === undefined) {
    throw new Error('The WebGL probe was not installed before the page loaded');
  }
  return report;
}
