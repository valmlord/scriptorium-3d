import { createSpinePicker, pointerNdcX, pointerNdcY } from '@engine/picking';
import { slotToBookAddress } from '@engine/slots';
import type { Viewer } from '@engine/viewer';
import type { Choreography } from './choreography';

/**
 * The pointer and the keyboard, turned into navigation events.
 *
 * This is the only part of M5 that touches the DOM, which is why it is as thin
 * as it is: a pick resolves to an instance slot in `@engine/picking`,
 * `slotToBookAddress` turns the slot into an address, and the choreography
 * decides what that means. Nothing here knows what a level is.
 *
 * **Hovering and choosing are the same pick.** The difference is what happens
 * to the answer: a hover sets the cursor, so the reader can tell a spine they
 * can open from the fabric of the room, and a click flies to it. The hover's
 * appearance is M6's, where a spine gains a title overlay; the cursor is what
 * M5 owes it.
 *
 * **Escape goes back up a level.** Keyboard navigation proper is M10's, and
 * until there is a reader with a close button (M6) a flight into a book needs
 * at least one way out that does not involve reloading the page.
 */

/** The key that goes up a level. */
const BACK_KEY = 'Escape';

/** The cursor over a volume, and over everything else. */
const CURSOR_OVER_VOLUME = 'pointer';
const CURSOR_DEFAULT = 'default';

/**
 * Install the pointer and key handlers. Returns the function that removes
 * them again, which is what a test and a hot reload both need.
 */
export function installControls(
  canvas: HTMLCanvasElement,
  viewer: Viewer,
  choreography: Choreography
): () => void {
  const picker = createSpinePicker();

  /** The slot under `event`, or `null` where there is no room or no hit. */
  const slotUnder = (event: PointerEvent | MouseEvent): number | null => {
    const room = viewer.room;
    if (room === null) {
      return null;
    }
    const bounds = canvas.getBoundingClientRect();
    return picker.pick(
      pointerNdcX(event.clientX - bounds.left, bounds.width),
      pointerNdcY(event.clientY - bounds.top, bounds.height),
      viewer.camera,
      room.spines
    );
  };

  const onPointerMove = (event: PointerEvent): void => {
    canvas.style.cursor =
      slotUnder(event) === null ? CURSOR_DEFAULT : CURSOR_OVER_VOLUME;
  };

  const onPointerLeave = (): void => {
    canvas.style.cursor = CURSOR_DEFAULT;
  };

  const onClick = (event: MouseEvent): void => {
    const room = viewer.room;
    const slot = slotUnder(event);
    if (room === null || slot === null) {
      return;
    }
    // The slot is an index into this room's spines, so the address it stands
    // for is that room's. `@engine/slots` owns that mapping; nothing here
    // reconstructs it.
    choreography.openVolume(slotToBookAddress(room.room, slot));
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== BACK_KEY) {
      return;
    }
    if (choreography.back()) {
      event.preventDefault();
    }
  };

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('click', onClick);
  window.addEventListener('keydown', onKeyDown);

  return () => {
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('click', onClick);
    window.removeEventListener('keydown', onKeyDown);
    canvas.style.cursor = CURSOR_DEFAULT;
  };
}
