import { describe, expect, it, vi } from 'vitest';
import type { Address } from '@core/address';
import { createHighlight, highlightAt } from '@ui/highlight';
import type { Hit } from '@ui/highlight';

const ADDRESS: Address = { room: 7n, wall: 2, shelf: 3, volume: 17, page: 101 };

const HIT: Hit = { address: ADDRESS, offset: 120, length: 9 };

describe('the highlight', () => {
  it('starts with no hit', () => {
    expect(createHighlight().hit).toBeNull();
  });

  it('holds the last hit it was given and tells every listener', () => {
    const highlight = createHighlight();
    const first = vi.fn();
    const second = vi.fn();
    highlight.subscribe(first);
    highlight.subscribe(second);

    highlight.set(HIT);

    expect(highlight.hit).toBe(HIT);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('stops telling a listener that unsubscribed', () => {
    const highlight = createHighlight();
    const listener = vi.fn();
    const unsubscribe = highlight.subscribe(listener);

    unsubscribe();
    highlight.set(HIT);

    expect(listener).not.toHaveBeenCalled();
  });

  it('marks the hit only on the page the hit is at', () => {
    expect(highlightAt(HIT, { ...ADDRESS })).toEqual({ offset: 120, length: 9 });
  });

  it('marks nothing on any other page, whichever component differs', () => {
    const elsewhere: readonly Address[] = [
      { ...ADDRESS, room: 8n },
      { ...ADDRESS, wall: 1 },
      { ...ADDRESS, shelf: 4 },
      { ...ADDRESS, volume: 16 },
      { ...ADDRESS, page: 100 },
    ];

    for (const address of elsewhere) {
      expect(highlightAt(HIT, address)).toBeNull();
    }
  });

  it('marks nothing without a hit or without an open page', () => {
    expect(highlightAt(null, ADDRESS)).toBeNull();
    expect(highlightAt(HIT, null)).toBeNull();
  });
});
