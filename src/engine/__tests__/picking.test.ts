import { describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three';
import { CAMERA_FAR, CAMERA_FOV, CAMERA_NEAR, applyRig } from '@engine/camera';
import { volumeLateralOffset } from '@engine/layout';
import { createSpinePicker, pointerNdcX, pointerNdcY } from '@engine/picking';
import { ROOM_POSE, bookPose, shelfPose } from '@engine/poses';
import { createRoom } from '@engine/room';
import type { RoomHandle } from '@engine/room';
import {
  SPINES_PER_ROOM,
  bookAddressToSlot,
  slotToBookAddress,
  slotToCoordinates,
} from '@engine/slots';

/**
 * Picking is how a pointer becomes an address, and if it is wrong the reader
 * opens a book that is not the one they clicked — both of them equally
 * plausible, which is this project's whole class of danger. So every one of
 * the 640 slots is aimed at and read back, rather than a handful.
 *
 * No WebGL anywhere: a `Raycaster` is arithmetic over the room's geometry, and
 * the room builds in Node exactly as it does in a browser (`docs/testing.md`
 * §1). What the renderer normally does and these tests do by hand is update
 * the world matrices.
 */

const ROOM = 0n;

/** A camera with the application's own projection, as `./viewer.ts` builds it. */
function createCamera(): PerspectiveCamera {
  return new PerspectiveCamera(CAMERA_FOV, 16 / 9, CAMERA_NEAR, CAMERA_FAR);
}

/** A room whose world matrices are current, as a drawn frame leaves them. */
function createReadyRoom(): RoomHandle {
  const handle = createRoom(ROOM);
  handle.group.updateMatrixWorld(true);
  return handle;
}

describe('a pointer offset as a normalised device coordinate', () => {
  it('puts the middle of the canvas at the origin', () => {
    expect(pointerNdcX(400, 800)).toBeCloseTo(0, 12);
    expect(pointerNdcY(300, 600)).toBeCloseTo(0, 12);
  });

  it('puts the top left corner at (-1, 1) and the bottom right at (1, -1)', () => {
    expect(pointerNdcX(0, 800)).toBe(-1);
    expect(pointerNdcY(0, 600)).toBe(1);
    expect(pointerNdcX(800, 800)).toBe(1);
    expect(pointerNdcY(600, 600)).toBe(-1);
  });
});

describe('picking a volume', () => {
  it('returns the slot of every one of the 640 volumes when aimed at it', () => {
    const handle = createReadyRoom();
    const camera = createCamera();
    const picker = createSpinePicker();

    const wrong: string[] = [];
    for (let slot = 0; slot < SPINES_PER_ROOM; slot += 1) {
      const { wall, shelf, volume } = slotToCoordinates(slot);
      applyRig(camera, bookPose(wall, shelf, volume));
      camera.updateMatrixWorld(true);

      const picked = picker.pick(0, 0, camera, handle.spines);
      if (picked !== slot) {
        wrong.push(`slot ${String(slot)} picked ${String(picked)}`);
      }
    }

    expect(wrong).toEqual([]);
    handle.dispose();
  });

  it('resolves the slot it picks to the address of that volume', () => {
    const handle = createReadyRoom();
    const camera = createCamera();
    const picker = createSpinePicker();
    const address = { room: ROOM, wall: 2, shelf: 3, volume: 17 };

    applyRig(camera, bookPose(address.wall, address.shelf, address.volume));
    camera.updateMatrixWorld(true);
    const slot = picker.pick(0, 0, camera, handle.spines);

    expect(slot).toBe(bookAddressToSlot(address));
    expect(slot === null ? null : slotToBookAddress(ROOM, slot)).toEqual(address);
    handle.dispose();
  });

  it('picks a volume from across the room, not only from in front of it', () => {
    const handle = createReadyRoom();
    const camera = createCamera();
    const picker = createSpinePicker();
    // On the room's axis, level with shelf 2 of wall 0 and opposite volume 20:
    // a metre and a half away rather than a third of one, which is the
    // distance a reader chooses a book from before flying to it.
    applyRig(camera, {
      ...shelfPose(0, 2),
      radial: 0,
      lateral: volumeLateralOffset(20),
    });
    camera.updateMatrixWorld(true);

    const slot = picker.pick(0, 0, camera, handle.spines);

    expect(slot).not.toBeNull();
    expect(slotToCoordinates(slot ?? -1)).toEqual({ wall: 0, shelf: 2, volume: 20 });
    handle.dispose();
  });

  it('picks nothing where the pointer is over the fabric of the room', () => {
    const handle = createReadyRoom();
    const camera = createCamera();
    const picker = createSpinePicker();
    applyRig(camera, ROOM_POSE);
    camera.updateMatrixWorld(true);

    // The top edge of the frame at the room's vantage is the ceiling, which is
    // not a volume. A pick has to answer "nothing" rather than the nearest
    // plausible spine.
    expect(picker.pick(0, 1, camera, handle.spines)).toBeNull();
    handle.dispose();
  });

  it('does not pick a volume the room does not draw', () => {
    const handle = createReadyRoom();
    const camera = createCamera();
    const picker = createSpinePicker();
    const address = { room: ROOM, wall: 0, shelf: 0, volume: 5 };
    applyRig(camera, bookPose(address.wall, address.shelf, address.volume));
    camera.updateMatrixWorld(true);
    expect(picker.pick(0, 0, camera, handle.spines)).toBe(bookAddressToSlot(address));

    // The unfilled tail of the last room is left undrawn (SPEC §3), and what is
    // undrawn must not be pickable: a spine you can click and not open is worse
    // than a gap in the shelf.
    handle.spines.count = 1;

    expect(picker.pick(0, 0, camera, handle.spines)).toBeNull();
    handle.dispose();
  });
});
