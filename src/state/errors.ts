import type { NavigationEventType, NavigationLevel } from './navigation';

/**
 * Dedicated error types for the two ways a navigation request can be wrong, in
 * the pattern of `src/core/errors.ts` and `src/engine/errors.ts`: each carries
 * the offending value and what was expected of it.
 *
 * The ranges of `room`, `wall`, `shelf` and `volume` are `core`'s business and
 * are refused there — `assertValidAddress` raises `InvalidAddressError` for a
 * wall of 7 and `AddressBeyondLibraryError` for a volume in the unfilled tail
 * of the last room (SPEC §3) — so nothing here restates them.
 */

/**
 * The `(state, event)` pair has no transition.
 *
 * `docs/architecture.md` §4 requires transitions to be explicit and total: an
 * unhandled pair throws rather than being silently ignored, because an event
 * that changes nothing and says nothing is indistinguishable from one the user
 * never made. The legal events at that level are named in the message, and
 * they are read from the same table that decides the transition, so the
 * message cannot drift from the behaviour.
 */
export class IllegalTransitionError extends Error {
  readonly level: NavigationLevel;
  readonly eventType: NavigationEventType;
  readonly legalEventTypes: readonly NavigationEventType[];

  constructor(
    level: NavigationLevel,
    eventType: NavigationEventType,
    legalEventTypes: readonly NavigationEventType[]
  ) {
    const legal =
      legalEventTypes.length === 0
        ? 'nothing'
        : legalEventTypes.map((type) => `"${type}"`).join(', ');
    super(
      `Navigation event "${eventType}" has no transition at the "${level}" level: legal here is ${legal}`
    );
    this.name = 'IllegalTransitionError';
    this.level = level;
    this.eventType = eventType;
    this.legalEventTypes = legalEventTypes;
  }
}

/**
 * An address component arrived as something other than an integer.
 *
 * `core`'s `assertValidAddress` checks the range of each component and not its
 * integrality — it is written for addresses that came out of `fromLinear`,
 * where being an integer is a property of the arithmetic. A navigation event
 * is not: it arrives from a pointer, and from a URL in M8. A wall of `1.5`
 * passes every range check in `core` and then fails inside `toLinear` as
 * `RangeError: The number 1.5 cannot be converted to a BigInt`, which names
 * neither the component nor the request, so it is refused here first.
 */
export class NonIntegerComponentError extends Error {
  readonly component: string;
  readonly value: number;

  constructor(component: string, value: number) {
    super(
      `Navigation component "${component}" must be an integer, received ${String(value)}`
    );
    this.name = 'NonIntegerComponentError';
    this.component = component;
    this.value = value;
  }
}
