import {
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  FogExp2,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  WebGLRenderer,
} from 'three';
import type { CameraPose } from '@motion/rig';
import { CAMERA_FAR, CAMERA_FOV, CAMERA_NEAR, applyRig } from './camera';
import { ROOM_POSE } from './poses';
import { createRetirement } from './retirement';
import { createRoom } from './room';
import type { RoomHandle } from './room';

/**
 * The renderer, the scene and the one animation loop.
 *
 * This is the part that needs a WebGL context, so it is kept thin enough to
 * review by eye: the arithmetic it draws lives in `./layout.ts` and
 * `./palette.ts` and is unit-tested without a context, which is what the
 * `engine` row of `docs/testing.md` §1 asks for. Nothing here decides where
 * anything stands.
 *
 * `docs/architecture.md` §2: exactly one `setAnimationLoop` in the project,
 * and it is `start()` below. There is no `requestAnimationFrame` anywhere in
 * `src/`, and gsap's own ticker does not have one either — the loop advances
 * gsap's root timeline through `src/motion/clock.ts`. The loop has one writer
 * per property, `applyRig` writing the camera and nothing else writing it, and
 * it allocates nothing.
 *
 * The loop asks its caller for the rig once per frame rather than reaching for
 * a flight itself: composing the layers is `app`'s job, and a viewer that
 * imported `state` or `motion` at runtime would be the layer boundary of
 * `docs/architecture.md` §1 going the wrong way. Without a frame source the
 * camera stands at the room's own vantage, which is what the M4 scenario in
 * `e2e/room.spec.ts` looks at.
 *
 * **Every render goes through `renderFrame()`**, whose whole body is the
 * render and the report of it to the retirement policy (`./retirement.ts`).
 * The report has to follow each render and nothing else, because it is what
 * decides when a replaced room's shader programs may be released, and
 * `__tests__/render-frame.test.ts` holds the function to exactly that shape.
 */

/** The fog and the void outside the doorways are the same colour. */
const ATMOSPHERE_COLOR = 0x0d0b09;

/**
 * Exponential-squared fog rather than linear. The library has no horizon to
 * put a far plane at, and `FogExp2` reaches zero visibility asymptotically, so
 * the corridors of M9 can recede into it without a distance at which they
 * abruptly stop existing.
 */
const FOG_DENSITY = 0.3;

/** The scene's fill light. Dim: the room's own lamps are what light it. */
const AMBIENT_COLOR = 0x6b6350;
const AMBIENT_INTENSITY = 0.35;

/**
 * Two device pixels per CSS pixel is the point past which the extra fragments
 * buy nothing visible, and a phone at ratio 3 would pay 2.25 times the
 * fragment cost for it.
 */
const MAX_PIXEL_RATIO = 2;

/** A running view of the library. */
export interface Viewer {
  /** The scene being drawn, for a caller that needs to inspect it. */
  readonly scene: Scene;
  /** The camera the loop writes. */
  readonly camera: PerspectiveCamera;
  /** The renderer, whose `info` carries the draw call count. */
  readonly renderer: WebGLRenderer;
  /** The room currently loaded, or `null` before the first `loadRoom`. */
  readonly room: RoomHandle | null;
  /** Whether a replaced room is being kept for its shader programs, for the debug hook. */
  readonly isRetiring: boolean;
  /**
   * Build `room` and put it on screen in place of the loaded one, which is
   * `room` from the moment this returns.
   *
   * A room that cannot be built throws before anything changes, leaving the
   * old one loaded. Otherwise the old room leaves the scene at once, so no
   * frame draws two rooms or picks from the wrong one, and it is handed to the
   * retirement policy rather than disposed: releasing it before the new room
   * has rendered would free the shader programs the new room is about to use,
   * and the swap frame would link them again. A room that has rendered with
   * titles is kept until the loaded room has too, through any number of loads
   * in between; one that has not is disposed after the next render, or at
   * once when a titled room is already being kept (`./retirement.ts`).
   */
  loadRoom(room: bigint): RoomHandle;
  /** Begin the one animation loop. */
  start(): void;
  /** Stop the loop, leaving the scene loaded. */
  stop(): void;
  /**
   * Stop the loop and release the retiring room, the loaded room, the
   * renderer and the resize listener.
   */
  dispose(): void;
}

/** What a viewer needs from the layer composing it. */
export interface ViewerOptions {
  /**
   * The rig to put the camera at, asked for once per frame with the loop's own
   * timestamp in seconds. The caller advances its animation clock here, so the
   * one loop drives every moving thing in the application.
   */
  readonly frame?: (seconds: number) => CameraPose;
}

/** Build a viewer that draws into `canvas`. Does not load a room or start. */
export function createViewer(
  canvas: HTMLCanvasElement,
  options: ViewerOptions = {}
): Viewer {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  // Both set explicitly rather than left to the default. Linear output would
  // show these materials washed out, and without tone mapping the two point
  // lights clip to white where they fall on a spine.
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new Scene();
  scene.background = new Color(ATMOSPHERE_COLOR);
  scene.fog = new FogExp2(ATMOSPHERE_COLOR, FOG_DENSITY);
  scene.add(new AmbientLight(AMBIENT_COLOR, AMBIENT_INTENSITY));

  const camera = new PerspectiveCamera(CAMERA_FOV, 1, CAMERA_NEAR, CAMERA_FAR);

  let loaded: RoomHandle | null = null;
  let running = false;
  const retirement = createRetirement();

  const resize = (): void => {
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);

  const viewer: Viewer = {
    scene,
    camera,
    renderer,
    get room(): RoomHandle | null {
      return loaded;
    },

    get isRetiring(): boolean {
      return retirement.isOccupied;
    },

    loadRoom(room: bigint): RoomHandle {
      // Built before the old one is let go, so a room that cannot be built
      // leaves the reader looking at the one they were in.
      const next = createRoom(room);
      // Out of the scene here and released by the policy through its own
      // `dispose()`, which does not touch the scene: a room handed over while
      // still in it would be drawn on top of the new one until its release.
      const outgoing = loaded;
      if (outgoing !== null) {
        scene.remove(outgoing.group);
      }
      retirement.replace(outgoing);
      loaded = next;
      scene.add(next.group);
      return next;
    },

    start(): void {
      if (running) {
        return;
      }
      running = true;
      // The only `setAnimationLoop` in the project. `time` is the timestamp
      // three.js already has; a `Clock` would be a second source of truth for
      // the same number.
      const { frame } = options;
      renderer.setAnimationLoop((time) => {
        applyRig(camera, frame?.(time / 1000) ?? ROOM_POSE);
        renderFrame();
      });
    },

    stop(): void {
      running = false;
      renderer.setAnimationLoop(null);
    },

    dispose(): void {
      viewer.stop();
      window.removeEventListener('resize', resize);
      retirement.dispose();
      unloadRoom();
      renderer.dispose();
    },
  };

  /**
   * Draw the frame and tell the policy whether the loaded room drew with
   * titles. Exactly these two statements: the report belongs after every
   * render and nowhere else, and `__tests__/render-frame.test.ts` refuses any
   * other shape. `loaded` is `null` only before the first `loadRoom`, when
   * nothing is retiring.
   */
  function renderFrame(): void {
    renderer.render(scene, camera);
    if (loaded !== null) retirement.noteRender(loaded.titles.isTitled);
  }

  function unloadRoom(): void {
    if (loaded === null) {
      return;
    }
    scene.remove(loaded.group);
    loaded.dispose();
    loaded = null;
  }

  return viewer;
}
