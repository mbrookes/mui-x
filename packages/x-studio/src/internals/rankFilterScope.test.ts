import { describe, expect, it } from 'vitest';
import type { StudioFilterState, StudioPage } from '../models';
import { hasConflictingRankFilter, resolveRankFilterPageId } from './rankFilterScope';

function makeFilter(
  overrides: Partial<StudioFilterState> & { scope?: StudioFilterState['scope'] },
): StudioFilterState {
  return {
    id: 'f1',
    field: 'value',
    operator: 'equals',
    value: '',
    scope: { kind: 'page' },
    ...overrides,
  } as StudioFilterState;
}

function makePage(id: string, widgetRows: string[][] = []): StudioPage {
  return { id, title: id, widgetRows } as StudioPage;
}

describe('resolveRankFilterPageId', () => {
  it('returns the explicit pageId of a page-scoped filter', () => {
    const filter = makeFilter({ scope: { kind: 'page', pageId: 'page-2' } });
    expect(resolveRankFilterPageId(filter, {})).toBe('page-2');
  });

  it('returns null for a legacy pageId-less page filter (applies everywhere)', () => {
    const filter = makeFilter({ scope: { kind: 'page' } });
    expect(resolveRankFilterPageId(filter, {})).toBe(null);
  });

  it('resolves the page whose widgetRows contain a widget-scoped filter', () => {
    const filter = makeFilter({ scope: { kind: 'widget', widgetId: 'w1' } });
    const pages = {
      'page-1': makePage('page-1', [['other']]),
      'page-2': makePage('page-2', [['w1', 'w2']]),
    };
    expect(resolveRankFilterPageId(filter, pages)).toBe('page-2');
  });

  it('returns null when the widget is not placed on any page', () => {
    const filter = makeFilter({ scope: { kind: 'widget', widgetId: 'ghost' } });
    const pages = { 'page-1': makePage('page-1', [['w1']]) };
    expect(resolveRankFilterPageId(filter, pages)).toBe(null);
  });

  it('returns null for other scope kinds', () => {
    const filter = makeFilter({
      scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
    });
    expect(resolveRankFilterPageId(filter, {})).toBe(null);
  });
});

describe('hasConflictingRankFilter', () => {
  const pages = {
    'page-1': makePage('page-1', [['w1']]),
    'page-2': makePage('page-2', [['w2']]),
  };

  it('does not conflict with a rank filter on a different page', () => {
    const target = makeFilter({ id: 't', scope: { kind: 'page', pageId: 'page-2' } });
    const filters = [
      makeFilter({ id: 'r1', filterMode: 'rank', scope: { kind: 'page', pageId: 'page-1' } }),
    ];
    expect(hasConflictingRankFilter('t', target, filters, pages)).toBe(false);
  });

  it('conflicts with a rank filter on the same page', () => {
    const target = makeFilter({ id: 't', scope: { kind: 'page', pageId: 'page-1' } });
    const filters = [
      makeFilter({ id: 'r1', filterMode: 'rank', scope: { kind: 'page', pageId: 'page-1' } }),
    ];
    expect(hasConflictingRankFilter('t', target, filters, pages)).toBe(true);
  });

  it('ignores the filter being changed (same id)', () => {
    const target = makeFilter({ id: 'r1', scope: { kind: 'page', pageId: 'page-1' } });
    const filters = [
      makeFilter({ id: 'r1', filterMode: 'rank', scope: { kind: 'page', pageId: 'page-1' } }),
    ];
    expect(hasConflictingRankFilter('r1', target, filters, pages)).toBe(false);
  });

  it('ignores cross-filter and non-rank filters', () => {
    const target = makeFilter({ id: 't', scope: { kind: 'page', pageId: 'page-1' } });
    const filters = [
      makeFilter({
        id: 'x',
        filterMode: 'rank',
        scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
      }),
      makeFilter({ id: 'c', filterMode: 'condition', scope: { kind: 'page', pageId: 'page-1' } }),
    ];
    expect(hasConflictingRankFilter('t', target, filters, pages)).toBe(false);
  });

  it('a pageId-less (null) target conflicts with any rank filter', () => {
    const target = makeFilter({ id: 't', scope: { kind: 'page' } });
    const filters = [
      makeFilter({ id: 'r1', filterMode: 'rank', scope: { kind: 'page', pageId: 'page-2' } }),
    ];
    expect(hasConflictingRankFilter('t', target, filters, pages)).toBe(true);
  });

  it('a pageId-less (null) existing rank filter conflicts with any target', () => {
    const target = makeFilter({ id: 't', scope: { kind: 'page', pageId: 'page-2' } });
    const filters = [makeFilter({ id: 'r1', filterMode: 'rank', scope: { kind: 'page' } })];
    expect(hasConflictingRankFilter('t', target, filters, pages)).toBe(true);
  });

  it('resolves widget-scoped filters to their host page for the conflict check', () => {
    // target is a widget filter on page-1 (w1); existing rank is a widget filter on page-2 (w2)
    const target = makeFilter({ id: 't', scope: { kind: 'widget', widgetId: 'w1' } });
    const filters = [
      makeFilter({ id: 'r1', filterMode: 'rank', scope: { kind: 'widget', widgetId: 'w2' } }),
    ];
    expect(hasConflictingRankFilter('t', target, filters, pages)).toBe(false);

    // same page → conflict
    const target2 = makeFilter({ id: 't', scope: { kind: 'widget', widgetId: 'w2' } });
    expect(hasConflictingRankFilter('t', target2, filters, pages)).toBe(true);
  });
});
