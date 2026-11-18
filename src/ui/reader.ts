import { PAGES_PER_BOOK, assertValidAddress } from '@core/address';
import type { Address, BookAddress } from '@core/address';
import { AddressBeyondLibraryError } from '@core/errors';
import { addressOf, bookAddressOf } from '@state/navigation';
import type { Navigation, NavigationState } from '@state/navigation';
import type { GenerationRequest } from '@worker/client';
import { READER_ROWS, pageLines } from './page-grid';
import './reader.css';

/**
 * The reader: the page the navigation machine says is open, as real DOM text.
 *
 * **It is a projection of `@state` and holds no opinion of its own**
 * (`docs/architecture.md` §4). The open volume and the open page live in the
 * machine; this renders what the machine says and dispatches events when the
 * reader asks to turn. There is no second record of where the user is, which
 * is why the only way the view can disagree with the machine is by lagging.
 *
 * **An interrupted turn is ADR-0030's model, mapped** (ADR-0032). The machine
 * commits on the event and the view lags behind it by one generation request.
 * The one rule that makes that safe is below in `accept`: a page is written to
 * the DOM only while the machine still has that page open, so the DOM is a
 * pure function of the machine's address exactly as the camera rig is a pure
 * function of the playhead. A superseded reply changes nothing, whether it was
 * cancelled, already in flight, or served from the cache inside the same task.
 *
 * **The text is text.** 80 line elements of 40 characters, selectable and
 * copyable, laid out by a monospace font rather than drawn into a texture
 * (`./page-grid.ts`). A `<canvas>` would be faster and would not be a page.
 *
 * **What it does not reach for.** `@core/address` for the arithmetic of an
 * address and `@state` for where the user is; the generation client is
 * injected as `BookSource` rather than constructed here, because the title
 * resolver of `@app` shares one client and one cache with it and composing the
 * layers is `app`'s job (`docs/architecture.md` §1). Nothing in here knows
 * what a `Worker` is, and nothing in here can generate a page.
 */

/**
 * What the reader needs of `@worker/client`'s `GenerationClient`, which
 * satisfies it structurally. A page and the volume's title, each as a handle
 * that can be abandoned (ADR-0016).
 */
export interface BookSource {
  page(address: Address): GenerationRequest<string>;
  title(book: BookAddress): GenerationRequest<string>;
}

/** What the composition root gives the reader. */
export interface ReaderOptions {
  /** Where the overlay is mounted. */
  readonly container: HTMLElement;
  /** The machine the reader projects, and dispatches its turns to. */
  readonly navigation: Navigation;
  /** Where the text comes from. */
  readonly source: BookSource;
}

/** The reader overlay, mounted and watching the machine. */
export interface Reader {
  /** The overlay's root element, for a caller that needs to find it. */
  readonly element: HTMLElement;
  /** Whether the view has caught up with the machine and nothing is pending. */
  isIdle(): boolean;
  /** Resolves the next time the view has caught up. */
  whenIdle(): Promise<void>;
  /** Stop watching, abandon what is in flight, and remove the overlay. */
  dispose(): void;
}

/**
 * The overlay's element ids.
 *
 * `aria-labelledby` needs the heading's, and the end-to-end suite needs the
 * controls' — a page turn interrupted mid-flight has to dispatch two turns
 * inside one task, which a test can only do by finding the button in the page
 * itself. One reader is mounted, so these are fixed rather than generated.
 */
const READER_ID = 'reader';
const READER_TITLE_ID = 'reader-title';
const PREVIOUS_ID = 'reader-previous';
const NEXT_ID = 'reader-next';
const CLOSE_ID = 'reader-close';

/**
 * The interface chrome, in English.
 *
 * The library's own text is always Cyrillic and the chrome is bilingual
 * (SPEC §8), but the dictionary and the language switch are the i18n work this
 * milestone does not do. Until then these are the strings, in the repository's
 * language, in one place rather than scattered through the builder.
 */
const TEXT = {
  region: 'Reader',
  previous: 'Previous page',
  next: 'Next page',
  close: 'Close the reader',
  loading: 'generating',
  unavailable: 'This page could not be generated',
} as const;

/** Build the reader, mount it, and start projecting `navigation`. */
export function createReader(options: ReaderOptions): Reader {
  const { container, navigation, source } = options;

  const lineElements: readonly HTMLParagraphElement[] = buildLines();
  const title = element('h2', 'reader-title');
  title.id = READER_TITLE_ID;
  const position = element('p', 'reader-position');
  const status = element('p', 'reader-status');
  // `role="status"` on the one small element that changes, and not on the
  // page: a live region holding 3200 characters would read the whole page out
  // again on every turn, which is a worse reader than no live region at all.
  status.setAttribute('role', 'status');

  const previous = button(PREVIOUS_ID, TEXT.previous);
  const next = button(NEXT_ID, TEXT.next);
  const close = button(CLOSE_ID, TEXT.close);

  const page = document.createElement('article');
  page.className = 'reader-page';
  // Focusable because it scrolls: a region a pointer can scroll and a keyboard
  // cannot reach is unusable without a mouse. Focus is not *moved* here when a
  // book opens, deliberately — the machine commits the instant a spine is
  // clicked (ADR-0030) and the camera is still flying, so taking the focus
  // then would take it during a movement the reader is still watching.
  page.tabIndex = 0;
  page.setAttribute('aria-labelledby', READER_TITLE_ID);
  page.append(...lineElements);

  const panel = element('div', 'reader-panel');
  const header = document.createElement('header');
  header.className = 'reader-header';
  const controls = element('div', 'reader-controls');
  controls.append(previous, next, close);
  header.append(title, position, status, controls);
  panel.append(header, page);

  const root = document.createElement('section');
  root.className = 'reader';
  root.id = READER_ID;
  root.setAttribute('aria-label', TEXT.region);
  root.hidden = true;
  root.append(panel);
  container.append(root);

  /** The page the machine has open, or `null` when no book is. */
  let open: Address | null = null;

  /** The page whose text is in the DOM, if any. */
  let rendered: Address | null = null;

  /**
   * The page the reader has finished dealing with, written or refused. It is
   * `rendered` except after a failure, and the difference is what keeps
   * `isIdle` from waiting forever for a page that will not come.
   */
  let settled: Address | null = null;

  /** The volume whose title is in the heading, if any. */
  let titled: BookAddress | null = null;

  /** The page the request in flight asked for, so a repeat is not reissued. */
  let requestedPage: Address | null = null;

  let pageRequest: GenerationRequest<string> | null = null;
  let titleRequest: GenerationRequest<string> | null = null;
  const idleWaiters: (() => void)[] = [];

  const reader: Reader = {
    element: root,

    isIdle(): boolean {
      return (
        pageRequest === null && titleRequest === null && sameAddress(open, settled)
      );
    },

    whenIdle(): Promise<void> {
      if (reader.isIdle()) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },

    dispose(): void {
      unsubscribe();
      previous.removeEventListener('click', onPrevious);
      next.removeEventListener('click', onNext);
      close.removeEventListener('click', onClose);
      shut();
      root.remove();
    },
  };

  const onPrevious = (): void => {
    turnBy(-1);
  };
  const onNext = (): void => {
    turnBy(1);
  };
  const onClose = (): void => {
    navigation.dispatch({ type: 'back' });
  };

  previous.addEventListener('click', onPrevious);
  next.addEventListener('click', onNext);
  close.addEventListener('click', onClose);

  const unsubscribe = navigation.subscribe(project);
  project(navigation.state);

  return reader;

  /** Render what `state` says is open, and ask for whatever is missing. */
  function project(state: NavigationState): void {
    const wanted = addressOf(state);
    if (wanted === null) {
      shut();
      return;
    }
    open = wanted;
    root.hidden = false;
    showPosition(wanted);
    askForTitle(bookAddressOf(state));
    askForPage(wanted);
    release();
  }

  /** Close the overlay and abandon everything it was waiting for. */
  function shut(): void {
    open = null;
    rendered = null;
    settled = null;
    titled = null;
    requestedPage = null;
    abandon();
    root.hidden = true;
    // Emptied rather than left holding the last page: a hidden overlay still
    // answers `textContent`, and a page nobody has open is not a page.
    for (const line of lineElements) {
      line.replaceChildren();
    }
    page.setAttribute('aria-busy', 'false');
    release();
  }

  /** Ask for `address` unless it is already shown or already on its way. */
  function askForPage(address: Address): void {
    if (sameAddress(address, rendered) && pageRequest === null) {
      settled = address;
      return;
    }
    if (pageRequest !== null && sameAddress(address, requestedPage)) {
      return;
    }
    cancelPage();
    page.setAttribute('aria-busy', 'true');
    showStatus(address, true);
    requestedPage = address;
    const request = source.page(address);
    pageRequest = request;
    request.result.then(
      (text) => {
        accept(request, address, text);
      },
      (error: unknown) => {
        refuse(request, address, error);
      }
    );
  }

  /**
   * Write `text`, if the machine still has `address` open.
   *
   * **A write is guarded by the address and nothing else** (ADR-0032). The DOM
   * is a pure function of what the machine says is open, so a reply for any
   * other page changes nothing — and it is not only the cancelled request that
   * gets here: a page already in the client's cache resolves inside the same
   * task as the turn that asked for it, so two turns dispatched together can
   * land their replies in the order the user did not ask for. Deliberately
   * *not* also guarded on being the request in flight: a reply carrying the
   * right text for the open page is the right text, whichever request fetched
   * it.
   */
  function accept(
    from: GenerationRequest<string>,
    address: Address,
    text: string
  ): void {
    if (!isOpen(address)) {
      return;
    }

    let lines: readonly string[];
    try {
      // The text crossed a `postMessage` boundary, so its length is checked
      // before anything here is written or forgotten (`./errors.ts`). Validated
      // *first*, because a throw after `forgetPageRequest` would leave this
      // page neither rendered nor settled, and the reader would never report
      // itself idle again.
      lines = pageLines(text);
    } catch (error: unknown) {
      refuse(from, address, error);
      return;
    }

    forgetPageRequest(from);
    // Zipped over the lines and looked up by row: both are `READER_ROWS` long
    // by construction, so there is nothing to guard against here.
    lines.forEach((line, row) => {
      lineElements[row]?.replaceChildren(line);
    });
    rendered = address;
    settled = address;
    page.setAttribute('aria-busy', 'false');
    showStatus(address, false);
    release();
  }

  /**
   * A page that did not arrive, if that is still the question being asked.
   *
   * **A refusal is guarded by the request, not only by the address**, and that
   * is the one place this layer needs two rules rather than one (ADR-0032). A
   * cancellation is a fact about a *request*: the machine can leave a page and
   * come back to it inside a single task, so by the time a cancelled request's
   * rejection runs, its address may be open again — and reporting that page as
   * one that could not be generated would be a reader lying about a page which
   * is on its way. Requiring the reply to be the one still in flight is what
   * distinguishes "this page failed" from "this request was abandoned", which
   * is why no error class is inspected here.
   *
   * The last page stays on screen, because a reader that blanks is harder to
   * diagnose than one that says what happened.
   */
  function refuse(
    from: GenerationRequest<string>,
    address: Address,
    error: unknown
  ): void {
    if (pageRequest !== from || !isOpen(address)) {
      return;
    }
    forgetPageRequest(from);
    settled = address;
    page.setAttribute('aria-busy', 'false');
    status.replaceChildren(`${TEXT.unavailable}: ${describe(error)}`);
    release();
  }

  /** Ask for the volume's title unless the heading already carries it. */
  function askForTitle(book: BookAddress | null): void {
    if (book === null || sameBook(book, titled)) {
      return;
    }
    cancelTitle();
    const request = source.title(book);
    titleRequest = request;
    request.result.then(
      (text) => {
        if (!isOpenBook(book)) {
          return;
        }
        forgetTitleRequest(request);
        titled = book;
        title.replaceChildren(text);
        release();
      },
      () => {
        if (!isOpenBook(book)) {
          return;
        }
        forgetTitleRequest(request);
        // The position below the heading says which volume this is, so a title
        // that did not arrive costs the heading and nothing else.
        release();
      }
    );
  }

  /**
   * Forget the page request in flight, if `from` is the one in flight.
   *
   * It is not always: turning away from a page and back to it inside one task
   * leaves a reply from the first request to arrive while the second is still
   * out, and both are for the page the machine has open. The reply is still
   * the right text for that page and is written; what must not happen is the
   * record of the *other* request being cleared, because that would report the
   * reader idle with a request outstanding and `waitForIdle()` would resolve
   * in the middle of a turn.
   */
  function forgetPageRequest(from: GenerationRequest<string>): void {
    if (pageRequest === from) {
      pageRequest = null;
      requestedPage = null;
    }
  }

  /** The same, for the heading's request. */
  function forgetTitleRequest(from: GenerationRequest<string>): void {
    if (titleRequest === from) {
      titleRequest = null;
    }
  }

  /**
   * Dispatch a turn `step` pages from the page the machine has open, if there
   * is such a page.
   *
   * The page it turns from is read out of the machine rather than out of this
   * module's own copy of it, so two clicks inside one task turn two pages.
   * Reading `open` would give the same answer today, because a dispatch
   * notifies its listeners before it returns — but that is an invariant of
   * `@state` that nothing states, and the machine is the source of truth
   * (`docs/architecture.md` §4), so it is asked directly.
   */
  function turnBy(step: number): void {
    const here = addressOf(navigation.state);
    if (here === null) {
      return;
    }
    const wanted = here.page + step;
    if (!pageExists(here, wanted)) {
      return;
    }
    navigation.dispatch({ type: 'turn-page', page: wanted });
  }

  /** The volume's position, and the turns that are possible from this page. */
  function showPosition(address: Address): void {
    // The room's name runs to 3197 characters (SPEC §3) and belongs to the
    // address bar of M8, with the copy button SPEC §7 asks for. What a reader
    // can use is where in the room the volume stands.
    position.replaceChildren(
      `Wall ${String(address.wall)}, shelf ${String(address.shelf)}, volume ${String(address.volume)}`
    );
    previous.disabled = !pageExists(address, address.page - 1);
    next.disabled = !pageExists(address, address.page + 1);
  }

  /**
   * The page indicator.
   *
   * One-based, which is the one place this layer does not use the SPEC's own
   * numbering: an address's `page` runs 0 to 409 and the URL carries it that
   * way (SPEC §3, §7), while a reader holding a book counts its pages from
   * one. The address is unchanged; only the indicator is an ordinal.
   */
  function showStatus(address: Address, busy: boolean): void {
    const ordinal = `Page ${String(address.page + 1)} of ${String(PAGES_PER_BOOK)}`;
    status.replaceChildren(busy ? `${ordinal}, ${TEXT.loading}` : ordinal);
  }

  /** Whether `page` of the volume at `address` exists. */
  function pageExists(address: Address, page: number): boolean {
    if (!Number.isInteger(page) || page < 0 || page >= PAGES_PER_BOOK) {
      return false;
    }
    try {
      assertValidAddress({ ...address, page });
      return true;
    } catch (error: unknown) {
      // The library ends part-way through the last volume of the last room
      // (SPEC §3), so the last turn of that one volume is refused by the layer
      // that owns the range rather than by a rule copied into this one. Any
      // other refusal is a bug in the caller and is not swallowed here.
      if (error instanceof AddressBeyondLibraryError) {
        return false;
      }
      throw error;
    }
  }

  function isOpen(address: Address): boolean {
    return sameAddress(address, open);
  }

  function isOpenBook(book: BookAddress): boolean {
    return sameBook(book, open);
  }

  function abandon(): void {
    cancelPage();
    cancelTitle();
  }

  function cancelPage(): void {
    pageRequest?.cancel();
    pageRequest = null;
  }

  function cancelTitle(): void {
    titleRequest?.cancel();
    titleRequest = null;
  }

  /** Release the idle waiters, if the view has caught up. */
  function release(): void {
    if (!reader.isIdle()) {
      return;
    }
    for (const resolve of idleWaiters.splice(0)) {
      resolve();
    }
  }
}

/** The 80 line elements, built once and rewritten on every turn. */
function buildLines(): readonly HTMLParagraphElement[] {
  const lines: HTMLParagraphElement[] = [];
  for (let row = 0; row < READER_ROWS; row += 1) {
    lines.push(element('p', 'reader-line'));
  }
  return lines;
}

function element<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className: string
): HTMLElementTagNameMap[Tag] {
  const created = document.createElement(tag);
  created.className = className;
  return created;
}

function button(id: string, label: string): HTMLButtonElement {
  const created = element('button', 'reader-button');
  created.id = id;
  created.type = 'button';
  created.replaceChildren(label);
  return created;
}

/** Whether two addresses name the same page. `room` is a `bigint`. */
function sameAddress(one: Address | null, other: Address | null): boolean {
  if (one === null || other === null) {
    return one === other;
  }
  return sameBook(one, other) && one.page === other.page;
}

/** Whether two addresses name the same volume, whatever page they are at. */
function sameBook(one: BookAddress | null, other: BookAddress | null): boolean {
  if (one === null || other === null) {
    return one === other;
  }
  return (
    one.room === other.room &&
    one.wall === other.wall &&
    one.shelf === other.shelf &&
    one.volume === other.volume
  );
}

/** Whatever an unknown rejection can be said about, for the status line. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
