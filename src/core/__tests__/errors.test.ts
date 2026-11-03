import { describe, it, expect } from 'vitest';
import { PAGE_LENGTH } from '../address';
import {
  AddressBeyondLibraryError,
  InvalidAddressError,
  InvalidPageLengthError,
  InvalidSearchOffsetError,
  UnknownSymbolError,
  ValueOutOfDomainError,
} from '../errors';

describe('UnknownSymbolError', () => {
  it('carries every offending symbol and its position', () => {
    const err = new UnknownSymbolError([
      { symbol: 'x', index: 3 },
      { symbol: '?', index: 9 },
    ]);
    expect(err.symbols).toEqual([
      { symbol: 'x', index: 3 },
      { symbol: '?', index: 9 },
    ]);
    expect(err.message).toContain("'x' at index 3");
    expect(err.message).toContain("'?' at index 9");
    expect(err.name).toBe('UnknownSymbolError');
  });

  it('is an instance of Error', () => {
    expect(new UnknownSymbolError([{ symbol: 'x', index: 0 }])).toBeInstanceOf(Error);
  });
});

describe('InvalidPageLengthError', () => {
  it('carries the expected and received lengths', () => {
    const err = new InvalidPageLengthError(3200, 12);
    expect(err.expected).toBe(3200);
    expect(err.received).toBe(12);
    expect(err.message).toContain('3200');
    expect(err.message).toContain('12');
    expect(err.name).toBe('InvalidPageLengthError');
  });
});

describe('InvalidAddressError', () => {
  it('carries the component, value and permitted range', () => {
    const err = new InvalidAddressError('wall', 9, 0, 3);
    expect(err.component).toBe('wall');
    expect(err.value).toBe(9);
    expect(err.min).toBe(0);
    expect(err.max).toBe(3);
    expect(err.message).toContain('wall');
    expect(err.name).toBe('InvalidAddressError');
  });

  it('carries bigint values for the room component', () => {
    const err = new InvalidAddressError('room', 5n, 0n, 4n);
    expect(err.value).toBe(5n);
    expect(err.min).toBe(0n);
    expect(err.max).toBe(4n);
  });

  it('carries a string value for a malformed name', () => {
    const err = new InvalidAddressError('room', '', 0n, 4n);
    expect(err.value).toBe('');
    expect(err.message).toContain("'room'");
  });
});

describe('AddressBeyondLibraryError', () => {
  it('carries the linear index and the library size', () => {
    const err = new AddressBeyondLibraryError(36n ** 3200n, 36n ** 3200n);
    expect(err.linear).toBe(36n ** 3200n);
    expect(err.librarySize).toBe(36n ** 3200n);
    expect(err.message).toContain('beyond the end of the library');
    expect(err.name).toBe('AddressBeyondLibraryError');
  });

  it('is an instance of Error', () => {
    expect(new AddressBeyondLibraryError(1n, 2n)).toBeInstanceOf(Error);
  });
});

describe('ValueOutOfDomainError', () => {
  it('carries the value, radix and length', () => {
    const err = new ValueOutOfDomainError(36n ** 3200n, 36, 3200);
    expect(err.value).toBe(36n ** 3200n);
    expect(err.radix).toBe(36);
    expect(err.length).toBe(3200);
    expect(err.message).toContain('radix 36');
    expect(err.name).toBe('ValueOutOfDomainError');
  });
});

describe('InvalidSearchOffsetError', () => {
  it('states the requirement as an integer in range, which a fraction also fails', () => {
    // `search` refuses 1.5, and 1.5 *is* in [0, 3195]. A message naming the
    // range on its own would therefore assert something false about the very
    // value it is reporting, and send the reader after a bound that had not
    // been crossed. The compound predicate holds for all three rejected
    // shapes -- negative, fractional, past the end -- and this assertion is
    // what keeps the wording from regressing to the range alone.
    const err = new InvalidSearchOffsetError(1.5, 5, PAGE_LENGTH - 5);

    expect(err.message).toBe(
      'Search offset 1.5 is not an integer in [0, 3195] for a query of length 5'
    );
  });
});
