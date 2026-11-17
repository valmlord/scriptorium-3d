import type { PerspectiveCamera } from 'three';
import type { CameraPose } from '@motion/rig';
import { ROOM_HEIGHT } from './constants';
import { cameraFocus } from './scratch';

/**
 * The rig, copied onto the camera.
 *
 * This function is the only writer of the camera's position, orientation and
 * field of view (`docs/architecture.md` §2), it is called exactly once per
 * frame from the one `setAnimationLoop` in `./viewer.ts`, and it allocates
 * nothing: the point it looks at is the module scratch of `./scratch.ts`, and
 * `lookAt` is handed that same object every frame.
 *
 * It is also the whole of what `engine` knows about motion. The rig's six
 * numbers are animated in `src/motion` with no three.js in sight (ADR-0004),
 * and the camera is where those numbers stop being numbers.
 *
 * **The rig's frame is the room's own.** `bearing`, `radial` and `lateral` are
 * the three parameters `placeOnSide` in `./layout.ts` places every object in a
 * room with, so the arithmetic below is that function's arithmetic: `radial`
 * out along the bearing, `lateral` along the wall's tangent, which is the
 * outward normal turned a quarter turn towards +Z. A camera at a volume's
 * `lateral` and `height` is looking straight down the row at that volume, and
 * `__tests__/camera.test.ts` asserts exactly that against `spineMatrix`.
 */

/** Near and far planes that bracket a room without clipping its far wall. */
export const CAMERA_NEAR = 0.05;
export const CAMERA_FAR = ROOM_HEIGHT * 25;

/**
 * The field of view the camera is built with, and the one the room level uses.
 * A flight narrows it as it closes in, which is the rig's business from then
 * on: `fov` is one of its six fields precisely so that nothing else writes it.
 */
export const CAMERA_FOV = 58;

/**
 * How far ahead the point the camera looks at is placed, in metres.
 *
 * Any positive distance gives the same orientation, because `lookAt` only uses
 * the direction. One metre keeps the numbers in the same range as the room, so
 * a focus point printed in a debug session reads as a place rather than as a
 * scaled vector.
 */
const LOOK_REACH = 1;

/** Point `camera` where `rig` says, and give it the rig's field of view. */
export function applyRig(camera: PerspectiveCamera, rig: CameraPose): void {
  const outwardX = Math.cos(rig.bearing);
  const outwardZ = Math.sin(rig.bearing);
  const x = outwardX * rig.radial - outwardZ * rig.lateral;
  const z = outwardZ * rig.radial + outwardX * rig.lateral;
  camera.position.set(x, rig.height, z);

  // Straight ahead along the bearing, lifted by the pitch. The camera looks
  // along the wall's normal rather than at a point on it, which is what keeps
  // the shelves square in the frame instead of converging.
  const ahead = Math.cos(rig.pitch) * LOOK_REACH;
  cameraFocus.set(
    x + outwardX * ahead,
    rig.height + Math.sin(rig.pitch) * LOOK_REACH,
    z + outwardZ * ahead
  );
  camera.lookAt(cameraFocus);

  // Only when it has actually changed: the projection matrix is recomputed by
  // `updateProjectionMatrix`, and a flight changes the field of view on a
  // fraction of the frames it runs for.
  if (camera.fov !== rig.fov) {
    camera.fov = rig.fov;
    camera.updateProjectionMatrix();
  }
}
