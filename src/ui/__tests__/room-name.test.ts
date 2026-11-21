import { describe, expect, it } from 'vitest';
import { ROOM_COUNT, roomToName } from '@core/address';
import { REPORTED_ROOM_NAME_CHARACTERS, describeRoom } from '@ui/room-name';

/** The smallest room whose name is exactly `length` characters: `1` and zeros. */
function firstRoomNamed(length: number): bigint {
  return 36n ** BigInt(length - 1);
}

describe('a room name bounded for a line of text', () => {
  it('shows a short name whole', () => {
    expect(describeRoom(0n)).toBe('0');
    expect(describeRoom(35n)).toBe('z');
  });

  it('shows a name of exactly the bound whole', () => {
    const room = firstRoomNamed(REPORTED_ROOM_NAME_CHARACTERS);

    expect(describeRoom(room)).toBe(roomToName(room));
    expect(describeRoom(room)).toHaveLength(REPORTED_ROOM_NAME_CHARACTERS);
  });

  it('cuts a longer name to the bound and says how long it was', () => {
    const room = firstRoomNamed(REPORTED_ROOM_NAME_CHARACTERS + 1);

    expect(describeRoom(room)).toBe(
      `1${'0'.repeat(REPORTED_ROOM_NAME_CHARACTERS - 1)} (13 characters)`
    );
  });

  it('keeps the last room to a line, naming its 3197 characters', () => {
    const description = describeRoom(ROOM_COUNT - 1n);

    expect(description).toBe(
      `${roomToName(ROOM_COUNT - 1n).slice(0, REPORTED_ROOM_NAME_CHARACTERS)} (3197 characters)`
    );
  });
});
