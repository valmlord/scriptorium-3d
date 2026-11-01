import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { propertyRuns } from './property-runs';
import { sha256 } from '@noble/hashes/sha2.js';
import { LIBRARY_SIZE, PAGE_LENGTH, RADIX } from '../address';
import {
  DOMAIN_TAG,
  asciiToBytes as encodeAscii,
  HALF_DOMAIN,
  HALF_LENGTH,
  PRF_BYTES,
  counterModeStream,
  fromBytesBE,
  roundFunction,
  roundSeed,
  seedInput,
  toMinimalBytesBE,
} from '../prf';

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const asciiBytes = (text: string): Uint8Array =>
  Uint8Array.from(text, (character) => character.charCodeAt(0));

describe('SPEC §4.2 parameters', () => {
  it('matches the SPEC values verbatim', () => {
    expect(DOMAIN_TAG).toBe('scriptorium.3d/v1');
    expect(PRF_BYTES).toBe(1051);
    expect(HALF_LENGTH).toBe(1600);
    expect(HALF_DOMAIN).toBe(36n ** 1600n);
  });

  it('keeps DOMAIN_TAG pure ASCII, so hand-encoding it is UTF-8', () => {
    for (const character of DOMAIN_TAG) {
      expect(character.codePointAt(0)).toBeLessThan(0x80);
    }
  });

  it('leaves enough counter-mode output that the modulo bias is below 2^-128', () => {
    const halfDomainBits = HALF_DOMAIN.toString(2).length;

    expect(halfDomainBits).toBe(8272);
    expect(PRF_BYTES * 8 - halfDomainBits).toBeGreaterThanOrEqual(128);
  });
});

describe('the balanced split (SPEC §4.1, ADR-0002)', () => {
  it('halves the page exactly, because PAGE_LENGTH is even', () => {
    expect(PAGE_LENGTH % 2).toBe(0);
    expect(HALF_LENGTH * 2).toBe(PAGE_LENGTH);
  });

  it('covers [0, N) exactly: H squared is the library size', () => {
    expect(HALF_DOMAIN * HALF_DOMAIN).toBe(LIBRARY_SIZE);
    expect(HALF_DOMAIN).toBe(BigInt(RADIX) ** BigInt(PAGE_LENGTH / 2));
  });
});

describe('SHA-256 against published test vectors', () => {
  // FIPS 180-4 / NIST CSRC example digests. These are external values: they
  // prove the hash is SHA-256 and not merely self-consistent, which is the one
  // thing checking it against itself could never show (roadmap, M2).
  const published: readonly (readonly [string, string])[] = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    [
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
    ],
  ];

  for (const [message, digest] of published) {
    it(`hashes a ${String(message.length * 8)}-bit message to its published digest`, () => {
      expect(toHex(sha256(asciiBytes(message)))).toBe(digest);
    });
  }

  it('hashes one million repetitions of "a" to its published digest', () => {
    expect(toHex(sha256(asciiBytes('a'.repeat(1_000_000))))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'
    );
  });
});

describe('asciiToBytes', () => {
  it('encodes ASCII one byte per character', () => {
    expect(Array.from(encodeAscii('abc'))).toEqual([0x61, 0x62, 0x63]);
    expect(Array.from(encodeAscii(''))).toEqual([]);
    expect(Array.from(encodeAscii('\x7f'))).toEqual([0x7f]);
  });

  it('refuses a non-ASCII string rather than encoding it as something else', () => {
    // The tag is frozen ASCII, so this cannot happen today. The guard exists
    // because a future tag containing a non-ASCII character would otherwise be
    // truncated to its low bytes and silently change every book in the library.
    expect(() => encodeAscii('scriptorium.3d/v\u00e9')).toThrow(RangeError);
    expect(() => encodeAscii('\u0430')).toThrow(/ASCII/);
  });

  it('names the offending code point and its position', () => {
    try {
      encodeAscii('ab\u042f');
      expect.unreachable('asciiToBytes should have refused a Cyrillic character');
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
      expect((error as RangeError).message).toContain('1071');
      expect((error as RangeError).message).toContain('index 2');
    }
  });
});

describe('toMinimalBytesBE', () => {
  it('encodes zero as zero bytes, as SPEC §4.3 requires', () => {
    expect(toMinimalBytesBE(0n)).toHaveLength(0);
  });

  it('uses the fewest bytes that hold the value', () => {
    expect(Array.from(toMinimalBytesBE(1n))).toEqual([1]);
    expect(Array.from(toMinimalBytesBE(255n))).toEqual([255]);
    expect(Array.from(toMinimalBytesBE(256n))).toEqual([1, 0]);
    expect(Array.from(toMinimalBytesBE(65_535n))).toEqual([255, 255]);
    expect(Array.from(toMinimalBytesBE(65_536n))).toEqual([1, 0, 0]);
  });

  it('pads an odd number of hex digits without shifting the later nibbles', () => {
    // 0xfff has three hex digits; a naive split would read it as 0xff, 0xf0.
    expect(Array.from(toMinimalBytesBE(0xfffn))).toEqual([0x0f, 0xff]);
    expect(Array.from(toMinimalBytesBE(0xabcden))).toEqual([0x0a, 0xbc, 0xde]);
  });

  it('rejects a negative value rather than encoding its minus sign', () => {
    expect(() => toMinimalBytesBE(-1n)).toThrow(RangeError);
    expect(() => toMinimalBytesBE(-1n)).toThrow(/non-negative/);
  });

  it('never emits a leading zero byte', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: HALF_DOMAIN - 1n }), (value) => {
        expect(toMinimalBytesBE(value)[0]).not.toBe(0);
      }),
      { numRuns: propertyRuns(200) }
    );
  });

  it('round-trips through fromBytesBE over the half-domain', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: HALF_DOMAIN - 1n }), (value) => {
        expect(fromBytesBE(toMinimalBytesBE(value))).toBe(value);
      }),
      { numRuns: propertyRuns(200) }
    );
  });
});

describe('fromBytesBE', () => {
  it('reads no bytes as zero, mirroring the minimal encoding', () => {
    expect(fromBytesBE(new Uint8Array(0))).toBe(0n);
  });

  it('reads bytes big-endian: the first byte is the most significant', () => {
    expect(fromBytesBE(Uint8Array.from([1, 0]))).toBe(256n);
    expect(fromBytesBE(Uint8Array.from([0, 1]))).toBe(1n);
    expect(fromBytesBE(Uint8Array.from([0xde, 0xad, 0xbe, 0xef]))).toBe(0xdeadbeefn);
  });

  it('keeps leading zero bytes as leading zeros rather than failing', () => {
    expect(fromBytesBE(Uint8Array.from([0, 0, 42]))).toBe(42n);
  });
});

describe('the seed encoding (SPEC §4.3)', () => {
  const DOMAIN_TAG_LENGTH = DOMAIN_TAG.length;

  /**
   * Decode `seedInput` back into `(round, half)`. Its existence is the proof
   * that the encoding is injective: a byte string that can be parsed back only
   * one way cannot have come from two different inputs. This is what the
   * `u32be(length)` prefix buys — the decoder below reads the length and knows
   * exactly where `xb` ends.
   */
  const decodeSeedInput = (bytes: Uint8Array): { round: number; half: bigint } => {
    expect(toHex(bytes.subarray(0, DOMAIN_TAG_LENGTH))).toBe(
      toHex(asciiBytes(DOMAIN_TAG))
    );
    const round = bytes[DOMAIN_TAG_LENGTH];
    const length = Number(
      fromBytesBE(bytes.subarray(DOMAIN_TAG_LENGTH + 1, DOMAIN_TAG_LENGTH + 5))
    );
    const halfBytes = bytes.subarray(
      DOMAIN_TAG_LENGTH + 5,
      DOMAIN_TAG_LENGTH + 5 + length
    );

    // No bytes left over: the length prefix accounts for the whole buffer.
    expect(bytes.length).toBe(DOMAIN_TAG_LENGTH + 5 + length);
    expect(round).toBeDefined();

    return { round: round ?? -1, half: fromBytesBE(halfBytes) };
  };

  it('lays the fields out exactly as the SPEC writes them', () => {
    const bytes = seedInput(3, 0x0102n);

    // tag, then round 0x03, then the length 2 as u32be, then the two bytes.
    expect(toHex(bytes)).toBe(`${toHex(asciiBytes(DOMAIN_TAG))}03000000020102`);
  });

  it('encodes a zero half as a zero length and no half bytes', () => {
    const bytes = seedInput(0, 0n);

    expect(bytes).toHaveLength(DOMAIN_TAG_LENGTH + 5);
    expect(toHex(bytes.subarray(DOMAIN_TAG_LENGTH))).toBe('0000000000');
  });

  it('is injective: every encoding decodes back to the one input that made it', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 9 }),
        fc.bigInt({ min: 0n, max: HALF_DOMAIN - 1n }),
        (round, half) => {
          expect(decodeSeedInput(seedInput(round, half))).toEqual({ round, half });
        }
      ),
      { numRuns: propertyRuns(200) }
    );
  });

  it('separates a round index from the leading bytes of a half', () => {
    // Without the length prefix both of these would be the tag followed by
    // the bytes 01 02: round 1 with half 0x02, and round 1 with half 0x0102,
    // differ only in where the half begins. The prefix states it.
    const asRoundThenShortHalf = seedInput(1, 0x02n);
    const asRoundThenLongHalf = seedInput(1, 0x0102n);

    expect(toHex(asRoundThenShortHalf)).not.toBe(toHex(asRoundThenLongHalf));
    expect(toHex(roundSeed(1, 0x02n))).not.toBe(toHex(roundSeed(1, 0x0102n)));
  });

  it('produces the seeds an independent implementation of SPEC §4.3 produces', () => {
    // Computed by a separate reference implementation written from the SPEC
    // text alone (see the pull request). Pinning the raw seed, not just the
    // round-function output, localises a format break to the seed
    // construction rather than leaving it somewhere in the round function.
    expect(toHex(roundSeed(0, 0n))).toBe(
      '5409598d17a9fd42fae48057d6151a911704fd9bc55cca1f4eeb1e426f15f105'
    );
    expect(toHex(roundSeed(0, 1n))).toBe(
      '6b77348c9aa1887447c5ec4cb5f6eb43b9e7ade3079f2d989d291cfa53cbddf6'
    );
    expect(toHex(roundSeed(2, 65_535n))).toBe(
      '514cb139f4a0d0cc2f59d5941da7dc9f40be3e1580d6835820dd0c532a20fffa'
    );
    expect(toHex(roundSeed(9, HALF_DOMAIN - 1n))).toBe(
      '050ac8ca1c586d609d09672d2b9856433af480c81ecc29e3b9804a36b1b7fd2a'
    );
  });
});

describe('the counter-mode stream (SPEC §4.3)', () => {
  it('returns exactly PRF_BYTES bytes', () => {
    expect(counterModeStream(roundSeed(0, 0n))).toHaveLength(PRF_BYTES);
  });

  it('is SHA-256(seed ‖ u32be(block)) concatenated, block by block', () => {
    const seed = roundSeed(4, 12_345n);
    const stream = counterModeStream(seed);

    for (const block of [0, 1, 32]) {
      const expected = sha256(Uint8Array.from([...seed, 0, 0, 0, block]));
      const actual = stream.subarray(block * 32, block * 32 + 32);

      expect(toHex(actual)).toBe(toHex(expected).slice(0, actual.length * 2));
    }
  });

  it('truncates the last block rather than padding it', () => {
    // 1051 is not a multiple of 32: the 33rd block is cut short, which is why
    // the stream must be generated in whole blocks and sliced afterwards.
    expect(PRF_BYTES % 32).not.toBe(0);
    expect(Math.ceil(PRF_BYTES / 32)).toBe(33);
  });

  it('depends on the seed: a different seed gives different output', () => {
    expect(toHex(counterModeStream(roundSeed(0, 0n)))).not.toBe(
      toHex(counterModeStream(roundSeed(1, 0n)))
    );
  });
});

describe('the round function F (SPEC §4.3)', () => {
  it('lands inside the half-domain for every round and half', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 9 }),
        fc.bigInt({ min: 0n, max: HALF_DOMAIN - 1n }),
        (round, half) => {
          const value = roundFunction(round, half);

          expect(value).toBeGreaterThanOrEqual(0n);
          expect(value).toBeLessThan(HALF_DOMAIN);
        }
      ),
      { numRuns: propertyRuns(60) }
    );
  });

  it('is deterministic: the same input gives the same value', () => {
    expect(roundFunction(7, 99n)).toBe(roundFunction(7, 99n));
  });

  it('depends on the round index, so the rounds are not interchangeable', () => {
    const halves = [0n, 1n, HALF_DOMAIN - 1n];

    for (const half of halves) {
      const values = new Set(
        Array.from({ length: 10 }, (_unused, round) =>
          roundFunction(round, half).toString()
        )
      );

      expect(values.size).toBe(10);
    }
  });

  it('depends on the half, so neighbouring halves do not share a value', () => {
    expect(roundFunction(0, 0n)).not.toBe(roundFunction(0, 1n));
    expect(roundFunction(0, HALF_DOMAIN - 2n)).not.toBe(
      roundFunction(0, HALF_DOMAIN - 1n)
    );
  });

  it('matches values from an independent implementation of SPEC §4.3', () => {
    // Again from the separate reference implementation: these are the frozen
    // format (ADR-0003). A change here is a change to every book.
    expect(roundFunction(0, 0n).toString().slice(0, 40)).toBe(
      '5772748943158608044857956356397705750620'
    );
    expect(roundFunction(0, 1n).toString().slice(0, 40)).toBe(
      '1185566831591148033277145217165388623725'
    );
    expect(roundFunction(1, 0n).toString().slice(0, 40)).toBe(
      '8969355526787727547474216258477589843247'
    );
    expect(roundFunction(9, 0n).toString().slice(0, 40)).toBe(
      '1157233668299805374041963585312358173467'
    );
    expect(roundFunction(3, 255n).toString().slice(0, 40)).toBe(
      '1196779704294682155862511589606316175679'
    );
    expect(roundFunction(3, 256n).toString().slice(0, 40)).toBe(
      '3151831079919784157909267362036555939178'
    );
    expect(
      roundFunction(5, HALF_DOMAIN - 1n)
        .toString()
        .slice(0, 40)
    ).toBe('1163473009348898192841755467244374922393');
    expect(roundFunction(7, 12_345_678_901_234_567_890n).toString().slice(0, 40)).toBe(
      '1015640462930382295216815366079586336640'
    );
  });
});
