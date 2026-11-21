import { describe, expect, it } from 'vitest';
import { NoRoomLoadedError } from '@app/errors';
import { shownRoomOf } from '@app/shown-room';
import type { LoadedRoomHolder } from '@app/shown-room';

/**
 * The getter the choreography reads the room on screen through, called for
 * real over a viewer-shaped object: the viewer itself needs a WebGL context,
 * and what is under test is the getter's answer, not the viewer's.
 */

describe('the room on screen', () => {
  it('the shown-room getter throws NoRoomLoadedError when no room is loaded', () => {
    const shownRoom = shownRoomOf({ room: null });

    expect(() => shownRoom()).toThrow(NoRoomLoadedError);
  });

  it('answers the room the holder has loaded at the moment it is read', () => {
    const holder: { room: LoadedRoomHolder['room'] } = { room: { room: 0n } };
    const shownRoom = shownRoomOf(holder);

    holder.room = { room: 37n };

    // Read through, not copied: a swap is visible to the very next read.
    expect(shownRoom()).toBe(37n);
  });
});
