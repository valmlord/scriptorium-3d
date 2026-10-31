import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { LIBRARY_SIZE, PAGE_LENGTH } from '../address';
import { ValueOutOfDomainError } from '../errors';
import { ROUNDS, decrypt, encrypt } from '../feistel';
import { HALF_DOMAIN } from '../prf';

/** Addresses-as-values spread across the whole domain, edges included. */
const linearValue = fc.oneof(
  fc.constant(0n),
  fc.constant(1n),
  fc.constant(HALF_DOMAIN - 1n),
  fc.constant(HALF_DOMAIN),
  fc.constant(HALF_DOMAIN + 1n),
  fc.constant(LIBRARY_SIZE - 1n),
  fc.bigInt({ min: 0n, max: LIBRARY_SIZE - 1n })
);

describe('SPEC §4.2 parameters', () => {
  it('runs ten rounds, as the SPEC and ADR-0002 fix', () => {
    expect(ROUNDS).toBe(10);
  });
});

describe('the network is a permutation of [0, N)', () => {
  it('decrypt undoes encrypt', () => {
    fc.assert(
      fc.property(linearValue, (value) => {
        expect(decrypt(encrypt(value))).toBe(value);
      }),
      { numRuns: 120 }
    );
  });

  it('encrypt undoes decrypt', () => {
    fc.assert(
      fc.property(linearValue, (value) => {
        expect(encrypt(decrypt(value))).toBe(value);
      }),
      { numRuns: 120 }
    );
  });

  it('never leaves the domain', () => {
    fc.assert(
      fc.property(linearValue, (value) => {
        for (const result of [encrypt(value), decrypt(value)]) {
          expect(result).toBeGreaterThanOrEqual(0n);
          expect(result).toBeLessThan(LIBRARY_SIZE);
        }
      }),
      { numRuns: 60 }
    );
  });

  it('is injective on a sample: distinct inputs give distinct pages', () => {
    const inputs = [0n, 1n, 2n, 3n, HALF_DOMAIN - 1n, HALF_DOMAIN, LIBRARY_SIZE - 1n];

    const outputs = new Set(inputs.map((value) => encrypt(value).toString()));

    expect(outputs.size).toBe(inputs.length);
  });

  it('round-trips the first and last addresses of the library', () => {
    expect(decrypt(encrypt(0n))).toBe(0n);
    expect(decrypt(encrypt(LIBRARY_SIZE - 1n))).toBe(LIBRARY_SIZE - 1n);
  });

  it('round-trips a value whose lower half is zero and upper half is not', () => {
    // v = H exactly: b = 0, a = 1. The zero half is encoded as zero bytes
    // (SPEC §4.3), so this is the input that exercises that edge inside F.
    expect(decrypt(encrypt(HALF_DOMAIN))).toBe(HALF_DOMAIN);
  });
});

describe('domain rejection', () => {
  it('refuses a negative value', () => {
    expect(() => encrypt(-1n)).toThrow(ValueOutOfDomainError);
    expect(() => decrypt(-1n)).toThrow(ValueOutOfDomainError);
  });

  it('refuses the first value past the end of the library', () => {
    expect(() => encrypt(LIBRARY_SIZE)).toThrow(ValueOutOfDomainError);
    expect(() => decrypt(LIBRARY_SIZE)).toThrow(ValueOutOfDomainError);
  });

  it('accepts the last value inside the library', () => {
    expect(() => encrypt(LIBRARY_SIZE - 1n)).not.toThrow();
    expect(() => decrypt(LIBRARY_SIZE - 1n)).not.toThrow();
  });

  it('names the radix and page length it was asked to fit', () => {
    try {
      encrypt(LIBRARY_SIZE);
      expect.unreachable('encrypt should have rejected a value outside the domain');
    } catch (error) {
      expect(error).toBeInstanceOf(ValueOutOfDomainError);
      const domainError = error as ValueOutOfDomainError;
      expect(domainError.radix).toBe(36);
      expect(domainError.length).toBe(PAGE_LENGTH);
    }
  });
});

describe('diffusion (ADR-0002)', () => {
  it('sends neighbouring addresses to unrelated pages', () => {
    // The whole reason for a Feistel network rather than `linear * K mod N`:
    // with a linear bijection these two values would differ by a constant.
    const first = encrypt(1_000_000n);
    const second = encrypt(1_000_001n);

    const difference = first > second ? first - second : second - first;

    // Unrelated values differ in their top digits, so the difference is of the
    // same order as the domain itself rather than a small constant.
    expect(difference).toBeGreaterThan(LIBRARY_SIZE / 1_000_000n);
  });

  it('changes the upper half when only the lower half of the input changes', () => {
    // A single-round or linear construction would leave the upper half of the
    // output untouched by a change confined to the lower half of the input.
    const base = encrypt(0n);
    const changed = encrypt(1n);

    expect(base / HALF_DOMAIN).not.toBe(changed / HALF_DOMAIN);
  });
});

/**
 * The review gate for M2 asks why a balanced Feistel covers `[0, N)` exactly,
 * and what breaks when `PAGE_LENGTH` is odd. `36^3200` is too large to
 * enumerate, so the structural claim is demonstrated on a scaled-down network
 * with the same shape: the same split, the same round update, the same
 * recombination, over a domain small enough to check exhaustively.
 */
describe('why the balanced split covers the domain exactly', () => {
  /** The round update of SPEC §4.4, over an arbitrary half-domain. */
  const toyEncrypt = (value: number, half: number, rounds: number): number => {
    let left = Math.floor(value / half);
    let right = value % half;
    for (let round = 0; round < rounds; round++) {
      const mixed = (left + toyRoundFunction(round, right, half)) % half;
      left = right;
      right = mixed;
    }
    return left * half + right;
  };

  const toyDecrypt = (value: number, half: number, rounds: number): number => {
    let left = Math.floor(value / half);
    let right = value % half;
    for (let round = rounds - 1; round >= 0; round--) {
      const unmixed =
        (((right - toyRoundFunction(round, left, half)) % half) + half) % half;
      right = left;
      left = unmixed;
    }
    return left * half + right;
  };

  /** Any function at all works: a Feistel round is reversible regardless. */
  const toyRoundFunction = (round: number, value: number, half: number): number =>
    (value * value * 7 + round * 31 + 13) % half;

  it('permutes [0, N) exactly when the digit count is even', () => {
    // Radix 6, four digits: N = 1296 = 36^2, so H = 36 and N = H * H.
    const half = 36;
    const size = half * half;

    const images = new Set<number>();
    for (let value = 0; value < size; value++) {
      const image = toyEncrypt(value, half, ROUNDS);
      expect(image).toBeGreaterThanOrEqual(0);
      expect(image).toBeLessThan(size);
      expect(toyDecrypt(image, half, ROUNDS)).toBe(value);
      images.add(image);
    }

    // Every value is hit exactly once: the map is onto as well as into, with
    // no cycle-walking and no unreachable page.
    expect(images.size).toBe(size);
  });

  it('stops covering the domain when the digit count is odd', () => {
    // Radix 6, three digits: N = 216, and the balanced split can only use
    // H = 6^1 = 6, so the square it permutes is [0, 36) — a 36-element
    // subset of a 216-element domain. The construction is no longer a
    // bijection of the library, and the failure is silent: every call still
    // returns a plausible-looking page.
    const radix = 6;
    const oddLength = 3;
    const size = radix ** oddLength;
    const half = radix ** Math.floor(oddLength / 2);

    expect(half * half).toBeLessThan(size);

    const images = new Set<number>();
    for (let value = 0; value < size; value++) {
      images.add(toyEncrypt(value, half, ROUNDS));
    }

    // 216 addresses collapse onto at most 36 pages: addresses share text.
    expect(images.size).toBeLessThan(size);
    expect(images.size).toBeLessThanOrEqual(half * half);
  });

  it('is exactly the property the real parameters have', () => {
    expect(PAGE_LENGTH % 2).toBe(0);
    expect(HALF_DOMAIN * HALF_DOMAIN).toBe(LIBRARY_SIZE);
  });
});
