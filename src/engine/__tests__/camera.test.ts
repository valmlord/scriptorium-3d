import { describe, expect, it, vi } from 'vitest';
import { Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { CAMERA_FOV, applyRig } from '@engine/camera';
import { ROOM_INRADIUS } from '@engine/constants';
import { spineMatrix } from '@engine/layout';
import { ROOM_POSE, bookPose } from '@engine/poses';
import type { CameraPose } from '@motion/rig';

/**
 * `applyRig` is where the rig's six numbers stop being numbers. It is the one
 * writer of the camera (`docs/architecture.md` §2) and the one place where the
 * rig's cylindrical frame has to agree with the frame the room is built in, so
 * the test that matters is the agreement: a camera at a volume's pose is
 * looking straight at that volume, checked against `spineMatrix` rather than
 * against a second copy of the arithmetic.
 */

/** The position a layout matrix puts an object at. */
function positionOf(matrix: Matrix4): Vector3 {
  return new Vector3().setFromMatrixPosition(matrix);
}

/** How far a point is from the room's vertical axis, which is what `radial` measures. */
function axisDistance(point: Vector3): number {
  return Math.hypot(point.x, point.z);
}

/** A few volumes spread over the walls, shelves and both ends of a shelf. */
const VOLUMES: readonly { wall: number; shelf: number; volume: number }[] = [
  { wall: 0, shelf: 0, volume: 0 },
  { wall: 1, shelf: 2, volume: 15 },
  { wall: 2, shelf: 4, volume: 31 },
  { wall: 3, shelf: 1, volume: 7 },
];

describe('a camera at a book pose', () => {
  it.each(VOLUMES)(
    'looks straight at the volume on wall $wall, shelf $shelf, volume $volume',
    ({ wall, shelf, volume }) => {
      const camera = new PerspectiveCamera(CAMERA_FOV, 1.5, 0.05, 60);

      applyRig(camera, bookPose(wall, shelf, volume));

      const spine = positionOf(spineMatrix(wall, shelf, volume, new Matrix4()));
      const towardsSpine = spine.clone().sub(camera.position).normalize();
      const forward = camera.getWorldDirection(new Vector3());

      // Dead on: the pose shares the volume's height and its offset along the
      // wall, and looks out along the wall's own normal.
      expect(forward.dot(towardsSpine)).toBeCloseTo(1, 9);
      expect(camera.position.y).toBeCloseTo(spine.y, 12);
      // And in front of it, inside the room rather than inside the shelf.
      expect(axisDistance(camera.position)).toBeLessThan(axisDistance(spine));
    }
  );
});

describe('the rig’s frame', () => {
  it('puts the camera out along the bearing, with lateral across it', () => {
    const camera = new PerspectiveCamera(CAMERA_FOV, 1.5, 0.05, 60);

    // Bearing zero is +X, so lateral runs along +Z: the outward normal turned
    // a quarter turn, which is `placeOnSide`'s convention in `./layout.ts`.
    applyRig(camera, {
      bearing: 0,
      radial: 0.5,
      height: 1.2,
      lateral: 0.25,
      pitch: 0,
      fov: CAMERA_FOV,
    });

    expect(camera.position.x).toBeCloseTo(0.5, 12);
    expect(camera.position.y).toBeCloseTo(1.2, 12);
    expect(camera.position.z).toBeCloseTo(0.25, 12);
  });

  it('reads a negative radial as the far side of the room', () => {
    const camera = new PerspectiveCamera(CAMERA_FOV, 1.5, 0.05, 60);

    applyRig(camera, { ...ROOM_POSE, bearing: 0 });

    expect(camera.position.x).toBeLessThan(0);
    expect(ROOM_POSE.radial).toBeLessThan(0);
  });

  it('looks level at pitch zero and down at a negative pitch', () => {
    const camera = new PerspectiveCamera(CAMERA_FOV, 1.5, 0.05, 60);
    const level: CameraPose = {
      bearing: 0,
      radial: 0,
      height: 1,
      lateral: 0,
      pitch: 0,
      fov: CAMERA_FOV,
    };

    applyRig(camera, level);
    expect(camera.getWorldDirection(new Vector3()).y).toBeCloseTo(0, 12);

    applyRig(camera, { ...level, pitch: -Math.PI / 6 });
    expect(camera.getWorldDirection(new Vector3()).y).toBeCloseTo(-0.5, 9);

    applyRig(camera, { ...level, pitch: Math.PI / 6 });
    expect(camera.getWorldDirection(new Vector3()).y).toBeCloseTo(0.5, 9);
  });

  it('keeps the horizon level: no roll at any bearing', () => {
    const camera = new PerspectiveCamera(CAMERA_FOV, 1.5, 0.05, 60);
    const right = new Vector3();

    for (let step = 0; step < 12; step += 1) {
      applyRig(camera, { ...ROOM_POSE, bearing: (step * Math.PI) / 6, pitch: 0 });
      right.set(1, 0, 0).applyQuaternion(camera.quaternion);

      expect(right.y).toBeCloseTo(0, 12);
    }
  });
});

describe('the field of view', () => {
  it('is taken from the rig, and the projection is recomputed when it changes', () => {
    const camera = new PerspectiveCamera(CAMERA_FOV, 1.5, 0.05, 60);
    const recomputed = vi.spyOn(camera, 'updateProjectionMatrix');

    applyRig(camera, { ...ROOM_POSE, fov: 44 });

    expect(camera.fov).toBe(44);
    expect(recomputed).toHaveBeenCalledTimes(1);
  });

  it('is left alone on the frames where it has not changed', () => {
    const camera = new PerspectiveCamera(CAMERA_FOV, 1.5, 0.05, 60);
    applyRig(camera, ROOM_POSE);
    const recomputed = vi.spyOn(camera, 'updateProjectionMatrix');

    applyRig(camera, ROOM_POSE);
    applyRig(camera, { ...ROOM_POSE, bearing: 1 });

    // A flight writes the camera on every frame and changes the field of view
    // on a few of them; the projection matrix follows the field of view and
    // not the frame.
    expect(recomputed).not.toHaveBeenCalled();
    expect(camera.fov).toBe(ROOM_POSE.fov);
  });
});

describe('the room’s own vantage', () => {
  it('stands inside the room, below the ceiling, looking at a shelved wall', () => {
    const camera = new PerspectiveCamera(CAMERA_FOV, 1.5, 0.05, 60);

    applyRig(camera, ROOM_POSE);

    expect(axisDistance(camera.position)).toBeLessThan(ROOM_INRADIUS);
    expect(camera.position.y).toBeGreaterThan(1);
    // Looking across the room, not at the floor.
    expect(camera.getWorldDirection(new Vector3()).y).toBeGreaterThan(-0.2);
  });
});
