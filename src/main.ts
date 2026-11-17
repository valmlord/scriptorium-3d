import { createViewer } from '@engine/viewer';
import { createChoreography } from '@app/choreography';
import { installControls } from '@app/controls';
import { installDebugHook } from '@app/debug';

/**
 * Entry point: mount the canvas, open the library at its first room, and join
 * the layers up.
 *
 * The order matters in one place. The choreography is built before the viewer
 * because the viewer asks for a rig on every frame it draws, and the room is
 * loaded before the controls are installed because a pick needs something to
 * pick from.
 *
 * `frame` is the single point where time enters the application: the one
 * `setAnimationLoop` hands its timestamp here, the choreography advances gsap's
 * root timeline with it, and the rig that comes back is written onto the
 * camera. There is no second clock and no second loop
 * (`docs/architecture.md` §2).
 *
 * The debug hook is installed only outside a production build. The condition is
 * `import.meta.env.MODE`, which Vite replaces with a literal at build time, so
 * `npm run build` drops the branch and the module behind it: the production
 * bundle contains no `__scriptorium` at all, and
 * `src/__tests__/production-bundle.test.ts` builds it and looks.
 */

/** Where the library opens until the router of M8 says otherwise. */
const FIRST_ROOM = 0n;

const canvas = document.getElementById('canvas');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('Canvas element not found');
}

const choreography = createChoreography(FIRST_ROOM);
const viewer = createViewer(canvas, {
  frame: (seconds) => choreography.frame(seconds),
});

viewer.loadRoom(FIRST_ROOM);
installControls(canvas, viewer, choreography);
viewer.start();

if (import.meta.env.MODE !== 'production') {
  installDebugHook(window, {
    state: () => choreography.state,
    address: () => choreography.address,
    rig: () => choreography.rig(),
    waitForIdle: () => choreography.whenIdle(),
  });
}
