/**
 * What "nothing is happening" means, composed out of the things that can be
 * busy.
 *
 * `window.__scriptorium.waitForIdle()` is what keeps the end-to-end suite off
 * `waitForTimeout`, and review rejects a test that sleeps on a duration
 * (`docs/testing.md` §7). It can only be sound if it accounts for every source
 * of pending work the composition knows about, which from M6 is three: the
 * camera flight, the worker client's request table, and the reader catching up
 * with the machine.
 *
 * **It is composed here rather than owned by the hook** (`docs/testing.md`
 * §7). Each source answers for itself; this joins them, and `src/main.ts`
 * decides which ones exist. A hook holding its own opinion of idleness would
 * be a second answer to a question the sources already answer.
 *
 * **One pass over the list is not an answer.** Settling one source can make
 * another busy: a page arriving leaves the client quiet and the reader writing,
 * and a flight arriving at a shelf is what makes the title resolver ask for
 * 32 titles. So this re-reads every source after each settlement and only
 * returns when they are all idle at the same time.
 */

/** Something that can be busy and can say when it next is not. */
export interface IdleSource {
  /** Whether it is idle at this instant. */
  isIdle(): boolean;
  /** Resolves the next time it is idle. */
  whenIdle(): Promise<void>;
}

/** Whether every source is idle at this instant. */
export function areAllIdle(sources: readonly IdleSource[]): boolean {
  return sources.every((source) => source.isIdle());
}

/** Resolves once every source is idle at the same time. */
export async function whenAllIdle(sources: readonly IdleSource[]): Promise<void> {
  // The loop is the whole of it: a source that settles may have started work
  // somewhere else, so the list is read again rather than trusted once.
  while (!areAllIdle(sources)) {
    await Promise.all(
      sources.filter((source) => !source.isIdle()).map((source) => source.whenIdle())
    );
  }
}
