import type { Page } from '@playwright/test';

/**
 * A probe installed in the page before the app loads, which counts WebGL draw
 * calls, reads the drawing buffer back, and notes whether a replaced room was
 * being kept in each frame.
 *
 * Why the draw calls are counted here rather than read from
 * `renderer.info.render.calls`: counting the GL calls themselves needs nothing
 * from the application at all, and it is a level below three.js' own
 * bookkeeping, so it cannot agree with the renderer about a draw call that did
 * not happen.
 *
 * Why the pixels are read inside the animation callback: a WebGL drawing
 * buffer is cleared once the frame is composited unless `preserveDrawingBuffer`
 * is set, so `toDataURL` after the fact is unreliable. Wrapping
 * `requestAnimationFrame` and reading immediately after the application's own
 * callback returns puts the read in the same task as the draw, where the
 * buffer is still there, and needs no renderer option changed for the test.
 *
 * Why `memory().isRetiring` is read in the same place: a room replaced by a
 * search is kept only from the swap until the new room's first titled render,
 * which can be a single frame (`src/engine/retirement.ts`). Read after the
 * application's callback, in every frame that drew, it is the state that
 * frame's draw calls were issued under. Polling it from Playwright misses it:
 * a `waitForFunction` every 50 ms, the interval `readWebGLProbe` uses, missed
 * it in 10 of 10 WebKit loads on correct code when M7 measured it.
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
  /**
   * `window.__scriptorium.memory().isRetiring` once the frame had drawn, or
   * `null` in a build without the debug hook.
   */
  isRetiring: boolean | null;
}

/** One texture upload: how large it was, in pixels. */
export interface TextureUpload {
  width: number;
  height: number;
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
  /**
   * Every texture upload, in order.
   *
   * Counted because a draw-call assertion cannot tell a room whose spines
   * carry titles from one whose spines do not: both draw 640 instances in one
   * call. The atlas reaches the GPU as a `texImage2D` of its own size, so this
   * is how a test knows the titles it is asserting about are on screen.
   */
  uploads: TextureUpload[];
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
    const report: ProbeReport = { frames: [], pixels: null, uploads: [] };
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

      // Both upload calls are counted, because which one a texture takes is
      // three.js' choice and not the application's: on WebGL2 a canvas-backed
      // texture is allocated once and then sent through `texSubImage2D`, which
      // is the call the spine atlas actually makes.
      //
      // The size is read off the arguments rather than off fixed positions,
      // because each call has a sized form and a source form: with a canvas
      // the source comes last and carries its own dimensions, and in the sized
      // form the width and height are the third and fourth numbers.
      type AnyUpload = (...args: unknown[]) => void;
      const countUploads = (name: 'texImage2D' | 'texSubImage2D'): void => {
        const patchable = gl as unknown as Record<string, AnyUpload>;
        const original = patchable[name]?.bind(gl);
        if (original === undefined) {
          return;
        }
        patchable[name] = (...args: unknown[]): void => {
          const numbers = args.filter(
            (argument): argument is number => typeof argument === 'number'
          );
          const source = args.at(-1);
          report.uploads.push(
            source !== null &&
              typeof source === 'object' &&
              'width' in source &&
              'height' in source
              ? { width: Number(source.width), height: Number(source.height) }
              : { width: numbers[3] ?? 0, height: numbers[4] ?? 0 }
          );
          original(...args);
        };
      };
      countUploads('texImage2D');
      countUploads('texSubImage2D');
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
        const frame: FrameDrawCalls = { instanced: [], plain: 0, isRetiring: null };
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
        frame.isRetiring = window.__scriptorium?.memory().isRetiring ?? null;
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
