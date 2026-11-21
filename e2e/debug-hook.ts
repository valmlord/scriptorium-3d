import type { Page } from '@playwright/test';

/**
 * `window.__scriptorium`, as a test sees it (`docs/testing.md` §7).
 *
 * This is what lets an end-to-end test ask the application where it is instead
 * of sleeping: every helper below waits on a state, and `waitForIdle` waits on
 * all four of the things that generate or draw - the camera flight, the worker
 * client's request table, the reader and the title resolver (`src/app/idle.ts`,
 * `docs/testing.md` §7). No test in this directory passes a duration to
 * anything.
 *
 * The hook is present because the suite runs against a **test build**
 * (`npm run build:e2e`), which is the production pipeline with the one branch
 * in `src/main.ts` left in. The production bundle has no hook at all, and
 * `src/__tests__/production-bundle.test.ts` is what holds that.
 *
 * Only primitives cross the page boundary. The machine's state carries the
 * room as a `bigint`, which is not worth asking a serialiser about, so the
 * helpers return the level, the numeric components of the address and the
 * rig's numbers.
 */

/** The address a state names, without the room. */
export interface HookAddress {
  wall: number;
  shelf: number;
  volume: number;
  page: number;
}

/** The camera's numbers. */
export interface HookRig {
  bearing: number;
  radial: number;
  height: number;
  lateral: number;
  pitch: number;
  fov: number;
}

declare global {
  interface Window {
    __scriptorium?: {
      state(): { level: string };
      address(): (HookAddress & { room: bigint }) | null;
      rig(): HookRig;
      memory(): {
        geometries: number;
        textures: number;
        programs: number | null;
        isRetiring: boolean;
      };
      frames(): never;
      waitForIdle(): Promise<void>;
    };
  }
}

/** The navigation level the machine is at. */
export function hookLevel(page: Page): Promise<string> {
  return page.evaluate(() => {
    const hook = window.__scriptorium;
    if (hook === undefined) {
      throw new Error('window.__scriptorium is not installed in this build');
    }
    return hook.state().level;
  });
}

/** The address the user is at, without its room, or `null` above a book. */
export function hookAddress(page: Page): Promise<HookAddress | null> {
  return page.evaluate(() => {
    const address = window.__scriptorium?.address() ?? null;
    return address === null
      ? null
      : {
          wall: address.wall,
          shelf: address.shelf,
          volume: address.volume,
          page: address.page,
        };
  });
}

/** The camera's rig this frame. */
export function hookRig(page: Page): Promise<HookRig> {
  return page.evaluate(() => {
    const hook = window.__scriptorium;
    if (hook === undefined) {
      throw new Error('window.__scriptorium is not installed in this build');
    }
    return hook.rig();
  });
}

/** Whether the hook is there at all. */
export function hookIsInstalled(page: Page): Promise<boolean> {
  return page.evaluate(() => window.__scriptorium !== undefined);
}

/** What `frames()` does, which in M5 is refuse by name. */
export function hookFramesRefusal(page: Page): Promise<string> {
  return page.evaluate(() => {
    try {
      window.__scriptorium?.frames();
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error);
    }
    return 'frames() returned instead of refusing';
  });
}

/** Resolves when the camera has arrived and nothing is pending. */
export function waitForIdle(page: Page): Promise<void> {
  return page.evaluate(async () => {
    const hook = window.__scriptorium;
    if (hook === undefined) {
      throw new Error('window.__scriptorium is not installed in this build');
    }
    await hook.waitForIdle();
  });
}
