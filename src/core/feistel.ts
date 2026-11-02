import { LIBRARY_SIZE, PAGE_LENGTH, RADIX } from './address';
import { ValueOutOfDomainError } from './errors';
import { HALF_DOMAIN, roundFunction } from './prf';

/**
 * The address-page bijection: a 10-round balanced Feistel network over
 * `Z_(36^3200)` (SPEC §4.4, ADR-0002).
 *
 * Why a Feistel network rather than `page = (linear * K) mod N`: both are
 * bijections, but modular multiplication is linear, so neighbouring addresses
 * produce correlated pages and walking one shelf shows a pattern where the
 * premise of the library requires none. A Feistel network is equally
 * reversible and destroys that structure.
 *
 * Why it covers the domain exactly: `PAGE_LENGTH` is even, so
 * `N = 36^3200 = (36^1600)^2 = H^2`. Splitting a value into
 * `(a, b) = (v / H, v mod H)` is therefore a bijection `[0, N) → [0, H) x [0, H)`,
 * every round is a bijection on that square (swap composed with adding a
 * function of the untouched half, modulo H), and recombining `a * H + b` is the
 * inverse of the split. No cycle-walking, no unreachable pages, no value to
 * special-case.
 */

/** Rounds in the network (SPEC §4.2). Part of the frozen format (ADR-0003). */
export const ROUNDS = 10;

/**
 * Add two halves modulo the half-domain.
 *
 * Kept as a named operation rather than inlined because the subtraction below
 * needs the non-negative correction that `bigint %` does not give, and seeing
 * the two side by side is what makes the round inverse checkable by eye.
 */
function addMod(left: bigint, right: bigint): bigint {
  return (left + right) % HALF_DOMAIN;
}

/**
 * Subtract two halves modulo the half-domain, landing in `[0, HALF_DOMAIN)`.
 *
 * JavaScript's `%` on `bigint` keeps the sign of the dividend, so a plain
 * `(left - right) % HALF_DOMAIN` returns a negative value whenever
 * `right > left`. That value is still a correct residue class, but it is not a
 * legal Feistel half: it would later be recombined as `a * H + b` into a
 * number outside `[0, N)` and converted to a page of the wrong length. The
 * `+ HALF_DOMAIN` before the second reduction is what keeps decryption inside
 * the domain.
 */
function subMod(left: bigint, right: bigint): bigint {
  return (((left - right) % HALF_DOMAIN) + HALF_DOMAIN) % HALF_DOMAIN;
}

/**
 * Reject a value that is not a member of the library's domain `[0, N)`.
 * The network is a permutation of exactly that interval; handing it anything
 * else would produce a plausible-looking result for an address that does not
 * exist.
 */
function assertInDomain(value: bigint): void {
  if (value < 0n || value >= LIBRARY_SIZE) {
    throw new ValueOutOfDomainError(value, RADIX, PAGE_LENGTH);
  }
}

/**
 * The forward direction (SPEC §4.4): linear address index to page value.
 *
 *     a, b = v / H, v mod H
 *     for i = 0 … 9:  a, b = b, (a + F(i, b)) mod H
 *     return a * H + b
 */
export function encrypt(value: bigint): bigint {
  assertInDomain(value);

  let left = value / HALF_DOMAIN;
  let right = value % HALF_DOMAIN;
  for (let round = 0; round < ROUNDS; round++) {
    const mixed = addMod(left, roundFunction(round, right));
    left = right;
    right = mixed;
  }
  return left * HALF_DOMAIN + right;
}

/**
 * The inverse direction (SPEC §4.4): page value to linear address index.
 *
 *     a, b = v / H, v mod H
 *     for i = 9 … 0:  a, b = (b - F(i, a)) mod H, a
 *     return a * H + b
 *
 * Each round undoes `encrypt`'s round `i`: encryption left `(a', b') = (b, (a + F(i, b)) mod H)`,
 * so `b` is read straight off `a'` and `a` is recovered as `(b' - F(i, a')) mod H`.
 * `F` is evaluated on the half that round did not change, which is why the
 * network inverts without `F` having to be invertible itself.
 */
export function decrypt(value: bigint): bigint {
  assertInDomain(value);

  let left = value / HALF_DOMAIN;
  let right = value % HALF_DOMAIN;
  for (let round = ROUNDS - 1; round >= 0; round--) {
    const unmixed = subMod(right, roundFunction(round, left));
    right = left;
    left = unmixed;
  }
  return left * HALF_DOMAIN + right;
}
