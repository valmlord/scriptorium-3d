import { createViewer } from '@engine/viewer';

/**
 * Entry point. Mounts the canvas and opens the library at its first room.
 *
 * Composition is `@app`'s job from M8 onward, when the router decides which
 * address the page opens at. Until there is a URL scheme wired up, this is the
 * whole of it: find the canvas, build the viewer, load room 0 and start the
 * loop.
 */

/** Where the library opens until the router of M8 says otherwise. */
const FIRST_ROOM = 0n;

const canvas = document.getElementById('canvas');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('Canvas element not found');
}

const viewer = createViewer(canvas);
viewer.loadRoom(FIRST_ROOM);
viewer.start();
