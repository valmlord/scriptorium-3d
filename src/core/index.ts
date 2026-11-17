// Core layer exports — the pure, dependency-free domain logic.
// M1: the format version, alphabet, radix codec and the address model.
// M2: the Feistel round function, the network itself and the public API.
//
// Only `@worker` may import this barrel at runtime. It re-exports the
// generation surface, so a rule phrased on `./library` alone is defeated by an
// import of `./index` (ADR-0029); every other layer imports the specific
// module it needs.

export * from './format';
export * from './errors';
export * from './alphabet';
export * from './bignum';
export * from './address';
export * from './prf';
export * from './feistel';
export * from './library';
