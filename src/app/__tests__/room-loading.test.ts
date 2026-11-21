import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';
import ts from 'typescript';
import { listSourceFiles, readSourceFiles } from '../../__tests__/source-files';

/**
 * After startup, the room on screen changes through the choreography's swap
 * and nothing else. The swap reaches the viewer through the `showRoom`
 * callback `src/main.ts` wires, which loads the room and then refreshes the
 * shelf titles; a second caller of `loadRoom` skips the refresh, leaving the
 * shelf being read blank, and shows a room the navigation machine does not
 * name.
 *
 * Pinned here rather than left to review. Every source file under `src/`
 * outside `__tests__` is parsed with the TypeScript compiler and its calls are
 * counted by the callee's property name, so a comment or a string quoting the
 * call does not count, and a call through an alias of the viewer, an optional
 * chain or a bracket does, as does a third one inside `main.ts`, which is
 * where the next composition change would add it. The two allowed are the
 * startup load and the one inside `showRoom`. What it cannot see is the
 * method taken off the viewer into a variable and called by that name; no
 * code here does that, and finding it would take the type checker.
 */

const SOURCE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** The property whose calls are counted. */
const LOAD_ROOM = 'loadRoom';

/** A call to `loadRoom`, by file and one-based line. */
interface LoadRoomCall {
  readonly file: string;
  readonly line: number;
}

/** Whether `callee` names a property called `loadRoom`, by dot or by bracket. */
function isLoadRoomCallee(callee: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text === LOAD_ROOM;
  }
  return (
    ts.isElementAccessExpression(callee) &&
    ts.isStringLiteralLike(callee.argumentExpression) &&
    callee.argumentExpression.text === LOAD_ROOM
  );
}

function loadRoomCallsIn(path: string, text: string): readonly LoadRoomCall[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const file = relative(REPOSITORY_ROOT, path).split('\\').join('/');
  const calls: LoadRoomCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isLoadRoomCallee(node.expression)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      calls.push({ file, line: line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

describe('who loads a room', () => {
  it('loadRoom is called exactly twice, both in src/main.ts', () => {
    const calls = readSourceFiles(listSourceFiles(SOURCE_ROOT)).flatMap((file) =>
      loadRoomCallsIn(file.path, file.text)
    );

    const locations = calls
      .map((call) => `${call.file}:${String(call.line)}`)
      .join(', ');

    // Every location goes into the message, which the printed array truncates,
    // so a third call says where it is.
    expect(calls, `loadRoom is called at ${locations}`).toHaveLength(2);
    expect(calls.map((call) => call.file)).toEqual(['src/main.ts', 'src/main.ts']);
  });
});
