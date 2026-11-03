import { SRGBColorSpace } from 'three';
import type { Color } from 'three';
import type { BookAddress } from '@core/address';
import { bookAddressToSlot } from './slots';

/**
 * The colour of a binding, as a function of the address it sits at.
 *
 * `docs/architecture.md` §5 forbids `Math.random()` in generation outright,
 * and §3 says why: appearance derived from chance makes a room look different
 * each time it is entered, and the library stops being a place. So the colour
 * of volume 17 on shelf 2 of wall 3 of room `4af…` is a pure function of those
 * coordinates — the same in every session, on every machine, forever.
 *
 * **Not the linear index itself.** Hue taken straight from the linear index
 * bands: the index of neighbouring volumes on one shelf differs by exactly
 * `PAGES_PER_BOOK`, so any smooth map from index to hue paints the 32 spines
 * of a shelf as a gradient, and a shelf reads as a rainbow ramp rather than as
 * books. The index is therefore run through an avalanching integer mix first —
 * `splitmix64`'s finalizer, which is six operations and whose defining
 * property is exactly the one needed here: flipping one input bit changes
 * about half the output bits, so volumes 17 and 18 land at unrelated hues.
 *
 * `splitmix64` rather than `core`'s SHA-256 PRF: this is a visual decision
 * with no adversary, and the PRF costs a hash of the whole page value where
 * this costs six multiplications. Rather than `Math.random()` with a seed,
 * because a seeded PRNG has to be walked in order — the colour of one spine
 * must be computable without computing the other 639, which a raycast hit on
 * a single instance needs.
 */

/** 64-bit mask: `bigint` has no fixed width, so every step is masked back. */
const WORD = (1n << 64n) - 1n;

const MIX_A = 0xbf58476d1ce4e5b9n;
const MIX_B = 0x94d049bb133111ebn;

/**
 * Distinguishes this use of the mixer from any other. Not a magic number to
 * taste: the fractional part of the golden ratio in 64 bits, the usual choice
 * for a seed with no structure in its bit pattern.
 */
const DOMAIN_SEED = 0x9e3779b97f4a7c15n;

/**
 * Spreads the slots of one room across the word before they are mixed. A large
 * odd multiplier, so slot by slot it steps through the whole 64-bit space
 * without a cycle; `0xd1342543de82ef95` is one of the multipliers measured for
 * exactly this by Steele and Vigna.
 *
 * Multiplied in rather than mixed in separately, because mixing the slot on
 * its own and combining the two by `xor` makes the room's own fold cancel
 * itself: the fold of room 0 *is* `mix64(DOMAIN_SEED)`, so `xor` against
 * `mix64(0 + DOMAIN_SEED)` gave zero, and `mix64` fixes zero. The first spine
 * of the first room — the most looked-at object in the whole library — came
 * out at the minimum of all three fields at once. Found by measuring the
 * distribution rather than by reading the code.
 */
const SLOT_STRIDE = 0xd1342543de82ef95n;

/** Hue is taken from the whole circle; the muting is done with the other two. */
const SATURATION_MIN = 0.18;
const SATURATION_SPAN = 0.28;

/**
 * Bindings are dark. Lightness above ~0.45 reads as paper rather than cloth,
 * and the spines have to stay readable against the fog behind them.
 */
const LIGHTNESS_MIN = 0.22;
const LIGHTNESS_SPAN = 0.18;

/** Width of each of the three fields read out of a mixed word. */
const FIELD_BITS = 21n;
const FIELD_MASK = (1n << FIELD_BITS) - 1n;
const FIELD_SCALE = Number(1n << FIELD_BITS);

/**
 * A room's contribution to its volumes' colours, folded once per room.
 *
 * Every bit of the room number takes part: a room index runs to 16545 bits,
 * and truncating it to the low 64 would make rooms that differ only high up
 * identical in appearance. Folding is `O(limbs)` and happens once for 640
 * spines, which is why it is not folded into `spineSeed`.
 */
export function roomSeed(room: bigint): bigint {
  let seed = DOMAIN_SEED;
  let remaining = room;
  do {
    seed = mix64(seed ^ (remaining & WORD));
    remaining >>= 64n;
  } while (remaining > 0n);
  return seed;
}

/** The seed of one volume: its room's fold, mixed with its slot in that room. */
export function spineSeed(roomFold: bigint, slot: number): bigint {
  return mix64((roomFold ^ (BigInt(slot) * SLOT_STRIDE)) & WORD);
}

/**
 * Write the colour of the volume at `slot` of the room `roomFold` folds into
 * `target`, and return it. Takes the fold rather than the room so that
 * building 640 spines folds the room once.
 */
export function spineColorFromSeed(
  roomFold: bigint,
  slot: number,
  target: Color
): Color {
  const seed = spineSeed(roomFold, slot);
  const hue = field(seed, 0n);
  const saturation = SATURATION_MIN + SATURATION_SPAN * field(seed, FIELD_BITS);
  const lightness = LIGHTNESS_MIN + LIGHTNESS_SPAN * field(seed, FIELD_BITS * 2n);
  // The colour space is passed explicitly. `setHSL` defaults to the working
  // space, which is linear, and a lightness of 0.22 read as linear renders at
  // roughly 0.5 in sRGB — the bindings came out half again as bright as the
  // figures above say, which is not what the next reader of those figures
  // would expect them to mean.
  return target.setHSL(hue, saturation, lightness, SRGBColorSpace);
}

/**
 * The colour of a volume named by its address, for callers that have one — a
 * picked spine, a bookmark — rather than a slot and a fold.
 */
export function spineColor(address: BookAddress, target: Color): Color {
  return spineColorFromSeed(roomSeed(address.room), bookAddressToSlot(address), target);
}

/** A field of `FIELD_BITS` bits read out of a mixed word, as a `[0, 1)` number. */
function field(seed: bigint, offset: bigint): number {
  return Number((seed >> offset) & FIELD_MASK) / FIELD_SCALE;
}

/**
 * `splitmix64`'s finalizer. Six operations, every one of them masked back to
 * 64 bits because `bigint` would otherwise keep growing.
 */
function mix64(value: bigint): bigint {
  let mixed = value & WORD;
  mixed ^= mixed >> 30n;
  mixed = (mixed * MIX_A) & WORD;
  mixed ^= mixed >> 27n;
  mixed = (mixed * MIX_B) & WORD;
  mixed ^= mixed >> 31n;
  return mixed;
}
