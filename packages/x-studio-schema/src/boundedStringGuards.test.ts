import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findSizeCapSites, SIZE_CALLS, SIZE_PROPERTIES } from 'test/utils/sizeCapScan';
import { SIZE_CAP_INVENTORY, SIZE_CAP_ROOTS, sitesProbedIn } from 'test/utils/sizeCapInventory';
import { parseStateMutation } from './parseStateMutation';
import { repairFilterDependsOn } from './internalGuards';
import { MAX_STRING_LENGTH } from './wireLimits';

/**
 * Every place this package bounds a string's LENGTH, pinned one clause at a time — and a
 * check that the list below is the WHOLE list, derived from the source rather than
 * remembered.
 *
 * ── Why this file exists, rather than seven more assertions spread over three suites ──
 *
 * A mutation sweep over the wire boundary found the same defect at four independent
 * guards at once: in a multi-clause guard, the clause that bounds a string's LENGTH was
 * the unpinned one while every sibling clause was pinned. `isBoundedValue`'s record-key
 * length, `isSafeId`'s length, `isStringArray`'s item length and
 * `isFiniteNumberRecord`'s key length could each be deleted with the entire 1019-test
 * package still green, while their siblings (the depth bound, the array caps, the
 * `isSafeKey` screen, the key-COUNT cap) all failed a test immediately.
 *
 * That was not four accidents. An earlier round had already found and fixed exactly this
 * shape on a fifth guard, one guard at a time, and it came back fourfold — because a
 * per-guard fix teaches nothing about the guard written next month. Two things make the
 * length clause the one that rots:
 *
 *  - It is the last clause of a `&&` chain, so a payload written to exercise the guard at
 *    all is normally rejected by an earlier clause and never reaches it.
 *  - It is the only clause whose violation is a SIZE rather than a SHAPE, so a test author
 *    reaching for "a value of the wrong shape" never produces one.
 *
 * So the mechanism, not the seven fixes:
 *
 *  1. `CAP_SITES` names every string-length clause and gives each one a payload that
 *     violates ONLY that clause — reaching it through a route where no sibling and no
 *     other guard would reject the payload first. Each site is asserted in BOTH
 *     directions: a string exactly AT the cap must be accepted, one character over must
 *     be rejected. One direction alone is not a pin — "rejects everything" and "accepts
 *     everything" each pass one of them.
 *
 *  2. `SIZE_CAP_INVENTORY` (in `test/utils/sizeCapInventory.ts`) derives the site list from
 *     the SOURCE and fails if it disagrees. A cap cannot be added without the inventory
 *     naming it and this test failing until somebody writes either a probe or a reason
 *     there is none — PROVIDED either its measurement is one the scan knows how to spell
 *     and sits inside the comparison, or its limit is a constant declared under the walked
 *     roots.
 *
 *     Those two qualifiers are load-bearing and each was added after the claim without it
 *     was measured false. The sentence used to end at "a new cap cannot be added", and the
 *     completeness test below was titled `accounts for every size cap at the inventoried
 *     boundaries`; both were false, because the scan could not see a cap whose bound was a
 *     parameter. The sentence then ended at "a measurement the scan knows how to spell",
 *     which was false too, because a cap whose measurement is HOISTED or accumulated into a
 *     running total is not one expression at all — and that is the shape of every aggregate
 *     budget in these three packages. The boundary of the claim is fixed in place by the
 *     `escapes that defeated the NAME test`, `escapes that defeated the ADJACENCY test` and
 *     `blind spots` blocks at the bottom of this file, as fixtures rather than as a
 *     paragraph that can drift.
 *
 * ── What (2) used to be, and why it was replaced three times ──
 *
 * v1 counted occurrences of the IDENTIFIER `MAX_STRING_LENGTH` in a non-recursive
 * `readdirSync` of THIS directory, and its docblock claimed that made "the eighth occurrence
 * impossible to ship unpinned". A later sweep shipped three real, reachable caps it could
 * not see — `import { MAX_STRING_LENGTH as MAX_LEN }`, `value.length <= 10_000`, and the
 * same file moved into a subdirectory — and one it imagined (a prettier-reflowed multi-line
 * import). Meanwhile a genuinely unpinned cap was sitting one package over, in `x-studio`'s
 * `isWithinApprovalListLimits`, where a package-scoped scan could never look; relaxing it
 * put 20 429 JSON characters into the persisted doc where 399 belong, with the whole
 * 4822-test suite green.
 *
 * v2 replaced the token count with a per-LINE regex for "a size expression compared against
 * a SCREAMING_SNAKE_CASE name or a large literal", over recursive roots. That is still a
 * test on the NAME of the right operand, and a sweep found SEVEN real caps inside the three
 * directories it walks that it could not see — four with the bound passed in as an argument,
 * two written on a `Map`'s `.size`, one both — while its completeness test reported 43 sites
 * and 43 inventory rows. One of the seven was `MAX_STATS_ROWS`, the cap the round that
 * shipped v2 had itself just reported as unpinned, in a file that same commit added to the
 * scan. Two more were the string-length clause of a guard whose SIBLING clause in the same
 * function WAS inventoried — this file's own founding shape, reproduced inside the
 * enumeration built to break it. And because v2 matched per LINE while prettier reflows a
 * long comparison across two, the same formatting pressure that made v1 cry wolf now moved a
 * site OUT of the inventory silently.
 *
 * v3 made it an AST pass whose identity function INCLUDES by default: a size comparison is a
 * site unless what it is compared against is provably not a bound. That fixed the operand
 * side for good — but it still applied its size test to the comparison's operands DIRECTLY,
 * so the measurement had to be adjacent, and a sweep found 25 real bounds inside the same
 * three roots that it could not see: every aggregate cap at the data-middleware request
 * boundary and every per-turn persistence budget on the chat wire, all of them written
 * `total += x; if (total > CAP)`. Two whole named limits had no row at all. Every one was
 * KILLED by its own tests, so nothing was unguarded — but the enumeration was systematically
 * blind to the STRONGER member of each cap pair, since an aggregate cap is precisely what
 * gets added when the per-item cap beside it is not enough.
 *
 * So the scan now has TWO recognisers rather than a fifth guess at one pattern: the
 * measurement side (v3, unchanged) and a limit side that keys on the limit's DECLARATION and
 * never looks at the measured operand at all. See `test/utils/sizeCapScan.ts` for the
 * structural exclusions, and for why the two blind spots being different is the whole point.
 *
 * Adding a row is deliberately cheap and deliberately not optional. A site with no probe
 * needs a `why` in the inventory, which is a claim a reader can check rather than a silence.
 */

/** The inventory key for the probes below; the inventory names this file, and this file checks it. */
const THIS_FILE = 'x-studio-schema/src/boundedStringGuards.test.ts';

/** A string of exactly the cap, and one character past it. */
const AT_CAP = 'x'.repeat(MAX_STRING_LENGTH);
const OVER_CAP = 'x'.repeat(MAX_STRING_LENGTH + 1);

type CapSite = {
  /**
   * `<file>:<enclosing function>[<clause>]#<n>` — the identity the source scan below
   * derives, so a row and a clause cannot drift apart silently. The clause TEXT is part of
   * the id because an ordinal alone is POSITIONAL: inserting a cap above an existing one
   * used to renumber every following row, re-pointing its `why` and `probedIn` at a
   * different clause while one appended row restored green. See `sizeCapScan.ts`.
   */
  site: string;
  /** What the clause bounds, and the route the probe takes to reach it unmasked. */
  what: string;
  /*
   * Runs a payload carrying `probe` at exactly this clause's position through the real
   * boundary, and reports whether the boundary ACCEPTED it.
   *
   * The route matters more than the payload. Most fields that reach one of these guards
   * are also bounded by a second one — a `removedWidgetIds` entry passes through both
   * `isStringArray`'s item cap AND `isSafeId`'s, so an over-cap id there proves neither:
   * delete either clause and the other still rejects it. Each route below is chosen so
   * the named clause is the ONLY thing that can reject the payload.
   */
  accepts: (probe: string) => boolean;
};

const CAP_SITES: CapSite[] = [
  {
    site: 'x-studio-schema/parseStateMutation.ts:isBoundedValue[value.length <= MAX_STRING_LENGTH]#0',
    what:
      "the string VALUE arm, through `addFilter`'s uninterpreted `filter.value` — the one " +
      'field with no shape check of its own, so nothing but this clause can reject it',
    accepts: (probe) => parseStateMutation(addFilterWithValue(probe)).ok,
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isBoundedValue[key.length <= MAX_STRING_LENGTH]#0',
    what:
      'the record KEY arm, through the same uninterpreted `filter.value` carrying a record ' +
      'with one over-long own key and a small value',
    accepts: (probe) => parseStateMutation(addFilterWithValue({ [probe]: 1 })).ok,
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isString[value.length <= MAX_STRING_LENGTH]#0',
    what: '`addPage.args.title` — a required string in an `args` bag, which `isBoundedValue` never sees',
    accepts: (probe) =>
      parseStateMutation({ type: 'addPage', args: { id: 'p9', title: probe } }).ok,
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isOptionalString[value.length <= MAX_STRING_LENGTH]#0',
    what: '`setWidgetLayout.args.pageId` — present-but-over-cap, so the `undefined` arm is not the one answering',
    accepts: (probe) =>
      parseStateMutation({ type: 'setWidgetLayout', args: { rows: [['w1']], pageId: probe } }).ok,
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isSafeId[value.length <= MAX_STRING_LENGTH]#0',
    what:
      '`removeWidget.args.widgetId` — an id checked by `isSafeId` alone. NOT through ' +
      "`removedWidgetIds`/`widget.id`, where `isStringArray`'s item cap or the whole-record " +
      '`isBoundedValue` would mask it',
    accepts: (probe) => parseStateMutation({ type: 'removeWidget', args: { widgetId: probe } }).ok,
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isStringArray[item.length <= MAX_STRING_LENGTH]#0',
    what:
      'the ITEM cap, through `updateWidget.args.unsetFields` — a key-name list, so its entries ' +
      'are deliberately NOT run through `isSafeId`, and the `args` bag is not run through ' +
      '`isBoundedValue`. Both of the other routes to this clause are masked by one of those',
    accepts: (probe) =>
      parseStateMutation({
        type: 'updateWidget',
        args: { widgetId: 'w1', unsetFields: [probe] },
      }).ok,
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isFiniteNumberRecord[key.length <= MAX_STRING_LENGTH]#0',
    what:
      'the KEY cap, through `applyBulkUpdate.args.widgetColSpans` — its only caller. The ' +
      '`hasUnsafeOwnKeys` screen beside it inspects key NAMES, never their length',
    accepts: (probe) =>
      parseStateMutation({
        type: 'applyBulkUpdate',
        args: { ...validBulkArgs(), widgetColSpans: { [probe]: 6 } },
      }).ok,
  },
  {
    site: 'x-studio-schema/internalGuards.ts:repairFilterDependsOn[item.length <= MAX_STRING_LENGTH]#0',
    what:
      "the defense-in-depth twin of `isStringArray`'s item cap, on the paths that never reach " +
      'the wire parser. It REPAIRS rather than rejects, so "accepted" here means the field ' +
      'survived the repair rather than being stripped',
    accepts: (probe) =>
      Object.hasOwn(repairFilterDependsOn({ id: 'f1', dependsOn: [probe] }), 'dependsOn'),
  },
];

// ── Fixtures ────────────────────────────────────────────────────────────────────

function addFilterWithValue(value: unknown) {
  return {
    type: 'addFilter',
    args: {
      filter: {
        id: 'f-new',
        field: 'rev',
        operator: 'greater_than',
        value,
        scope: { kind: 'page', pageId: 'page-1' },
      },
    },
  };
}

function validBulkArgs(): Record<string, unknown> {
  return {
    removedWidgetIds: ['w1'],
    addedWidgets: [{ id: 'w-new', kind: 'chart', title: 'W', config: { chartType: 'bar' } }],
    updatedWidgets: [{ widgetId: 'w1', title: 'T' }],
    widgetRows: [['w-new']],
    activePageId: 'page-1',
  };
}

// ── The pins ────────────────────────────────────────────────────────────────────

describe('bounded-string guards', () => {
  // Two directions per clause. Neither alone is a pin: "reject everything" passes the
  // over-cap half, "accept everything" passes the at-cap half, and the clause under test is
  // the only thing that can tell the two payloads apart.
  describe.each(CAP_SITES)('$site', ({ what, accepts }) => {
    it(`accepts a string exactly at the cap (${what})`, () => {
      expect(accepts(AT_CAP)).toBe(true);
    });

    it('rejects the same payload one character over the cap', () => {
      expect(accepts(OVER_CAP)).toBe(false);
    });
  });

  // The mechanism. Everything above is a backlog; this is what stops the next one.
  describe('source scan', () => {
    it('accounts for every size comparison it can see at the inventoried boundaries', () => {
      const inSource = findSizeCapSites(SIZE_CAP_ROOTS).map(({ site }) => site);
      const accountedFor = SIZE_CAP_INVENTORY.map(({ site }) => site);

      // Sorted rather than compared as sets, so the failure output names the missing site.
      expect([...inSource].sort()).toEqual([...accountedFor].sort());
    });

    it('gives every unprobed site a stated reason', () => {
      // The escape hatch is a claim, not a silence: "this one does not need a probe" is
      // exactly the sentence that shipped the seven rows above unpinned in the first place.
      const unexplained = SIZE_CAP_INVENTORY.filter(
        (entry) => entry.probedIn === null && !entry.why?.trim(),
      );
      expect(unexplained).toEqual([]);
    });

    it('carries a probe for exactly the sites the inventory says live here', () => {
      // Closes the loop in the other direction: the inventory's `probedIn` is a claim about
      // THIS file, so a probe cannot be deleted while the inventory still credits it.
      expect(CAP_SITES.map(({ site }) => site).sort()).toEqual(sitesProbedIn(THIS_FILE).sort());
    });

    // …and the scan itself has to be able to see something, or the checks above pass by
    // finding nothing at all — the failure mode of every source-derived check.
    it('finds the caps it is scanning for', () => {
      const inSource = findSizeCapSites(SIZE_CAP_ROOTS).map(({ site }) => site);
      expect(inSource.length).toBeGreaterThanOrEqual(CAP_SITES.length);
      expect(inSource).toContain(
        'x-studio-schema/parseStateMutation.ts:isBoundedValue[value.length <= MAX_STRING_LENGTH]#0',
      );
      expect(inSource).toContain(
        'x-studio-schema/internalGuards.ts:repairFilterDependsOn[item.length <= MAX_STRING_LENGTH]#0',
      );
      // Across the package boundary — the region the predecessor scan could not reach, and
      // where a real cap did ship unpinned.
      expect(inSource).toContain(
        'x-studio/chat/studioBackendAdapter.ts:isWithinApprovalListLimits[entry.id.length > MAX_STRING_LENGTH]#0',
      );
    });

    it('fails loudly when a boundary root no longer exists', () => {
      // A root that cannot be read contributes zero sites, so without this the completeness
      // check would pass while covering nothing.
      expect(() =>
        findSizeCapSites([{ label: 'gone', dir: join(tmpdir(), 'no-such-boundary-root') }]),
      ).toThrow(/does not exist/);
    });
  });

  /**
   * Site ids must survive an INSERTION, or every `why` and `probedIn` below is positional.
   *
   * Measured on this exact fixture with the previous `#n`-ordinal id: inserting one cap at
   * the TOP of an already-inventoried guard shifted all four following ordinals by one, so
   * the completeness test failed with exactly ONE extra site, the obvious fix was to append
   * ONE inventory row — and after that edit every test was green again while four rows,
   * including the flagship one the isolation fixture in `studioBackendAdapter.test.ts` names
   * by string, each described the clause that used to be there.
   *
   * The failure this must have instead is the noisy one: the inserted clause is a new,
   * unaccounted-for id, and every existing id still names the same clause it always did.
   */
  describe('source scan — site ids survive a cap inserted above them', () => {
    let root: string;

    /** The same guard, with `note` present or absent as its FIRST clause. */
    function writeGuard(withInsertedFirstCap: boolean) {
      writeFileSync(
        join(root, 'ordered.ts'),
        [
          "import { MAX_ARRAY_LENGTH, MAX_STRING_LENGTH } from './wireLimits';",
          'export function isWithinLimits(v: any): boolean {',
          ...(withInsertedFirstCap
            ? ['  if (v.note.length > MAX_STRING_LENGTH) { return false; }']
            : []),
          '  if (v.list.length > MAX_ARRAY_LENGTH) { return false; }',
          '  if (v.entry.length > MAX_STRING_LENGTH) { return false; }',
          '  if (v.id.length > MAX_STRING_LENGTH) { return false; }',
          '  return v.title.length <= MAX_STRING_LENGTH;',
          '}',
        ].join('\n'),
      );
      return findSizeCapSites([{ label: 'fixture', dir: root }]);
    }

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'size-cap-scan-order-'));
    });

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('re-points no existing row when a cap is inserted first', () => {
      const before = writeGuard(false);
      const after = writeGuard(true);

      // Every id that existed still exists, and still carries the SAME clause text — which is
      // what "the row still describes its clause" means. An ordinal id fails both halves.
      for (const site of before) {
        const still = after.find((hit) => hit.site === site.site);
        expect(still, `${site.site} lost its identity when a cap was inserted above it`).not.toBe(
          undefined,
        );
        expect(still!.clause).toBe(site.clause);
      }

      // …and the insertion is not free: it shows up as exactly one NEW site, so the
      // completeness test fails until somebody writes a row for it.
      const added = after.filter((hit) => !before.some((old) => old.site === hit.site));
      expect(added.map((hit) => hit.clause)).toEqual(['v.note.length > MAX_STRING_LENGTH']);
    });

    it('still tells two IDENTICAL clauses in one declaration apart', () => {
      // The one thing the clause text alone cannot do. `#n` survives for exactly this case.
      writeFileSync(
        join(root, 'twice.ts'),
        [
          "import { MAX_STRING_LENGTH } from './wireLimits';",
          'export function checkTwice(a: string, b: string): boolean {',
          '  if (a.length > MAX_STRING_LENGTH) { return false; }',
          '  if (a.length > MAX_STRING_LENGTH) { return false; }',
          '  return b.length <= MAX_STRING_LENGTH;',
          '}',
        ].join('\n'),
      );
      const sites = findSizeCapSites([{ label: 'fixture', dir: root }])
        .map((hit) => hit.site)
        .filter((site) => site.startsWith('fixture/twice.ts'));
      expect(sites).toEqual([
        'fixture/twice.ts:checkTwice[a.length > MAX_STRING_LENGTH]#0',
        'fixture/twice.ts:checkTwice[a.length > MAX_STRING_LENGTH]#1',
        'fixture/twice.ts:checkTwice[b.length <= MAX_STRING_LENGTH]#0',
      ]);
    });
  });

  /**
   * The four ways the predecessor scan could be fooled, each as a real file on disk.
   *
   * These are not hypotheticals: every one was measured GREEN (or, for the last, RED) against
   * the identifier-counting version, while shipping a real, reachable cap. They are the
   * reason the identity function is now the SHAPE of a comparison over recursive roots
   * rather than an occurrence of one constant's NAME in one flat directory.
   */
  describe('source scan — the escapes that defeated the identifier count', () => {
    let root: string;

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'size-cap-scan-'));
      // C1 — the cap is real; the token it was matched on is gone.
      writeFileSync(
        join(root, 'aliased.ts'),
        [
          "import { MAX_STRING_LENGTH as MAX_LEN } from './wireLimits';",
          'export function isBoundedNote(value: string): boolean {',
          '  return value.length <= MAX_LEN;',
          '}',
        ].join('\n'),
      );
      // C3 — a numeric literal names nothing at all.
      writeFileSync(
        join(root, 'literal.ts'),
        [
          'export function isBoundedLabel(value: string): boolean {',
          '  return value.length <= 10_000;',
          '}',
        ].join('\n'),
      );
      // C5 — the structural one: the predecessor read exactly one directory, non-recursively.
      mkdirSync(join(root, 'guards'));
      writeFileSync(
        join(root, 'guards', 'nested.ts'),
        [
          "import { MAX_STRING_LENGTH } from '../wireLimits';",
          'export function isBoundedNested(value: string): boolean {',
          '  return value.length <= MAX_STRING_LENGTH;',
          '}',
        ].join('\n'),
      );
      // C6 — the FALSE ALARM: prettier reflows the import the moment a third constant is
      // added to the limits module, and the predecessor invented a phantom site for it.
      writeFileSync(
        join(root, 'reflowed.ts'),
        [
          'import {',
          '  MAX_ARRAY_LENGTH,',
          '  MAX_RECORD_KEYS,',
          '  MAX_STRING_LENGTH,',
          "} from './wireLimits';",
          '',
          'export const limits = { MAX_ARRAY_LENGTH, MAX_RECORD_KEYS, MAX_STRING_LENGTH };',
        ].join('\n'),
      );
      // The control: ordinary arity and emptiness checks must NOT become inventory rows, or
      // the inventory is noise nobody maintains.
      writeFileSync(
        join(root, 'ordinary.ts'),
        [
          'export function splitJwt(token: string): string[] {',
          '  const parts = token.split(".");',
          '  if (parts.length !== 3) {',
          '    throw new Error("MUI X: bad token");',
          '  }',
          '  return parts.length > 0 ? parts : [];',
          '}',
        ].join('\n'),
      );
    });

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it.each([
      ['an aliased import', 'fixture/aliased.ts:isBoundedNote[value.length <= MAX_LEN]#0'],
      ['a numeric literal', 'fixture/literal.ts:isBoundedLabel[value.length <= 10_000]#0'],
      [
        'a file in a subdirectory',
        'fixture/guards/nested.ts:isBoundedNested[value.length <= MAX_STRING_LENGTH]#0',
      ],
    ])('sees a cap written with %s', (_label, site) => {
      const sites = findSizeCapSites([{ label: 'fixture', dir: root }]).map((hit) => hit.site);
      expect(sites).toContain(site);
    });

    it('does not invent a site for a reflowed multi-line import, or for arity checks', () => {
      const sites = findSizeCapSites([{ label: 'fixture', dir: root }]).map((hit) => hit.site);
      expect(sites.filter((site) => site.startsWith('fixture/reflowed.ts'))).toEqual([]);
      expect(sites.filter((site) => site.startsWith('fixture/ordinary.ts'))).toEqual([]);
    });
  });

  /**
   * The seven shapes that defeated v2's NAME test, each as a real file on disk.
   *
   * Every one of these was measured MISSED against the regex scan while a real cap of that
   * exact shape sat inside the three inventoried roots. They are the reason the identity
   * function no longer asks what the right operand is CALLED.
   */
  describe('source scan — the escapes that defeated the NAME test', () => {
    let root: string;

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'size-cap-scan-v2-'));
      // The one that got worse, not better: v1 cried wolf when prettier reflowed an import,
      // v2 dropped the site when prettier reflowed a long COMPARISON — the same formatting
      // pressure, now failing silently. An AST does not have lines.
      writeFileSync(
        join(root, 'reflowed-comparison.ts'),
        [
          "import { MAX_STRING_LENGTH } from './wireLimits';",
          'export function isBoundedEntry(entry: { veryLongPropertyNameIndeed: string }): boolean {',
          '  return (',
          '    entry.veryLongPropertyNameIndeed.length <=',
          '    MAX_STRING_LENGTH',
          '  );',
          '}',
        ].join('\n'),
      );
      // The bound written on the LEFT. A comparison has two sides and a cap can be on either.
      writeFileSync(
        join(root, 'reversed.ts'),
        [
          "import { MAX_STRING_LENGTH } from './wireLimits';",
          'export function isBoundedReversed(value: string): boolean {',
          '  return MAX_STRING_LENGTH >= value.length;',
          '}',
        ].join('\n'),
      );
      // Four of the seven real misses were this: the cap arrives as an argument, so it has
      // no name to match. It is not an exotic way to write a cap — it is how a shared guard
      // parameterised over several limits has to be written.
      writeFileSync(
        join(root, 'parameterised.ts'),
        [
          'export function isBoundedByArgument(value: string, maxLength: number): boolean {',
          '  return value.length <= maxLength;',
          '}',
        ].join('\n'),
      );
      // Two of the seven: a Map/Set cap is a cap.
      writeFileSync(
        join(root, 'mapsize.ts'),
        [
          "import { MAX_TRACKED } from './wireLimits';",
          'export function isBoundedMemo(seen: Map<string, number>): boolean {',
          '  return seen.size <= MAX_TRACKED;',
          '}',
        ].join('\n'),
      );
      // A namespace import gives the bound a dotted name, which no identifier pattern matches.
      writeFileSync(
        join(root, 'namespaced.ts'),
        [
          "import * as limits from './wireLimits';",
          'export function isBoundedNamespaced(value: string): boolean {',
          '  return value.length <= limits.MAX_STRING_LENGTH;',
          '}',
        ].join('\n'),
      );
      // The controls, restated for the new rule: iteration and arity must still stay out, or
      // the inventory becomes noise nobody maintains.
      writeFileSync(
        join(root, 'ordinary2.ts'),
        [
          'export function summarise(rows: string[][]): number {',
          '  let total = 0;',
          '  for (let i = 0; i < rows.length; i += 1) {',
          '    if (rows[i].length > 0 && rows[i].length >= 2) {',
          '      total += 1;',
          '    }',
          '  }',
          '  return total;',
          '}',
          'export function sameShape(a: string[], b: string[]): boolean {',
          '  return a.length === b.length;',
          '}',
        ].join('\n'),
      );
    });

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it.each([
      [
        "prettier's own reflow of a long comparison",
        'fixture/reflowed-comparison.ts:isBoundedEntry[entry.veryLongPropertyNameIndeed.length <= MAX_STRING_LENGTH]#0',
      ],
      [
        'the operands reversed',
        'fixture/reversed.ts:isBoundedReversed[MAX_STRING_LENGTH >= value.length]#0',
      ],
      [
        'the cap passed in as a parameter',
        'fixture/parameterised.ts:isBoundedByArgument[value.length <= maxLength]#0',
      ],
      ['a Map/Set `.size`', 'fixture/mapsize.ts:isBoundedMemo[seen.size <= MAX_TRACKED]#0'],
      [
        'a namespace import',
        'fixture/namespaced.ts:isBoundedNamespaced[value.length <= limits.MAX_STRING_LENGTH]#0',
      ],
    ])('sees a cap written with %s', (_label, site) => {
      const sites = findSizeCapSites([{ label: 'fixture', dir: root }]).map((hit) => hit.site);
      expect(sites).toContain(site);
    });

    it('still keeps iteration, emptiness, arity and size-vs-size comparisons out', () => {
      // Four separate exclusions, all structural: the `for` condition, `> 0`, `>= 2`, and a
      // comparison of two measured sizes. None of them consults a name.
      const sites = findSizeCapSites([{ label: 'fixture', dir: root }]).map((hit) => hit.site);
      expect(sites.filter((site) => site.startsWith('fixture/ordinary2.ts'))).toEqual([]);
    });
  });

  /**
   * The ten shapes that defeated the ADJACENCY test, each as a real file on disk.
   *
   * v3 applied its size test to `node.left`/`node.right` DIRECTLY, so the measurement had to
   * be lexically inside the comparison. Every fixture below was measured MISSED against it
   * while a real cap of that exact shape sat inside the three inventoried roots — 25 of them,
   * including every aggregate bound at the data-middleware request boundary and every
   * per-turn persistence budget on the chat wire, with the completeness test green at 54/54.
   *
   * They are all one shape: **a cap whose parts are spread across two statements.** That is
   * dataflow, not syntax, and no fifth guess at the pattern would have closed it. What closes
   * it is a SECOND recogniser that never looks at the measured side at all — it asks only
   * whether the other operand references a limit constant the scan found DECLARED under the
   * same roots. A declaration is one node in one place, so unlike an enforcement site it is
   * always visible whole.
   *
   * `limits.ts` below is deliberately part of the fixture: the limit has to be DECLARED under
   * a walked root for this recogniser to fire, and the blind-spot block asserts the converse.
   */
  describe('source scan — the escapes that defeated the ADJACENCY test', () => {
    let root: string;

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'size-cap-scan-v3-'));
      // The declarations. `MAX_ENTRY_SIZE` is defined in terms of another constant, which is
      // how the real budgets are written (`16 * MAX_STRING_LENGTH`), so the fold has to reach
      // it. `seq` is a `let`: a mutable counter is not a limit, and the control below says so.
      writeFileSync(
        join(root, 'limits.ts'),
        [
          'export const MAX_TOTAL = 40_000;',
          'export const MAX_DEPTH = 32;',
          'export const MAX_ENTRY_SIZE = 4 * MAX_TOTAL;',
          'export let seq = 0;',
        ].join('\n'),
      );
      // THE dominant shape: the measurement hoisted one statement up. `wireValueSize` is in
      // `SIZE_CALLS` — the scan knows how to spell this measurement, it just is not inside
      // the comparison any more.
      writeFileSync(
        join(root, 'hoisted.ts'),
        [
          "import { MAX_TOTAL } from './limits';",
          'declare function wireValueSize(value: unknown): number;',
          'export function isBoundedHoisted(value: unknown): boolean {',
          '  const size = wireValueSize(value);',
          '  return size <= MAX_TOTAL;',
          '}',
        ].join('\n'),
      );
      // The aggregate budget — the cap you add when the per-item cap is not enough, and
      // therefore the STRONGER member of every cap pair in this codebase.
      writeFileSync(
        join(root, 'running.ts'),
        [
          "import { MAX_TOTAL } from './limits';",
          'export function isBoundedRunning(values: string[]): boolean {',
          '  let total = 0;',
          '  for (const value of values) {',
          '    total += value.length;',
          '    if (total > MAX_TOTAL) { return false; }',
          '  }',
          '  return true;',
          '}',
        ].join('\n'),
      );
      // The accumulator-plus-operand form, where the measured side is a SUM and so is not a
      // size expression even though half of it is.
      writeFileSync(
        join(root, 'accumulated.ts'),
        [
          "import { MAX_TOTAL } from './limits';",
          'export function fits(turnSize: number, value: string): boolean {',
          '  return turnSize + value.length <= MAX_TOTAL;',
          '}',
        ].join('\n'),
      );
      // A recursion counter, and the same counter reached through a field — the two forms
      // every depth bound and every `{ total: 0 }` accumulator in the roots is written in.
      writeFileSync(
        join(root, 'counter.ts'),
        [
          "import { MAX_DEPTH, MAX_TOTAL } from './limits';",
          'export function walkDeep(node: unknown, depth: number): boolean {',
          '  if (depth > MAX_DEPTH) { return false; }',
          '  return true;',
          '}',
          'export function walkWide(counter: { total: number }): boolean {',
          '  return counter.total <= MAX_TOTAL;',
          '}',
        ].join('\n'),
      );
      // A folded constant, and the limit reached through a namespace import.
      writeFileSync(
        join(root, 'folded.ts'),
        [
          "import { MAX_ENTRY_SIZE } from './limits';",
          "import * as limits from './limits';",
          'export function fitsEntry(size: number): boolean {',
          '  return size <= MAX_ENTRY_SIZE;',
          '}',
          'export function fitsNamespaced(size: number): boolean {',
          '  return size <= limits.MAX_TOTAL;',
          '}',
        ].join('\n'),
      );
      // A cast and an element access on the measurement, which the size test does not unwrap.
      writeFileSync(
        join(root, 'wrapped.ts'),
        [
          "import { MAX_TOTAL } from './limits';",
          'export function fitsCast(value: string): boolean {',
          '  return (value.length as number) <= MAX_TOTAL;',
          '}',
          'export function fitsIndexed(value: string): boolean {',
          "  return value['length'] <= MAX_TOTAL;",
          '}',
        ].join('\n'),
      );
      // The controls for the NEW recogniser, which over-approximates and so needs its own.
      writeFileSync(
        join(root, 'ordinary3.ts'),
        [
          "import { MAX_TOTAL, seq } from './limits';",
          'export function iterate(): number {',
          '  let count = 0;',
          '  for (let i = 0; i < MAX_TOTAL; i += 1) { count += 1; }',
          '  return count;',
          '}',
          'export function afterSeq(ticket: number): boolean {',
          '  return ticket > seq;',
          '}',
          'export function bothLimits(): boolean {',
          '  return MAX_TOTAL > MAX_DEPTH;',
          '}',
        ].join('\n'),
      );
    });

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it.each([
      [
        'a measurement hoisted into a const',
        'fixture/hoisted.ts:isBoundedHoisted[size <= MAX_TOTAL]#0',
      ],
      ['a running total', 'fixture/running.ts:isBoundedRunning[total > MAX_TOTAL]#0'],
      [
        'an accumulator plus the measurement',
        'fixture/accumulated.ts:fits[turnSize + value.length <= MAX_TOTAL]#0',
      ],
      ['a recursion counter', 'fixture/counter.ts:walkDeep[depth > MAX_DEPTH]#0'],
      [
        'a counter reached through a field',
        'fixture/counter.ts:walkWide[counter.total <= MAX_TOTAL]#0',
      ],
      [
        'a limit folded from another limit',
        'fixture/folded.ts:fitsEntry[size <= MAX_ENTRY_SIZE]#0',
      ],
      [
        'a limit reached through a namespace import',
        'fixture/folded.ts:fitsNamespaced[size <= limits.MAX_TOTAL]#0',
      ],
      [
        'a cast on the measurement',
        'fixture/wrapped.ts:fitsCast[(value.length as number) <= MAX_TOTAL]#0',
      ],
      [
        'an element access on the measurement',
        "fixture/wrapped.ts:fitsIndexed[value['length'] <= MAX_TOTAL]#0",
      ],
    ])('sees a cap written with %s', (_label, site) => {
      const sites = findSizeCapSites([{ label: 'fixture', dir: root }]).map((hit) => hit.site);
      expect(sites).toContain(site);
    });

    it('keeps `for` bounds, mutable counters and limit-vs-limit comparisons out', () => {
      // The new recogniser over-approximates on purpose, so it needs its own controls. `seq`
      // is a `let` — a comparison against a value that is reassigned bounds nothing — and a
      // comparison of two limits to each other has no measured quantity at all.
      const sites = findSizeCapSites([{ label: 'fixture', dir: root }]).map((hit) => hit.site);
      expect(sites.filter((site) => site.startsWith('fixture/ordinary3.ts'))).toEqual([]);
    });
  });

  /**
   * What the scan STILL cannot see, asserted rather than described.
   *
   * There are now two recognisers, and what survives is the INTERSECTION of their blind
   * spots: a cap whose measurement is not adjacent to the comparison AND whose limit is not a
   * constant declared under the walked roots. Both halves have to fail at once, which is why
   * every fixture below carries a hoisted or unknown measurement AND a parameter, a literal
   * or an imported-from-outside limit. Neither half alone is a hiding place any more.
   *
   * They are fixtures here — asserted MISSED — so that the limit of the claim is
   * machine-checked, a reader is told exactly where it ends, and the next sweep finds them
   * already written down instead of reporting them as a discovery. Nothing in the three
   * inventoried roots is currently written this way; these are the shapes to watch for.
   *
   * If one of these ever needs to be covered, the fix is to add the helper to `SIZE_CALLS`,
   * or to bring the declaring directory into `SIZE_CAP_ROOTS` (and delete the corresponding
   * expectation here), not to guess a wider pattern.
   */
  describe('source scan — blind spots', () => {
    let root: string;

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'size-cap-scan-blind-'));
      // A size measured by a helper the scan has not been told about.
      writeFileSync(
        join(root, 'customMeasure.ts'),
        [
          "import { MAX_STRING_LENGTH } from './wireLimits';",
          'declare function utf8Bytes(value: string): number;',
          'export function isBoundedByBytes(value: string): boolean {',
          '  return utf8Bytes(value) <= MAX_STRING_LENGTH;',
          '}',
        ].join('\n'),
      );
      // A bound enforced by TRUNCATION, with no comparison anywhere.
      writeFileSync(
        join(root, 'truncating.ts'),
        [
          "import { MAX_STRING_LENGTH } from './wireLimits';",
          'export function boundedNote(value: string): string {',
          '  return value.slice(0, MAX_STRING_LENGTH);',
          '}',
          'export function boundedCount(values: string[]): number {',
          '  return Math.min(values.length, MAX_STRING_LENGTH);',
          '}',
        ].join('\n'),
      );
      // BOTH halves fail at once: the measurement is hoisted (so recogniser 1 sees two
      // identifiers) and the limit is a PARAMETER (so recogniser 2 finds no declaration).
      // This is how a shared guard parameterised over several limits would accumulate — four
      // of v2's seven real misses were the parameterised form, they were just still adjacent.
      writeFileSync(
        join(root, 'hoistedParam.ts'),
        [
          'export function isBoundedByBoth(value: string, maxLength: number): boolean {',
          '  const size = value.length;',
          '  return size <= maxLength;',
          '}',
        ].join('\n'),
      );
      // The limit is a real named constant — declared OUTSIDE every walked root. Recogniser 2
      // resolves names against the declarations it found, and it found none for this one.
      writeFileSync(
        join(root, 'importedLimit.ts'),
        [
          "import { MAX_ELSEWHERE } from '@mui/some-other-package';",
          'export function isBoundedByImport(total: number): boolean {',
          '  return total <= MAX_ELSEWHERE;',
          '}',
        ].join('\n'),
      );
    });

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it.each([
      ['a size measured by a helper not in SIZE_CALLS', 'fixture/customMeasure.ts'],
      ['a bound enforced by slice/Math.min rather than a comparison', 'fixture/truncating.ts'],
      [
        'a HOISTED measurement bounded by a PARAMETER — both recognisers blind at once',
        'fixture/hoistedParam.ts',
      ],
      ['a limit declared outside every walked root', 'fixture/importedLimit.ts'],
    ])('does NOT see %s — a known, stated limit of the claim', (_label, filePrefix) => {
      const sites = findSizeCapSites([{ label: 'fixture', dir: root }]).map((hit) => hit.site);
      expect(sites.filter((site) => site.startsWith(filePrefix))).toEqual([]);
    });

    it('sees the SAME cap the moment either half becomes visible', () => {
      // The gap above is the INTERSECTION of two blind spots, and this is what makes that a
      // measured statement rather than a turn of phrase: the identical guard, changed only so
      // that its measurement is adjacent (recogniser 1) or its limit is declared here
      // (recogniser 2), is seen both times.
      const adjacent = mkdtempSync(join(tmpdir(), 'size-cap-scan-blind-a-'));
      const declared = mkdtempSync(join(tmpdir(), 'size-cap-scan-blind-b-'));
      try {
        writeFileSync(
          join(adjacent, 'guard.ts'),
          [
            'export function isBoundedByBoth(value: string, maxLength: number): boolean {',
            '  return value.length <= maxLength;',
            '}',
          ].join('\n'),
        );
        writeFileSync(
          join(declared, 'guard.ts'),
          [
            'export const MAX_LENGTH_HERE = 10_000;',
            'export function isBoundedByBoth(value: string): boolean {',
            '  const size = value.length;',
            '  return size <= MAX_LENGTH_HERE;',
            '}',
          ].join('\n'),
        );
        expect(
          findSizeCapSites([{ label: 'fixture', dir: adjacent }]).map((hit) => hit.site),
        ).toEqual(['fixture/guard.ts:isBoundedByBoth[value.length <= maxLength]#0']);
        expect(
          findSizeCapSites([{ label: 'fixture', dir: declared }]).map((hit) => hit.site),
        ).toEqual(['fixture/guard.ts:isBoundedByBoth[size <= MAX_LENGTH_HERE]#0']);
      } finally {
        rmSync(adjacent, { recursive: true, force: true });
        rmSync(declared, { recursive: true, force: true });
      }
    });

    it('names the measurements it does know, so the gap above is reviewable', () => {
      // The under-approximating half of the identity function, in one place, exported. A cap
      // written against any of these is seen whatever the bound is called; a cap written
      // against anything else is not seen at all.
      expect([...SIZE_PROPERTIES].sort()).toEqual(['byteLength', 'length', 'size']);
      expect([...SIZE_CALLS].sort()).toEqual(['wireStringSize', 'wireValueSize']);
    });
  });
});
