import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';
import ts from 'typescript';
import { listSourceFiles, readSourceFiles } from '../../__tests__/source-files';

/**
 * Where the viewer reports a render to the retirement policy.
 *
 * `noteRender` decides when a replaced room's shader programs may go: a report
 * missing after an untitled render keeps a room the loaded one no longer needs,
 * and a report the render has not earned, or one made inside `loadRoom` before
 * the new room is drawn, releases the titled program a frame early and the
 * next frame links it again. `./retirement.test.ts` proves what the policy does
 * with a report; where the reports come from is what only the source can say,
 * so this parses every file under `src/` outside `__tests__` with the
 * TypeScript compiler and holds `renderFrame()` in `viewer.ts` to its shape:
 *
 * ```ts
 * renderer.render(scene, camera);
 * if (loaded !== null) retirement.noteRender(loaded.titles.isTitled);
 * ```
 *
 * Twelve assertions, R1 to R10 with R4 and R6 in two halves, each in the form
 * the design of #59 (section 1.7) gives it, so that each refuses its own
 * defect and no other: a count is only a count, a position is checked on the
 * statement it names, and statements are found by kind rather than by index
 * wherever a position is not the point.
 *
 * **What it cannot see, by design.** The counts match a call by its callee's
 * property name, or for `renderFrame` by the identifier, so a call that reaches
 * its function another way is not counted: an element access
 * (`renderer['render'](...)`), `.call` and `.bind`, a parenthesized callee,
 * and a local binding (`const { render } = renderer`, `const rf =
 * renderFrame`). None appears in `src/` outside tests; review is what keeps it
 * so.
 */

const SOURCE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const VIEWER = 'src/engine/viewer.ts';

const RENDER = 'render';
const NOTE_RENDER = 'noteRender';
const RENDER_FRAME = 'renderFrame';
const SET_ANIMATION_LOOP = 'setAnimationLoop';

/** A parsed source file and its path from the repository root. */
interface ParsedSource {
  readonly file: string;
  readonly source: ts.SourceFile;
}

function parse(path: string, text: string): ParsedSource {
  return {
    file: relative(REPOSITORY_ROOT, path).split('\\').join('/'),
    source: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true),
  };
}

/** Every node under `root`, `root` included, in source order. */
function descendants(root: ts.Node): readonly ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return nodes;
}

/** Whether `call`'s callee is a property access naming `name`, whatever the receiver. */
function callsProperty(call: ts.CallExpression | undefined, name: string): boolean {
  return (
    call !== undefined &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === name
  );
}

/** Whether `call`'s callee is the bare identifier `name`. */
function callsIdentifier(call: ts.CallExpression, name: string): boolean {
  return ts.isIdentifier(call.expression) && call.expression.text === name;
}

/** Where each call matching `matches` is, as `file:line`, across `sources`. */
function callSites(
  sources: readonly ParsedSource[],
  matches: (call: ts.CallExpression) => boolean
): readonly string[] {
  return sources.flatMap(({ file, source }) =>
    descendants(source)
      .filter(
        (node): node is ts.CallExpression => ts.isCallExpression(node) && matches(node)
      )
      .map((call) => {
        const { line } = source.getLineAndCharacterOfPosition(call.getStart(source));
        return `${file}:${String(line + 1)}`;
      })
  );
}

/** The call an expression statement makes, if that is what it is. */
function statementCall(
  statement: ts.Statement | undefined
): ts.CallExpression | undefined {
  return statement !== undefined &&
    ts.isExpressionStatement(statement) &&
    ts.isCallExpression(statement.expression)
    ? statement.expression
    : undefined;
}

/** The statements of an `if`'s consequent: its block's, or the bare one. */
function consequentStatements(guard: ts.IfStatement): readonly ts.Statement[] {
  return ts.isBlock(guard.thenStatement)
    ? guard.thenStatement.statements
    : [guard.thenStatement];
}

describe('where a render is reported', () => {
  it('renderFrame is the render call and a guarded noteRender, and nothing else renders or reports', () => {
    const sources = readSourceFiles(listSourceFiles(SOURCE_ROOT)).map(
      ({ path, text }) => parse(path, text)
    );
    const viewer = sources.find(({ file }) => file === VIEWER);
    const viewerNodes = viewer === undefined ? [] : descendants(viewer.source);
    const renderFrame = viewerNodes.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === RENDER_FRAME
    );
    const body: readonly ts.Statement[] = renderFrame?.body?.statements ?? [];
    const guard = body.find(ts.isIfStatement);
    const consequent = guard === undefined ? [] : consequentStatements(guard);
    const firstConsequentCall =
      guard === undefined
        ? undefined
        : descendants(guard.thenStatement).find(ts.isCallExpression);
    const loops = viewerNodes
      .filter(
        (node): node is ts.CallExpression =>
          ts.isCallExpression(node) && callsProperty(node, SET_ANIMATION_LOOP)
      )
      .map((call) => call.arguments[0])
      .filter(
        (argument): argument is ts.ArrowFunction | ts.FunctionExpression =>
          argument !== undefined &&
          (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
      );

    const renders = callSites(sources, (call) => callsProperty(call, RENDER));
    const reports = callSites(sources, (call) => callsProperty(call, NOTE_RENDER));
    const renderFrames = callSites(sources, (call) =>
      callsIdentifier(call, RENDER_FRAME)
    );

    expect(renders, `R1: render is called at ${renders.join(', ')}`).toHaveLength(1);

    expect(reports, `R2: noteRender is called at ${reports.join(', ')}`).toHaveLength(
      1
    );

    expect(
      body,
      'R3: renderFrame in viewer.ts has exactly two statements'
    ).toHaveLength(2);

    expect(
      statementCall(body[0]) !== undefined,
      'R4a: the first statement of renderFrame is a call'
    ).toBe(true);

    expect(
      callsProperty(
        body.map(statementCall).find((call) => call !== undefined),
        RENDER
      ),
      'R4b: the first call statement of renderFrame calls render'
    ).toBe(true);

    expect(
      guard?.expression.getText(),
      'R5: the if of renderFrame tests loaded !== null'
    ).toBe('loaded !== null');

    expect(consequent, "R6a: the if's consequent is a single statement").toHaveLength(
      1
    );

    expect(
      callsProperty(statementCall(consequent[0]), NOTE_RENDER),
      "R6b: the first statement of the if's consequent calls noteRender"
    ).toBe(true);

    expect(
      firstConsequentCall?.arguments.map((argument) => argument.getText()),
      "R7: the consequent's first call passes loaded.titles.isTitled alone"
    ).toEqual(['loaded.titles.isTitled']);

    expect(
      renderFrames,
      `R8: renderFrame is called at ${renderFrames.join(', ')}`
    ).toHaveLength(1);

    expect(
      loops.some((loop) =>
        descendants(loop.body).some(
          (node) => ts.isCallExpression(node) && callsIdentifier(node, RENDER_FRAME)
        )
      ),
      'R9: the function passed to setAnimationLoop calls renderFrame'
    ).toBe(true);

    // An absent `if` is R5's to report, but it has no else to be clean of either.
    expect(
      guard !== undefined && guard.elseStatement === undefined,
      'R10: the if of renderFrame has no else'
    ).toBe(true);
  });
});
