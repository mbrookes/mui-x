import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Enumerate every shipped CALL SITE of a family of guard functions, from the TypeScript AST,
 * so the list can never be a remembered one.
 *
 * ── Why this is derived rather than written down ──
 *
 * A guard's own behaviour is cheap to unit-test. What no unit test of a guard can tell you is
 * whether every place that should CALL it still does. That question has now been answered
 * wrongly twice in this codebase, both times by a human enumeration:
 *
 *  - The CSS family was closed by hand with the commit message *"Of the 15 shipped sites, 12
 *    had no discriminating test; this closes the final three."* There were 29 sites for the
 *    guards it named, and four of the fourteen it never counted had no discriminating test —
 *    including two lines byte-identical to pinned siblings ten lines away in the same `sx`.
 *  - `isSafeKey` was then reported swept at *"4 sites, 4/4 KILLED"*. One line in
 *    `applyMutation.ts` — `const isSafePatchKey = isSafeKey;` — gives it FOURTEEN more, and
 *    eight of those were unpinned. 78% of the family, hidden by a module-local rebinding.
 *
 * The second miss is the one that matters here, because the scan built to prevent the first
 * already NAMED that escape in its docblock and closed it only for the two modules it
 * hardcoded. So this is generic over a {@link GuardFamily}: the mechanism a family needs is
 * the same, and a family that is not registered is the family the next miss happens in.
 *
 * ── The identity function ──
 *
 * A site is a `CallExpression` whose callee RESOLVES, through this file's own binding
 * analysis, to a function exported by one of the family's modules. Resolution covers:
 *
 *  - named imports, including aliased ones (`import { sanitizeCssColor as sc }`);
 *  - namespace imports (`import * as css from …; css.sanitizeCssColor(x)`);
 *  - MODULE-LOCAL REBINDINGS (`const isSafePatchKey = isSafeKey; isSafePatchKey(k)`) — the
 *    escape that was live in `applyMutation.ts` while the previous scan's docblock claimed to
 *    have closed it;
 *  - imports written with the repo's own package specifiers (`@mui/x-studio/internals/…`),
 *    resolved through `tsconfig.json`'s `paths`, not just relative ones;
 *  - guards declared as exported arrow consts, not only as `export function`.
 *
 * ── What this does NOT catch, stated because each line is a TEST ──
 *
 * The previous version of this file had a section headed "The one blind spot, made loud
 * rather than left silent". It had at least five, and machine-checked one. The list below is
 * the whole list as measured, and every entry is a fixture in `cssGuardCallSites.test.ts`'s
 * `the scan's own identity function` block — asserted MISSED or asserted REPORTED, against a
 * control proving the canonical form is caught. This is the discipline `sizeCapScan.ts` in
 * this directory already applies and this file's predecessor cited without adopting.
 *
 * Escapes closed by REPORTING rather than by resolving — {@link findIndirectGuardReferences}
 * returns them and the inventory test asserts it empty, so they fail loudly instead of
 * silently subtracting a row:
 *
 *  - a guard passed as a value rather than called: `[x].map(sanitizeFontSize)`, a default
 *    parameter, an object-literal property, a `useMemo` dependency;
 *  - a rebinding that is not a plain module-scope `const g = guard;` (a `let`, a rebinding
 *    inside a function body, a destructured namespace member);
 *  - a barrel re-export of a guard module ({@link findGuardReExports}, unchanged).
 *
 * Genuinely NOT seen, and not reported either:
 *
 *  - a call in a file outside the family's `roots` (today: `packages`, and there are no guard
 *    calls in `docs`/`examples`/`scripts`/`test` — grepped, and re-grepped by a test);
 *  - a namespace member read through a COMPUTED access (`css['sanitizeCssColor'](x)`);
 *  - a guard reached through a dynamic `import()`;
 *  - a guard re-implemented inline rather than called, which is a semantic question no
 *    syntactic scan decides.
 *
 * **The honest claim:** a guard call written as a direct call through a static import, a
 * namespace, or a module-scope const alias, in a file under the family's roots, cannot be
 * added without a new inventory row. Anything else is either REPORTED by
 * {@link findIndirectGuardReferences}/{@link findGuardReExports} or in the four-item list
 * above. It is not "no guard call can ship unlisted".
 */

/** Same derivation `sizeCapInventory.ts` uses; `import.meta.url` is a file URL here. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * A set of guard modules scanned together. Registering a family is what makes its call sites
 * countable; an unregistered family is exactly where the last two misses happened.
 */
export interface GuardFamily {
  /** Human-readable name, used in failure messages. */
  name: string;
  /** Repo-relative paths of the modules whose exported functions ARE the family. */
  modules: string[];
  /** Repo-relative directories walked for call sites. */
  roots: string[];
}

/**
 * The x-studio CSS-sanitizer family: the boundary between a doc-authored value — reachable
 * through `loadSerializedState(data: unknown)` and the AI `update_widget` tool call — and an
 * Emotion `sx` property value, which Emotion does not escape.
 */
export const CSS_GUARD_FAMILY: GuardFamily = {
  name: 'css',
  modules: [
    'packages/x-studio/src/internals/cssValueValidation.ts',
    'packages/x-studio/src/internals/textFontFamily.ts',
  ],
  roots: ['packages'],
};

/**
 * The prototype-pollution key denylist shared by the wire boundary and the reducer. Registered
 * because this is the family whose alias hid 78% of its call sites from the previous scan —
 * the one that scan was built to protect against, in the file next door to the one it covered.
 */
export const KEY_GUARD_FAMILY: GuardFamily = {
  name: 'unsafeKeys',
  modules: ['packages/x-studio-schema/src/unsafeKeys.ts'],
  roots: ['packages'],
};

export interface GuardSite {
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
  /** The guard's exported name, after resolving any alias or local rebinding. */
  guard: string;
  /** The call's first argument, source text, whitespace-collapsed. */
  arg: string;
}

function isSourceFile(name: string): boolean {
  return /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts');
}

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) {
    return acc;
  }
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

function toRepoRelative(full: string, repoRoot: string): string {
  return relative(repoRoot, full).split('\\').join('/');
}

/**
 * `tsconfig.json`'s `paths`, as a list of `[prefix, target]` pairs with the trailing `/*`
 * stripped. Read rather than hardcoded: `@mui/x-studio/internals/cssValueValidation` is a
 * spelling the repo maps and its own docs use, and the previous resolver returned `null` for
 * every non-relative specifier — so a file importing a guard that way contributed no bindings
 * and every call in it vanished, silently.
 */
function readPathAliases(repoRoot: string): Array<[string, string]> {
  const file = join(repoRoot, 'tsconfig.json');
  if (!existsSync(file)) {
    return [];
  }
  const parsed = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'));
  const paths = (parsed.config?.compilerOptions?.paths ?? {}) as Record<string, string[]>;
  const pairs: Array<[string, string]> = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    const target = targets[0];
    if (typeof target !== 'string') {
      continue;
    }
    pairs.push([pattern.replace(/\*$/, ''), target.replace(/^\.\//, '').replace(/\*$/, '')]);
  }
  // Longest prefix first, so `@mui/x-studio/` wins over a hypothetical `@mui/`.
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

/** Resolve an import specifier to a repo-relative file path, or `null`. */
function resolveSpecifier(
  fromFile: string,
  specifier: string,
  repoRoot: string,
  aliases: Array<[string, string]>,
): string | null {
  let base: string;
  if (specifier.startsWith('.')) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    const hit = aliases.find(([prefix]) => specifier.startsWith(prefix));
    if (!hit) {
      return null;
    }
    base = resolve(repoRoot, hit[1] + specifier.slice(hit[0].length));
  }
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) {
      return toRepoRelative(candidate, repoRoot);
    }
  }
  return null;
}

/**
 * The exported function names of the family's modules — the family, read from the family.
 *
 * Both `export function f() {}` and `export const f = (…) => …` count. Collecting only
 * function DECLARATIONS was a real escape: a guard written in the arrow-const style half this
 * codebase already uses was not in the family at all, so it had zero call sites by
 * construction and the inventory never grew a row for it.
 */
export function readGuardNames(
  family: GuardFamily = CSS_GUARD_FAMILY,
  repoRoot: string = REPO_ROOT,
): string[] {
  const names: string[] = [];
  for (const rel of family.modules) {
    const file = join(repoRoot, rel);
    const source = parse(file, readFileSync(file, 'utf8'));
    source.forEachChild((node) => {
      const exported =
        ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) {
        return;
      }
      if (ts.isFunctionDeclaration(node) && node.name) {
        names.push(node.name.text);
        return;
      }
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (
            ts.isIdentifier(decl.name) &&
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
          ) {
            names.push(decl.name.text);
          }
        }
      }
    });
  }
  return names;
}

/**
 * Files worth parsing: any file that mentions a guard module by name. A call site must import
 * its guard, and an import names the module in its specifier however the binding is spelled —
 * so this pre-filter cannot drop a real call site, it only avoids parsing the whole monorepo.
 * (True of the pre-filter; the RESOLVER that runs after it is where the package-specifier
 * escape lived, which is why that is fixed above rather than argued about here.)
 */
function candidateFiles(family: GuardFamily, repoRoot: string, guards: string[]): string[] {
  const tokens = family.modules
    .map((m) =>
      m
        .split('/')
        .pop()!
        .replace(/\.tsx?$/, ''),
    )
    .concat(guards);
  // The guard modules themselves are always parsed: guards call each other WITHOUT importing,
  // so a guard module need not mention its own filename to contain call sites.
  const files = family.modules.map((m) => join(repoRoot, m));
  for (const root of family.roots) {
    for (const full of walk(join(repoRoot, root))) {
      if (files.includes(full)) {
        continue;
      }
      const text = readFileSync(full, 'utf8');
      if (tokens.some((n) => text.includes(n))) {
        files.push(full);
      }
    }
  }
  return files;
}

/**
 * The family's modules PLUS every barrel that re-exports one, transitively.
 *
 * Re-export chains were the previous scan's declared blind spot, closed by asserting that no
 * barrel exists. One does — `x-studio-schema/src/index.ts` re-exports `unsafeKeys.ts` — so
 * asserting it away was never going to work for a family registered later. Following the chain
 * is cheaper than forbidding it: a module reachable by `export … from` is an equally valid
 * import target for the same guard, so it joins the family's module set and imports through it
 * resolve like any other.
 *
 * What this still cannot follow is a RENAMING re-export (`export { isSafeKey as safeKey }`),
 * because the consumer then spells a name the family does not contain.
 * {@link findGuardReExports} returns exactly those, and the inventory test asserts none exist.
 */
function expandModules(
  family: GuardFamily,
  repoRoot: string,
  aliases: Array<[string, string]>,
  guards: string[],
): string[] {
  const modules = new Set(family.modules);
  const files = candidateFiles(family, repoRoot, guards);
  for (let pass = 0; pass < 4; pass += 1) {
    const before = modules.size;
    for (const full of files) {
      const file = toRepoRelative(full, repoRoot);
      if (modules.has(file)) {
        continue;
      }
      const source = parse(full, readFileSync(full, 'utf8'));
      for (const node of source.statements) {
        if (
          !ts.isExportDeclaration(node) ||
          !node.moduleSpecifier ||
          !ts.isStringLiteral(node.moduleSpecifier)
        ) {
          continue;
        }
        const target = resolveSpecifier(full, node.moduleSpecifier.text, repoRoot, aliases);
        if (!target || !modules.has(target)) {
          continue;
        }
        // A renaming re-export is reported, not followed — see `findGuardReExports`.
        const clause = node.exportClause;
        if (clause && ts.isNamedExports(clause)) {
          const carriesGuardVerbatim = clause.elements.some(
            (element) => !element.propertyName && guards.includes(element.name.text),
          );
          if (!carriesGuardVerbatim) {
            continue;
          }
        }
        modules.add(file);
      }
    }
    if (modules.size === before) {
      break;
    }
  }
  return [...modules];
}

/** Everything the three entry points below need, derived once from a family. */
interface FamilyContext {
  family: GuardFamily;
  /** The family's exported guard names. */
  guards: Set<string>;
  /** `tsconfig.json` path aliases, longest prefix first. */
  aliases: Array<[string, string]>;
  /** Declaring modules PLUS the barrels that re-export them — every valid import target. */
  modules: string[];
  /** Absolute paths of the files worth parsing. */
  files: string[];
}

function familyContext(family: GuardFamily, repoRoot: string): FamilyContext {
  const guardNames = readGuardNames(family, repoRoot);
  const aliases = readPathAliases(repoRoot);
  return {
    family,
    guards: new Set(guardNames),
    aliases,
    modules: expandModules(family, repoRoot, aliases, guardNames),
    files: candidateFiles(family, repoRoot, guardNames),
  };
}

interface FileBindings {
  /** local identifier -> guard name (named imports, aliases, module-scope const rebindings). */
  bindings: Map<string, string>;
  /** local names of `import * as ns` namespaces bound to a guard module. */
  namespaces: Set<string>;
  /** Nodes that legitimately mention a guard outside a call: imports and resolved aliases. */
  resolvedRefs: Set<ts.Node>;
}

function collectBindings(
  source: ts.SourceFile,
  file: string,
  full: string,
  ctx: FamilyContext,
  repoRoot: string,
): FileBindings {
  const { family, guards, aliases, modules } = ctx;
  const bindings = new Map<string, string>();
  const namespaces = new Set<string>();
  const resolvedRefs = new Set<ts.Node>();

  // A guard module's own functions are in scope inside it without any import. Only the
  // DECLARING modules, not the barrels that re-export them.
  if (family.modules.includes(file)) {
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
    const target = resolveSpecifier(full, node.moduleSpecifier.text, repoRoot, aliases);
    if (!target || !modules.includes(target)) {
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

  // MODULE-SCOPE REBINDINGS, resolved to a fixed point so `const a = g; const b = a;` also
  // resolves. This is the escape that was live: `applyMutation.ts:100` is one line, and it
  // moved fourteen call sites out of sight of a scan that resolved imports only.
  for (let pass = 0; pass < 4; pass += 1) {
    let grew = false;
    source.forEachChild((node) => {
      if (!ts.isVariableStatement(node)) {
        return;
      }
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          ts.isIdentifier(decl.initializer) &&
          bindings.has(decl.initializer.text) &&
          !bindings.has(decl.name.text)
        ) {
          bindings.set(decl.name.text, bindings.get(decl.initializer.text)!);
          resolvedRefs.add(decl.initializer);
          grew = true;
        }
      }
    });
    if (!grew) {
      break;
    }
  }

  return { bindings, namespaces, resolvedRefs };
}

/**
 * Any RENAMING re-export of a guard (`export { isSafeKey as safeKey } from './unsafeKeys'`).
 * Must stay empty: a consumer importing through it spells a name the family does not contain,
 * so every call in that consumer vanishes — and vanishes by making the site count DROP, which
 * is the direction that looks like success.
 *
 * A PLAIN re-export is no longer reported here. It used to be, with the assertion "must stay
 * empty", and one exists (`x-studio-schema/src/index.ts`) — the previous version simply never
 * scanned a family that had one. Plain re-exports are now FOLLOWED (see {@link expandModules})
 * rather than forbidden, which is both more honest and less work than banning barrels.
 */
export function findGuardReExports(
  family: GuardFamily = CSS_GUARD_FAMILY,
  repoRoot: string = REPO_ROOT,
): string[] {
  const ctx = familyContext(family, repoRoot);
  const found: string[] = [];
  for (const full of ctx.files) {
    const source = parse(full, readFileSync(full, 'utf8'));
    source.forEachChild((node) => {
      if (
        !ts.isExportDeclaration(node) ||
        !node.moduleSpecifier ||
        !ts.isStringLiteral(node.moduleSpecifier)
      ) {
        return;
      }
      const target = resolveSpecifier(full, node.moduleSpecifier.text, repoRoot, ctx.aliases);
      if (!target || !ctx.modules.includes(target)) {
        return;
      }
      const clause = node.exportClause;
      if (!clause || !ts.isNamedExports(clause)) {
        return;
      }
      for (const element of clause.elements) {
        if (element.propertyName && ctx.guards.has(element.propertyName.text)) {
          found.push(
            `${toRepoRelative(full, repoRoot)} -> ${target} renames ${element.propertyName.text} to ${element.name.text}`,
          );
        }
      }
    });
  }
  return found;
}

/**
 * Every place a guard is MENTIONED but not directly called: passed as a callback, stored in a
 * `let`, put on an object literal, used as a default parameter, re-exported by name.
 *
 * These are the forms the scan deliberately does not resolve, and reporting them is what turns
 * each from a silent subtraction into a failing test. A guard reference that is not a callee
 * adds a real, executed invocation somewhere the site list cannot see — `[x].map(guard)` was
 * measured escaping the previous scan with its completeness test green.
 *
 * A module-scope `const g = guard;` is NOT reported: that one IS resolved, so its call sites
 * appear as ordinary rows.
 */
export function findIndirectGuardReferences(
  family: GuardFamily = CSS_GUARD_FAMILY,
  repoRoot: string = REPO_ROOT,
): string[] {
  const ctx = familyContext(family, repoRoot);
  const found: string[] = [];

  for (const full of ctx.files) {
    const source = parse(full, readFileSync(full, 'utf8'));
    const file = toRepoRelative(full, repoRoot);
    const { bindings, namespaces, resolvedRefs } = collectBindings(
      source,
      file,
      full,
      ctx,
      repoRoot,
    );

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        return;
      }
      if (ts.isIdentifier(node) && bindings.has(node.text) && !resolvedRefs.has(node)) {
        const parent = node.parent;
        // Positions that MENTION the name without referring to the value: the callee of a
        // call (that is a site, counted elsewhere), a declaration's own name, a property
        // name (`obj.isSafeKey`), a property key, and any type position (`typeof isSafeKey`).
        const benign =
          !parent ||
          (ts.isCallExpression(parent) && parent.expression === node) ||
          (ts.isFunctionDeclaration(parent) && parent.name === node) ||
          (ts.isVariableDeclaration(parent) && parent.name === node) ||
          (ts.isParameter(parent) && parent.name === node) ||
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          ts.isTypeQueryNode(parent) ||
          ts.isTypeReferenceNode(parent) ||
          ts.isImportSpecifier(parent) ||
          ts.isExportSpecifier(parent);
        if (!benign) {
          found.push(`${file}: ${node.text} referenced without being called`);
        }
        return;
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        namespaces.has(node.expression.text) &&
        ctx.guards.has(node.name.text)
      ) {
        const parent = node.parent;
        if (!(parent && ts.isCallExpression(parent) && parent.expression === node)) {
          found.push(
            `${file}: ${node.expression.text}.${node.name.text} referenced without being called`,
          );
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

export function findGuardSites(
  family: GuardFamily = CSS_GUARD_FAMILY,
  repoRoot: string = REPO_ROOT,
): GuardSite[] {
  const ctx = familyContext(family, repoRoot);
  const sites: GuardSite[] = [];
  const seen = new Map<string, number>();

  for (const full of ctx.files) {
    const text = readFileSync(full, 'utf8');
    const source = parse(full, text);
    const file = toRepoRelative(full, repoRoot);
    const { bindings, namespaces } = collectBindings(source, file, full, ctx, repoRoot);

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
          ctx.guards.has(callee.name.text)
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
