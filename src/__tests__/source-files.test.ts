import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSourceFiles, readSourceFiles } from './source-files';

/**
 * The listing the source scans share, driven over a directory of its own.
 *
 * The race it exists for is between two workers: `layer-boundaries.test.ts`
 * deletes its scratch files while a scan may be reading. Listing and reading
 * are separate steps of the helper, so each case here deletes a file between
 * them, which turns that race into a fixed sequence that fails or passes the
 * same way every run.
 */

/** A scratch file of the shape `layer-boundaries.test.ts` writes. */
const SCRATCH_FILE = '__layer_boundary_test__.4242.ts';

/** In a directory made for the case and removed afterwards, whatever happens. */
function inScratchDirectory(body: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'source-files-'));
  try {
    body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('the source listing', () => {
  it('a layer-boundary scratch file deleted mid-scan does not fail a scan', () => {
    inScratchDirectory((directory) => {
      writeFileSync(join(directory, 'room.ts'), 'export const room = 0;\n');
      writeFileSync(join(directory, SCRATCH_FILE), 'export const scratch = 0;\n');

      const listed = listSourceFiles(directory);
      rmSync(join(directory, SCRATCH_FILE));
      const read = readSourceFiles(listed);

      expect(read.map((file) => file.path)).toEqual([join(directory, 'room.ts')]);
    });
  });

  it('a file that merely starts with the scratch prefix is still listed', () => {
    inScratchDirectory((directory) => {
      // A `startsWith` skip, an `includes` skip and the `.gitignore` glob
      // would all hide this one; the scratch files end in a process id.
      const lookalike = join(directory, '__layer_boundary_test__.notes.ts');
      writeFileSync(lookalike, 'export const notes = 0;\n');

      const listed = listSourceFiles(directory);

      expect(listed).toEqual([lookalike]);
    });
  });

  it('a real source file deleted mid-scan fails the scan', () => {
    inScratchDirectory((directory) => {
      const vanishing = join(directory, 'room.ts');
      writeFileSync(vanishing, 'export const room = 0;\n');

      const listed = listSourceFiles(directory);
      rmSync(vanishing);

      expect(() => readSourceFiles(listed)).toThrow(/ENOENT/);
    });
  });
});
