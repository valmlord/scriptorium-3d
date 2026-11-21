// Type only: the generation surface stays in the worker (ADR-0029).
import type { PadMode } from '@core/library';
import type { Hit } from './highlight';
import type { MessageSegment } from './query';
import { describeRoom } from './room-name';
import type { SearchSession, SearchStatus } from './search-session';
import './search.css';

/**
 * The search panel: the form a phrase is typed into, and the two regions that
 * say what became of it.
 *
 * **A view of `./search-session.ts` and nothing more.** The rules about which
 * reply counts, what is refused and what ends in the failure status are the
 * session's, unit-tested there; this module builds the form, hands each submit
 * to the session, and renders the session's status. It holds no record of its
 * own about where a search stands.
 *
 * **The markup, and why each part is what it is.** A `<form>` with
 * `role="search"`. A labelled `<textarea>` rather than a single-line input,
 * because an input swallows the line breaks of a paste, and a pasted line
 * break is a character the user must see refused (ADR-0035). A `fieldset` of
 * two radios for the padding, `random` checked, and a submit button. Enter
 * submits with or without Shift, so a line break can only arrive by paste.
 * No `maxlength`: it truncates a paste without a word, which is the silent
 * substitution SPEC §2 forbids; the bound is `./query.ts`'s, and refused by
 * name.
 *
 * **Two regions, because a result and a refusal are different news.** The
 * result is a `role="status"` line, polite, carrying the hit's offset as
 * `data-offset` for the end-to-end suite. A refusal is a `role="alert"`, read
 * at once, and the field is marked `aria-invalid` and described by it.
 *
 * **Typed and generated text reaches the DOM as text only.** Every string here
 * is set through `textContent` or `replaceChildren` with a string, and every
 * element is created rather than parsed; nothing in this module touches
 * `innerHTML`. A refused character the message shows as itself is inside its
 * own `<bdi>`, so that a right-to-left letter cannot reorder the sentence.
 *
 * Reached only from Playwright: it needs a DOM, and `vitest` runs in `node`.
 */

/** What the composition root gives the panel. */
export interface SearchPanelOptions {
  /** Where the panel is mounted. */
  readonly container: HTMLElement;
  /** The session each submit is handed to, and whose status is shown. */
  readonly session: SearchSession;
}

export interface SearchPanel {
  /** The panel's root element, for a caller that needs to find it. */
  readonly element: HTMLElement;
  /** Stop watching the session and remove the panel. */
  dispose(): void;
}

/**
 * The panel's element ids. `<label for>` and `aria-describedby` need them, and
 * the end-to-end suite finds the field and the two regions by them. One panel
 * is mounted, so they are fixed.
 */
const SEARCH_ID = 'search';
const QUERY_ID = 'search-query';
const STATUS_ID = 'search-status';
const REFUSAL_ID = 'search-refusal';
const MODE_NAME = 'search-mode';

/**
 * The interface chrome, in English, until the i18n work of M10 (SPEC §8).
 *
 * `failed` is the whole of what a failure says. An error's own message is
 * never shown: a `core` error can carry the raw characters it refused, and a
 * worker error names the request it was for.
 */
const TEXT = {
  region: 'Search the library',
  query: 'Phrase to find',
  mode: 'Fill the rest of the page with',
  random: 'Random text',
  spaces: 'Spaces',
  submit: 'Search',
  searching: 'Searching',
  failed: 'The search could not be completed.',
} as const;

/** Build the panel, mount it, and start showing `session`'s status. */
export function createSearchPanel(options: SearchPanelOptions): SearchPanel {
  const { container, session } = options;

  const label = element('label', 'search-label');
  label.htmlFor = QUERY_ID;
  label.textContent = TEXT.query;

  const query = element('textarea', 'search-query');
  query.id = QUERY_ID;
  query.rows = 3;
  // A query is symbols of a page, not prose: a spelling checker would
  // underline every one of them, and a capitalising keyboard would change the
  // first letter, which `normalize` folds anyway but the user did not type.
  query.spellcheck = false;
  query.autocapitalize = 'off';
  query.setAttribute('autocomplete', 'off');

  const random = radio('random', TEXT.random, true);
  const spaces = radio('spaces', TEXT.spaces, false);
  const legend = document.createElement('legend');
  legend.textContent = TEXT.mode;
  const modes = element('fieldset', 'search-modes');
  modes.append(legend, random.label, spaces.label);

  const submit = element('button', 'search-submit');
  submit.type = 'submit';
  submit.textContent = TEXT.submit;

  const status = element('p', 'search-status');
  status.id = STATUS_ID;
  status.setAttribute('role', 'status');

  const refusal = element('p', 'search-refusal');
  refusal.id = REFUSAL_ID;
  refusal.setAttribute('role', 'alert');

  const form = element('form', 'search');
  form.id = SEARCH_ID;
  form.setAttribute('role', 'search');
  form.setAttribute('aria-label', TEXT.region);
  form.append(label, query, modes, submit, status, refusal);
  container.append(form);

  const onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    // Left unhandled on purpose. The session's promise rejects only for a
    // bug, such as a listener of the machine throwing while a hit is
    // dispatched, and the browser's own report of an unhandled rejection,
    // with its stack, is the most useful thing that bug can produce; the
    // end-to-end suite watches the console for it.
    void session.submit(query.value, random.input.checked ? 'random' : 'spaces');
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    // Enter while an input method is composing confirms the composition, and
    // is the input method's rather than the form's.
    if (event.key !== 'Enter' || event.isComposing) {
      return;
    }
    event.preventDefault();
    form.requestSubmit();
  };

  form.addEventListener('submit', onSubmit);
  query.addEventListener('keydown', onKeyDown);
  const unsubscribe = session.subscribe(render);
  render(session.status);

  return {
    element: form,
    dispose(): void {
      unsubscribe();
      form.removeEventListener('submit', onSubmit);
      query.removeEventListener('keydown', onKeyDown);
      form.remove();
    },
  };

  function render(shown: SearchStatus): void {
    switch (shown.kind) {
      case 'idle':
        showStatus('', null);
        clearRefusal();
        return;
      case 'searching':
        showStatus(TEXT.searching, null);
        clearRefusal();
        return;
      case 'found':
        showStatus(describeHit(shown.hit), shown.hit.offset);
        clearRefusal();
        return;
      case 'failed':
        showStatus(TEXT.failed, null);
        clearRefusal();
        return;
      case 'refused':
        showStatus('', null);
        showRefusal(shown.refusal.message);
        return;
    }
  }

  /** The result line, and the hit's zero-based offset for the e2e suite. */
  function showStatus(text: string, offset: number | null): void {
    status.textContent = text;
    if (offset === null) {
      delete status.dataset.offset;
    } else {
      status.dataset.offset = String(offset);
    }
  }

  function showRefusal(message: readonly MessageSegment[]): void {
    refusal.replaceChildren(...message.map(segmentNode));
    query.setAttribute('aria-invalid', 'true');
    query.setAttribute('aria-describedby', REFUSAL_ID);
  }

  function clearRefusal(): void {
    refusal.replaceChildren();
    query.removeAttribute('aria-invalid');
    query.removeAttribute('aria-describedby');
  }
}

/**
 * Where a hit landed, in words.
 *
 * The room's name is bounded (`./room-name.ts`): this line is a live region,
 * and the last room's name is 3197 characters. The page and the position are
 * one-based, as the reader's page indicator is, and the position says so; the
 * wall, the shelf and the volume are the address's own numbers, as the
 * reader's position line shows them.
 */
function describeHit(hit: Hit): string {
  const { room, wall, shelf, volume, page } = hit.address;
  return `Found in room ${describeRoom(room)}, wall ${String(wall)}, shelf ${String(shelf)}, volume ${String(volume)}, page ${String(page + 1)}, at character ${String(hit.offset + 1)}, counting from 1.`;
}

/** One segment of a refusal: a string, or a created `<bdi>` holding a glyph. */
function segmentNode(segment: MessageSegment): Node | string {
  if (segment.kind === 'text') {
    return segment.text;
  }
  const isolated = document.createElement('bdi');
  isolated.textContent = segment.text;
  return isolated;
}

/** A radio of the padding fieldset, inside its own label. */
function radio(
  mode: PadMode,
  text: string,
  isChecked: boolean
): { readonly label: HTMLLabelElement; readonly input: HTMLInputElement } {
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = MODE_NAME;
  input.value = mode;
  input.checked = isChecked;
  const label = element('label', 'search-mode');
  label.append(input, text);
  return { label, input };
}

function element<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className: string
): HTMLElementTagNameMap[Tag] {
  const created = document.createElement(tag);
  created.className = className;
  return created;
}
