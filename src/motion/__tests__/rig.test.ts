import { describe, expect, it } from 'vitest';
import { RIG_FIELDS, createRig, posesEqual, snapshotOf } from '@motion/rig';
import type { CameraPose } from '@motion/rig';

/**
 * The rig is six numbers, and everything else in this layer is built from the
 * list of their names: the timeline's tween variables, the pose comparison
 * that decides whether a built flight still leads where the user is going, and
 * the snapshot the debug hook reports. A field that reaches the interface and
 * misses the list would be a field that quietly stops being animated, so the
 * list is asserted against a real rig's own keys rather than reviewed by eye.
 */

const POSE: CameraPose = {
  bearing: 1.25,
  radial: -0.45,
  height: 1.52,
  lateral: 0,
  pitch: -0.1127,
  fov: 58,
};

describe('the field list', () => {
  it('names every field a rig has, and nothing else', () => {
    const rig = createRig(POSE);

    expect([...RIG_FIELDS].sort()).toEqual(Object.keys(rig).sort());
  });
});

describe('a rig built from a pose', () => {
  it('holds the pose it was given', () => {
    expect(createRig(POSE)).toEqual(POSE);
  });

  it('is a separate object, so writing it does not write the pose', () => {
    const rig = createRig(POSE);

    rig.bearing = 99;

    expect(POSE.bearing).toBe(1.25);
  });
});

describe('a snapshot of a rig', () => {
  it('holds the values the rig had when it was taken', () => {
    const rig = createRig(POSE);

    const snapshot = snapshotOf(rig);
    rig.height = 0.1;

    expect(snapshot.height).toBe(1.52);
    expect(rig.height).toBe(0.1);
  });
});

describe('comparing two poses', () => {
  it('calls a pose equal to itself', () => {
    expect(posesEqual(POSE, { ...POSE })).toBe(true);
  });

  it.each(RIG_FIELDS)('notices a difference in %s', (field) => {
    const other: CameraPose = { ...POSE, [field]: POSE[field] + 1 };

    expect(posesEqual(POSE, other)).toBe(false);
  });
});
