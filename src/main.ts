import { roomToName } from '@core/address';
import { createViewer } from '@engine/viewer';
import { GenerationClient, createGenerationWorker } from '@worker/client';
import { createReader } from '@ui/reader';
import { createChoreography } from '@app/choreography';
import { installControls } from '@app/controls';
import { installDebugHook } from '@app/debug';
import { whenAllIdle } from '@app/idle';
import { createTitleResolver } from '@app/titles';

/**
 * Entry point: mount the canvas, open the library at its first room, and join
 * the layers up.
 *
 * The order matters in four places. The choreography is built before the
 * viewer because the viewer asks for a rig on every frame it draws; the room
 * is loaded before the controls are installed because a pick needs something
 * to pick from; the reader and the title resolver are given the one generation
 * client rather than one each, so a title drawn on a spine and the page behind
 * it come out of the same cache; and the reader is built before the title
 * resolver, so that it subscribes to the machine first. Both react to the same
 * event and the worker answers in the order it was asked, so that subscription
 * order is what puts the page somebody is waiting to read ahead of 32 titles
 * for spines the camera is still flying towards.
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

const choreography = createChoreography(FIRST_ROOM);
const client = new GenerationClient(createGenerationWorker());
const viewer = createViewer(canvas, {
  frame: (seconds) => choreography.frame(seconds),
});

viewer.loadRoom(FIRST_ROOM);

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
 * A name is base-36 and a room index runs to 4975 digits (`@core/address`), so
 * the whole name is not a thing to put in a console line: it would bury the
 * rest of the message and the digits past the first few identify nothing a
 * person can act on. The length is reported alongside, which is what makes two
 * truncated names distinguishable.
 */
const REPORTED_ROOM_NAME_DIGITS = 12;

function describeRoom(room: bigint): string {
  const name = roomToName(room);
  return name.length <= REPORTED_ROOM_NAME_DIGITS
    ? name
    : `${name.slice(0, REPORTED_ROOM_NAME_DIGITS)} (${String(name.length)} digits)`;
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
 * line, where someone is looking. Reporting it here as well would be the only
 * `console` call in `src/`, in the one file that has nothing on screen yet to
 * report it on.
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
