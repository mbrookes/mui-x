import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

/**
 * Enumerate the size-cap clauses at a stated set of trust boundaries, from the TypeScript
 * AST, with an identity function that INCLUDES by default.
 *
 * ── Three rounds of getting this wrong, and what actually changed ──
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
 * ── The change that is not a fourth guess at the pattern ──
 *
 * Every version so far asked "does this LOOK like a cap?" and answered NO for shapes it did
 * not know. That under-approximates, so each version was broken by the next round finding a
 * shape it could not see, and each break was silent. The identity function is now inverted on
 * the operand side: a size comparison is a site UNLESS the thing it is compared against is
 * provably not a cap. Nothing about the operand's name, spelling, or import style is
 * consulted. That costs inventory rows — measured, 54 sites where v2 found 43, of which two
 * are genuinely not caps and carry a `why` saying so — and it buys a failure direction that
 * is noisy rather than silent.
 *
 * A site is an ORDERING comparison (`<`, `<=`, `>`, `>=`) where exactly one side measures a
 * size ({@link SIZE_PROPERTIES} or {@link SIZE_CALLS}), minus exclusions that are structural
 * rather than lexical:
 *
 *  - EQUALITY operators (`===`, `!==`). A cap is an ordering; `a.length === 3` is a shape
 *    check. A bound that rejects only the exact threshold rejects nothing.
 *  - the condition of a `for` statement — `i < arr.length` is an iteration bound, and it is
 *    the one place a size legitimately appears as the LIMIT rather than the measured
 *    quantity. That is a syntactic position, not a naming convention.
 *  - both sides measuring a size — `a.length !== b.length`, `safe.length === value.length`:
 *    two measured quantities compared to each other, neither a limit.
 *  - a numeric literal below {@link MIN_CAP_LITERAL} on the other side. `> 0` is emptiness,
 *    `>= 2` is arity. This is the one remaining VALUE test, and it is a floor rather than a
 *    pattern: it can only exclude a comparison against a small constant, so the way to hide a
 *    cap behind it is to write a cap of 63 — which is not a payload bound.
 *
 * ── What this still cannot see, stated because it is tested ──
 *
 * "Is this expression a size?" and "is this operand a bound?" are semantic questions, and no
 * syntactic or type-level test decides them. The operand side is now over-approximated, so
 * that half no longer under-approximates. The MEASUREMENT side is still a list —
 * {@link SIZE_PROPERTIES} and {@link SIZE_CALLS} — so a size measured by a helper not on it
 * is invisible, as is any bound enforced WITHOUT a comparison (`slice(0, CAP)`,
 * `Math.min(len, CAP)`). Those are not hypotheticals left for a later round to discover: each
 * is a fixture in `boundedStringGuards.test.ts`'s `blind spots` block, asserted MISSED, so
 * the limitation is machine-checked and a reader is told exactly where it ends.
 *
 * The honest claim is therefore: **a size cap written as a comparison against a measurement
 * this scan knows how to spell cannot be added at these boundaries without becoming a new,
 * unaccounted-for site.** It is NOT "no cap can ship unpinned".
 */

/** Right-hand numeric literals below this are arity/emptiness checks, not caps. */
export const MIN_CAP_LITERAL = 64;

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
  /** `<label>/<path>:<enclosing declaration>#<n>` — the identity a pin row names. */
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
 * Every size-cap clause under `roots`, as `<label>/<file>:<enclosing declaration>#<n>`.
 *
 * `#n` counts caps within one declaration, so adding a second cap to a function that already
 * has a pin row is a NEW, unregistered site rather than a silent passenger on the existing
 * one.
 */
export function findSizeCapSites(roots: SizeCapRoot[]): SizeCapSite[] {
  const sites: SizeCapSite[] = [];

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
      const rel = relative(root.dir, file).split(sep).join('/');
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
        /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const seen = new Map<string, number>();

      const visit = (node: ts.Node): void => {
        if (ts.isBinaryExpression(node) && ORDERING_OPERATORS.has(node.operatorToken.kind)) {
          const leftIsSize = isSizeExpression(node.left);
          const rightIsSize = isSizeExpression(node.right);
          const isForCondition = Boolean(
            node.parent && ts.isForStatement(node.parent) && node.parent.condition === node,
          );

          // Exactly one side measures a size (so `a.length !== b.length` is out), it is not a
          // `for` bound, and the other side is not a small constant. Everything else counts,
          // whatever the operand happens to be called.
          if (leftIsSize !== rightIsSize && !isForCondition) {
            const bound = leftIsSize ? node.right : node.left;
            if (!isSmallNumericLiteral(bound)) {
              const key = `${root.label}/${rel}:${enclosingDeclaration(node)}`;
              const nth = seen.get(key) ?? 0;
              seen.set(key, nth + 1);
              sites.push({
                site: `${key}#${nth}`,
                clause: node.getText(source).replace(/\s+/g, ' '),
              });
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }

  return sites;
}
