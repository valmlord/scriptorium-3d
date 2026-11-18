import { describe, expect, it } from 'vitest';
import { build } from 'vite';
import { DOMAIN_TAG } from '@core/prf';

/**
 * What the shipped bundles contain, asserted against the bundles themselves.
 *
 * Two properties live here, and neither can be answered by reading the source.
 * The first is the debug hook's strip. The second is ADR-0005's: that the
 * generation surface is on the worker thread and not on the main one.
 *
 * **Why the layer rule cannot answer the second.** `no-restricted-imports`
 * decides one import edge at a time, and every edge on the path is legal:
 * `@app` may import `@worker/client`, and `@worker` may import `@core`'s
 * barrel because the worker is the layer that generates. Only the transitive
 * closure is illegal, and a lint rule cannot see a closure. ADR-0029 wrote
 * that down and left the detector as "a person reading this paragraph"; this
 * is that detector, mechanised.
 *
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

/** A build's output, split by the thread that runs it. */
interface EmittedCode {
  /** Every JavaScript chunk: the module graph `index.html` loads. */
  readonly mainThread: string;
  /** The worker's bundle, built as a graph of its own. */
  readonly worker: string;
}

/**
 * The code a build of `mode` emits, split by thread.
 *
 * The split is the build's own: vite compiles `new Worker(new URL(...))` as a
 * **separate module graph** and emits it as an *asset* beside the chunks, so
 * `type === 'chunk'` is exactly the main thread and the JavaScript asset is
 * exactly the worker. That is sturdier than matching the hashed file names,
 * and it is why the concatenation `bundleText` returns cannot answer a
 * question about one thread.
 *
 * A build with no worker throws rather than returning nothing to search: an
 * assertion about the worker must not pass against a build that stopped
 * emitting one.
 */
async function emittedCode(mode: string): Promise<EmittedCode> {
  const outputs = await build({ mode, logLevel: 'silent', build: { write: false } });
  const results = Array.isArray(outputs) ? outputs : [outputs];

  const chunks: string[] = [];
  const workers: string[] = [];
  for (const file of results.flatMap((result) =>
    'output' in result ? result.output : []
  )) {
    if (file.type === 'chunk') {
      chunks.push(file.code);
    } else if (file.fileName.endsWith('.js')) {
      workers.push(Buffer.from(file.source).toString('utf8'));
    }
  }

  if (workers.length === 0) {
    throw new Error(`the ${mode} build emitted no worker bundle`);
  }
  return { mainThread: chunks.join('\n'), worker: workers.join('\n') };
}

describe('what runs on which thread', () => {
  it('ships the generation surface in the worker and not on the main thread', async () => {
    // `DOMAIN_TAG` is imported rather than spelled out here: it is the
    // library's identity (SPEC §4.2) and the one string only the generation
    // surface contains. Minification mangles identifiers and leaves string
    // literals alone, so this survives a production build.
    const { mainThread, worker } = await emittedCode('production');

    // ADR-0005: a `getPage` on the main thread is a dropped frame waiting for
    // the right moment. Shipping one that nobody calls is how that stops being
    // a property of the code and becomes a property of who remembers. M6 put
    // it there through one constant and nothing noticed (ADR-0032).
    expect(mainThread).not.toContain(DOMAIN_TAG);
    // And the absence above is the boundary holding rather than the library
    // having quietly stopped being in the build at all.
    expect(worker).toContain(DOMAIN_TAG);
  });
});

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
