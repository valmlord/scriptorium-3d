import { describe, expect, it, vi } from 'vitest';
import type { Address } from '@core/address';
import type * as NavigationModule from '@state/navigation';
import { createNavigation } from '@state/navigation';
import { createHighlight } from '@ui/highlight';
import { createSearchSession } from '@ui/search-session';
import type { SearchStatus } from '@ui/search-session';
import { lateSource } from './search-fakes';

/**
 * Rule 8's other half: an error from the route computation that is not one of
 * the three address classes is a bug, and it propagates rather than ending in
 * the failure status.
 *
 * No address makes `atPageAddress` throw anything else, so the real module is
 * wrapped and that one function made to throw a `TypeError`. A file of its own
 * because `vi.mock` is hoisted over the whole file, and the rest of the
 * session's tests run against the machine unwrapped.
 */

const failure = vi.hoisted(() => ({ thrown: new TypeError('a bug in the route') }));

vi.mock('@state/navigation', async (importOriginal) => {
  const actual = await importOriginal<typeof NavigationModule>();
  return {
    ...actual,
    atPageAddress: (): never => {
      throw failure.thrown;
    },
  };
});

const HIT_ADDRESS: Address = { room: 37n, wall: 1, shelf: 2, volume: 3, page: 4 };

describe('the search session, when the route computation has a bug', () => {
  it('an error of another class from the route computation propagates', async () => {
    const navigation = createNavigation(0n);
    const highlight = createHighlight();
    const fake = lateSource();
    const session = createSearchSession({ navigation, source: fake.source, highlight });
    const shown: SearchStatus[] = [];
    session.subscribe((status) => shown.push(status));
    const submitted = session.submit('мир', 'random');

    fake.last().resolve({ address: HIT_ADDRESS, offset: 0 });

    await expect(submitted).rejects.toBe(failure.thrown);
    expect(shown.map((status) => status.kind)).not.toContain('failed');
    expect(navigation.state.level).toBe('room');
    expect(highlight.hit).toBeNull();
  });
});
