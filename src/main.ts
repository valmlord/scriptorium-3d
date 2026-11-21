import { roomToName } from '@core/address';
import { createViewer } from '@engine/viewer';
import { GenerationClient, createGenerationWorker } from '@worker/client';
import { createReader } from '@ui/reader';
import { createChoreography } from '@app/choreography';
import { installControls } from '@app/controls';
import { installDebugHook } from '@app/debug';
import { whenAllIdle } from '@app/idle';
import { shownRoomOf } from '@app/shown-room';
import { createTitleResolver } from '@app/titles';

/**
 * Entry point: mount the canvas, open the library at its first room, and join
 * the layers up.
 *
 * The order is viewer, first room, choreography, reader, title resolver,
 * controls, loop, and it matters in five places:
 *
 * - **The viewer and its first room come before the choreography**, because
 *   the choreography's `shownRoom` is `shownRoomOf(viewer)`, evaluated as an
 *   argument, and the viewer is the one holder of the room on screen. The
 *   viewer's `frame` closure reads the choreography lazily, and nothing calls
 *   it before `viewer.start()`.
 * - **`showRoom` may refer to the viewer and the title resolver** although the
 *   resolver is built after it: it runs only from a swap inside `frame()`,
 *   which needs the loop started, so both exist by then.
 * - **The room is loaded before the controls are installed**, because a pick
 *   needs something to pick from.
 * - **The reader and the title resolver are given the one generation client**
 *   rather than one each, so a title drawn on a spine and the page behind it
 *   come out of the same cache.
 * - **The reader is built before the title resolver**, so that it subscribes
 *   to the machine first. Both react to the same event and the worker answers
 *   in the order it was asked, so that subscription order is what puts the
 *   page somebody is waiting to read ahead of 32 titles for spines the camera
 *   is still flying towards.
 *
 * **After startup, `viewer.loadRoom` is called by the swap alone**, through
 * the `showRoom` below. A second caller would skip `titles.refresh()`, leaving
 * the shelf being read blank, and would put a room on screen that the machine
 * does not name. `src/app/__tests__/room-loading.test.ts` counts the calls in
 * `src/` and allows exactly these two.
 *
 * `frame` is the single point where time enters the application: the one
 * `setAnimationLoop` hands its timestamp here, the choreography advances gsap's
 * root timeline with it, and the rig that comes back is written onto the
 * camera. There is no second clock and no second loop
 * (`docs/architecture.md` §2).
 *
 * The debug hook is installed only outside a production build. The condition is
 * `import.meta.env.MODE`, which Vite replaces with a literal at build time, so
 * `npm run build` drops the branch and the module behind it: the production
 * bundle contains no `__scriptorium` at all, and
 * `src/__tests__/production-bundle.test.ts` builds it and looks.
 *
 * **`waitForIdle` is composed here** (`docs/testing.md` §7). Three things can
 * be busy from M6: the camera flight, the worker client's request table, and
 * the reader catching up with the machine. The title resolver is a fourth,
 * and it is in the list because the titles of a shelf are generated work a
 * test has every reason to wait for. `@app/idle` joins them; nothing here
 * holds a second opinion about what idle means.
 */

/** Where the library opens until the router of M8 says otherwise. */
const FIRST_ROOM = 0n;

const canvas = document.getElementById('canvas');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('Canvas element not found');
}

const viewer = createViewer(canvas, {
  frame: (seconds) => choreography.frame(seconds),
});

viewer.loadRoom(FIRST_ROOM);

// One query for the whole session, read on every flight rather than once, so
// a preference changed while the page is open applies to the next flight.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const choreography = createChoreography(FIRST_ROOM, {
  shownRoom: shownRoomOf(viewer),
  showRoom: (room) => {
    viewer.loadRoom(room);
    // The machine moved before the swap, so the shelf it is at in this room
    // was asked for while the last room was on screen.
    titles.refresh();
  },
  prefersReducedMotion: () => reducedMotion.matches,
});
const client = new GenerationClient(createGenerationWorker());

const reader = createReader({
  container: document.body,
  navigation: choreography.navigation,
  source: client,
});
const titles = createTitleResolver({
  navigation: choreography.navigation,
  source: client,
  destination: viewer,
  /**
   * A shelf the atlas will not take, reported here because this is the only
   * place that could decide what to do with it. The reader sees nothing: a
   * spine cannot show an error, the shelf stays undrawn, and it is asked for
   * again the next time the camera approaches it, so the consequence is a wall
   * of blank spines rather than a silent wrong title, which is the direction
   * this project errs in.
   *
   * What it is not is silent to whoever is working on the thing. The condition
   * is a bug on this side of the boundary - the client fans a shelf out over
   * exactly the number of requests the atlas requires, so a refusal means one
   * of the two stopped agreeing - and a bug that leaves blank spines and no
   * trace is one that gets attributed to generation or to WebGL. So it goes to
   * the console, which is the only `console` call in `src/`, and the e2e suite
   * asserts a clean console over the reading flow (`e2e/reader.spec.ts`), so
   * this line going off in a run is a failure rather than noise.
   *
   * It is a reported failure rather than an unhandled rejection because an
   * unhandled rejection is a console line nobody owns and a red test run.
   * The frame instrumentation of M10 is where this gets somewhere better.
   */
  onFailure: (shelf, error) => {
    console.error(
      `the atlas refused the titles of wall ${String(shelf.wall)}, shelf ${String(shelf.shelf)} of room ${describeRoom(shelf.room)}`,
      error
    );
  },
});

/**
 * How much of a room's name a console line carries.
 *
 * A name is base-36 and the last room's is 3197 characters long
 * (`@core/address`; 4975 is the same index in decimal, which is the figure
 * that gets quoted and is not the one that matters here), so the whole name is
 * not a thing to put in a console line: it would bury the rest of the message
 * and the characters past the first few identify nothing a person can act on.
 * The length is reported alongside, which is what makes two truncated names
 * distinguishable.
 */
const REPORTED_ROOM_NAME_CHARACTERS = 12;

function describeRoom(room: bigint): string {
  const name = roomToName(room);
  return name.length <= REPORTED_ROOM_NAME_CHARACTERS
    ? name
    : `${name.slice(0, REPORTED_ROOM_NAME_CHARACTERS)} (${String(name.length)} characters)`;
}

installControls(canvas, viewer, choreography);
viewer.start();

/**
 * Pay the cold-start cost on a page nobody is waiting for (ADR-0005): the
 * first `getPage` of a fresh worker measured up to 12.4 ms, roughly eight
 * times a warm one.
 *
 * The rejection is caught and deliberately nothing is done with it. A worker
 * that cannot generate a throwaway page cannot generate the first page the
 * reader asks for either, and that one is refused in the reader's own status
 * line, where someone is looking. The refused shelf above is reported because
 * nothing on screen can say so and the condition is a bug on this side of the
 * boundary; a worker that cannot warm up says so through the reader on the
 * very next page, so a second line here would report the same fault twice.
 */
client.warmUp().catch(() => {
  // Deliberately nothing. See above.
});

if (import.meta.env.MODE !== 'production') {
  installDebugHook(window, {
    state: () => choreography.state,
    address: () => choreography.address,
    rig: () => choreography.rig(),
    waitForIdle: () =>
      whenAllIdle([
        choreography,
        reader,
        titles,
        {
          isIdle: () => client.isQuiet,
          whenIdle: () => client.whenQuiet(),
        },
      ]),
  });
}
