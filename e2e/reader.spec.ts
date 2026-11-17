import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PAGE_LENGTH } from '../src/core/address';
import type { Address, BookAddress } from '../src/core/address';
import { TITLE_LENGTH, getPage, getTitle } from '../src/core/library';
import { isApplicationMessage } from './console';
import { hookAddress, hookLevel, waitForIdle } from './debug-hook';
import { clickFirstVolume } from './spines';
import { installWebGLProbe, readWebGLProbe } from './webgl-probe';

/**
 * M6's end-to-end scenarios: the page on screen is the page at that address,
 * it is text rather than a texture, and turning it is interruptible.
 *
 * **The expected text is computed here, by `core` itself.** The suite imports
 * `getPage` and `getTitle` and compares what the browser shows against what
 * the library says, which is the only way "the reader shows the page at that
 * address" is a statement about the bijection rather than about the reader
 * agreeing with itself. A title is asserted against `getTitle` and never
 * against the first 25 characters of a page taken here, because a copy of the
 * rule in the test would pass a reader that had copied the rule wrongly.
 *
 * Nothing waits on a duration. Every step waits on `waitForIdle()`, which from
 * M6 accounts for the camera, the worker's request table, the reader catching
 * up with the machine, and the shelf of titles (`docs/testing.md` §7).
 *
 * Where the library opens: `src/main.ts` holds room 0, and the hook reports
 * the rest of the address.
 */

/** The room the application opens at, which the hook does not report. */
const FIRST_ROOM = 0n;

/** The grid of `src/ui/page-grid.ts`: 80 lines of 40 characters. */
const READER_ROWS = 80;

/** The reader's elements, as a test reaches them. */
const READER = '#reader';
const READER_PAGE = '#reader .reader-page';
const READER_TITLE = '#reader-title';
const READER_STATUS = '#reader .reader-status';
const NEXT_PAGE = '#reader-next';
const PREVIOUS_PAGE = '#reader-previous';

/** 4 walls * 5 shelves * 32 volumes, restated because the page cannot be asked. */
const SPINES_PER_ROOM = 640;

/** Frames to let pass before reading the draw-call probe. */
const PROBE_FRAMES = 6;

declare global {
  interface Window {
    /** Every text the reader's page element has held since the observer started. */
    __readerTexts?: string[];
  }
}

/** The full address the hook reports, in the room the application opened at. */
async function openAddress(page: Page): Promise<Address> {
  const address = await hookAddress(page);
  expect(address).not.toBeNull();
  if (address === null) {
    throw new Error('no book is open');
  }
  return { room: FIRST_ROOM, ...address };
}

/** The volume of an address, for `getTitle`. */
function volumeOf(address: Address): BookAddress {
  return {
    room: address.room,
    wall: address.wall,
    shelf: address.shelf,
    volume: address.volume,
  };
}

/** The reader's page text as the DOM holds it, which is the page itself. */
async function readerContent(page: Page): Promise<string> {
  return (await page.locator(READER_PAGE).textContent()) ?? '';
}

/** Open the first volume the pointer can find, and wait for it to settle. */
async function openFirstVolume(page: Page): Promise<Address> {
  await page.goto('/');
  await waitForIdle(page);
  await clickFirstVolume(page);
  await waitForIdle(page);
  await expect(page.locator(READER)).toBeVisible();
  return openAddress(page);
}

/** Record every text the reader's page element holds from now on. */
function watchReaderText(page: Page): Promise<void> {
  return page.evaluate((selector: string) => {
    const article = document.querySelector(selector);
    if (article === null) {
      throw new Error('the reader is not mounted');
    }
    const texts: string[] = [];
    window.__readerTexts = texts;
    new MutationObserver(() => {
      texts.push(article.textContent ?? '');
    }).observe(article, { subtree: true, childList: true, characterData: true });
  }, READER_PAGE);
}

/** The texts the reader has held since `watchReaderText`. */
async function recordedTexts(page: Page): Promise<string[]> {
  return (await page.evaluate(() => window.__readerTexts ?? [])) as string[];
}

test('the reader shows the 3200 characters of the page at that address', async ({
  page,
}) => {
  const address = await openFirstVolume(page);

  const shown = await readerContent(page);

  expect(shown).toHaveLength(PAGE_LENGTH);
  // The claim of the milestone: this is the page the library holds at that
  // address, not 3200 plausible characters.
  expect(shown).toBe(getPage(address));
  expect(address.page).toBe(0);
  await expect(page.locator(`${READER_PAGE} p`)).toHaveCount(READER_ROWS);
});

test('the page is real text, which can be selected and copied', async ({ page }) => {
  const address = await openFirstVolume(page);

  const selected = await page.evaluate((selector: string) => {
    const article = document.querySelector(selector);
    if (article === null) {
      return null;
    }
    const range = document.createRange();
    range.selectNodeContents(article);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return {
      text: selection?.toString() ?? '',
      userSelect: window.getComputedStyle(article).userSelect,
    };
  }, READER_PAGE);

  expect(selected).not.toBeNull();
  // A line per element, so a selection across the page comes back with the
  // newlines and nothing else between the characters. The spaces matter: the
  // alphabet's symbol 0 is a space (SPEC §2) and HTML collapses whitespace
  // unless the lines are laid out `pre`, so this is what holds that rule.
  expect(selected?.text.replaceAll('\n', '')).toBe(getPage(address));
  expect(selected?.userSelect).not.toBe('none');
});

test('a title on the page is the first 25 characters of page 0', async ({ page }) => {
  const address = await openFirstVolume(page);

  const heading = await page.locator(READER_TITLE).textContent();

  // Against `getTitle`, not against a slice taken here: SPEC §4 defines a
  // title and the test must not hold a second copy of that definition.
  expect(heading).toBe(getTitle(volumeOf(address)));
  expect(heading).toHaveLength(TITLE_LENGTH);
});

test('turning a page shows the next page of the same volume', async ({ page }) => {
  const address = await openFirstVolume(page);

  await page.locator(NEXT_PAGE).click();
  await waitForIdle(page);

  const turned = await openAddress(page);
  expect(turned.page).toBe(1);
  expect(await hookLevel(page)).toBe('book');
  expect(await readerContent(page)).toBe(getPage({ ...address, page: 1 }));
  await expect(page.locator(READER_STATUS)).toHaveText('Page 2 of 410');
  // The first page of a volume has nowhere to turn back to, and the second
  // does, so the control is a projection of the address as well.
  await expect(page.locator(PREVIOUS_PAGE)).toBeEnabled();
});

test('a page turn interrupted mid-flight leaves the machine and the view agreeing', async ({
  page,
}) => {
  const address = await openFirstVolume(page);
  await watchReaderText(page);

  // Two turns in one task, which is the only way to be sure the second lands
  // while the first is still being generated: the worker answers a page in
  // single-digit milliseconds, so two separate clicks would not interrupt
  // anything (ADR-0005).
  await page.evaluate((selector: string) => {
    const next = document.querySelector(selector);
    if (!(next instanceof HTMLButtonElement)) {
      throw new Error('the reader has no next-page control');
    }
    next.click();
    next.click();
  }, NEXT_PAGE);

  await waitForIdle(page);

  // ADR-0030's definition of consistency, in the reader: the machine and the
  // view may disagree about which page is on screen while a turn is in
  // flight, and may not disagree about which page is being opened.
  const reached = await openAddress(page);
  expect(reached.page).toBe(2);
  expect(await readerContent(page)).toBe(getPage({ ...address, page: 2 }));
  await expect(page.locator(READER_STATUS)).toHaveText('Page 3 of 410');
  await expect(page.locator(READER_PAGE)).toHaveAttribute('aria-busy', 'false');

  // And the superseded page was never shown. The request for it was cancelled
  // and its reply, late or cached, changes nothing (ADR-0031).
  const shown = await recordedTexts(page);
  expect(shown).not.toContain(getPage({ ...address, page: 1 }));
  expect([...new Set(shown)]).toEqual([getPage({ ...address, page: 2 })]);
});

test('a turn superseded by a cached page writes nothing to the view', async ({
  page,
}) => {
  const address = await openFirstVolume(page);
  // Both pages are in the client's cache after this, so both replies resolve
  // inside the task that asks for them rather than after a round trip.
  await page.locator(NEXT_PAGE).click();
  await waitForIdle(page);
  await page.locator(PREVIOUS_PAGE).click();
  await waitForIdle(page);
  await watchReaderText(page);

  await page.evaluate(
    (selectors: { next: string; previous: string }) => {
      const next = document.querySelector(selectors.next);
      const previous = document.querySelector(selectors.previous);
      if (!(next instanceof HTMLButtonElement)) {
        throw new Error('the reader has no next-page control');
      }
      if (!(previous instanceof HTMLButtonElement)) {
        throw new Error('the reader has no previous-page control');
      }
      next.click();
      next.click();
      previous.click();
    },
    { next: NEXT_PAGE, previous: PREVIOUS_PAGE }
  );

  await waitForIdle(page);

  // Three turns, two of them superseded by replies that resolve inside the
  // task that asked for them, because those pages are in the client's cache.
  // The only text the view ever held is the page the machine ended at.
  const reached = await openAddress(page);
  expect(reached.page).toBe(1);
  expect([...new Set(await recordedTexts(page))]).toEqual([
    getPage({ ...address, page: 1 }),
  ]);
});

test('closing the reader leaves the book, and the text with it', async ({ page }) => {
  await openFirstVolume(page);

  await page.locator('#reader-close').click();
  await waitForIdle(page);

  expect(await hookLevel(page)).toBe('shelf');
  expect(await hookAddress(page)).toBeNull();
  await expect(page.locator(READER)).toBeHidden();
  // Emptied rather than left holding the last page: a hidden overlay still
  // answers `textContent`, and a page nobody has open is not a page.
  expect(await readerContent(page)).toBe('');
});

test('the reader has no serious or critical accessibility violations', async ({
  page,
}) => {
  await openFirstVolume(page);

  const results = await new AxeBuilder({ page }).include(READER).analyze();

  const serious = results.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious'
  );
  expect(serious).toEqual([]);
});

test('the spines keep their one draw call once a shelf has titles', async ({
  page,
}) => {
  await installWebGLProbe(page);

  await page.goto('/');
  await waitForIdle(page);
  await clickFirstVolume(page);
  // The shelf of titles is resolved and drawn into the atlas by the time the
  // hook reports idle, so the frames read below are frames with titles in
  // them (`src/app/titles.ts`).
  await waitForIdle(page);
  const report = await readWebGLProbe(page, PROBE_FRAMES);

  const settled = report.frames.slice(-PROBE_FRAMES);
  expect(settled.length).toBeGreaterThan(0);
  for (const frame of settled) {
    // The claim of `docs/architecture.md` §3, now that a spine carries a
    // title: 640 volumes, one instanced call. A texture per shelf would have
    // made this grow with every shelf the reader visits.
    expect(frame.instanced.filter((count) => count === SPINES_PER_ROOM)).toHaveLength(
      1
    );
  }
});

test('reading a book logs nothing to the console', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (!isApplicationMessage(message.text())) {
      return;
    }
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    problems.push(error.toString());
  });

  await openFirstVolume(page);
  await page.locator(NEXT_PAGE).click();
  await waitForIdle(page);

  // The patched spine shader is compiled on the first shelf of titles, and a
  // shader that does not compile is a console error and nothing else
  // (`src/engine/titles.ts`).
  expect(problems).toEqual([]);
});
