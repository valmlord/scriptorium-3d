/**
 * Which console messages are the application's, and which are the browser's.
 *
 * Two scenarios assert that reading the library logs nothing, and they are
 * worth keeping strict: a patched shader that fails to compile is a
 * `THREE.WebGLProgram` error and nothing else (`src/engine/titles.ts`), and an
 * unhandled rejection from a cancelled request is a page error.
 *
 * `GL Driver Message` lines are neither. They come from the GL driver by way
 * of Chromium: on this platform a WebGL canvas composited with the rest of the
 * page is read back, and the driver reports the stall as a performance
 * warning. Nothing in `src/` decides whether they appear, they appear on the
 * room's own page with no overlay over it, and they were reproduced on
 * `main`'s own bundle while M6 was being written. A test that fails on them
 * fails for a reason unrelated to the change in front of it, which is the
 * failure mode ADR-0007 keeps out of this suite.
 */

/** Whether `text` is a message the application itself produced. */
export function isApplicationMessage(text: string): boolean {
  return !text.includes('GL Driver Message');
}
