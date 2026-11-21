import { beforeAll, describe, expect, it } from 'vitest';
import { ROOM_COUNT } from '@core/address';
import type { Address } from '@core/address';
import { AddressBeyondLibraryError, InvalidAddressError } from '@core/errors';
import { NonIntegerComponentError } from '@state/errors';
import { addressOf, atPageAddress, createNavigation } from '@state/navigation';
import type { Navigation, NavigationState } from '@state/navigation';
import { createHighlight } from '@ui/highlight';
import type { Highlight } from '@ui/highlight';
import { createSearchSession } from '@ui/search-session';
import type { SearchSession, SearchStatus } from '@ui/search-session';
import {
  FAILED_QUERY_TEXT,
  failingSource,
  flushMicrotasks,
  lateSource,
  rejectingSource,
  workerErrors,
} from './search-fakes';
import type { FakeSearchSource, WorkerErrors } from './search-fakes';

/**
 * The search session's rules, against a real `Navigation` and the three fakes
 * of `./search-fakes.ts`. DOM-free: the panel that shows the status is
 * `../search.ts`, reached from Playwright.
 */

const OPENING_ROOM = 0n;
const HERE: Address = { room: OPENING_ROOM, wall: 1, shelf: 2, volume: 3, page: 4 };
const ELSEWHERE: Address = { room: 37n, wall: 3, shelf: 0, volume: 31, page: 409 };

/**
 * The last slot of the last room, every component at its maximum: past the
 * library's end, because the last room is only partly filled (SPEC §3).
 */
const LAST_SLOT_OF_LAST_ROOM: Address = {
  room: ROOM_COUNT - 1n,
  wall: 3,
  shelf: 4,
  volume: 31,
  page: 409,
};

let errors: WorkerErrors;

beforeAll(async () => {
  errors = await workerErrors();
});

interface Harness {
  readonly navigation: Navigation;
  readonly highlight: Highlight;
  readonly session: SearchSession;
  readonly fake: FakeSearchSource;
  /** Every state the machine notified, in order. */
  readonly notified: NavigationState[];
  /** Every status the session showed, in order. */
  readonly shown: SearchStatus[];
}

function harness(fake: FakeSearchSource): Harness {
  const navigation = createNavigation(OPENING_ROOM);
  const highlight = createHighlight();
  const session = createSearchSession({ navigation, source: fake.source, highlight });
  const notified: NavigationState[] = [];
  const shown: SearchStatus[] = [];
  navigation.subscribe((state) => notified.push(state));
  session.subscribe((status) => shown.push(status));
  return { navigation, highlight, session, fake, notified, shown };
}

function hitAt(address: Address, offset = 10): { address: Address; offset: number } {
  return { address, offset };
}

describe('the search session', () => {
  it("the fakes settle with the worker client's own errors", () => {
    expect(errors.cancelled.name).toBe('CancelledRequestError');
    expect(errors.failed.name).toBe('GenerationFailedError');
    expect(errors.failed.message).toContain(FAILED_QUERY_TEXT);
  });

  it('a second submit cancels the first and only the second hit navigates', async () => {
    const { navigation, highlight, session, fake, notified } = harness(lateSource());
    const first = session.submit('мир', 'random');
    const second = session.submit('дом', 'random');
    const [older, newer] = fake.issued;

    newer?.resolve(hitAt(ELSEWHERE));
    older?.resolve(hitAt(HERE));
    await Promise.all([first, second]);
    await flushMicrotasks();

    expect(older?.cancels).toBe(1);
    expect(newer?.cancels).toBe(0);
    expect(addressOf(navigation.state)).toEqual(ELSEWHERE);
    expect(notified).toHaveLength(1);
    expect(highlight.hit?.address).toEqual(ELSEWHERE);
  });

  it('a cancelled search whose text is resubmitted is not reported as a failure', async () => {
    const { session, fake, shown } = harness(rejectingSource(errors));
    const first = session.submit('мир', 'random');
    void session.submit('мир', 'random');

    await expect(first).resolves.toBeUndefined();
    await flushMicrotasks();

    expect(fake.issued[0]?.cancels).toBe(1);
    expect(shown.map((status) => status.kind)).not.toContain('failed');
    expect(session.status).toEqual({ kind: 'searching' });
    expect(session.isIdle()).toBe(false);
  });

  it('a refused submit cancels the search in flight', async () => {
    const { navigation, highlight, session, fake } = harness(lateSource());
    const first = session.submit('мир', 'random');
    const refused = session.submit('мир!', 'random');
    fake.issued[0]?.resolve(hitAt(HERE));

    await Promise.all([first, refused]);
    await flushMicrotasks();

    expect(fake.issued).toHaveLength(1);
    expect(fake.issued[0]?.cancels).toBe(1);
    expect(session.status.kind).toBe('refused');
    expect(navigation.state.level).toBe('room');
    expect(highlight.hit).toBeNull();
    expect(session.isIdle()).toBe(true);
  });

  it('a refused submit shows the refusal and asks the source for nothing', async () => {
    const { session, fake } = harness(lateSource());

    await expect(session.submit('мир\tдом', 'spaces')).resolves.toBeUndefined();

    expect(fake.issued).toHaveLength(0);
    expect(session.status).toMatchObject({
      kind: 'refused',
      refusal: { reason: 'unknown-symbols' },
    });
  });

  it('a navigation event the session did not dispatch cancels the pending search', async () => {
    const { navigation, session, fake, notified } = harness(lateSource());
    const submitted = session.submit('мир', 'random');

    navigation.dispatch({ type: 'select-wall', wall: 1 });
    fake.last().resolve(hitAt(HERE));
    await submitted;
    await flushMicrotasks();

    expect(fake.last().cancels).toBe(1);
    expect(session.status).toEqual({ kind: 'idle' });
    expect(session.isIdle()).toBe(true);
    expect(navigation.state).toEqual({ level: 'wall', room: OPENING_ROOM, wall: 1 });
    expect(notified).toHaveLength(1);
  });

  it('the highlight is set before the machine is told to move', async () => {
    const { navigation, highlight, session, fake } = harness(lateSource());
    const seenAtNotification: unknown[] = [];
    navigation.subscribe(() => seenAtNotification.push(highlight.hit));
    const submitted = session.submit('мир', 'random');

    fake.last().resolve(hitAt(ELSEWHERE, 77));
    await submitted;

    expect(seenAtNotification).toEqual([{ address: ELSEWHERE, offset: 77, length: 3 }]);
  });

  it('dispatches a hit as one gesture and reports where it landed', async () => {
    const { navigation, session, fake, notified } = harness(lateSource());
    const submitted = session.submit('мир', 'spaces');

    fake.last().resolve(hitAt(ELSEWHERE, 5));
    await submitted;

    expect(fake.last()).toMatchObject({ query: 'мир', mode: 'spaces' });
    expect(navigation.state).toEqual(atPageAddress(ELSEWHERE));
    expect(notified).toHaveLength(1);
    expect(session.status).toEqual({
      kind: 'found',
      hit: { address: ELSEWHERE, offset: 5, length: 3 },
    });
    expect(session.isIdle()).toBe(true);
  });

  it("sends the accepted query and marks its length, not the raw input's", async () => {
    const { highlight, session, fake } = harness(lateSource());
    // `Ё` typed decomposed: two units in the input, one symbol accepted.
    const typed = '\u0415\u0308\u0436';
    expect(typed).toHaveLength(3);
    const submitted = session.submit(typed, 'random');

    fake.last().resolve(hitAt(HERE));
    await submitted;

    expect(fake.last().query).toBe('ёж');
    expect(highlight.hit?.length).toBe(2);
  });

  it("a failed search shows the fixed failure text, not the error's message", async () => {
    const { navigation, session, fake } = harness(lateSource());
    const submitted = session.submit('мир', 'random');

    fake.last().reject(errors.failed);

    await expect(submitted).resolves.toBeUndefined();
    expect(session.status).toEqual({ kind: 'failed' });
    expect(JSON.stringify(session.status)).not.toContain(FAILED_QUERY_TEXT);
    expect(navigation.state.level).toBe('room');
    expect(session.isIdle()).toBe(true);
  });

  it('a superseded search that fails with a GenerationFailedError is a non-event', async () => {
    const { session, fake, shown } = harness(failingSource(errors));
    const first = session.submit('мир', 'random');
    void session.submit('дом', 'random');

    await expect(first).resolves.toBeUndefined();
    await flushMicrotasks();

    expect(fake.issued[0]?.cancels).toBe(1);
    expect(shown.map((status) => status.kind)).not.toContain('failed');
    expect(session.status).toEqual({ kind: 'searching' });
  });

  it('a hit whose address the machine refuses shows the fixed failure text', async () => {
    const pastTheLastRoom: Address = { ...HERE, room: ROOM_COUNT };
    const beyond = LAST_SLOT_OF_LAST_ROOM;
    // Preconditions: each address is refused by the class this case is for.
    expect(() => atPageAddress(pastTheLastRoom)).toThrow(InvalidAddressError);
    expect(() => atPageAddress(beyond)).toThrow(AddressBeyondLibraryError);

    for (const address of [pastTheLastRoom, beyond]) {
      const { navigation, highlight, session, fake, notified } = harness(lateSource());
      const submitted = session.submit('мир', 'random');

      fake.last().resolve(hitAt(address));

      await expect(submitted).resolves.toBeUndefined();
      expect(session.status).toEqual({ kind: 'failed' });
      expect(navigation.state.level).toBe('room');
      expect(notified).toHaveLength(0);
      expect(highlight.hit).toBeNull();
    }
  });

  it('a hit with a non-integer component shows the fixed failure text', async () => {
    const halfPage: Address = { ...HERE, page: 1.5 };
    expect(() => atPageAddress(halfPage)).toThrow(NonIntegerComponentError);
    const { navigation, highlight, session, fake } = harness(lateSource());
    const submitted = session.submit('мир', 'random');

    fake.last().resolve(hitAt(halfPage));

    await expect(submitted).resolves.toBeUndefined();
    expect(session.status).toEqual({ kind: 'failed' });
    expect(navigation.state.level).toBe('room');
    expect(highlight.hit).toBeNull();
  });

  it("a listener that throws during the hit's dispatch is not reported as a failed search", async () => {
    const { navigation, session, fake, shown } = harness(lateSource());
    // A class in rule 8's catch list, so that a `try` filtering by class
    // around the dispatch would catch it and be told apart from one that ends
    // before the dispatch.
    const thrown = new InvalidAddressError('wall', 99, 0, 3);
    navigation.subscribe(() => {
      throw thrown;
    });
    const submitted = session.submit('мир', 'random');

    fake.last().resolve(hitAt(ELSEWHERE));

    await expect(submitted).rejects.toBe(thrown);
    expect(shown.map((status) => status.kind)).not.toContain('failed');
    expect(session.status.kind).toBe('found');
    expect(addressOf(navigation.state)).toEqual(ELSEWHERE);
  });

  it('is idle only while no search is in flight', async () => {
    const { session, fake } = harness(lateSource());
    expect(session.isIdle()).toBe(true);
    await expect(session.whenIdle()).resolves.toBeUndefined();

    const submitted = session.submit('мир', 'random');
    let hasIdleResolved = false;
    void session.whenIdle().then(() => {
      hasIdleResolved = true;
    });
    await flushMicrotasks();
    expect(session.isIdle()).toBe(false);
    expect(hasIdleResolved).toBe(false);
    fake.last().resolve(hitAt(HERE));

    await submitted;
    await flushMicrotasks();
    expect(hasIdleResolved).toBe(true);
    expect(session.isIdle()).toBe(true);
  });

  it('dispose abandons the search in flight and stops watching the machine', async () => {
    const { navigation, session, fake, shown } = harness(lateSource());
    const submitted = session.submit('мир', 'random');
    const shownBefore = shown.length;

    session.dispose();
    navigation.dispatch({ type: 'select-wall', wall: 2 });
    fake.last().resolve(hitAt(HERE));
    await submitted;

    expect(fake.last().cancels).toBe(1);
    expect(session.isIdle()).toBe(true);
    expect(shown).toHaveLength(shownBefore);
    expect(navigation.state).toEqual({ level: 'wall', room: OPENING_ROOM, wall: 2 });
  });

  it('after dispose, a navigation notification does not reach the session', () => {
    // With nothing in flight the session's listener does nothing visible, so
    // a dispose that left it subscribed would pass the test above. Counting
    // the notifications that reach it is what tells the two apart.
    const machine = createNavigation(OPENING_ROOM);
    let reachedSession = 0;
    const navigation: Navigation = {
      get state(): NavigationState {
        return machine.state;
      },
      dispatch: (event) => machine.dispatch(event),
      dispatchAll: (events) => machine.dispatchAll(events),
      subscribe: (listener) =>
        machine.subscribe((state) => {
          reachedSession += 1;
          listener(state);
        }),
    };
    const session = createSearchSession({
      navigation,
      source: lateSource().source,
      highlight: createHighlight(),
    });
    navigation.dispatch({ type: 'select-wall', wall: 1 });
    expect(reachedSession).toBe(1);

    session.dispose();
    machine.dispatch({ type: 'back' });

    expect(machine.state).toEqual({ level: 'room', room: OPENING_ROOM });
    expect(reachedSession).toBe(1);
  });

  it('stops telling a status listener that unsubscribed', async () => {
    const { session } = harness(lateSource());
    const seen: SearchStatus[] = [];
    const unsubscribe = session.subscribe((status) => seen.push(status));

    unsubscribe();
    await session.submit('мир!', 'random');

    expect(seen).toEqual([]);
  });
});
