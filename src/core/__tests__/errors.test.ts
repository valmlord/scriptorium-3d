import { describe, it, expect } from 'vitest';
import {
  AddressBeyondLibraryError,
  InvalidAddressError,
  InvalidPageLengthError,
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
