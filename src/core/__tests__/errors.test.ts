import { describe, it, expect } from 'vitest';
import { PAGE_LENGTH, RADIX } from '../address';
import {
  AddressBeyondLibraryError,
  InvalidAddressError,
  InvalidPageLengthError,
  InvalidSearchOffsetError,
  InvalidSearchQueryError,
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

  it('reads as a comma-separated list when several symbols are unknown', () => {
    const err = new UnknownSymbolError([
      { symbol: 'x', index: 3 },
      { symbol: '?', index: 9 },
    ]);

    // Asserted as one whole string rather than as two `toContain` calls: both
    // substrings survive the separator being emptied, so only the joined form
    // shows whether the list still reads as a list.
    expect(err.message).toBe("Unknown symbol(s): 'x' at index 3, '?' at index 9");
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

  it('quotes the largest value that would have fitted', () => {
    // Radix 10 and length 3 so the bound is legible: the inclusive maximum is
    // 999 and the codec refuses 1000. The expected text is spelled out rather
    // than rebuilt from the same expression the message uses, because a bound
    // computed twice the same wrong way agrees with itself. An off-by-one here
    // advertises as legal a value `intToDigits` rejects.
    const err = new ValueOutOfDomainError(1000n, 10, 3);

    expect(err.message).toBe(
      'Value 1000 out of domain for radix 10 and length 3 (allowed [0, 999])'
    );
  });

  it('quotes the real page domain boundary, not one off it', () => {
    const err = new ValueOutOfDomainError(36n ** 3200n, RADIX, PAGE_LENGTH);

    expect(err.message).toContain(`(allowed [0, ${String(36n ** 3200n - 1n)}])`);
  });
});

describe('InvalidSearchQueryError', () => {
  it('carries the length received and the permitted range', () => {
    const err = new InvalidSearchQueryError(0, 1, PAGE_LENGTH);

    expect(err.length).toBe(0);
    expect(err.min).toBe(1);
    expect(err.max).toBe(PAGE_LENGTH);
  });

  it('names the length and both bounds in the message', () => {
    const err = new InvalidSearchQueryError(PAGE_LENGTH + 1, 1, PAGE_LENGTH);

    expect(err.message).toBe('Search query length 3201 not in [1, 3200]');
  });

  it('identifies itself by name', () => {
    const err = new InvalidSearchQueryError(0, 1, PAGE_LENGTH);

    expect(err.name).toBe('InvalidSearchQueryError');
  });

  it('is an instance of Error', () => {
    expect(new InvalidSearchQueryError(0, 1, PAGE_LENGTH)).toBeInstanceOf(Error);
  });
});

describe('InvalidSearchOffsetError', () => {
  it('carries the offset, the query length and the largest offset that fits', () => {
    const err = new InvalidSearchOffsetError(PAGE_LENGTH - 4, 5, PAGE_LENGTH - 5);

    expect(err.offset).toBe(PAGE_LENGTH - 4);
    expect(err.queryLength).toBe(5);
    expect(err.maxOffset).toBe(PAGE_LENGTH - 5);
  });

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

  it('identifies itself by name', () => {
    const err = new InvalidSearchOffsetError(-1, 5, PAGE_LENGTH - 5);

    expect(err.name).toBe('InvalidSearchOffsetError');
  });

  it('is an instance of Error', () => {
    expect(new InvalidSearchOffsetError(-1, 5, PAGE_LENGTH - 5)).toBeInstanceOf(Error);
  });
});
