import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Enumerate every SIZE CAP written at a trust boundary, by the SHAPE of the clause
 * rather than by the NAME of the constant it compares against.
 *
 * ── Why the shape, and why a list of roots ──
 *
 * The first version of this scan (in `boundedStringGuards.test.ts`) counted occurrences
 * of the identifier `MAX_STRING_LENGTH` in `readdirSync()` of ONE directory. It was
 * presented as making an unpinned cap impossible to ship, and a later sweep found three
 * ordinary ways to ship one it could not see:
 *
 *  - `import { MAX_STRING_LENGTH as MAX_LEN }` — the cap is real, the token is gone.
 *  - `value.length <= 10_000` — a numeric literal names nothing at all.
 *  - the same file moved to `src/guards/` — `readdirSync` is not recursive, and nothing
 *    asserted that the one directory it read was the whole package.
 *
 * It also cried wolf: reflowing an import to prettier's multi-line form (what happens the
 * moment a third constant is added to the limits module) invented a phantom site, because
 * only the `import`/`} from` lines were skipped and not the member lines between them.
 *
 * All four are the same mistake — the identity function was "a token appears" rather than
 * "a size is bounded", over a domain that was one hard-coded directory rather than a
 * stated set of boundaries. So:
 *
 *  - `ROOTS` is an explicit, reviewable list of boundary directories, each walked
 *    RECURSIVELY and each asserted to exist, so a renamed or moved directory fails loudly
 *    instead of silently shrinking the scan's domain to nothing.
 *  - a site is a COMPARISON whose left operand measures a size (`.length`,
 *    `.byteLength`, `wireStringSize(...)`, `wireValueSize(...)`) and whose right operand
 *    is a cap: a SCREAMING_SNAKE_CASE identifier (whatever it is imported as) or a
 *    numeric literal of at least {@link MIN_CAP_LITERAL}. An import line contains no
 *    comparison, so reflowing one can never invent a site.
 *
 * The literal floor is what keeps `parts.length !== 3`, `rows.length > 0` and the rest of
 * ordinary code out of the inventory: a cap on a payload is a large number, an
 * arity/emptiness check is a small one.
 */

/** Right-hand numeric literals below this are arity/emptiness checks, not caps. */
export const MIN_CAP_LITERAL = 64;

const SIZE_EXPRESSION = String.raw`(?:\.length\b|\.byteLength\b|\bwireStringSize\([^()]*\)|\bwireValueSize\([^()]*\))`;
const COMPARISON = String.raw`\s*(?:>=|<=|>|<|===|!==|==|!=)\s*`;
const CAP_OPERAND = String.raw`([A-Z][A-Z0-9_]{2,}\b|\d[\d_]*)`;
const CAP_CLAUSE = new RegExp(SIZE_EXPRESSION + COMPARISON + CAP_OPERAND, 'g');

/**
 * `function foo(`, `const foo = (`, `const foo = function`, `foo(…) {` (method shorthand)
 * and `foo: (…) =>` (object-literal property). The first version recognised only
 * `function foo(`, so a cap inside an arrow function or beside a derived constant reported
 * as `<module>#0` — indistinguishable from a genuine module-level use, which is exactly the
 * shape an "it is not really a cap" escape hatch takes.
 */
const ENCLOSING_DECLARATIONS = [
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/,
  // `const f = (v) => …` / `const f = function …`. The `=>`/`function` requirement keeps
  // ordinary destructuring (`const dependsOn = (entry as X).dependsOn`) out.
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*(?::[^=]*)?=>|[A-Za-z0-9_$]+\s*=>)/,
  // Object-literal property holding an arrow function — `applyBulkUpdate: (args) => {`,
  // which is how the wire parser's per-mutation validators are written.
  /^([A-Za-z0-9_$]+)\s*:\s*(?:async\s+)?\([^()]*\)\s*(?::[^=]*)?=>/,
  // Class / object-literal method shorthand, minus the statement keywords that share its
  // `name(…) {` shape.
  /^(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(?!if\b|for\b|while\b|switch\b|catch\b|return\b|else\b|do\b|with\b)([A-Za-z0-9_$]+)\s*\([^;]*\)\s*(?::[^{;]+)?\{\s*$/,
];

export interface SizeCapRoot {
  /** Stable prefix for every site id found under `dir`, so ids survive a directory move. */
  label: string;
  /** Absolute path to the boundary directory. */
  dir: string;
}

export interface SizeCapSite {
  /** `<label>/<path>:<enclosing declaration>#<n>` — the identity a pin row names. */
  site: string;
  /** The source line, trimmed, so a failure report shows the clause and not just its id. */
  clause: string;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(path));
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
 * Every size-cap clause under `roots`, as `<label>/<file>:<enclosing declaration>#<n>`.
 *
 * `#n` counts caps within one declaration, so adding a second cap to a function that
 * already has a pin row is a NEW, unregistered site rather than a silent passenger on the
 * existing one.
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
      const lines = readFileSync(file, 'utf8').split('\n');
      let enclosing = '<module>';
      const seen = new Map<string, number>();

      for (const raw of lines) {
        const trimmed = raw.trim();
        // Whole-line comments, including every line of a JSDoc block.
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
          continue;
        }
        for (const pattern of ENCLOSING_DECLARATIONS) {
          const match = pattern.exec(trimmed);
          if (match) {
            enclosing = match[1];
            break;
          }
        }
        // A trailing `// …` comment on a code line. `:` guards against `https://`.
        const code = raw.replace(/(^|[^:])\/\/.*$/, '$1');
        for (const match of code.matchAll(CAP_CLAUSE)) {
          const operand = match[1];
          if (/^\d/.test(operand) && Number(operand.replace(/_/g, '')) < MIN_CAP_LITERAL) {
            continue;
          }
          const key = `${root.label}/${rel}:${enclosing}`;
          const nth = seen.get(key) ?? 0;
          seen.set(key, nth + 1);
          sites.push({ site: `${key}#${nth}`, clause: trimmed });
        }
      }
    }
  }

  return sites;
}
