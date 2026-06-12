import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createDefaultStudioState } from '../../models/stateTypes';
import type { StudioState } from '../../models';
import {
  DEFAULT_STUDIO_LOCALE_TEXT,
  type ResolvedStudioFeatures,
} from '../../internals/StudioUIConfigContext';
import { StudioQuickFilterBar } from './StudioQuickFilterBar';

// ── Shared mutable state ──────────────────────────────────────────────────────

let mockState: StudioState;
let mockFeatures: ResolvedStudioFeatures;

const BASE_FEATURES: ResolvedStudioFeatures = {
  compose: true,
  filters: true,
  quickFilter: false,
  savedFilterViews: true,
  dataManagement: true,
  relationships: true,
  widgetFilters: true,
  aiChat: false,
  grid: true,
  chart: true,
  kpi: true,
  text: true,
  filter: true,
  pivot: true,
  map: true,
  kpiSparkline: true,
  kpiTrend: true,
  kpiTarget: true,
  kpiCalculatedFields: true,
  chartAnnotations: true,
  chartCalculatedFields: true,
  gridGroupBy: true,
  gridSummary: true,
  gridConditionalFormats: true,
  gridCalculatedFields: true,
  calculatedFields: true,
};

vi.mock('../../context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../context')>();
  return {
    ...actual,
    useStudioController: () => ({
      setDrawerOpen: vi.fn(),
      removeFilter: vi.fn(),
    }),
    useStudioSelector: (selector: (state: StudioState) => unknown) => selector(mockState),
  };
});

vi.mock('../../internals/StudioUIConfigContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../internals/StudioUIConfigContext')>();
  return {
    ...actual,
    useStudioLocaleText: () => DEFAULT_STUDIO_LOCALE_TEXT,
    useStudioFeatures: () => mockFeatures,
  };
});

const { render } = createRenderer();

const PAGE_ID = 'page-1';

function makePageFilter(id: string, field: string = 'country') {
  return {
    id,
    field,
    sourceId: 'src1',
    operatorId: 'equals',
    values: ['France'],
    value: 'France',
    operator: 'equals' as const,
    scope: 'page' as const,
    pageId: PAGE_ID,
    filterMode: 'condition' as const,
  };
}

const DATA_SOURCES_WITH_DATE = {
  src1: {
    id: 'src1',
    label: 'Source',
    fields: [
      { id: 'order_date', label: 'Order Date', type: 'date' as const },
      { id: 'country', label: 'Country', type: 'string' as const },
    ],
    rows: [],
  },
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('StudioQuickFilterBar', () => {
  // Reset features to default before each test
  // eslint-disable-next-line vitest/prefer-each -- intentional reset pattern
  beforeEach(() => {
    mockFeatures = { ...BASE_FEATURES, quickFilter: false };
  });

  it('renders nothing when there are no page filters', () => {
    mockState = createDefaultStudioState({
      filters: [],
      dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
    });
    const { container } = render(<StudioQuickFilterBar />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a chip for each active page filter', () => {
    mockState = createDefaultStudioState({
      filters: [makePageFilter('f1', 'country'), makePageFilter('f2', 'region')],
      dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
      dataSources: {
        src1: {
          id: 'src1',
          label: 'Source',
          fields: [
            { id: 'country', label: 'Country', type: 'string' as const },
            { id: 'region', label: 'Region', type: 'string' as const },
          ],
          rows: [],
        },
      },
    });
    render(<StudioQuickFilterBar />);
    expect(screen.getByText(/Country/)).toBeDefined();
    expect(screen.getByText(/Region/)).toBeDefined();
  });

  it('shows dashboard date-range filter as chip when quickFilter is disabled', () => {
    mockFeatures = { ...BASE_FEATURES, quickFilter: false };
    mockState = createDefaultStudioState({
      filters: [
        { ...makePageFilter('dr1', 'order_date'), isDashboardDateRange: true as const },
        makePageFilter('f1', 'country'),
      ],
      dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
      dataSources: DATA_SOURCES_WITH_DATE,
    });
    render(<StudioQuickFilterBar />);
    // Both filters shown when quickFilter bar is off (user can still clear them)
    expect(screen.getByText(/Order Date/)).toBeDefined();
    expect(screen.getByText(/Country/)).toBeDefined();
  });

  it('hides dashboard date-range filter chip when quickFilter is enabled (bar handles it)', () => {
    mockFeatures = { ...BASE_FEATURES, quickFilter: true };
    mockState = createDefaultStudioState({
      filters: [
        { ...makePageFilter('dr1', 'order_date'), isDashboardDateRange: true as const },
        makePageFilter('f1', 'country'),
      ],
      dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
      dataSources: DATA_SOURCES_WITH_DATE,
    });
    render(<StudioQuickFilterBar />);
    // Date range filter excluded from chips — the bar component handles it
    expect(screen.queryByText(/Order Date/)).toBeNull();
    // Regular page filter still shown
    expect(screen.getByText(/Country/)).toBeDefined();
  });

  it('shows "Filtered" label when chips are present', () => {
    mockState = createDefaultStudioState({
      filters: [makePageFilter('f1')],
      dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
    });
    render(<StudioQuickFilterBar />);
    expect(screen.getByText('Filtered')).toBeDefined();
  });

  it('does not show chips for filters on other pages', () => {
    mockState = createDefaultStudioState({
      filters: [{ ...makePageFilter('f1'), pageId: 'other-page' }],
      dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
    });
    const { container } = render(<StudioQuickFilterBar />);
    expect(container.firstChild).toBeNull();
  });

  it('shows chips for filters with no pageId (legacy data)', () => {
    const filterWithoutPageId = { ...makePageFilter('f1'), pageId: undefined };
    mockState = createDefaultStudioState({
      filters: [filterWithoutPageId as any],
      dashboard: { id: 'd1', title: 'T', activePageId: PAGE_ID },
    });
    render(<StudioQuickFilterBar />);
    expect(screen.getByText('Filtered')).toBeDefined();
  });
});
