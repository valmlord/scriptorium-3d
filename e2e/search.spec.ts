import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { BOOKS_PER_SHELF, PAGE_LENGTH } from '../src/core/address';
import type { Address } from '../src/core/address';
import { getPage, getTitle } from '../src/core/library';
import type { PadMode } from '../src/core/library';
import { ROOM_POSE, bookPose } from '../src/engine/poses';
import { RIG_FIELDS } from '../src/motion/rig';
import type { CameraPose } from '../src/motion/rig';
import { depthOf } from '../src/state/navigation';
import { isApplicationMessage } from './console';
import { hookLevel, hookRig, waitForIdle } from './debug-hook';
import type { HookRig } from './debug-hook';
import { clickFirstVolume, clickFirstVolumeInPage } from './spines';
import { installWebGLProbe } from './webgl-probe';
import type { FrameDrawCalls, TextureUpload } from './webgl-probe';

/**
 * M7's end-to-end scenarios: a phrase typed into the panel is flown to, in
 * whichever room holds it, and the reader marks it there.
 *
 * **The expected text is computed here, by `core` itself**, as in
 * `./reader.spec.ts`: the page the reader shows is compared against `getPage`
 * of the address the hook reports, and a spine's title against `getTitle`, so
 * "the page holds the phrase" is a statement about the bijection and not about
 * the reader agreeing with the panel. The camera's poses come from
 * `@engine/poses`, which is pure arithmetic and the one definition of where the
 * camera stands at each level.
 *
 * **Nothing waits on a duration.** Every step waits on `waitForIdle()`, which
 * from M7 also waits for the search session to have acted on its reply
 * (`src/main.ts`), or on a condition: polled inside the page once per animation
 * frame, or held by a retrying assertion such as `toHaveText`.
 *
 * **Every scenario runs under the clean-console assertion**, as a fixture
 * rather than repeated in each test: an unhandled rejection from a superseded
 * search, a shader that fails to compile in the new room, and a shelf the
 * atlas refuses are all console lines and nothing else.
 *
 * A search's room is drawn from a room count 4975 digits long for random
 * padding, and is a deterministic but equally deep one for spaces, so every
 * search here changes rooms: the library opens at room 0, and no hit lands
 * there.
 */

/** The panel's elements, by the ids `src/ui/search.ts` fixes. */
const QUERY = '#search-query';
const STATUS = '#search-status';
const REFUSAL = '#search-refusal';
const PANEL = '#search';

/** The reader's elements, as `./reader.spec.ts` reaches them. */
const READER = '#reader';
const READER_PAGE = '#reader .reader-page';
const READER_MARK = '#reader .reader-mark';

/** The key that goes up a level (`src/app/controls.ts`). */
const BACK_KEY = 'Escape';

/** From a book up to the room: shelf, wall, room (`src/state/navigation.ts`). */
const LEVELS_ABOVE_BOOK = depthOf('book');

/** The label of the spaces radio, which is how a person finds it. */
const SPACES_LABEL = 'Spaces';

/** A phrase of the alphabet with a space in it, so both modes have to keep one. */
const PHRASE = 'вавилонская библиотека';
const OTHER_PHRASE = 'шестигранные галереи';

/**
 * A room's own draw calls, as `./room.spec.ts` fixes them: four instanced
 * kinds and the floor and ceiling plates. Two rooms in one frame are twelve.
 */
const MAX_DRAW_CALLS = 6;

/**
 * How far a sampled rig may be from a pose and still be at it.
 *
 * Not zero, because gsap writes `start + change * ratio`, which at the end of a
 * tween can differ from the end value in the last bit. A frame in the middle of
 * the shortest leg (0.7 s) moves the rig by orders of magnitude more.
 */
const POSE_TOLERANCE = 1e-6;

/**
 * An address whose page holds a double space, which is what a search that
 * collapsed runs of spaces would send somewhere else (ADR-0035). Its page is
 * not 0, so the route ends in a page turn as well. The scenario asserts the
 * double space rather than trusting this comment: room 3, wall 2, shelf 4,
 * volume 17, page 0 has none.
 */
const DOUBLE_SPACED_ADDRESS: Address = {
  room: 7n,
  wall: 1,
  shelf: 2,
  volume: 3,
  page: 4,
};

/** What the page shows after a search has settled. */
interface Settled {
  level: string;
  address: Address | null;
  /** The panel's `data-offset`, zero-based, or `null` if it shows no hit. */
  offset: number | null;
  /** The reader's 80 lines, joined. */
  text: string;
  /** The text of each `<mark>` in the reader, in order. */
  marked: string[];
  rig: HookRig;
}

/** What the device holds, as `memory()` reports it (`./debug-hook.ts`). */
type Memory = ReturnType<NonNullable<Window['__scriptorium']>['memory']>;

declare global {
  interface Window {
    /** The `kind` of every message the page posted to a worker, in order. */
    __workerRequests?: string[];
    /** Every string drawn with `fillText` on a 2D canvas, in order. */
    __drawnTitles?: string[];
    /** The rig, once per animation frame, from the moment sampling starts. */
    __rigSamples?: HookRig[];
    /** Every text the panel's status line was given, in order. */
    __statusTexts?: string[];
  }
}

const test = base.extend<{ cleanConsole: undefined }>({
  cleanConsole: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on('console', (message) => {
        // The browser's own GL driver messages are not the application's; see
        // `./console.ts`.
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
      await use(undefined);
      expect(problems).toEqual([]);
    },
    { auto: true },
  ],
});

/** Open the library and wait for the camera to settle at the room's vantage. */
async function openLibrary(page: Page): Promise<void> {
  await page.goto('/');
  await waitForIdle(page);
}

/** Type `input` into the panel and submit it with Enter, as a person would. */
async function search(
  page: Page,
  input: string,
  mode: PadMode = 'random'
): Promise<void> {
  if (mode === 'spaces') {
    await page.getByLabel(SPACES_LABEL).check();
  }
  const field = page.locator(QUERY);
  await field.fill(input);
  await field.press('Enter');
}

/**
 * Everything a settled search is judged by, in one round trip. The room is a
 * `bigint` of up to 4975 digits and crosses the page boundary as a decimal
 * string.
 */
async function settled(page: Page): Promise<Settled> {
  const shown = await page.evaluate(
    (selectors: { status: string; text: string; mark: string }) => {
      const hook = window.__scriptorium;
      if (hook === undefined) {
        throw new Error('window.__scriptorium is not installed in this build');
      }
      const address = hook.address();
      return {
        level: hook.state().level,
        address:
          address === null ? null : { ...address, room: address.room.toString() },
        offset:
          document.querySelector(selectors.status)?.getAttribute('data-offset') ?? null,
        text: document.querySelector(selectors.text)?.textContent ?? '',
        marked: Array.from(
          document.querySelectorAll(selectors.mark),
          (mark) => mark.textContent ?? ''
        ),
        rig: hook.rig(),
      };
    },
    { status: STATUS, text: READER_PAGE, mark: READER_MARK }
  );
  return {
    ...shown,
    address: fromPageAddress(shown.address),
    offset: shown.offset === null ? null : Number(shown.offset),
  };
}

/** An address as it crosses the page boundary, its room a decimal string. */
type PageAddress = Omit<Address, 'room'> & { room: string };

function fromPageAddress(shown: PageAddress | null): Address | null {
  return shown === null ? null : { ...shown, room: BigInt(shown.room) };
}

/** The address a settled search reached; fails the test if there is none. */
function reachedAddress(address: Address | null): Address {
  expect(address).not.toBeNull();
  if (address === null) {
    throw new Error('the search reached no book');
  }
  return address;
}

/** The offset the panel reported; fails the test if it reported none. */
function reportedOffset(result: Settled): number {
  expect(result.offset).not.toBeNull();
  if (result.offset === null) {
    throw new Error('the panel reported no offset');
  }
  return result.offset;
}

/** The characters of `text` from `offset`, counted in code points. */
function slice(text: string, offset: number, length: number): string {
  return Array.from(text)
    .slice(offset, offset + length)
    .join('');
}

/** Whether `rig` is at `pose`, to within `POSE_TOLERANCE` in every field. */
function isAtPose(rig: HookRig, pose: CameraPose): boolean {
  return RIG_FIELDS.every(
    (field) => Math.abs(rig[field] - pose[field]) <= POSE_TOLERANCE
  );
}

function bookPoseOf(address: Address): CameraPose {
  return bookPose(address.wall, address.shelf, address.volume);
}

/** What a search leaves on the device once its replaced room is released. */
interface Retired {
  memory: Memory;
  /** The room of the book the machine is at, as a decimal string, or `null` above a book. */
  room: string | null;
  level: string;
}

/**
 * Wait for idle, submit `input` in the page, wait for idle again and then for
 * the replaced room to be released, and read `memory()`, the room and the
 * level, all in one round trip.
 *
 * One `page.evaluate` because at software GL every round trip waits on the
 * render loop, and on the slow CI runner each costs about 0.8 s (#69). The
 * wait before the submit is what lets the first search follow `page.goto`
 * directly, with no round trip of its own for the opening idle. The submit
 * skips the typing, which `typing a phrase flies to a book that holds it at
 * the stated offset` covers.
 */
async function searchUntilRetired(page: Page, input: string): Promise<Retired> {
  return page.evaluate(
    async (inputs: { selector: string; input: string }) => {
      const hook = window.__scriptorium;
      const field = document.querySelector(inputs.selector);
      if (
        hook === undefined ||
        !(field instanceof HTMLTextAreaElement) ||
        field.form === null
      ) {
        throw new Error('the panel or the debug hook is missing');
      }
      await hook.waitForIdle();
      field.value = inputs.input;
      field.form.requestSubmit();
      await hook.waitForIdle();
      // A condition and not a duration: the replaced room is released by a
      // render, and only then do the counts describe one room.
      while (hook.memory().isRetiring) {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }
      return {
        memory: hook.memory(),
        room: hook.address()?.room.toString() ?? null,
        level: hook.state().level,
      };
    },
    { selector: QUERY, input }
  );
}

/**
 * How long each probe's record was before a search. A probe with no mark
 * carries nothing back, so a test pays only for the records it reads.
 */
interface ProbeMarks {
  frames?: number;
  titles?: number;
  uploads?: number;
}

/** Where a search ended, and what each marked probe recorded from its mark on. */
interface Searched {
  address: Address | null;
  frames: FrameDrawCalls[];
  drawn: string[];
  uploads: TextureUpload[];
}

/**
 * Submit `input` in the page and wait for idle, in one round trip, for the
 * reason `searchUntilRetired` gives. The records are sliced in the page
 * rather than carried across whole.
 */
async function searchInPage(
  page: Page,
  input: string,
  since: ProbeMarks
): Promise<Searched> {
  const searched = await page.evaluate(
    async (inputs: { selector: string; input: string; since: ProbeMarks }) => {
      const hook = window.__scriptorium;
      const probe = window.__webglProbe;
      const field = document.querySelector(inputs.selector);
      if (
        hook === undefined ||
        probe === undefined ||
        !(field instanceof HTMLTextAreaElement) ||
        field.form === null
      ) {
        throw new Error('the panel, the debug hook or the WebGL probe is missing');
      }
      field.value = inputs.input;
      field.form.requestSubmit();
      await hook.waitForIdle();
      const address = hook.address();
      const { frames, titles, uploads } = inputs.since;
      return {
        address:
          address === null ? null : { ...address, room: address.room.toString() },
        frames: frames === undefined ? [] : probe.frames.slice(frames),
        drawn: titles === undefined ? [] : (window.__drawnTitles ?? []).slice(titles),
        uploads: uploads === undefined ? [] : probe.uploads.slice(uploads),
      };
    },
    { selector: QUERY, input, since }
  );
  return { ...searched, address: fromPageAddress(searched.address) };
}

/**
 * Record the `kind` of every message posted to a worker, below the client.
 *
 * This is how "the client stayed quiet" is observed: a refused query must not
 * reach the worker at all, and the client's own record of what it sent is the
 * thing under test. The warm-up page of `src/main.ts` is a `page` message, so
 * only `search` messages are counted.
 */
async function installWorkerProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sent: string[] = [];
    window.__workerRequests = sent;
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function recorded(
      this: Worker,
      message: unknown,
      ...rest: unknown[]
    ): void {
      sent.push(
        typeof message === 'object' && message !== null && 'kind' in message
          ? String(message.kind)
          : typeof message
      );
      Reflect.apply(original, this, [message, ...rest]);
    };
  });
}

/** How many `search` messages the page has posted to its worker. */
function searchesSent(page: Page): Promise<number> {
  return page.evaluate(
    () => (window.__workerRequests ?? []).filter((kind) => kind === 'search').length
  );
}

/**
 * Record every string drawn with `fillText`, which on this page is the spine
 * atlas and nothing else (`src/engine/titles.ts`). A title on a spine is GPU
 * texture, so the text drawn into the canvas behind it is the closest a test
 * can get to reading it without comparing pixels.
 */
async function installTitleProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const drawn: string[] = [];
    window.__drawnTitles = drawn;
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function recorded(
      this: CanvasRenderingContext2D,
      text: string,
      ...rest: unknown[]
    ): void {
      drawn.push(text);
      Reflect.apply(original, this, [text, ...rest]);
    };
  });
}

/** The atlas, in pixels (`src/engine/atlas.ts`), which is how its upload is told apart. */
const ATLAS_WIDTH = 1024;
const ATLAS_HEIGHT = 2048;

function atlasUploadsIn(uploads: readonly TextureUpload[]): number {
  return uploads.filter(
    (upload) => upload.width === ATLAS_WIDTH && upload.height === ATLAS_HEIGHT
  ).length;
}

for (const mode of ['random', 'spaces'] as const) {
  test(`typing a phrase flies to a book that holds it at the stated offset (${mode})`, async ({
    page,
  }) => {
    await openLibrary(page);

    await search(page, PHRASE, mode);
    await waitForIdle(page);

    const result = await settled(page);
    const address = reachedAddress(result.address);
    const offset = reportedOffset(result);
    expect(address.room).not.toBe(0n);
    expect(result.level).toBe('book');
    // The page on screen is the library's page at that address, and it holds
    // the phrase where the panel says it does.
    expect(result.text).toBe(getPage(address));
    expect(slice(result.text, offset, Array.from(PHRASE).length)).toBe(PHRASE);
    expect(result.marked.join('')).toBe(PHRASE);
    expect(isAtPose(result.rig, bookPoseOf(address))).toBe(true);
    await expect(page.locator(READER)).toBeVisible();
    if (mode === 'spaces') {
      const characters = Array.from(result.text);
      const outside = [
        ...characters.slice(0, offset),
        ...characters.slice(offset + Array.from(PHRASE).length),
      ];
      expect(outside.every((character) => character === ' ')).toBe(true);
    }
  });
}

test('a cross-room flight never draws two rooms', async ({ page }) => {
  await installWebGLProbe(page);
  // The opening wait for idle is folded into the click's round trip.
  await page.goto('/');
  // A shelf first, so the opening room has rendered with titles and is kept
  // from the swap until the new room's first titled render. An untitled room
  // is gone by the end of the swap frame, which would leave this scenario
  // nothing to catch.
  await clickFirstVolumeInPage(page);
  // Each step below is one round trip, for the reason `searchUntilRetired`
  // gives, and the probe's frames are sliced in the page rather than carried
  // across whole.
  const atRoom = await page.evaluate(
    async (back: { key: string; presses: number }) => {
      const hook = window.__scriptorium;
      if (hook === undefined) {
        throw new Error('window.__scriptorium is not installed in this build');
      }
      const probe = window.__webglProbe;
      if (probe === undefined) {
        throw new Error('The WebGL probe was not installed before the page loaded');
      }
      // At the book first, so the shelf's titles are drawn before the way back.
      await hook.waitForIdle();
      // Dispatched where `keyboard.press` would deliver the key, at the focused
      // element, from which it bubbles to the `window` listener of
      // `src/app/controls.ts`; that listener reads only `key` and `target`.
      for (let press = 0; press < back.presses; press += 1) {
        (document.activeElement ?? document.body).dispatchEvent(
          new KeyboardEvent('keydown', {
            key: back.key,
            bubbles: true,
            cancelable: true,
          })
        );
      }
      await hook.waitForIdle();
      return { level: hook.state().level, frames: probe.frames.length };
    },
    { key: BACK_KEY, presses: LEVELS_ABOVE_BOOK }
  );
  expect(atRoom.level).toBe('room');

  const { address, frames } = await searchInPage(page, PHRASE, {
    frames: atRoom.frames,
  });

  expect(reachedAddress(address).room).not.toBe(0n);
  expect(frames.length).toBeGreaterThan(0);
  const overBudget = frames
    .map((frame) => frame.instanced.length + frame.plain)
    .filter((calls) => calls > MAX_DRAW_CALLS);
  expect(overBudget).toEqual([]);
  // The precondition, read in every frame after the app had drawn: without a
  // frame that kept the old room, the budget above held against a swap that
  // never had two rooms to draw.
  expect(frames.some((frame) => frame.isRetiring === true)).toBe(true);
});

test('a decomposed ё is highlighted as one character', async ({ page }) => {
  // Built from escapes, so an editor cannot recompose it, and checked anyway.
  const decomposedYo = '\u0435\u0308';
  expect(decomposedYo).toHaveLength(2);
  const input = `${decomposedYo}лка`;
  const accepted = '\u0451лка';
  await openLibrary(page);
  const field = page.locator(QUERY);
  await field.fill(input);
  // And the field still holds it decomposed, so it is the app that composes it.
  expect(await field.inputValue()).toBe(input);

  await field.press('Enter');
  await waitForIdle(page);

  const result = await settled(page);
  const offset = reportedOffset(result);
  expect(result.marked.join('')).toBe(accepted);
  expect(Array.from(result.marked.join(''))).toHaveLength(Array.from(accepted).length);
  expect(slice(result.text, offset, Array.from(accepted).length)).toBe(accepted);
});

const REFUSALS = [
  {
    input: 'мир!a',
    message:
      'Not in the alphabet: ! (U+0021) at position 4, a (U+0061) at position 5. Positions count from 1.',
    glyphs: ['!', 'a'],
  },
  {
    // A tab is not a space (ADR-0035), and it has no glyph worth showing.
    input: 'мир\tдом',
    message: 'Not in the alphabet: U+0009 at position 4. Positions count from 1.',
    glyphs: [],
  },
];

for (const refusal of REFUSALS) {
  test(`a query with characters outside the alphabet is refused and names them and their positions (${JSON.stringify(refusal.input)})`, async ({
    page,
  }) => {
    await installWorkerProbe(page);
    await openLibrary(page);
    const rigBefore = await hookRig(page);

    await search(page, refusal.input);

    await expect(page.locator(REFUSAL)).toHaveText(refusal.message);
    // A glyph is shown inside its own `<bdi>`, and only a printable one.
    expect(await page.locator(`${REFUSAL} bdi`).allTextContents()).toEqual(
      refusal.glyphs
    );
    await expect(page.locator(QUERY)).toHaveAttribute('aria-invalid', 'true');
    await waitForIdle(page);
    expect(await searchesSent(page)).toBe(0);
    expect(await hookLevel(page)).toBe('room');
    expect(isAtPose(await hookRig(page), rigBefore)).toBe(true);
  });
}

test('a 3200-character page resolves to its own address', async ({ page }) => {
  const text = getPage(DOUBLE_SPACED_ADDRESS);
  expect(text).toHaveLength(PAGE_LENGTH);
  expect(text).toContain('  ');
  await openLibrary(page);

  await search(page, text);
  await waitForIdle(page);

  const result = await settled(page);
  expect(result.address).toEqual(DOUBLE_SPACED_ADDRESS);
  expect(result.offset).toBe(0);
  expect(result.text).toBe(text);
  expect(result.marked.join('')).toBe(text);
});

test('axe reports no serious or critical violation on the panel', async ({ page }) => {
  await openLibrary(page);
  const idle = await new AxeBuilder({ page }).include(PANEL).analyze();

  await search(page, 'мир!a');
  await expect(page.locator(REFUSAL)).not.toBeEmpty();
  const refused = await new AxeBuilder({ page }).include(PANEL).analyze();

  for (const results of [idle, refused]) {
    const serious = results.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious'
    );
    expect(serious).toEqual([]);
  }
});

test('the panel is keyboard reachable', async ({ page }) => {
  await openLibrary(page);

  await page.keyboard.press('Tab');
  await expect(page.locator(QUERY)).toBeFocused();
  await page.keyboard.type(PHRASE);
  await page.keyboard.press('Enter');
  await waitForIdle(page);

  const reached = await settled(page);
  expect(reached.level).toBe('book');
  expect(slice(reached.text, reportedOffset(reached), Array.from(PHRASE).length)).toBe(
    PHRASE
  );

  // Escape typed into the field is the field's. Outside it, the same key
  // would fly up to the shelf.
  await expect(page.locator(QUERY)).toBeFocused();
  await page.keyboard.press('Escape');
  await waitForIdle(page);

  const after = await settled(page);
  expect(after.level).toBe('book');
  expect(after.address).toEqual(reached.address);
});

test('with reduced motion the flight is a cut', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openLibrary(page);
  await clickFirstVolume(page);
  await waitForIdle(page);
  const start = reachedAddress((await settled(page)).address);
  await page.evaluate(() => {
    const hook = window.__scriptorium;
    if (hook === undefined) {
      throw new Error('window.__scriptorium is not installed in this build');
    }
    const samples: HookRig[] = [];
    window.__rigSamples = samples;
    const sample = (): void => {
      samples.push(hook.rig());
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  await search(page, PHRASE);
  await waitForIdle(page);

  const reached = reachedAddress((await settled(page)).address);
  expect(reached.room).not.toBe(start.room);
  const samples = await page.evaluate(() => window.__rigSamples ?? []);
  expect(samples.length).toBeGreaterThan(0);
  // Up to the room stop of room 0, the swap, and down to the book in the new
  // room, with nothing in between: a flight would leave every frame of its
  // legs here.
  const poses = [bookPoseOf(start), ROOM_POSE, bookPoseOf(reached)];
  const between = samples.filter((rig) => !poses.some((pose) => isAtPose(rig, pose)));
  expect(between).toEqual([]);
});

test('a search during a flight retargets it', async ({ page }) => {
  await openLibrary(page);

  const during = await page.evaluate(
    async (inputs: { selector: string; first: string; second: string }) => {
      const hook = window.__scriptorium;
      const field = document.querySelector(inputs.selector);
      if (
        hook === undefined ||
        !(field instanceof HTMLTextAreaElement) ||
        field.form === null
      ) {
        throw new Error('the panel or the debug hook is missing');
      }
      const form = field.form;
      const nextFrame = (): Promise<void> =>
        new Promise((resolve) => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      field.value = inputs.first;
      form.requestSubmit();
      // Waits on the hit having moved the machine, which is a condition and
      // not a duration: the flight it starts lasts seconds.
      while (hook.state().level !== 'book') {
        await nextFrame();
      }
      const firstRoom = hook.address()?.room.toString() ?? null;
      const before = hook.rig();
      await nextFrame();
      const after = hook.rig();
      field.value = inputs.second;
      form.requestSubmit();
      return { firstRoom, isFlying: JSON.stringify(before) !== JSON.stringify(after) };
    },
    { selector: QUERY, first: PHRASE, second: OTHER_PHRASE }
  );
  await waitForIdle(page);

  expect(during.isFlying).toBe(true);
  const result = await settled(page);
  const address = reachedAddress(result.address);
  expect(address.room.toString()).not.toBe(during.firstRoom);
  expect(result.level).toBe('book');
  expect(result.text).toBe(getPage(address));
  expect(
    slice(result.text, reportedOffset(result), Array.from(OTHER_PHRASE).length)
  ).toBe(OTHER_PHRASE);
  expect(isAtPose(result.rig, bookPoseOf(address))).toBe(true);
});

test('two searches in one task end at the second', async ({ page }) => {
  await installWorkerProbe(page);
  await openLibrary(page);
  await page.evaluate((selector: string) => {
    const status = document.querySelector(selector);
    if (status === null) {
      throw new Error(`nothing is mounted at ${selector}`);
    }
    const texts: string[] = [];
    window.__statusTexts = texts;
    // Each text the line is given is a new text node, so the added nodes are
    // the whole sequence even when two writes land in one batch.
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          texts.push(node.textContent ?? '');
        }
      }
    }).observe(status, { childList: true });
  }, STATUS);

  await page.evaluate(
    (inputs: { selector: string; first: string; second: string }) => {
      const field = document.querySelector(inputs.selector);
      if (!(field instanceof HTMLTextAreaElement) || field.form === null) {
        throw new Error('the panel is missing');
      }
      field.value = inputs.first;
      field.form.requestSubmit();
      field.value = inputs.second;
      field.form.requestSubmit();
    },
    { selector: QUERY, first: PHRASE, second: OTHER_PHRASE }
  );
  await waitForIdle(page);

  const result = await settled(page);
  const address = reachedAddress(result.address);
  expect(result.text).toBe(getPage(address));
  expect(
    slice(result.text, reportedOffset(result), Array.from(OTHER_PHRASE).length)
  ).toBe(OTHER_PHRASE);
  expect(result.marked.join('')).toBe(OTHER_PHRASE);
  // Both reached the worker, and only one hit was ever reported.
  expect(await searchesSent(page)).toBe(2);
  const found = (await page.evaluate(() => window.__statusTexts ?? [])).filter((text) =>
    text.startsWith('Found in room')
  );
  expect(found).toHaveLength(1);
});

test('a cross-room search leaks no geometry, texture or program', async ({ page }) => {
  // The opening wait for idle is folded into the first search's round trip.
  await page.goto('/');
  const settledMemory: Memory[] = [];
  const rooms: (string | null)[] = ['0'];

  // The third count is compared with the first, both read at a book with
  // nothing retiring. The first is past warm-up: it replaced the opening
  // room, which never drew titles, and left the titled program linked. The
  // second would not do, because the outgoing rooms differ: search 2
  // releases room A, entered from the room level and titled by its own
  // reply, and search 3 releases room B, entered from a book while a titled
  // room was kept and titled by the swap's `titles.refresh()`. So a room that
  // entered by replacing a titled room and is never disposed leaks only on
  // the third. The retirement policy gets the same calls in both, so a unit
  // test of the policy cannot see it.
  //
  // The flights' share is three wall-clock flights, about 3.1 + 6.2 + 6.2 =
  // 15.5 s: GSAP flights run on the render loop's timestamp, the same on
  // every runner. On the slow CI runner the projection is up to about 25 s,
  // about 20 to 24 s in the central range: the flights, about 0.8 s for each
  // of four round trips (the goto and the three searches), measured from the
  // failing CI trace, and up to about 1.8 s of in-page latency per search,
  // bounded from the same trace (#69). That is above half the 30 s timeout,
  // and it is the recorded floor, not a defect.
  for (let round = 0; round < 3; round += 1) {
    const { memory, room, level } = await searchUntilRetired(page, PHRASE);
    expect(level).toBe('book');
    settledMemory.push(memory);
    rooms.push(room);
  }

  // Every search changed rooms.
  for (let index = 1; index < rooms.length; index += 1) {
    expect(rooms[index]).not.toBe(rooms[index - 1]);
  }
  const [first, , third] = settledMemory;
  expect(third?.geometries).toBe(first?.geometries);
  expect(third?.textures).toBe(first?.textures);
  expect(third?.programs).toBe(first?.programs);
});

test("the new room's spines carry their own titles", async ({ page }) => {
  await installTitleProbe(page);
  await installWebGLProbe(page);
  // The opening wait for idle is folded into the click's round trip.
  await page.goto('/');
  // From a book, so the old room has a shelf of its own titles and the new
  // shelf's reply arrives during the retreat, while the old room is still on
  // screen: it is not written there, and the swap's `titles.refresh()` is
  // what draws it. From the room level the swap comes first and the reply
  // draws itself, so that path would go untested. Everything drawn from here
  // on is drawn for the room the search reaches.
  await clickFirstVolumeInPage(page);
  // One round trip each, for the reason `searchUntilRetired` gives.
  const before = await page.evaluate(async () => {
    const hook = window.__scriptorium;
    if (hook === undefined) {
      throw new Error('window.__scriptorium is not installed in this build');
    }
    await hook.waitForIdle();
    return {
      level: hook.state().level,
      titles: window.__drawnTitles?.length ?? 0,
      uploads: window.__webglProbe?.uploads.length ?? 0,
    };
  });
  // A click that missed would leave the search to start from the room level,
  // the path the comment above rules out, and the test would pass without
  // the swap's `titles.refresh()`.
  expect(before.level).toBe('book');

  const searched = await searchInPage(page, PHRASE, {
    titles: before.titles,
    uploads: before.uploads,
  });

  const address = reachedAddress(searched.address);
  const expected = Array.from({ length: BOOKS_PER_SHELF }, (_, volume) =>
    getTitle({ room: address.room, wall: address.wall, shelf: address.shelf, volume })
  );
  expect(new Set(searched.drawn)).toEqual(new Set(expected));
  // And they reached the GPU, in the new room's own atlas.
  expect(atlasUploadsIn(searched.uploads)).toBeGreaterThan(0);
});
