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
