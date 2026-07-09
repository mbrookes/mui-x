import { describe, expect, it, vi, beforeEach } from 'vitest';
import { StudioController } from '../../store/StudioController';
import type {
  StudioDataSource,
  StudioRelationship,
  StudioWidget,
  StudioWidgetConfig,
} from '../../models';
import { exportGridToCsv, exportChartToPng } from '../../internals/widgetUtils';
import { runWidgetExport } from './widgetExport';

vi.mock('../../internals/widgetUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../internals/widgetUtils')>();
  return { ...actual, exportGridToCsv: vi.fn(), exportChartToPng: vi.fn() };
});

const source: StudioDataSource = {
  id: 's1',
  label: 'Source',
  fields: [{ id: 'status', label: 'Status', type: 'string' }],
  rows: [{ status: 'active' }, { status: 'inactive' }],
};

function makeController(widget: StudioWidget, dataSources: Record<string, StudioDataSource> = {}) {
  return new StudioController({
    doc: { widgets: { [widget.id]: widget } },
    runtime: { dataSources },
  });
}

describe('runWidgetExport', () => {
  beforeEach(() => {
    vi.mocked(exportGridToCsv).mockClear();
    vi.mocked(exportChartToPng).mockClear();
  });

  it('dispatches a grid widget to CSV export with cross-filter-resolved rows', () => {
    const widget: StudioWidget = {
      id: 'w1',
      kind: 'grid',
      title: 'Grid',
      sourceId: 's1',
      config: {} as StudioWidgetConfig,
    };
    const controller = makeController(widget, { s1: source });

    runWidgetExport({
      widget,
      source,
      controller,
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: null,
      imperativeExport: null,
    });

    expect(exportGridToCsv).toHaveBeenCalledTimes(1);
    const [passedWidget, passedSource, rows] = vi.mocked(exportGridToCsv).mock.calls[0];
    expect(passedWidget).toBe(widget);
    expect(passedSource).toBe(source);
    expect(rows).toEqual([{ status: 'active' }, { status: 'inactive' }]);
    expect(exportChartToPng).not.toHaveBeenCalled();
  });

  it('dispatches a chart widget to PNG export with its container and background colour', () => {
    const widget: StudioWidget = {
      id: 'w2',
      kind: 'chart',
      title: 'Chart',
      sourceId: 's1',
      config: { chartType: 'bar' } as StudioWidgetConfig,
    };
    const controller = makeController(widget, { s1: source });
    const container = document.createElement('div');

    runWidgetExport({
      widget,
      source,
      controller,
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: container,
      imperativeExport: null,
      chartBackgroundColor: '#fff',
    });

    expect(exportChartToPng).toHaveBeenCalledTimes(1);
    expect(vi.mocked(exportChartToPng).mock.calls[0]).toEqual([widget, container, '#fff']);
    expect(exportGridToCsv).not.toHaveBeenCalled();
  });

  // Regression coverage for finding 2.19: a cross-source display column (a grid column whose
  // `sourceId` differs from the widget's primary source) is joined onto rows for DISPLAY by
  // `useWidgetRows.ts`'s `enrichWithCrossSourceFields`, but the export path used to call
  // `pipeline.resolveWidgetRows` directly and hand the (un-enriched) rows straight to
  // `exportGridToCsv` — so a cross-source column rendered correctly on screen but exported as
  // an empty column. Assert the exported rows now carry the joined value.
  it('enriches cross-source display columns in the exported rows, matching what the grid displays', () => {
    const ordersSource: StudioDataSource = {
      id: 'orders',
      label: 'Orders',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'customerId', label: 'Customer', type: 'string' },
        { id: 'total', label: 'Total', type: 'number' },
      ],
      rows: [
        { id: 'o1', customerId: 'c1', total: 100 },
        { id: 'o2', customerId: 'c2', total: 50 },
      ],
    };
    const customersSource: StudioDataSource = {
      id: 'customers',
      label: 'Customers',
      fields: [
        { id: 'id', label: 'ID', type: 'string' },
        { id: 'company', label: 'Company', type: 'string' },
      ],
      rows: [
        { id: 'c1', company: 'Acme' },
        { id: 'c2', company: 'Globex' },
      ],
    };
    const relationships: StudioRelationship[] = [
      {
        id: 'rel-orders-customers',
        type: 'many-to-one',
        sourceId: 'orders',
        sourceField: 'customerId',
        targetId: 'customers',
        targetField: 'id',
      },
    ];
    const widget: StudioWidget = {
      id: 'w4',
      kind: 'grid',
      title: 'Orders',
      sourceId: 'orders',
      config: {
        columns: [
          { fieldId: 'total' },
          // Cross-source display column — `sourceId` differs from the widget's own source.
          { fieldId: 'company', sourceId: 'customers' },
        ],
      } as StudioWidgetConfig,
    };
    const controller = new StudioController({
      doc: {
        widgets: { [widget.id]: widget },
        relationships,
      },
      runtime: { dataSources: { orders: ordersSource, customers: customersSource } },
    });

    runWidgetExport({
      widget,
      source: ordersSource,
      controller,
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: null,
      imperativeExport: null,
    });

    expect(exportGridToCsv).toHaveBeenCalledTimes(1);
    const [, , rows] = vi.mocked(exportGridToCsv).mock.calls[0];
    expect(rows).toHaveLength(2);
    // `toMatchObject` (rather than `toEqual`) sidesteps the enumerable row-identity symbol
    // that cross-source enrichment stamps onto each row (see internals/rowIdentity.ts) —
    // irrelevant to this assertion, which only cares about the joined `company` value.
    expect(rows[0]).toMatchObject({ id: 'o1', customerId: 'c1', total: 100, company: 'Acme' });
    expect(rows[1]).toMatchObject({ id: 'o2', customerId: 'c2', total: 50, company: 'Globex' });
  });

  it('delegates pivot and custom-kind widgets to their imperative export handler', () => {
    const pivot: StudioWidget = {
      id: 'w3',
      kind: 'pivot',
      title: 'Pivot',
      sourceId: 's1',
      config: {} as StudioWidgetConfig,
    };
    const imperativeExport = vi.fn();
    runWidgetExport({
      widget: pivot,
      source,
      controller: makeController(pivot, { s1: source }),
      pageId: 'page-1',
      isCustomKind: false,
      chartContainer: null,
      imperativeExport,
    });
    expect(imperativeExport).toHaveBeenCalledTimes(1);
    expect(exportGridToCsv).not.toHaveBeenCalled();
    expect(exportChartToPng).not.toHaveBeenCalled();
  });
});
