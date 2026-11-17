import { describe, expect, it } from 'vitest';
import { build } from 'vite';

/**
 * The debug hook is in development and test builds only (`docs/testing.md`
 * §7), and this is where that is established rather than asserted.
 *
 * It would be easy to write a test that passes for the wrong reason. "The
 * production bundle does not contain `__scriptorium`" is also true of a bundle
 * built from a project that never had a debug hook, of a hook whose name was
 * changed, and of a hook that was deleted this morning. So both builds are
 * made and compared: the name has to be **absent** from the production bundle
 * and **present** in the test build. Breaking the strip turns the first red;
 * breaking the hook turns the second red.
 *
 * The bundles are built in memory (`write: false`), so this leaves nothing on
 * disk and does not race with `npm run build`.
 */

/** The property the hook installs on `window`. */
const HOOK_NAME = '__scriptorium';

/** The code of every chunk and asset a build of `mode` emits, concatenated. */
async function bundleText(mode: string): Promise<string> {
  const outputs = await build({
    mode,
    logLevel: 'silent',
    build: { write: false },
  });

  const results = Array.isArray(outputs) ? outputs : [outputs];
  return results
    .flatMap((result) => ('output' in result ? result.output : []))
    .map((chunk) =>
      chunk.type === 'chunk' ? chunk.code : Buffer.from(chunk.source).toString('utf8')
    )
    .join('\n');
}

describe('the production bundle', () => {
  it('carries no debug hook, and the test build does', async () => {
    const production = await bundleText('production');
    const forTests = await bundleText('test');

    // Not merely unreachable: the branch is a build-time constant, so the call
    // and the module behind it are gone from the output altogether.
    expect(production).not.toContain(HOOK_NAME);
    // And the absence above is the strip working rather than the hook having
    // quietly stopped existing.
    expect(forTests).toContain(HOOK_NAME);
  });

  it('contains the application it is a bundle of', async () => {
    // A build that emitted nothing would pass the assertion above for the
    // emptiest of reasons.
    const production = await bundleText('production');

    expect(production.length).toBeGreaterThan(100_000);
    expect(production).toContain('Canvas element not found');
  });
});
