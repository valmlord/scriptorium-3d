/**
 * The version of the frozen format (SPEC §4.5).
 *
 * `DOMAIN_TAG`, the alphabet order, `ROUNDS`, `PRF_BYTES` and the
 * linearisation together decide which text lives at which address. This number
 * names that whole arrangement, so that a link made under one format is
 * refused rather than silently opened at different text. Bumping it is a
 * deliberate act that accompanies a format change, never a routine release
 * chore (ADR-0003).
 *
 * It has a module of its own rather than a home in `address.ts` or
 * `library.ts`, and the reason is ADR-0029. It versions the bijection, not the
 * address model, so `address.ts` would be the wrong owner; and it is reached
 * from the main thread — `@app/url.ts` writes it into every fragment — while
 * `library.ts` is the generation surface no layer but `worker` may touch at
 * runtime. A constant that costs nothing to read does not belong behind that
 * boundary.
 */
export const FORMAT_VERSION = 1;

/**
 * A book's title is the first 25 characters of its page 0 (SPEC §5).
 *
 * Here for the reason above, applied a second time, which is the move ADR-0029
 * named and left for whoever needed it. The length of a title is a fact about
 * the format, not about generating one: `library.ts` uses it to decide how
 * many digits to render, and `worker/cache.ts` uses it on the **main thread**
 * to budget a cache entry in bytes. While it lived in `library.ts`, that one
 * constant put the whole generation surface — `prf`, `feistel`, `library` and
 * `@noble/hashes` — into the main-thread bundle the moment anything on that
 * thread imported the worker client, which is what M6 did. ADR-0032 records
 * the measurement, and `src/__tests__/production-bundle.test.ts` is what
 * notices if it happens again.
 */
export const TITLE_LENGTH = 25;
