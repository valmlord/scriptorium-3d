import { roomToName } from '@core/address';

/**
 * A room's name, bounded for a line of text a person reads: the search
 * panel's status line, and the console line `src/main.ts` writes for a shelf
 * the atlas refused.
 *
 * A name is base-36 and the last room's is 3197 characters long
 * (`@core/address`; 4975 is the same index in decimal, which is the figure
 * that gets quoted and is not the one that matters here). In a console line
 * the whole name would bury the rest of the message. In a status line it is
 * worse: the line is a `role="status"` region, so a screen reader would read
 * 3197 characters aloud before reaching the wall, the shelf and the volume,
 * and the panel would grow to hold them. The characters past the first few
 * identify nothing a person can act on in either place; the whole name is the
 * address bar's, with the copy button SPEC §7 asks for (M8).
 */

/**
 * How much of a room's name is shown. The length is reported beside a
 * truncated name, which is what keeps two truncated names distinguishable.
 */
export const REPORTED_ROOM_NAME_CHARACTERS = 12;

/** The room's name, whole if it is short and a prefix with its length if not. */
export function describeRoom(room: bigint): string {
  const name = roomToName(room);
  return name.length <= REPORTED_ROOM_NAME_CHARACTERS
    ? name
    : `${name.slice(0, REPORTED_ROOM_NAME_CHARACTERS)} (${String(name.length)} characters)`;
}
