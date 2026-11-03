/**
 * Dedicated error types for the ways a request to the engine can be wrong, in
 * the pattern of `src/core/errors.ts` and `src/app/errors.ts`: each carries
 * the offending value and what was expected of it.
 *
 * Address components are `core`'s business and are refused there — a wall of 7
 * raises `InvalidAddressError` from `assertValidAddress`, and nothing here
 * restates those ranges. What the engine owns is the one quantity `core` has
 * no name for: the instance slot, an index into the room's single
 * `InstancedMesh`.
 */

/**
 * An instance slot is not an integer in `[0, SPINES_PER_ROOM)`. The usual
 * cause is a raycast hit from a mesh other than the spines, whose `instanceId`
 * then indexes a room that does not have that many volumes — which would
 * otherwise resolve to a plausible address for the wrong object.
 */
export class InvalidInstanceSlotError extends Error {
  readonly slot: number;
  readonly max: number;

  constructor(slot: number, max: number) {
    super(
      `Instance slot ${String(slot)} is not an integer in [0, ${String(max + 1)}): a room holds ${String(max + 1)} volumes`
    );
    this.name = 'InvalidInstanceSlotError';
    this.slot = slot;
    this.max = max;
  }
}
