/**
 * How many samples every benchmark task in `src/core/__tests__/*.bench.ts`
 * takes, and the Vitest options that enforce it.
 *
 * Fixed rather than inferred from a time budget. Vitest otherwise runs each
 * task for a wall-clock duration, so the number of samples behind a median
 * depends on how fast the machine is — and a median that does not say how many
 * samples it is made of is not a number anyone can compare. `time: 0` disables
 * the duration floor so that this count is the only thing deciding the sample
 * size, on every machine.
 *
 * 50 is chosen for what a median of 50 rules out: a scheduler hiccup has to
 * take 26 of the samples to move it, where a single reading or a median of
 * three can be moved by one. A task here costs one to fifty milliseconds, so
 * 50 of them is well under a second apiece.
 *
 * What it does **not** buy is agreement between runs. Measured on a shared
 * 4 vCPU container, the `getPage` median over 50 samples varied 9% across
 * eight consecutive repetitions and 80% over 150 — the spread does not shrink
 * with the sample count, because the noise is the host's own drift over
 * seconds rather than per-call jitter, and a longer median just averages a
 * longer stretch of it. So the run-to-run spread of a published figure is a
 * property of the machine, not of this constant, and no sample count would
 * make a gate built on these numbers decide by the code. That is why
 * `bench:report`'s CI job does not gate on the figures, and why the report
 * carries mean, min and p99 beside each median rather than the median alone.
 *
 * **It lives in its own module so that every bench file reads the same
 * number**, the way every property test routes its case count through
 * `property-runs.ts`. A number has one home (ADR-0013), and here that is not
 * only tidiness: `scripts/report-generation-cost.ts` prints each row's sample
 * count and tells the reader the count does not vary with the machine. One
 * bench file left on a time budget makes that sentence false, and the row that
 * falsifies it sits in the same table — which is how this was found.
 */
export const BENCH_SAMPLES = 50;

/** The task options that hold every bench to `BENCH_SAMPLES`. */
export const benchOptions = { iterations: BENCH_SAMPLES, time: 0 } as const;
