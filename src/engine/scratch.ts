import { Color, Matrix4, Vector3 } from 'three';

/**
 * The module-level scratch objects of `docs/architecture.md` §2.
 *
 * A `new THREE.Vector3()` per frame at 60 fps is 3600 objects a minute handed
 * to the garbage collector, and the collection it eventually triggers is a
 * dropped frame in the middle of a camera flight. So the objects that would be
 * allocated are allocated once, here, and reused.
 *
 * Each is named for the one job it does, and every one of them is written in
 * full before it is read, so no caller can observe another's leftovers. They
 * are exported because that is what makes the reuse testable: a test can hold
 * the identity of each and assert that a frame did not replace it
 * (`__tests__/frame-allocation.test.ts`).
 *
 * The room builder and the frame loop never run inside one another, which is
 * what allows `roomInstanceMatrix` and `cameraFocus` to be separate names
 * rather than one shared buffer with a comment asking the reader to be careful.
 */

/** The transform of the one instance the room builder is placing. */
export const roomInstanceMatrix = new Matrix4();

/** The colour of the one instance the room builder is placing. */
export const roomInstanceColor = new Color();

/** The point the camera is looking at this frame. */
export const cameraFocus = new Vector3();
