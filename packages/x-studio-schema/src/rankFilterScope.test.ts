import { describe, expect, it } from 'vitest';
import type { StudioDoc, StudioFilterState } from './stateTypes';
import {
  buildRankFilterWidgetPageIndex,
  dedupeRankFilters,
  hasConflictingRankFilter,
  resolveRankFilterPageId,
} from './rankFilterScope';

/**
 * Builds a page map whose `widgetRows` are GETTERS counting their own reads, so a test can
 * assert how many times the sweep walks the layout without timing anything (a wall-clock
 * assertion would be flaky on shared CI).
 */
function makeCountingPages(
  pageCount: number,
  widgetsPerPage: number,
): { pages: StudioDoc['pages']; reads: () => number } {
  const counter = { reads: 0 };
  const makePage = (id: string, rows: string[][]) => ({
    id,
    title: id,
    get widgetRows() {
      counter.reads += 1;
      return rows;
    },
  });

  const pages: Record<string, unknown> = {};
  for (let p = 0; p < pageCount; p += 1) {
    const id = `page-${p}`;
    const rows: string[][] = [];
    for (let w = 0; w < widgetsPerPage; w += 1) {
      rows.push([`w-${p}-${w}`]);
    }
    pages[id] = makePage(id, rows);
  }
  return { pages: pages as StudioDoc['pages'], reads: () => counter.reads };
}

function rankFilter(id: string, widgetId: string): StudioFilterState {
  return {
    id,
    field: 'category',
    operator: 'equals',
    value: null,
    filterMode: 'rank',
    scope: { kind: 'widget', widgetId },
  } as unknown as StudioFilterState;
}

/** A `page`-scoped rank filter. Omitting `pageId` builds the legacy pageId-less scope,
 *  which resolves to the `null` "applies everywhere" wildcard — NOT the UNRESOLVABLE
 *  `undefined` sentinel. */
function pageRankFilter(id: string, pageId?: string): StudioFilterState {
  return {
    id,
    field: 'category',
    operator: 'equals',
    value: null,
    filterMode: 'rank',
    scope: pageId === undefined ? { kind: 'page' } : { kind: 'page', pageId },
  } as unknown as StudioFilterState;
}

describe('buildRankFilterWidgetPageIndex', () => {
  it('maps every placed widget to its page', () => {
    const pages = {
      'page-1': { id: 'page-1', title: 'A', widgetRows: [['w1', 'w2'], ['w3']] },
      'page-2': { id: 'page-2', title: 'B', widgetRows: [['w4']] },
    } as unknown as StudioDoc['pages'];
    const index = buildRankFilterWidgetPageIndex(pages);
    expect(index.get('w1')).toBe('page-1');
    expect(index.get('w3')).toBe('page-1');
    expect(index.get('w4')).toBe('page-2');
    // An unplaced widget must be absent, so `Map.get` yields the same UNRESOLVABLE
    // `undefined` the un-indexed scan returns.
    expect(index.get('nope')).toBeUndefined();
  });

  it('resolves a widget duplicated across pages to the FIRST page, like the scan it replaces', () => {
    const pages = {
      'page-1': { id: 'page-1', title: 'A', widgetRows: [['dup']] },
      'page-2': { id: 'page-2', title: 'B', widgetRows: [['dup']] },
    } as unknown as StudioDoc['pages'];
    const filter = rankFilter('f1', 'dup');
    expect(buildRankFilterWidgetPageIndex(pages).get('dup')).toBe('page-1');
    // Same answer with and without the index — the tie-break must not drift.
    expect(resolveRankFilterPageId(filter, pages)).toBe('page-1');
    expect(resolveRankFilterPageId(filter, pages, buildRankFilterWidgetPageIndex(pages))).toBe(
      'page-1',
    );
  });

  // The `if (!page) continue` guard is unreachable from every IN-package caller (the
  // factory's `screenPagesShape` and the load boundary's `normalizePersistedPages` both
  // drop null pages first), but this function is exported from the package index and
  // `@mui/x-studio`'s `StudioFiltersDrawer` calls it with `pages` read straight off the
  // store — which a host's `initialState` populates. That is the path the guard is for.
  it('skips a null page value instead of dereferencing it', () => {
    const pages = {
      'page-1': null,
      'page-2': { id: 'page-2', title: 'B', widgetRows: [['w1']] },
    } as unknown as StudioDoc['pages'];
    let index!: ReturnType<typeof buildRankFilterWidgetPageIndex>;
    expect(() => {
      index = buildRankFilterWidgetPageIndex(pages);
    }).not.toThrow();
    expect(index.get('w1')).toBe('page-2');
  });

  it('tolerates a page with no widgetRows', () => {
    const pages = {
      'page-1': { id: 'page-1', title: 'A' },
      'page-2': { id: 'page-2', title: 'B', widgetRows: [['w1']] },
    } as unknown as StudioDoc['pages'];
    expect(buildRankFilterWidgetPageIndex(pages).get('w1')).toBe('page-2');
  });
});

describe('rank-filter sweep complexity', () => {
  // R4 finding: `dedupeRankFilters` re-scanned `Object.values(pages)` × rows for EVERY
  // resolve, and `hasConflictingRankFilter` resolves once for the target plus once per kept
  // filter — so the layout walk ran O(R²) times over an immutable page map. On a legitimate
  // 100-page / 5 000-widget doc with 100 rank filters that was ~120ms in a synchronous
  // reducer call; the un-deduped load boundary with 1 000 rank filters took over a second.
  it('walks the page layout once per sweep, not once per resolve', () => {
    const pageCount = 20;
    const { pages, reads } = makeCountingPages(pageCount, 5);
    const filters = Array.from({ length: 30 }, (_, i) =>
      rankFilter(`f-${i}`, `w-${i % pageCount}-0`),
    );

    dedupeRankFilters(filters, pages);

    // One O(W) index build: each page's `widgetRows` is read exactly once.
    expect(reads()).toBe(pageCount);
  });

  it('still drops every conflicting rank filter while using the index', () => {
    const pages = {
      'page-1': { id: 'page-1', title: 'A', widgetRows: [['w1', 'w2']] },
      'page-2': { id: 'page-2', title: 'B', widgetRows: [['w3']] },
    } as unknown as StudioDoc['pages'];
    const filters = [
      rankFilter('f1', 'w1'),
      rankFilter('f2', 'w2'), // same page as f1 → dropped
      rankFilter('f3', 'w3'), // page-2 → kept
      rankFilter('f4', 'unplaced'), // UNRESOLVABLE → kept
    ];
    const result = dedupeRankFilters(filters, pages);
    expect(result.changed).toBe(true);
    expect(result.filters.map((f) => f.id)).toEqual(['f1', 'f3', 'f4']);
  });

  // ARCHITECTURE.md's reference-stability contract, which names this function
  // explicitly: every handler and helper returns its INPUT reference unchanged when
  // nothing changed. It is load-bearing rather than cosmetic — `commitDocPatch` pushes an
  // undo entry only when the doc reference changes, so a sweep that always rebuilt would
  // manufacture a no-op undo step on every layout mutation and load.
  it('returns the SAME filters array when nothing conflicts', () => {
    const pages = {
      'page-1': { id: 'page-1', title: 'A', widgetRows: [['w1']] },
      'page-2': { id: 'page-2', title: 'B', widgetRows: [['w3']] },
    } as unknown as StudioDoc['pages'];
    const filters = [rankFilter('f1', 'w1'), rankFilter('f3', 'w3')];
    const result = dedupeRankFilters(filters, pages);
    expect(result.changed).toBe(false);
    expect(result.filters).toBe(filters);
  });

  it('hasConflictingRankFilter agrees with and without an index', () => {
    const pages = {
      'page-1': { id: 'page-1', title: 'A', widgetRows: [['w1', 'w2']] },
      'page-2': { id: 'page-2', title: 'B', widgetRows: [['w3']] },
    } as unknown as StudioDoc['pages'];
    const existing = [rankFilter('f1', 'w1')];
    const index = buildRankFilterWidgetPageIndex(pages);

    const samePage = rankFilter('f2', 'w2');
    expect(hasConflictingRankFilter('f2', samePage, existing, pages)).toBe(true);
    expect(hasConflictingRankFilter('f2', samePage, existing, pages, index)).toBe(true);

    const otherPage = rankFilter('f3', 'w3');
    expect(hasConflictingRankFilter('f3', otherPage, existing, pages)).toBe(false);
    expect(hasConflictingRankFilter('f3', otherPage, existing, pages, index)).toBe(false);

    const unplaced = rankFilter('f4', 'nowhere');
    expect(hasConflictingRankFilter('f4', unplaced, existing, pages)).toBe(false);
    expect(hasConflictingRankFilter('f4', unplaced, existing, pages, index)).toBe(false);
  });
});

// The two `hasConflictingRankFilter` arms nothing above reaches: SELF-exclusion, and an
// unresolvable OTHER filter (the mirror of the unresolvable TARGET arm, which the case
// above does cover).
describe('hasConflictingRankFilter — sentinel and exclusion semantics', () => {
  const pages = {
    'page-1': { id: 'page-1', title: 'A', widgetRows: [['w1', 'w2']] },
    'page-2': { id: 'page-2', title: 'B', widgetRows: [['w3']] },
  } as unknown as StudioDoc['pages'];

  // Every call in this package passes the target ABSENT from `filters` (the reducer checks
  // a not-yet-added filter, the sweeps check against `kept`), so the `filter.id === filterId`
  // exclusion is never exercised here. It is load-bearing for the OTHER caller shape:
  // `@mui/x-studio`'s `PageFilterRow`/`WidgetFilterRow` ask "would this filter conflict if I
  // turned rank mode on?" while it is already IN `doc.filters`, so without self-exclusion
  // every such filter would report a conflict with itself and the affordance would be dead.
  it.each([
    ['widget-scoped', () => rankFilter('f1', 'w1')],
    ['page-scoped', () => pageRankFilter('f1', 'page-1')],
  ])('excludes the target itself when it is already in filters (%s)', (_label, build) => {
    const target = build();
    expect(hasConflictingRankFilter('f1', target, [target], pages)).toBe(false);
    expect(
      hasConflictingRankFilter(
        'f1',
        target,
        [target],
        pages,
        buildRankFilterWidgetPageIndex(pages),
      ),
    ).toBe(false);
  });

  // The asymmetry the module doc calls out: UNRESOLVABLE (`undefined`) must stay distinct
  // from the `null` wildcard. An unplaced widget's rank filter is never removed
  // (`dropWidgetScopedFilters` only fires on widget REMOVAL), so if it were treated as a
  // wildcard, ONE of them would reject every rank `addFilter` on every page forever.
  it('does not let an unresolvable OTHER filter block a null-wildcard target', () => {
    const wildcardTarget = pageRankFilter('new-f'); // no pageId → resolves to `null`
    const unplaced = [rankFilter('f-unplaced', 'nowhere')];
    expect(hasConflictingRankFilter('new-f', wildcardTarget, unplaced, pages)).toBe(false);
    expect(
      hasConflictingRankFilter(
        'new-f',
        wildcardTarget,
        unplaced,
        pages,
        buildRankFilterWidgetPageIndex(pages),
      ),
    ).toBe(false);
  });

  // The mirror: an unresolvable TARGET is likewise not blocked by the wildcard.
  it('does not let a null-wildcard OTHER filter block an unresolvable target', () => {
    const unplacedTarget = rankFilter('new-f', 'nowhere');
    const wildcard = [pageRankFilter('f-wild')];
    expect(hasConflictingRankFilter('new-f', unplacedTarget, wildcard, pages)).toBe(false);
  });

  // …but a RESOLVED target IS blocked by the wildcard, so the two cases above are pinning
  // the sentinel and not a blanket "never conflicts".
  it('still lets a null-wildcard OTHER filter block a resolved target', () => {
    expect(
      hasConflictingRankFilter(
        'new-f',
        rankFilter('new-f', 'w1'),
        [pageRankFilter('f-wild')],
        pages,
      ),
    ).toBe(true);
  });
});

// ─── R6 F2 (secondary): the resolver keys off the page RECORD KEY, not `page.id` ──

describe('resolveRankFilterPageId — page id ↔ record key desync', () => {
  const desyncedPages = {
    p1: { id: 'zzz', title: 'P1', widgetRows: [['w1']] },
  } as unknown as StudioDoc['pages'];

  const widgetRank = {
    id: 'fw',
    field: 'v',
    operator: 'equals',
    value: 1,
    filterMode: 'rank',
    rankDirection: 'top',
    scope: { kind: 'widget', widgetId: 'w1' },
  } as unknown as StudioFilterState;

  const pageRank = {
    id: 'fp',
    field: 'v',
    operator: 'equals',
    value: 1,
    filterMode: 'rank',
    rankDirection: 'top',
    scope: { kind: 'page', pageId: 'p1' },
  } as unknown as StudioFilterState;

  // A host `initialState` can install a page whose `id` disagrees with its record key
  // (`normalizePersistedPages` repairs it only at the LOAD boundary, re-stamping `id` FROM
  // the key). Everything else that resolves a widget's page — `scope.pageId`,
  // `dashboard.activePageId`, `@mui/x-studio`'s `internals/widgetPageResolution.ts` — uses
  // the key, so this must too.
  it('resolves the record key, both indexed and unindexed', () => {
    expect(resolveRankFilterPageId(widgetRank, desyncedPages)).toBe('p1');
    expect(
      resolveRankFilterPageId(
        widgetRank,
        desyncedPages,
        buildRankFilterWidgetPageIndex(desyncedPages),
      ),
    ).toBe('p1');
  });

  // The consequence of keying off `page.id`: the guard saw `'zzz'` vs `'p1'`, reported no
  // conflict, and BOTH rank filters installed — until the next load repaired `page.id` and
  // `dedupeRankFilters` finally dropped one, silently losing a user's filter.
  it('sees the conflict the desync used to hide', () => {
    expect(hasConflictingRankFilter('fw', widgetRank, [pageRank], desyncedPages)).toBe(true);
    expect(dedupeRankFilters([pageRank, widgetRank], desyncedPages)).toEqual({
      filters: [pageRank],
      changed: true,
    });
  });
});
