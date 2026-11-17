/**
 * Dedicated error types for the ways a flight can be asked for something it
 * cannot do, in the pattern of `src/core/errors.ts`: each carries the
 * offending value and what was expected of it.
 *
 * Every one of them is a programming fault rather than a user's, which is why
 * they are loud. A flight that quietly flew somewhere else, or quietly stopped
 * reporting that it had arrived, would be found by watching the camera and not
 * by reading a stack trace.
 */

/** The clock was asked to go backwards. See `./clock.ts`. */
export class NonMonotonicClockError extends Error {
  readonly from: number;
  readonly to: number;

  constructor(from: number, to: number) {
    super(
      `The motion clock cannot go backwards, from ${String(from)} s to ${String(to)} s: ` +
        'a root time that moves back renders every tween in reverse, so a flight would play backwards instead of reporting a fault'
    );
    this.name = 'NonMonotonicClockError';
    this.from = from;
    this.to = to;
  }
}

/** The flight was asked to fly to a label that is not on the route. */
export class UnknownFlightLabelError extends Error {
  readonly label: string;
  readonly known: readonly string[];

  constructor(label: string, known: readonly string[]) {
    super(
      `There is no stop named "${label}" on this route: it has ${known.map((name) => `"${name}"`).join(', ')}`
    );
    this.name = 'UnknownFlightLabelError';
    this.label = label;
    this.known = known;
  }
}

/**
 * A route began somewhere other than where the flight does.
 *
 * The rig is only ever moved along the timeline, so the pose at time zero is
 * the one place every route must agree on: it is where a retreat ends and
 * where the next route is appended from. A route with a different origin would
 * make the rig jump the moment the timeline rendered, which is the one thing
 * this design exists to make impossible.
 */
export class FlightOriginMismatchError extends Error {
  readonly field: string;
  readonly expected: string | number;
  readonly received: string | number;

  constructor(field: string, expected: string | number, received: string | number) {
    super(
      `A flight route must begin where the flight begins: the route's origin has ${field} ${String(received)} where the flight's has ${String(expected)}`
    );
    this.name = 'FlightOriginMismatchError';
    this.field = field;
    this.expected = expected;
    this.received = received;
  }
}

/**
 * A leg of the route takes no time, or a time that is not a number.
 *
 * A zero-length leg puts two labels at the same point on the timeline, and two
 * levels that share a time are two levels the flight cannot tell apart —
 * including when it is asked whether it has arrived.
 */
export class InvalidLegDurationError extends Error {
  readonly label: string;
  readonly seconds: number;

  constructor(label: string, seconds: number) {
    super(
      `The leg to "${label}" must take a finite number of seconds greater than zero, not ${String(seconds)}`
    );
    this.name = 'InvalidLegDurationError';
    this.label = label;
    this.seconds = seconds;
  }
}

/** Two stops on one route share a label, so neither can be flown to by name. */
export class RepeatedFlightLabelError extends Error {
  readonly label: string;

  constructor(label: string) {
    super(
      `The stop "${label}" appears twice on this route: a label names one point on the timeline, and the levels it names are distinct`
    );
    this.name = 'RepeatedFlightLabelError';
    this.label = label;
  }
}
