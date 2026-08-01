import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findSizeCapSites } from 'test/utils/sizeCapScan';
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
 *     the SOURCE and fails if it disagrees. A new cap cannot be added without the
 *     inventory naming it and this test failing until somebody writes either a probe or a
 *     reason there is none.
 *
 * ── What (2) used to be, and why it was replaced ──
 *
 * The first version counted occurrences of the IDENTIFIER `MAX_STRING_LENGTH` in a
 * non-recursive `readdirSync` of THIS directory, and its docblock claimed that made "the
 * eighth occurrence impossible to ship unpinned". A later sweep shipped three real,
 * reachable caps it could not see — `import { MAX_STRING_LENGTH as MAX_LEN }`,
 * `value.length <= 10_000`, and the same file moved into a subdirectory — and one it
 * imagined (a prettier-reflowed multi-line import). Meanwhile a genuinely unpinned cap was
 * sitting one package over, in `x-studio`'s `isWithinApprovalListLimits`, where a
 * package-scoped scan could never look; relaxing it put 20 429 JSON characters into the
 * persisted doc where 399 belong, with the whole 4822-test suite green.
 *
 * So the scan now matches the SHAPE of a size clause over a stated list of boundary roots,
 * walked recursively — see `test/utils/sizeCapScan.ts` for the reasoning, and the
 * `source scan` block at the bottom of this file for each of those escapes as a test.
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
   * `<file>:<enclosing function>#<n>` — the identity the source scan below derives, so a
   * row and a clause cannot drift apart silently. `#n` distinguishes several caps in one
   * function (`isBoundedValue` bounds a string VALUE and a record KEY separately), so
   * adding a second cap to a function that already has a row is a new, unregistered site.
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
    site: 'x-studio-schema/parseStateMutation.ts:isBoundedValue#0',
    what:
      "the string VALUE arm, through `addFilter`'s uninterpreted `filter.value` — the one " +
      'field with no shape check of its own, so nothing but this clause can reject it',
    accepts: (probe) => parseStateMutation(addFilterWithValue(probe)).ok,
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isBoundedValue#3',
    what:
      'the record KEY arm, through the same uninterpreted `filter.value` carrying a record ' +
      'with one over-long own key and a small value',
    accepts: (probe) => parseStateMutation(addFilterWithValue({ [probe]: 1 })).ok,
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isString#0',
    what: '`addPage.args.title` — a required string in an `args` bag, which `isBoundedValue` never sees',
    accepts: (probe) =>
      parseStateMutation({ type: 'addPage', args: { id: 'p9', title: probe } }).ok,
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isOptionalString#0',
    what: '`setWidgetLayout.args.pageId` — present-but-over-cap, so the `undefined` arm is not the one answering',
    accepts: (probe) =>
      parseStateMutation({ type: 'setWidgetLayout', args: { rows: [['w1']], pageId: probe } }).ok,
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isSafeId#0',
    what:
      '`removeWidget.args.widgetId` — an id checked by `isSafeId` alone. NOT through ' +
      "`removedWidgetIds`/`widget.id`, where `isStringArray`'s item cap or the whole-record " +
      '`isBoundedValue` would mask it',
    accepts: (probe) => parseStateMutation({ type: 'removeWidget', args: { widgetId: probe } }).ok,
  },
  {
    site: 'x-studio-schema/parseStateMutation.ts:isStringArray#1',
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
    site: 'x-studio-schema/parseStateMutation.ts:isFiniteNumberRecord#1',
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
    site: 'x-studio-schema/internalGuards.ts:repairFilterDependsOn#1',
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
    it('accounts for every size cap at the inventoried boundaries', () => {
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
      expect(inSource).toContain('x-studio-schema/parseStateMutation.ts:isBoundedValue#0');
      expect(inSource).toContain('x-studio-schema/internalGuards.ts:repairFilterDependsOn#1');
      // Across the package boundary — the region the predecessor scan could not reach, and
      // where a real cap did ship unpinned.
      expect(inSource).toContain(
        'x-studio/chat/studioBackendAdapter.ts:isWithinApprovalListLimits#2',
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
      ['an aliased import', 'fixture/aliased.ts:isBoundedNote#0'],
      ['a numeric literal', 'fixture/literal.ts:isBoundedLabel#0'],
      ['a file in a subdirectory', 'fixture/guards/nested.ts:isBoundedNested#0'],
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
});
