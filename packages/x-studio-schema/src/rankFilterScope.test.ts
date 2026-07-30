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
