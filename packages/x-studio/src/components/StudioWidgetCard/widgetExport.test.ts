import { describe, expect, it, vi, beforeEach } from 'vitest';
import { StudioController } from '../../store/StudioController';
import type { StudioDataSource, StudioWidget, StudioWidgetConfig } from '../../models';
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
