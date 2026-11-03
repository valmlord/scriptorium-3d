import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `docs/architecture.md` §2: no allocation in the loop, because a
 * `new THREE.Vector3()` per frame at 60 fps is 3600 objects a minute handed to
 * the garbage collector, and the collection it eventually triggers is a
 * dropped frame in the middle of a flight.
 *
 * This is asserted by counting, not by sampling the heap. Heap growth across
 * many frames was tried first and does not discriminate in this environment:
 * over 300 000 frames, three rounds measured 76 KiB, 3981 KiB and 4594 KiB of
 * growth for the real loop against 1062 KiB, 2237 KiB and 3506 KiB for a
 * control that allocates a `Vector3` every frame on purpose — the compiler's
 * own background work is larger than the signal, and a gate built on those
 * numbers would decide by luck (the reasoning of ADR-0013, applied to memory
 * rather than to time). Those figures are in the pull request.
 *
 * So `three`'s own constructors are wrapped and counted instead. What that
 * covers is every `new Vector3`, `new Matrix4`, `new Color`, `new Quaternion`
 * and `new Euler` written in `src/engine`; what it does not cover is three.js'
 * own internals, which bind their constructors inside the library and are not
 * reached by this, and plain objects and arrays. The claim it supports is
 * therefore exactly: the frame path allocates no three.js objects.
 */

const allocations = vi.hoisted(() => ({
  Vector3: 0,
  Matrix4: 0,
  Color: 0,
  Quaternion: 0,
  Euler: 0,
}));

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  return {
    ...actual,
    Vector3: class CountedVector3 extends actual.Vector3 {
      constructor(x?: number, y?: number, z?: number) {
        super(x, y, z);
        allocations.Vector3 += 1;
      }
    },
    Matrix4: class CountedMatrix4 extends actual.Matrix4 {
      constructor() {
        super();
        allocations.Matrix4 += 1;
      }
    },
    Color: class CountedColor extends actual.Color {
      constructor(...args: ConstructorParameters<typeof actual.Color>) {
        super(...args);
        allocations.Color += 1;
      }
    },
    Quaternion: class CountedQuaternion extends actual.Quaternion {
      constructor(x?: number, y?: number, z?: number, w?: number) {
        super(x, y, z, w);
        allocations.Quaternion += 1;
      }
    },
    Euler: class CountedEuler extends actual.Euler {
      constructor(x?: number, y?: number, z?: number, order?: never) {
        super(x, y, z, order);
        allocations.Euler += 1;
      }
    },
  };
});

const three = await import('three');
const { PerspectiveCamera } = three;
const { ORBIT_PERIOD_SECONDS, orbitBearing, updateOrbit } =
  await import('@engine/camera');
const { cameraFocus, roomInstanceColor, roomInstanceMatrix } =
  await import('@engine/scratch');
const { createRoom } = await import('@engine/room');
const { ROOM_INRADIUS } = await import('@engine/constants');
const { SPINES_PER_ROOM } = await import('@engine/slots');

/** Frames to run. 10 000 at 60 fps is nearly three minutes of flying. */
const FRAMES = 10_000;

function totalAllocations(): number {
  return Object.values(allocations).reduce((sum, count) => sum + count, 0);
}

/** Start each measurement from zero. */
function resetCounters(): void {
  allocations.Vector3 = 0;
  allocations.Matrix4 = 0;
  allocations.Color = 0;
  allocations.Quaternion = 0;
  allocations.Euler = 0;
}

// The module-level scratch is allocated once when the modules above load,
// which is before any test runs. Counting restarts here, so what is counted is
// what the work under test allocates.
beforeEach(resetCounters);

describe('the frame path', () => {
  it('allocates no three.js objects over ten thousand frames', () => {
    const camera = new PerspectiveCamera(58, 1.5, 0.05, 60);
    resetCounters();

    for (let frame = 0; frame < FRAMES; frame += 1) {
      updateOrbit(camera, frame / 60);
    }

    expect(allocations).toEqual({
      Vector3: 0,
      Matrix4: 0,
      Color: 0,
      Quaternion: 0,
      Euler: 0,
    });
  });

  it('writes the module scratch rather than a fresh vector of its own', () => {
    const camera = new PerspectiveCamera(58, 1.5, 0.05, 60);
    const focus = cameraFocus;

    updateOrbit(camera, ORBIT_PERIOD_SECONDS / 12);

    // A sixth of a turn from the phase the orbit starts at brings the wall
    // bearing to 90 degrees, so the focus is out along +Z and nowhere else,
    // and the camera stands on the opposite side of the room from it.
    expect(cameraFocus).toBe(focus);
    expect(focus.x).toBeCloseTo(0, 9);
    expect(focus.z).toBeGreaterThan(ROOM_INRADIUS);
    expect(camera.position.z).toBeLessThan(0);
    expect(orbitBearing(ORBIT_PERIOD_SECONDS / 12)).toBeCloseTo(Math.PI / 2, 12);
  });

  it('is the only writer of the camera, and moves it every frame', () => {
    const camera = new PerspectiveCamera(58, 1.5, 0.05, 60);

    updateOrbit(camera, 0);
    const start = camera.position.clone();
    updateOrbit(camera, ORBIT_PERIOD_SECONDS / 2);
    const half = camera.position.clone();
    updateOrbit(camera, ORBIT_PERIOD_SECONDS);

    expect(half.x).toBeCloseTo(-start.x, 9);
    expect(half.y).toBeCloseTo(start.y, 12);
    expect(camera.position.x).toBeCloseTo(start.x, 9);
    expect(camera.position.z).toBeCloseTo(start.z, 9);
  });
});

describe('building a room', () => {
  it('reuses one matrix and one colour for all 640 spines', () => {
    const matrix = roomInstanceMatrix;
    const spineColor = roomInstanceColor;

    const handle = createRoom(0n);

    expect(handle.spines.count).toBe(SPINES_PER_ROOM);
    // 664 instance transforms and 640 colours, and not one object allocated
    // for any of them: the builder writes the two singletons in place.
    expect(allocations.Matrix4).toBe(0);
    expect(allocations.Color).toBe(0);
    expect(allocations.Quaternion).toBe(0);
    expect(allocations.Euler).toBe(0);
    expect(roomInstanceMatrix).toBe(matrix);
    expect(roomInstanceColor).toBe(spineColor);

    handle.dispose();
  });

  it('counts the allocations it is asked to count', () => {
    // The counters are the apparatus of this file, so they are themselves
    // checked: a test that cannot see an allocation it was shown proves
    // nothing about the ones it did not see.
    const before = totalAllocations();

    void new three.Vector3();
    void new three.Matrix4();
    void new three.Color();
    void new three.Quaternion();
    void new three.Euler();

    expect(totalAllocations()).toBe(before + 5);
  });
});
