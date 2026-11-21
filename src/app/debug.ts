import type { Address } from '@core/address';
import type { CameraRigSnapshot } from '@motion/rig';
import type { NavigationState } from '@state/navigation';
import { FrameTimingsUnavailableError } from './errors';

/**
 * `window.__scriptorium`, the hook `docs/testing.md` §7 specifies.
 *
 * It exists so that an end-to-end test can ask where the application is
 * instead of sleeping for two seconds and hoping. `waitForIdle` is the
 * load-bearing one: a test that waits on a fixed duration is rejected in
 * review, and this is what makes that reasonable rather than strict.
 *
 * **In development and test builds only.** The call that installs it stands
 * behind `import.meta.env.MODE !== 'production'` in `src/main.ts`, which Vite
 * replaces with a constant at build time, so the production bundle contains
 * neither the call nor this module — and `src/__tests__/production-bundle.test.ts`
 * builds the bundle and looks for the name rather than trusting that.
 *
 * **It reports and does not drive.** Every member is a question. A hook that
 * could also navigate would be a second way into the navigation machine, and
 * the machine being the only way is what architecture §4 is about.
 *
 * **It does not pretend to know what it does not.** `frames()` is M10's, where
 * the frame budget is measured, and it refuses by name until then. Returning
 * zeros would make a budget assertion pass on a hook that never measured
 * anything, which is the one failure mode a debug hook must not have.
 */

/**
 * What the renderer is holding on the device, and whether a replaced room is
 * still being kept, for a test that looks for a leak across room changes.
 */
export interface MemorySnapshot {
  /** Geometries uploaded and not yet released, from `renderer.info.memory`. */
  readonly geometries: number;
  /** Textures uploaded and not yet released, from `renderer.info.memory`. */
  readonly textures: number;
  /**
   * Shader programs the renderer holds, from `renderer.info.programs`, or
   * `null` while it has no program cache, which its constructor creates.
   */
  readonly programs: number | null;
  /**
   * Whether a replaced room is being kept for its shader programs
   * (`@engine/retirement`). The counts above include it while it is, so a leak
   * test compares them only once this is `false`.
   */
  readonly isRetiring: boolean;
}

/** What the hook answers. `docs/testing.md` §7 is the specification. */
export interface DebugHook {
  /** The current node of the navigation machine. */
  state(): NavigationState;
  /** Where the user is, or `null` above the book level. */
  address(): Address | null;
  /** The camera's numbers this frame. */
  rig(): CameraRigSnapshot;
  /** What the device holds now. Draw calls are `e2e/webgl-probe.ts`'s, per frame. */
  memory(): MemorySnapshot;
  /**
   * The rolling frame budget. M10 collects it; until then this throws
   * `FrameTimingsUnavailableError` rather than returning a shape full of
   * zeros, hence the `never`.
   */
  frames(): never;
  /** Resolves when the camera has arrived and nothing is pending. */
  waitForIdle(): Promise<void>;
}

/** Everything the hook needs in order to answer. */
export type DebugProbes = Omit<DebugHook, 'frames'>;

/**
 * Where the hook is installed. `window` satisfies it, and so does a plain
 * object, which is what lets this be tested without a DOM. The property is
 * optional because the production bundle is a build in which nothing ever
 * sets it.
 */
export interface DebugHookTarget {
  __scriptorium?: DebugHook;
}

declare global {
  interface Window {
    /**
     * Present in a development or test build and `undefined` in a production
     * one, which is what `docs/testing.md` §7 promises and what
     * `src/__tests__/production-bundle.test.ts` checks by building the bundle.
     */
    __scriptorium?: DebugHook;
  }
}

/** Install the hook on `target`, answering from `probes`. */
export function installDebugHook(target: DebugHookTarget, probes: DebugProbes): void {
  target.__scriptorium = {
    state: () => probes.state(),
    address: () => probes.address(),
    rig: () => probes.rig(),
    memory: () => probes.memory(),
    frames: () => {
      throw new FrameTimingsUnavailableError();
    },
    waitForIdle: () => probes.waitForIdle(),
  };
}
