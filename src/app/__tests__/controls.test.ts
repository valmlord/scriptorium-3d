import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isEditableTarget } from '@app/controls';

/**
 * Which key events the controls leave alone. The handlers themselves need a
 * canvas and a WebGL viewer and are Playwright's (`e2e/search.spec.ts` presses
 * Escape in the query field); the decision of what counts as a field is a
 * predicate, and that runs here.
 *
 * Vitest runs in `node`, where the DOM's element classes do not exist. They are
 * stood in for by plain classes with the same inheritance, so `instanceof`
 * inside the predicate is exercised for real: an object passes only by being
 * an instance of the class the predicate names.
 */

class FakeElement {
  isContentEditable = false;
}
class FakeInputElement extends FakeElement {}
class FakeTextAreaElement extends FakeElement {}
class FakeSelectElement extends FakeElement {}
class FakeCanvasElement extends FakeElement {}

beforeEach(() => {
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('HTMLInputElement', FakeInputElement);
  vi.stubGlobal('HTMLTextAreaElement', FakeTextAreaElement);
  vi.stubGlobal('HTMLSelectElement', FakeSelectElement);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isEditableTarget', () => {
  it('leaves a key typed in a textarea to the textarea', () => {
    // Arrange
    const searchField = new FakeTextAreaElement();

    // Act
    const isEditable = isEditableTarget(searchField);

    // Assert
    expect(isEditable).toBe(true);
  });

  it('leaves a key typed in an input to the input', () => {
    expect(isEditableTarget(new FakeInputElement())).toBe(true);
  });

  it('leaves a key pressed on a select to the select', () => {
    expect(isEditableTarget(new FakeSelectElement())).toBe(true);
  });

  it('leaves a key typed in a contenteditable element to that element', () => {
    // Arrange
    const region = new FakeElement();
    region.isContentEditable = true;

    // Act
    const isEditable = isEditableTarget(region);

    // Assert
    expect(isEditable).toBe(true);
  });

  it('takes a key aimed at an element that is not a field', () => {
    // The canvas and the body are where a key lands when the reader is
    // looking at the room, so they must not be mistaken for a field.
    expect(isEditableTarget(new FakeCanvasElement())).toBe(false);
    expect(isEditableTarget(new FakeElement())).toBe(false);
  });

  it('takes a key whose target is not an element at all', () => {
    // `KeyboardEvent.target` is an `EventTarget`: a window or a document
    // dispatched to directly is one, and it has no `isContentEditable`.
    expect(isEditableTarget({ isContentEditable: true })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
