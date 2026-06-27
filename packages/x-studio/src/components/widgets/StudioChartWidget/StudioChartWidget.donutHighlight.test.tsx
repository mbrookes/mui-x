import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { StudioDataSource, StudioState, StudioWidget } from '../../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../../test/studioContextMock';
import { PieHighlightContext } from './PieCrossHighlightContext';
import { StudioChartWidget } from './StudioChartWidget';

// Capture the per-arc ratio the donut feeds to CrossHighlightPieArc, keyed by the
// arc's rendered label (so we can assert which SLICE gets the solid overlay).
let capturedRatioByLabel: Record<string, number> = {};
let capturedHighlightedItem: unknown = 'unset';

vi.mock('@mui/x-charts/PieChart', () => ({
  PieChart: (props: {
    series: Array<{ data: Array<{ id: number; label: string; value: number }> }>;
    highlightedItem?: unknown;
  }) => {
    capturedHighlightedItem = props.highlightedItem ?? null;
    // The Provider lives in StudioChartWidget (our parent), so the context is live here.
    const ctx = React.useContext(PieHighlightContext);
    const data = props.series?.[0]?.data ?? [];
    capturedRatioByLabel = {};
    for (const slice of data) {
      capturedRatioByLabel[slice.label] = ctx.ratioByIndex.get(slice.id) ?? 1;
    }
    return <div data-testid="pie-chart" />;
  },
}));
vi.mock('@mui/x-charts/BarChart', () => ({ BarChart: () => <div /> }));
vi.mock('@mui/x-charts/LineChart', () => ({ LineChart: () => <div /> }));
vi.mock('@mui/x-charts/ScatterChart', () => ({ ScatterChart: () => <div /> }));
vi.mock('@mui/x-charts-pro/SankeyChart', () => ({ SankeyChart: () => <div /> }));

let mockState: StudioState;
const controller = { clearCrossFilter: vi.fn(), applyCrossFilter: vi.fn() };

vi.mock('../../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../context')>()),
  useStudioSelector: mockUseStudioSelector,
  useStudioController: mockUseStudioController,
}));

const { render } = createRenderer();

// Distribution chosen so the AGGREGATION order (first-seen in rows) differs from the
// VALUE-sorted order the donut renders in, and there are > 8 distinct categories so
// pieMaxSlices:8 folds the tail into an "Other" bucket — exactly the survey's shape.
const CATS = [
  ['Already used', 222],
  ['Organic search', 175],
  ['Word of mouth', 80],
  ['Tutorial', 38],
  ['Social media', 20],
  ['On a blog', 16],
  ['LLMs', 14],
  ['Conference', 4],
  ['Other', 30],
] as const;

function makeSource(): StudioDataSource {
  const rows: Array<Record<string, unknown>> = [];
  let id = 0;
  // Insert in REVERSE so first-seen aggregation order != value-descending order.
  for (let i = CATS.length - 1; i >= 0; i -= 1) {
    const [label, count] = CATS[i];
    for (let n = 0; n < (count as number); n += 1) {
      id += 1;
      rows.push({ id: String(id), source: label });
    }
  }
  return {
    id: 'survey',
    label: 'Survey',
    fields: [{ id: 'source', label: 'Source', type: 'string' }],
    rows,
  };
}

function createState(overrides?: Partial<StudioState>): StudioState {
  return {
    schemaVersion: 1,
    mode: 'edit',
    dashboard: { id: 'd', title: 'D', activePageId: 'page-1' },
    pages: { 'page-1': { id: 'page-1', title: 'P', widgetRows: [] } },
    widgets: overrides?.widgets ?? {},
    dataSources: overrides?.dataSources ?? {},
    relationships: [],
    filters: overrides?.filters ?? [],
    expressionFields: [],
    shell: {
      openDrawers: { data: true, compose: true, filters: false },
      selectedWidgetId: null,
      selectedFieldId: null,
      selectedSourceId: null,
    },
  };
}

const donut: StudioWidget = {
  id: 'q-donut',
  kind: 'chart',
  title: 'Composition',
  sourceId: 'survey',
  config: {
    chartType: 'donut',
    xField: 'source',
    yField: 'source',
    yAggregation: 'count',
    pieArcLabel: 'percent',
    pieMaxSlices: 8,
    pieLegendBelow: true,
  },
};

describe('donut cross-highlight overlay alignment (survey repro)', () => {
  beforeEach(() => {
    capturedRatioByLabel = {};
    capturedHighlightedItem = 'unset';
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('lights up the SELECTED slice (not the first slice) when a bar cross-filters the donut', () => {
    const source = makeSource();
    mockState = createState({
      widgets: { [donut.id]: donut },
      dataSources: { survey: source },
      // Incoming cross-filter from a sibling bar widget: user clicked "Organic search".
      filters: [
        {
          id: 'cf-1',
          field: 'source',
          operator: 'equals',
          value: 'Organic search',
          scope: { kind: 'cross-filter', sourceWidgetId: 'q-bar', pageId: 'page-1' },
        },
      ],
    });

    render(
      <ThemeProvider theme={createTheme()}>
        <StudioChartWidget widget={donut} dataSource={source} pageId="page-1" />
      </ThemeProvider>,
    );

    // In cross-highlight mode with pieMaxSlices, the MUI highlightedItem must stay null —
    // the highlight is rendered purely by the overlay arc.
    expect(capturedHighlightedItem).toBe(null);

    // The selected category must get the full overlay (ratio ~1) and everything else ~0.
    expect(capturedRatioByLabel['Organic search']).toBeCloseTo(1, 5);
    expect(capturedRatioByLabel['Already used']).toBeCloseTo(0, 5);
    expect(capturedRatioByLabel['Word of mouth']).toBeCloseTo(0, 5);
  });
});
