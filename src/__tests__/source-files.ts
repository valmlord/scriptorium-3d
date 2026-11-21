import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The listing every source scan in the suite reads from: the TypeScript files
 * under a directory, outside every `__tests__` directory.
 *
 * A helper rather than a test, and collected as neither: Vitest's `include`
 * matches `*.test.ts` only. It lives in `src/__tests__/` because its scans sit
 * in more than one layer, and a layer test reaches it by a relative path. It
 * imports Node's built-ins and nothing else, so it cannot carry a layer import
 * around the lint block of the layer that uses it.
 *
 * **The layer-boundary scratch files are skipped by their exact name.**
 * `layer-boundaries.test.ts` writes `__layer_boundary_test__.<pid>.ts` into
 * each layer directory and deletes it in `afterAll`, from another worker, so a
 * scan running beside it can list such a file and then find it gone when it
 * reads. Skipping by name, rather than catching `ENOENT` on the read, keeps a
 * real file that vanishes mid-scan a failure. The pattern is narrower than
 * `.gitignore`'s glob on purpose: it matches what is written, a run of digits,
 * and no file that merely starts with the same prefix.
 */

/** What `layer-boundaries.test.ts` writes: the prefix, a process id, `.ts`. */
const LAYER_BOUNDARY_SCRATCH_FILE = /^__layer_boundary_test__\.\d+\.ts$/;

const TESTS_DIRECTORY = '__tests__';

/** A source file's path, as listed, and its text. */
export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/**
 * Every `.ts` file under `root`, outside `__tests__` directories and without
 * the layer-boundary scratch files, in a stable order.
 */
export function listSourceFiles(root: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== TESTS_DIRECTORY) {
        files.push(...listSourceFiles(path));
      }
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !LAYER_BOUNDARY_SCRATCH_FILE.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files.sort();
}

/**
 * The text of each listed file. A separate step from the listing, and a file
 * that has gone in between fails the read: only the scratch files may vanish,
 * and they are never listed.
 */
export function readSourceFiles(paths: readonly string[]): readonly SourceFile[] {
  return paths.map((path) => ({ path, text: readFileSync(path, 'utf8') }));
}
