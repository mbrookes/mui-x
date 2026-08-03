import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Enumerate every shipped CALL SITE of the x-studio CSS-sanitizer guard family, from the
 * TypeScript AST, so the list can never be a remembered one.
 *
 * ── Why this is derived rather than written down ──
 *
 * The guards in `internals/cssValueValidation.ts` and `internals/textFontFamily.ts` are what
 * stand between a doc-authored value — reachable through `loadSerializedState(data: unknown)`
 * and the AI `update_widget` tool call — and an Emotion `sx` property value, which Emotion
 * does not escape. The guards' own behaviour is thoroughly unit-tested. What no unit test of a
 * guard can tell you is whether every place that should CALL it still does.
 *
 * That gap was closed once by hand, and the hand-enumeration was itself wrong. The fix commit
 * recorded: *"Completes the repo-wide enumeration of `sanitizeCssColor` / `sanitizeFiniteNumber`
 * / `sanitizeFontSize` call sites. Of the 15 shipped sites, 12 had no discriminating test; this
 * closes the final three."* There were 29 sites for the guards it named, not 15, and four of
 * the fourteen it never counted had no discriminating test — including two lines byte-identical
 * to pinned siblings ten lines away in the same `sx` object. A remediation pass that enumerates
 * a guard's call sites by hand can miss the second site exactly as easily as the code it fixes.
 * So no count of these sites is written down in prose anywhere; it is derived here.
 *
 * ── Why the AST, and not a regex over the source ──
 *
 * `sizeCapScan.ts` in this directory records four rounds of a text scan being broken by the
 * next thing someone wrote, and the first of those was `import { MAX_STRING_LENGTH as MAX_LEN }`
 * — a rename the scan could not see. The same escape applies here and is cheaper to close than
 * to survive: `import { sanitizeCssColor as sc } from './cssValueValidation'` and
 * `import * as css from './cssValueValidation'; css.sanitizeCssColor(x)` are both ordinary
 * TypeScript, and both are invisible to a scan keyed on the guard's spelling at the call.
 *
 * So the identity function is not "the guard's name appears followed by a paren". It is:
 * a CallExpression whose callee RESOLVES, through this file's own import bindings, to a
 * function exported by a guard module. Aliases, namespace imports, comments and string
 * literals are all handled by construction rather than by pattern.
 *
 * ── The one blind spot, made loud rather than left silent ──
 *
 * Binding resolution is per-file and does not follow re-export chains, so a barrel that did
 * `export { sanitizeCssColor } from './cssValueValidation'` would hide every consumer that
 * imported through it. Nothing re-exports these modules today, and
 * {@link findGuardReExports} exists so that the day someone does, a test fails and says so,
 * instead of the site count quietly dropping.
 */

/** Same derivation `sizeCapInventory.ts` uses; `import.meta.url` is a file URL here. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Repo-relative paths of the modules whose exported functions ARE the guard family. */
export const CSS_GUARD_MODULES = [
  'packages/x-studio/src/internals/cssValueValidation.ts',
  'packages/x-studio/src/internals/textFontFamily.ts',
];

/** Repo-relative directories scanned for call sites. */
export const CSS_GUARD_ROOTS = ['packages'];

export interface CssGuardSite {
  /**
   * `<file>:<guard>(<first argument>)#<n>` — an identity built from what the call SAYS, not
   * from where it sits. Line numbers are deliberately absent: an ordinal over the file would
   * renumber every following row when a call is inserted above it, silently re-pointing each
   * row's notes at a different call. `#n` disambiguates only calls that are textually
   * identical to each other, which is the one case where the rows are interchangeable anyway.
   */
  site: string;
  /** Repo-relative path of the shipped module containing the call. */
  file: string;
  /** The guard's exported name, after resolving any local alias. */
  guard: string;
  /** The call's first argument, source text, whitespace-collapsed. */
  arg: string;
}

function isSourceFile(name: string): boolean {
  return /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts');
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (name.startsWith('.') || name === 'node_modules' || name === 'build' || name === 'dist') {
      continue;
    }
    const full = join(dir, name);
    if (entry.isDirectory()) {
      walk(full, acc);
    } else if (isSourceFile(name)) {
      acc.push(full);
    }
  }
  return acc;
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

/** The exported function names of the guard modules — the family, read from the family. */
export function readGuardNames(repoRoot: string = REPO_ROOT): string[] {
  const names: string[] = [];
  for (const rel of CSS_GUARD_MODULES) {
    const file = join(repoRoot, rel);
    const source = parse(file, readFileSync(file, 'utf8'));
    source.forEachChild((node) => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        names.push(node.name.text);
      }
    });
  }
  return names;
}

/**
 * Files worth parsing: any file that mentions a guard module by name. A call site must import
 * its guard, and an import names the module in its specifier however the binding is spelled —
 * so this pre-filter cannot drop a real call site, it only avoids parsing the whole monorepo.
 */
function candidateFiles(repoRoot: string): string[] {
  const moduleNames = CSS_GUARD_MODULES.map((m) =>
    m
      .split('/')
      .pop()!
      .replace(/\.tsx?$/, ''),
  );
  // The guard modules themselves are always parsed: guards call each other WITHOUT importing,
  // so a guard module need not mention its own filename to contain call sites.
  const files = CSS_GUARD_MODULES.map((m) => join(repoRoot, m));
  for (const root of CSS_GUARD_ROOTS) {
    for (const full of walk(join(repoRoot, root))) {
      if (files.includes(full)) {
        continue;
      }
      const text = readFileSync(full, 'utf8');
      if (moduleNames.some((n) => text.includes(n))) {
        files.push(full);
      }
    }
  }
  return files;
}

/** Resolve a relative import specifier to a repo-relative file path, or `null`. */
function resolveSpecifier(fromFile: string, specifier: string, repoRoot: string): string | null {
  if (!specifier.startsWith('.')) {
    return null;
  }
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) {
      return relative(repoRoot, candidate).split('\\').join('/');
    }
  }
  return null;
}

/**
 * Any `export ... from` that re-exports a guard module. Must stay empty: binding resolution
 * below is per-file, so a re-export would hide every consumer importing through the barrel.
 */
export function findGuardReExports(repoRoot: string = REPO_ROOT): string[] {
  const found: string[] = [];
  for (const full of candidateFiles(repoRoot)) {
    const source = parse(full, readFileSync(full, 'utf8'));
    source.forEachChild((node) => {
      if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const target = resolveSpecifier(full, node.moduleSpecifier.text, repoRoot);
        if (target && CSS_GUARD_MODULES.includes(target)) {
          found.push(`${relative(repoRoot, full)} -> ${target}`);
        }
      }
    });
  }
  return found;
}

export function findCssGuardSites(repoRoot: string = REPO_ROOT): CssGuardSite[] {
  const guards = new Set(readGuardNames(repoRoot));
  const sites: CssGuardSite[] = [];
  const seen = new Map<string, number>();

  for (const full of candidateFiles(repoRoot)) {
    const text = readFileSync(full, 'utf8');
    const source = parse(full, text);
    const file = relative(repoRoot, full).split('\\').join('/');

    // local identifier -> guard name, and the local names of `import * as ns` namespaces.
    const bindings = new Map<string, string>();
    const namespaces = new Set<string>();

    // A guard module's own functions are in scope inside it without any import.
    if (CSS_GUARD_MODULES.includes(file)) {
      for (const g of guards) {
        bindings.set(g, g);
      }
    }

    source.forEachChild((node) => {
      if (
        !ts.isImportDeclaration(node) ||
        !ts.isStringLiteral(node.moduleSpecifier) ||
        !node.importClause
      ) {
        return;
      }
      const target = resolveSpecifier(full, node.moduleSpecifier.text, repoRoot);
      if (!target || !CSS_GUARD_MODULES.includes(target)) {
        return;
      }
      const named = node.importClause.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        namespaces.add(named.name.text);
      } else if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          // `propertyName` is set only when the import is aliased (`{ x as y }`).
          const guard = (element.propertyName ?? element.name).text;
          if (guards.has(guard)) {
            bindings.set(element.name.text, guard);
          }
        }
      }
    });

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        let guard: string | undefined;
        if (ts.isIdentifier(callee)) {
          guard = bindings.get(callee.text);
        } else if (
          ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          namespaces.has(callee.expression.text) &&
          guards.has(callee.name.text)
        ) {
          guard = callee.name.text;
        }
        if (guard) {
          const arg = node.arguments[0]?.getText(source).trim().replace(/\s+/g, ' ') ?? '';
          const key = `${file}:${guard}(${arg})`;
          const n = seen.get(key) ?? 0;
          seen.set(key, n + 1);
          sites.push({ site: `${key}#${n}`, file, guard, arg });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return sites.sort((a, b) => a.site.localeCompare(b.site));
}
