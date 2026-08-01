import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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
 *  2. `covers every use of MAX_STRING_LENGTH in this package` derives the site list from
 *     the SOURCE and fails if it disagrees with `CAP_SITES`. A new guard that caps a
 *     string cannot be written without naming `MAX_STRING_LENGTH` — it is the only such
 *     constant in the package, and `wireLimits.ts`'s doc says so — and the moment it does,
 *     this test names the new site and fails until it has a row here. That is the part
 *     that makes the eighth occurrence impossible to ship unpinned; the seven rows below
 *     are just the backlog it started with.
 *
 * Adding a row is deliberately cheap and deliberately not optional. If a new use of
 * `MAX_STRING_LENGTH` is genuinely not a cap on a reachable payload (only one is today —
 * the rejection MESSAGE that quotes the number), it goes in `NON_CAP_USES` with a reason,
 * which is a claim a reader can check rather than a silence.
 */

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));

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
    site: 'parseStateMutation.ts:isBoundedValue#0',
    what:
      "the string VALUE arm, through `addFilter`'s uninterpreted `filter.value` — the one " +
      'field with no shape check of its own, so nothing but this clause can reject it',
    accepts: (probe) => parseStateMutation(addFilterWithValue(probe)).ok,
  },
  {
    site: 'parseStateMutation.ts:isBoundedValue#1',
    what:
      'the record KEY arm, through the same uninterpreted `filter.value` carrying a record ' +
      'with one over-long own key and a small value',
    accepts: (probe) => parseStateMutation(addFilterWithValue({ [probe]: 1 })).ok,
  },
  {
    site: 'parseStateMutation.ts:isString#0',
    what: '`addPage.args.title` — a required string in an `args` bag, which `isBoundedValue` never sees',
    accepts: (probe) =>
      parseStateMutation({ type: 'addPage', args: { id: 'p9', title: probe } }).ok,
  },
  {
    site: 'parseStateMutation.ts:isOptionalString#0',
    what: '`setWidgetLayout.args.pageId` — present-but-over-cap, so the `undefined` arm is not the one answering',
    accepts: (probe) =>
      parseStateMutation({ type: 'setWidgetLayout', args: { rows: [['w1']], pageId: probe } }).ok,
  },
  {
    site: 'parseStateMutation.ts:isSafeId#0',
    what:
      '`removeWidget.args.widgetId` — an id checked by `isSafeId` alone. NOT through ' +
      "`removedWidgetIds`/`widget.id`, where `isStringArray`'s item cap or the whole-record " +
      '`isBoundedValue` would mask it',
    accepts: (probe) => parseStateMutation({ type: 'removeWidget', args: { widgetId: probe } }).ok,
  },
  {
    site: 'parseStateMutation.ts:isStringArray#0',
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
    site: 'parseStateMutation.ts:isFiniteNumberRecord#0',
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
    site: 'internalGuards.ts:repairFilterDependsOn#0',
    what:
      "the defense-in-depth twin of `isStringArray`'s item cap, on the paths that never reach " +
      'the wire parser. It REPAIRS rather than rejects, so "accepted" here means the field ' +
      'survived the repair rather than being stripped',
    accepts: (probe) =>
      Object.hasOwn(repairFilterDependsOn({ id: 'f1', dependsOn: [probe] }), 'dependsOn'),
  },
];

/**
 * Uses of `MAX_STRING_LENGTH` in this package's source that are NOT a cap on a payload,
 * and therefore have no probe. Each needs a reason, because "this one does not need a
 * test" is exactly the claim that produced the seven rows above.
 */
const NON_CAP_USES: { site: string; why: string }[] = [
  {
    site: 'parseStateMutation.ts:unboundedValueError#0',
    why: 'interpolates the number into the rejection MESSAGE. It bounds nothing; the clauses it describes are all rowed above.',
  },
];

/** Files that name `MAX_STRING_LENGTH` without enforcing it, so the scan expects no sites in them. */
const NON_ENFORCING_FILES: { file: string; why: string }[] = [
  { file: 'wireLimits.ts', why: 'declares the constant.' },
  { file: 'index.ts', why: 're-exports it for consumers.' },
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

// ── The source scan ─────────────────────────────────────────────────────────────

/**
 * Every use of `MAX_STRING_LENGTH` in this package's non-test source, as
 * `<file>:<enclosing function>#<n>`.
 *
 * Comment and import lines are dropped first, so the docblocks that DESCRIBE a cap are not
 * mistaken for one — the point of the scan is that a clause cannot hide, not that prose
 * cannot.
 */
function findCapSitesInSource(): string[] {
  const sites: string[] = [];
  const files = readdirSync(CURRENT_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort();

  for (const file of files) {
    const lines = readFileSync(join(CURRENT_DIR, file), 'utf8').split('\n');
    let enclosingFunction = '<module>';
    const seenPerFunction = new Map<string, number>();

    for (const raw of lines) {
      const trimmed = raw.trim();
      // Comment lines (including every line of a JSDoc block, which start with `*`).
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
        continue;
      }
      const declaration = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(trimmed);
      if (declaration) {
        enclosingFunction = declaration[1];
      }
      // Imports name the constant without using it.
      if (trimmed.startsWith('import ') || trimmed.startsWith('} from ')) {
        continue;
      }
      // A trailing `// …` comment on a code line. `:` guards against `https://`.
      const code = raw.replace(/(^|[^:])\/\/.*$/, '$1');
      const uses = code.split('MAX_STRING_LENGTH').length - 1;
      for (let i = 0; i < uses; i += 1) {
        const key = `${file}:${enclosingFunction}`;
        const nth = seenPerFunction.get(key) ?? 0;
        seenPerFunction.set(key, nth + 1);
        sites.push(`${key}#${nth}`);
      }
    }
  }
  return sites;
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
  it('covers every use of MAX_STRING_LENGTH in this package', () => {
    const inSource = findCapSitesInSource().filter(
      (site) => !NON_ENFORCING_FILES.some(({ file }) => site.startsWith(`${file}:`)),
    );
    const accountedFor = [
      ...CAP_SITES.map(({ site }) => site),
      ...NON_CAP_USES.map(({ site }) => site),
    ];

    // Sorted rather than compared as sets, so the failure output names the missing site.
    expect([...inSource].sort()).toEqual([...accountedFor].sort());
  });

  // …and the scan itself has to be able to see something, or the test above passes by
  // finding nothing at all — the failure mode of every source-derived check.
  it('finds the caps it is scanning for', () => {
    const inSource = findCapSitesInSource();
    expect(inSource.length).toBeGreaterThanOrEqual(CAP_SITES.length);
    expect(inSource).toContain('parseStateMutation.ts:isBoundedValue#0');
    expect(inSource).toContain('internalGuards.ts:repairFilterDependsOn#0');
  });
});
