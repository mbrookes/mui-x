import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

/**
 * Enumerate the size-cap clauses at a stated set of trust boundaries, from the TypeScript
 * AST, with an identity function that INCLUDES by default.
 *
 * ── Four rounds of getting this wrong, and what actually changed ──
 *
 * v1 counted occurrences of the identifier `MAX_STRING_LENGTH` in a non-recursive
 * `readdirSync` of ONE directory. A sweep shipped three real caps it could not see
 * (`import { MAX_STRING_LENGTH as MAX_LEN }`, `value.length <= 10_000`, the same file moved
 * into a subdirectory) and one it imagined (a prettier-reflowed import).
 *
 * v2 — the version this replaces — matched, per LINE, a regex for "a size expression, a
 * comparison, and a SCREAMING_SNAKE_CASE name or a large numeric literal". Its docblock said
 * the identity function had moved from "a token appears" to "a size is bounded". It had not:
 * it was still a test on the NAME of the right operand, and a sweep found SEVEN real caps
 * inside the three directories it walks that it could not see, while its completeness test
 * reported 43 sites and 43 inventory rows:
 *
 *   requestShapeGuards.ts:112    `v.length > maxStringValueLength`        (cap is a parameter)
 *   requestShapeGuards.ts:268    `entryValue.length > valueLengthLimit`   (cap is a parameter)
 *   studioBackendAdapter.ts:250  `wireStringSize(value) <= max`           (cap is a parameter)
 *   studioBackendAdapter.ts:2037 `wireStringSize(rawOutput) > outputAllowance`
 *   richContext.ts:67            `rows.length <= max`                     (cap is a parameter)
 *   chatTurnMutations.ts:84      `turns.size > MAX_TRACKED_TURNS`         (`.size`)
 *   cacheKey.ts:135              `securityHashMemo.size >= …_MAX_SIZE`    (`.size`)
 *
 * Two of those are the string-length clause of a guard whose SIBLING clause in the same
 * function IS inventoried — the "one sentence about N things, a test for N-1" shape this
 * whole mechanism was built to break, reproduced inside its own enumeration. One of them,
 * `richContext.ts`'s `MAX_STATS_ROWS`, is the cap the round that shipped v2 itself reported
 * as unpinned, in a file that same commit added to the scan.
 *
 * Worse than any single miss: v2 matched per LINE, and prettier breaks a long binary
 * expression across lines with the operator trailing. The predecessor's documented sin was
 * CRYING WOLF on a reflowed import; v2 drops a site SILENTLY when the same formatter reflows
 * a long comparison. The failure direction got worse.
 *
 * v3 — the version this extends — inverted the OPERAND side: a size comparison is a site
 * unless what it is compared against is provably not a bound, so no name, spelling or import
 * style is consulted. That was right as far as it went, and it is kept below as the
 * MEASUREMENT-SIDE recogniser. What broke it is stated next, because it is the whole reason this
 * file now has two recognisers instead of one.
 *
 * ── Why ONE recogniser can never be enough: a cap is not always one expression ──
 *
 * v1 needed the constant's NAME in the file; v2 needed it on the same LINE; v3 needs the
 * measurement inside the same COMPARISON, because `isSizeExpression` is applied to
 * `node.left`/`node.right` directly. Each version was broken by the next round, and the
 * escapes converge on one sentence: **a source scan can only recognise a cap it can see
 * WHOLE, in one expression.** Hoist the measurement one statement up —
 *
 *     const size = wireValueSize(value);
 *     if (size > MAX_APPROVAL_INPUT_SIZE) { … }
 *
 * — and the comparison is two identifiers, so v3 sees nothing, even though `wireValueSize` is
 * in {@link SIZE_CALLS} by its own definition. That is not an exotic shape. It is how every
 * AGGREGATE BUDGET has to be written:
 *
 *     entryCount.total += semiJoins.length;
 *     if (entryCount.total > MAX_ARRAY_ITEMS_PER_DESCRIPTOR) { … }
 *
 * The measurement and the comparison are two statements apart, which is dataflow, not syntax,
 * and a syntactic scan cannot close that. Worse, the aggregate budget is the STRONGER member
 * of each cap pair — it is precisely the clause you add when the per-item cap turns out to be
 * insufficient, and `handler.ts` says so in its own comment beside the line above. So v3
 * enumerated the clause that is admittedly not enough and could not see the clause added to
 * close it. Measured: 25 real limit comparisons inside these three roots, in NONE of v3's 54
 * sites, including every aggregate bound at the data-middleware request boundary and every
 * per-turn persistence budget on the chat wire — plus two whole named limits
 * (`MAX_PREDICATE_VALUES_PER_DESCRIPTOR`, and the tool-input/approval-input budgets) with no
 * inventory row anywhere, while the completeness test reported 54 of 54.
 *
 * ── The change: split the problem by cap class, do not guess a fifth pattern ──
 *
 * A fifth attempt at "one identity function that sees every cap" would be broken by the next
 * cap whose parts are spread differently. Instead there are now TWO independent recognisers,
 * unioned, whose blind spots are structurally different — because what the first needs to see
 * whole is exactly what the second does not look at:
 *
 *  1. MEASUREMENT SIDE — v3, unchanged. One operand MEASURES a size
 *     ({@link SIZE_PROPERTIES} / {@link SIZE_CALLS}); the other can be anything, including a
 *     parameter or a literal. Needs the measurement to be adjacent; indifferent to the limit.
 *  2. LIMIT SIDE — new. One operand REFERENCES a limit constant this scan found
 *     DECLARED under the same roots, and the other does not. Indifferent to how the measured
 *     quantity was computed — a running total, a hoisted `const`, a counter, a field, a call
 *     the scan has never heard of — because it never looks at that side.
 *
 * (2) is name-driven in one narrow sense and it is worth being exact about which, since
 * "match the operand's name" is v2's documented sin. v2 tested whether the operand LOOKED
 * like a limit (SCREAMING_SNAKE). (2) tests whether the operand RESOLVES to a `const`
 * declaration, initialised to a number, that this scan itself found in the source. A
 * declaration is a single node in a single place — it is never spread across statements — so
 * unlike an enforcement site it is always visible whole. The set of limits is collected in a
 * first pass over the same files, folding numeric expressions (`4 * MAX_STRING_LENGTH`) to a
 * fixpoint, and it is pooled across roots BY NAME so that a limit declared in
 * `x-studio-schema` is recognised where `x-studio/chat` enforces it.
 *
 * Both recognisers share the structural exclusions, which are positional rather than lexical:
 *
 *  - EQUALITY operators (`===`, `!==`). A cap is an ordering; `a.length === 3` is a shape
 *    check. A bound that rejects only the exact threshold rejects nothing.
 *  - the condition of a `for` statement — `i < arr.length` is an iteration bound, and it is
 *    the one place a size legitimately appears as the LIMIT rather than the measured
 *    quantity. That is a syntactic position, not a naming convention.
 *  - both sides measuring a size — `a.length !== b.length`, `safe.length === value.length`:
 *    two measured quantities compared to each other, neither a limit. Likewise both sides
 *    referencing a declared constant.
 *  - for (1) only, a numeric literal below {@link MIN_CAP_LITERAL} on the other side. `> 0` is
 *    emptiness, `>= 2` is arity. This is the one remaining VALUE test, and it is a floor
 *    rather than a pattern: it can only exclude a comparison against a small constant, so the
 *    way to hide a cap behind it is to write a cap of 63 — which is not a payload bound.
 *
 * Over-approximation is deliberate on both sides. `fromVersion > CURRENT_SCHEMA_VERSION` and
 * `anchorTotal > GRID_COLS` are not payload caps; they become visible inventory rows carrying
 * a `why` that says so, which is the cheap, reviewable failure direction. Measured cost: 79
 * sites where v3 found 54, of which 5 are declared non-caps.
 *
 * ── What the UNION still cannot see, stated because it is tested ──
 *
 * "Is this expression a size?" and "is this operand a bound?" are semantic questions, and no
 * syntactic test decides them. What survives both recognisers is the INTERSECTION of their
 * blind spots — a cap whose measurement is not adjacent AND whose limit is not a declared
 * constant:
 *
 *  - `const n = value.length; if (n > maxLength)` — hoisted measurement, limit is a parameter.
 *    (1) sees two identifiers; (2) finds no declared constant. This is real: it is how a
 *    shared guard parameterised over several limits would accumulate.
 *  - a size measured by a helper not in {@link SIZE_CALLS} and compared against a literal or
 *    a parameter.
 *  - a bound enforced WITHOUT a comparison at all (`slice(0, CAP)`, `Math.min(len, CAP)`).
 *  - a limit declared OUTSIDE the walked roots and imported in.
 *
 * Each is a fixture in `boundedStringGuards.test.ts`'s `blind spots` block, asserted MISSED,
 * so the limitation is machine-checked and a reader is told exactly where it ends rather than
 * being left to discover it as the next round's headline.
 *
 * **The honest claim, and it is deliberately two claims rather than one:** a cap written as an
 * ordering comparison cannot be added at these boundaries without becoming a new,
 * unaccounted-for site IF EITHER its measurement is one this scan knows how to spell and sits
 * inside the comparison, OR its limit is a constant declared under these roots. It is NOT "no
 * cap can ship unpinned", and it is not "every cap here is enumerated" — it is two stated
 * sufficient conditions with a stated, tested gap between them.
 */

/** Right-hand numeric literals below this are arity/emptiness checks, not caps. */
export const MIN_CAP_LITERAL = 64;

/**
 * How many times the limit-collection pass re-reads the files to fold constants defined in
 * terms of constants. Chains are two or three deep in practice (`MAX_TURN_APPROVAL_INPUT_SIZE
 * = 16 * MAX_STRING_LENGTH`); this is a termination guard, not a tuning knob.
 */
const MAX_FOLD_PASSES = 8;

/**
 * Property accesses that measure a size. `size` is here because a `Map`/`Set` cap
 * (`turns.size > MAX_TRACKED_TURNS`) is a cap, and v2 could not see one.
 */
export const SIZE_PROPERTIES = new Set(['length', 'byteLength', 'size']);

/**
 * Calls that measure a size. This list is the scan's remaining under-approximation: a cap
 * written `byteLen(value) > CAP` is invisible until `byteLen` is added here. Exported and
 * explicit so the gap is reviewable rather than buried inside a pattern.
 */
export const SIZE_CALLS = new Set(['wireStringSize', 'wireValueSize']);

const ORDERING_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

export interface SizeCapRoot {
  /** Stable prefix for every site id found under `dir`, so ids survive a directory move. */
  label: string;
  /** Absolute path to the boundary directory. */
  dir: string;
}

export interface SizeCapSite {
  /**
   * `<label>/<path>:<enclosing declaration>[<clause>]#<n>` — the identity a pin row names.
   *
   * The clause TEXT is part of the id on purpose; see {@link findSizeCapSites}.
   */
  site: string;
  /** The source text of the clause, so a failure report shows it and not just an id. */
  clause: string;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // `__tests__` holds test-support code (mock databases, builders) that is not a trust
      // boundary. `.test.ts` inside it is excluded below; the helpers beside it were not.
      if (entry.name !== '__tests__') {
        out.push(...walk(path));
      }
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
      continue;
    }
    out.push(path);
  }
  return out.sort();
}

/**
 * The names of every module-scope `const` under `roots` that is initialised to a number.
 *
 * This is recogniser (2)'s whole input, and the reason it can see a cap recogniser (1)
 * cannot: it keys on the limit's DECLARATION, which is one node in one place, rather than on
 * the enforcement site, whose parts may be spread across statements.
 *
 * Initialisers are folded, so `4 * MAX_STRING_LENGTH` counts. Folding needs the constants it
 * refers to, which may be declared in a file walked later, so this iterates to a fixpoint
 * rather than making one pass and losing whatever it saw out of order.
 *
 * Names are pooled across roots deliberately: a limit declared in `x-studio-schema` and
 * enforced in `x-studio/chat` has to be recognised at the enforcement site, and no import
 * graph is resolved here. The cost is that an unrelated local `const` sharing a limit's name
 * would be treated as one — an over-approximation, which is the direction this scan chooses
 * everywhere.
 */
function collectDeclaredLimits(files: string[], sources: Map<string, ts.SourceFile>): Set<string> {
  const values = new Map<string, number>();

  const fold = (node: ts.Expression): number | undefined => {
    if (ts.isNumericLiteral(node)) {
      return Number(node.text.replace(/_/g, ''));
    }
    if (ts.isParenthesizedExpression(node)) {
      return fold(node.expression);
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
      const operand = fold(node.operand);
      return operand === undefined ? undefined : -operand;
    }
    if (ts.isIdentifier(node)) {
      return values.get(node.text);
    }
    if (ts.isPropertyAccessExpression(node)) {
      // `limits.MAX_STRING_LENGTH` under a namespace import.
      return values.get(node.name.text);
    }
    if (ts.isBinaryExpression(node)) {
      const left = fold(node.left);
      const right = fold(node.right);
      if (left === undefined || right === undefined) {
        return undefined;
      }
      switch (node.operatorToken.kind) {
        case ts.SyntaxKind.AsteriskToken:
          return left * right;
        case ts.SyntaxKind.PlusToken:
          return left + right;
        case ts.SyntaxKind.MinusToken:
          return left - right;
        case ts.SyntaxKind.SlashToken:
          return left / right;
        default:
          return undefined;
      }
    }
    return undefined;
  };

  for (let pass = 0; pass < MAX_FOLD_PASSES; pass += 1) {
    let grew = false;
    for (const file of files) {
      const source = sources.get(file)!;
      const visit = (node: ts.Node): void => {
        if (
          ts.isVariableStatement(node) &&
          node.parent &&
          ts.isSourceFile(node.parent) &&
          // `let` is a counter, not a limit: `let messageIdCounter = 0` is reassigned, and a
          // comparison against it bounds nothing.
          (node.declarationList.flags & ts.NodeFlags.Const) !== 0
        ) {
          for (const declaration of node.declarationList.declarations) {
            if (
              ts.isIdentifier(declaration.name) &&
              declaration.initializer &&
              !values.has(declaration.name.text)
            ) {
              const value = fold(declaration.initializer);
              if (value !== undefined) {
                values.set(declaration.name.text, value);
                grew = true;
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    if (!grew) {
      break;
    }
  }

  return new Set(values.keys());
}

/** Whether `node` REFERENCES one of the declared limits — an identifier or its dotted form. */
function isDeclaredLimitReference(node: ts.Expression, limits: Set<string>): boolean {
  if (ts.isIdentifier(node)) {
    return limits.has(node.text);
  }
  return ts.isPropertyAccessExpression(node) && limits.has(node.name.text);
}

/** Whether `node` measures a size. */
function isSizeExpression(node: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(node) && SIZE_PROPERTIES.has(node.name.text)) {
    return true;
  }
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    SIZE_CALLS.has(node.expression.text)
  );
}

/** Whether `node` is a numeric literal too small to be a payload bound (`> 0`, `>= 2`, `> -1`). */
function isSmallNumericLiteral(node: ts.Expression): boolean {
  if (ts.isNumericLiteral(node)) {
    return Number(node.text.replace(/_/g, '')) < MIN_CAP_LITERAL;
  }
  // `-1` parses as unary minus applied to a literal, and a negative bound is never a cap.
  return ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand);
}

/**
 * The nearest NAMED enclosing declaration, so a cap inside an anonymous callback is
 * attributed to the function a reader would look in rather than to `<module>`.
 *
 * v2 derived this by remembering the last LINE that looked like a declaration, which
 * attributed a cap to whatever happened to be declared above it. Walking the AST upward
 * cannot make that mistake.
 */
function enclosingDeclaration(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isClassDeclaration(current)) &&
      current.name &&
      ts.isIdentifier(current.name)
    ) {
      return current.name.text;
    }
    if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      // `const f = (v) => …`, `{ applyBulkUpdate: (args) => … }` — named by what holds it.
      // An anonymous callback (`values.filter((v) => …)`) has neither, so keep walking up.
      const holder = current.parent;
      if (holder && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) {
        return holder.name.text;
      }
      if (holder && ts.isPropertyAssignment(holder) && ts.isIdentifier(holder.name)) {
        return holder.name.text;
      }
    }
  }
  return '<module>';
}

/**
 * Every size-cap clause under `roots`, as
 * `<label>/<file>:<enclosing declaration>[<clause>]#<n>`.
 *
 * ── Why the CLAUSE TEXT is in the id, and not just an ordinal ──
 *
 * The id used to be `<file>:<declaration>#<n>` with `#n` counting caps in AST order within
 * the declaration, and both tests that check ids compare SETS of id strings. That makes a row
 * POSITIONAL: inserting a cap ABOVE an existing one in an already-inventoried function shifts
 * every following ordinal by one, so the completeness test fails with exactly ONE extra site,
 * the obvious fix is to APPEND one inventory row, and after that edit every test is green
 * again while each existing row's `why` and `probedIn` now describe the clause that used to
 * be there. Measured on a four-cap fixture guard: inserting one cap first re-pointed all four
 * rows, including the one the isolation fixture in another package names by string.
 *
 * Keying on the clause's own text makes the id insertion-invariant. A row can now only stop
 * describing its clause if the clause itself is edited — and then the id changes, the
 * completeness test fails, and the failure names the old text and the new one rather than
 * silently re-filing a claim. The text is whitespace-normalised, so prettier reflowing a long
 * comparison across two lines does not move a site (v2's silent-drop failure, in the other
 * direction).
 *
 * `#n` remains, but it now counts only clauses whose text is IDENTICAL within the same
 * declaration — the one case where the text alone cannot tell two sites apart. It is normally
 * `#0`, and it is emitted unconditionally so that a second identical clause appearing later
 * cannot change the id of the first.
 */
export function findSizeCapSites(roots: SizeCapRoot[]): SizeCapSite[] {
  const parsed: { root: SizeCapRoot; file: string }[] = [];

  for (const root of roots) {
    // A root that no longer exists would otherwise contribute zero sites and pass — the
    // failure mode of every source-derived check.
    if (!statSync(root.dir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(
        `sizeCapScan: boundary root "${root.label}" does not exist at ${root.dir}. ` +
          'A root that cannot be read contributes no sites, so the completeness check would ' +
          'pass while covering nothing. Update ROOTS to the directory that moved.',
      );
    }
    for (const file of walk(root.dir)) {
      parsed.push({ root, file });
    }
  }

  const sources = new Map<string, ts.SourceFile>(
    parsed.map(({ file }) => [
      file,
      ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
        /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      ),
    ]),
  );

  // Pass 1 — every limit CONSTANT declared under the roots, pooled by name across all of
  // them. This is what lets recogniser (2) see a cap whose measured quantity is a running
  // total two statements away: it never looks at that side.
  const limits = collectDeclaredLimits(
    parsed.map(({ file }) => file),
    sources,
  );

  // Pass 2 — the comparisons.
  const sites: SizeCapSite[] = [];
  for (const { root, file } of parsed) {
    const source = sources.get(file)!;
    const rel = relative(root.dir, file).split(sep).join('/');
    const seen = new Map<string, number>();

    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && ORDERING_OPERATORS.has(node.operatorToken.kind)) {
        const isForCondition = Boolean(
          node.parent && ts.isForStatement(node.parent) && node.parent.condition === node,
        );

        const leftIsSize = isSizeExpression(node.left);
        const rightIsSize = isSizeExpression(node.right);
        // (1) MEASUREMENT SIDE: exactly one side measures a size (so `a.length !== b.length`
        // is out) and the other is not a small constant. Nothing about the other operand's
        // name is consulted, so a cap bounded by a parameter is seen.
        const measurementSide =
          leftIsSize !== rightIsSize && !isSmallNumericLiteral(leftIsSize ? node.right : node.left);

        // (2) LIMIT SIDE: exactly one side references a constant declared under these roots.
        // The other side is not inspected AT ALL — that is the point. `total += x` two
        // statements up, a hoisted `const`, a counter, a field, a helper this scan has never
        // heard of: all invisible to (1), all seen here.
        const limitSide =
          isDeclaredLimitReference(node.left, limits) !==
          isDeclaredLimitReference(node.right, limits);

        if (!isForCondition && (measurementSide || limitSide)) {
          const clause = node.getText(source).replace(/\s+/g, ' ');
          const key = `${root.label}/${rel}:${enclosingDeclaration(node)}[${clause}]`;
          const nth = seen.get(key) ?? 0;
          seen.set(key, nth + 1);
          sites.push({ site: `${key}#${nth}`, clause });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return sites;
}
