import { Raycaster, Vector2 } from 'three';
import type { Camera, InstancedMesh, Intersection } from 'three';

/**
 * What is under the pointer.
 *
 * Picking lives in `engine` because it needs a `Raycaster` and the room's
 * actual geometry; it cannot live in `motion`, which has no three.js in it at
 * all (ADR-0004). It resolves a pointer to an instance slot and stops there:
 * `slotToBookAddress` in `./slots.ts` turns a slot into a `BookAddress`, and
 * what that means for where the user is — a hover, or a flight — is the
 * navigation machine's decision and not this module's.
 *
 * **Hovering and choosing are the same call.** The difference is only what the
 * caller does with the answer, which is why there is one function here and not
 * two.
 *
 * **Only volumes that exist can be picked.** The room's `InstancedMesh` is
 * built at full capacity and drawn at `occupiedSlots` (`./room.ts`), and
 * three.js raycasts the instances it draws, so the undrawn tail of the
 * partially-filled last room (SPEC §3) is not pickable. A spine you can click
 * and not open would be worse than a gap in the shelf.
 *
 * **Nothing here allocates per pick.** The raycaster, the pointer vector and
 * the array three.js fills with intersections are owned by the picker and
 * reused, in the spirit of `docs/architecture.md` §2 — a pointer move is not a
 * frame, but it arrives at a similar rate while the camera is flying.
 */

/** An offset inside an element, as a normalised device coordinate in `[-1, 1]`. */
export function pointerNdcX(offsetX: number, width: number): number {
  return (offsetX / width) * 2 - 1;
}

/**
 * The same for the vertical axis, which is flipped: pointer offsets grow
 * downwards and normalised device coordinates grow upwards.
 */
export function pointerNdcY(offsetY: number, height: number): number {
  return 1 - (offsetY / height) * 2;
}

/** A reusable raycast against a room's spines. */
export interface SpinePicker {
  /**
   * The instance slot of the volume under `(ndcX, ndcY)`, or `null` where the
   * pointer is over the room's fabric or outside it.
   *
   * The camera's and the mesh's world matrices have to be current. The
   * renderer updates them on every frame it draws, so a pointer event between
   * two frames reads the matrices of the frame just drawn — which is the frame
   * the user was looking at when they aimed.
   */
  pick(
    ndcX: number,
    ndcY: number,
    camera: Camera,
    spines: InstancedMesh
  ): number | null;
}

/** Build a picker. One per application; it owns the objects a pick reuses. */
export function createSpinePicker(): SpinePicker {
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  // three.js pushes into this array and sorts it by distance, nearest first.
  const hits: Intersection[] = [];

  return {
    pick(
      ndcX: number,
      ndcY: number,
      camera: Camera,
      spines: InstancedMesh
    ): number | null {
      pointer.set(ndcX, ndcY);
      hits.length = 0;
      raycaster.setFromCamera(pointer, camera);
      raycaster.intersectObject(spines, false, hits);

      const nearest = hits[0];
      if (nearest?.instanceId === undefined) {
        return null;
      }
      return nearest.instanceId;
    },
  };
}
