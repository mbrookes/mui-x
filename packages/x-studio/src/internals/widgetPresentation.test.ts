import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createDefaultWidget,
  resolveWidgetRequiresDataSource,
  widgetKindRequiresDataSource,
} from '@mui/x-studio-core/engine';
import {
  createWidgetForKind,
  exportChartToPng,
  downloadCsv,
  exportGridToCsv,
} from './widgetPresentation';
import type {
  StudioCustomWidgetDef,
  StudioDataSource,
  StudioWidget,
  StudioWidgetConfig,
} from '../models';

function makeWidget(overrides: Partial<StudioWidget> = {}): StudioWidget {
  return {
    id: 'w1',
    kind: 'chart',
    title: 'Chart',
    sourceId: 'orders',
    config: {},
    ...overrides,
  };
}

describe('widgetKindRequiresDataSource', () => {
  it('returns false for text widgets', () => {
    expect(widgetKindRequiresDataSource('text')).toBe(false);
  });

  it('returns true for chart widgets', () => {
    expect(widgetKindRequiresDataSource('chart')).toBe(true);
  });

  it('returns true for grid widgets', () => {
    expect(widgetKindRequiresDataSource('grid')).toBe(true);
  });

  it('returns true for kpi widgets', () => {
    expect(widgetKindRequiresDataSource('kpi')).toBe(true);
  });

  it('returns true for filter widgets', () => {
    expect(widgetKindRequiresDataSource('filter')).toBe(true);
  });
});

// ─── isBuiltinWidgetKind / resolveWidgetRequiresDataSource / createWidgetForKind ──────
//
// The shared resolution + creation used by all three widget-picker creation sites (the compose
// drawer's click-to-add, and both canvas drop handlers), which used to disagree about custom
// kinds — see the comments on those exports.

describe('resolveWidgetRequiresDataSource', () => {
  it('honours an explicit `requiresDataSource` in either direction', () => {
    expect(resolveWidgetRequiresDataSource('weather-tile', { requiresDataSource: true })).toBe(
      true,
    );
    // An explicit `false` on a built-in wins too — that is how `text` opts out.
    expect(resolveWidgetRequiresDataSource('text', { requiresDataSource: false })).toBe(false);
  });

  it('falls back to the kind-derived rule for built-in kinds with no declaration', () => {
    expect(resolveWidgetRequiresDataSource('chart', undefined)).toBe(true);
    expect(resolveWidgetRequiresDataSource('chart', {})).toBe(true);
    expect(resolveWidgetRequiresDataSource('text', undefined)).toBe(false);
  });

  it('defaults a custom kind to false, per `StudioCustomWidgetDef.requiresDataSource`', () => {
    // The kind-derived rule would answer `true` here (`kind !== 'text'`), which is what made a
    // source-less custom widget click-addable but drop-refused.
    expect(resolveWidgetRequiresDataSource('weather-tile', undefined)).toBe(false);
    expect(resolveWidgetRequiresDataSource('weather-tile', { label: 'Weather' } as never)).toBe(
      false,
    );
  });
});

describe('createWidgetForKind', () => {
  const weatherDef = {
    kind: 'weather-tile',
    label: 'Weather tile',
    defaultConfig: { units: 'metric' },
    component: () => null,
  } as unknown as StudioCustomWidgetDef;

  it('applies a custom def label and defaultConfig', () => {
    const created = createWidgetForKind('weather-tile', new Map([[weatherDef.kind, weatherDef]]));
    expect(created.kind).toBe('weather-tile');
    expect(created.title).toBe('Weather tile');
    expect((created.config as StudioWidgetConfig).customConfig).toEqual({ units: 'metric' });
  });

  it('falls back to the kind string and an empty customConfig for an unregistered custom kind', () => {
    const created = createWidgetForKind('weather-tile');
    expect(created.title).toBe('weather-tile');
    expect((created.config as StudioWidgetConfig).customConfig).toEqual({});
  });

  it('leaves built-in kinds exactly as `createDefaultWidget` builds them', () => {
    const created = createWidgetForKind('kpi', new Map([[weatherDef.kind, weatherDef]]));
    expect(created.title).toBe('');
    expect(created.config).toEqual({ kpiAggregation: 'sum' });
  });
});

// ─── createDefaultWidget ──────────────────────────────────────────────────────

describe('exportChartToPng', () => {
  // The chart surface is resolved by CLASS (`.MuiChartsSurface-root`, the class MUI X Charts
  // puts on its root `<svg>`), not by "the first `<svg>` in the subtree" — see the
  // `.MuiChartsSurface-root` scoping tests at the bottom of this suite for why.
  function makeChartContainer(): HTMLElement {
    const container = document.createElement('div');
    container.innerHTML = '<svg class="MuiChartsSurface-root" width="100" height="50"></svg>';
    document.body.appendChild(container);
    return container;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('revokes the object URL and warns (without throwing) when the image fails to load', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-url');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      scale: vi.fn(),
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);

    // jsdom never actually loads a `blob:` URL into an `<img>` (neither `onload` nor
    // `onerror` fires on its own), so capture the constructed element to invoke its
    // `onerror` handler directly, exactly as the browser would on a real load failure.
    // Patching the shared `HTMLImageElement.prototype.src` accessor (rather than
    // subclassing the `Image` constructor) avoids jsdom's legacy `Image` factory not
    // reliably supporting `extends` — `new Image()` in the SUT still returns a normal
    // image element, and this setter observes every `.src` assignment on it.
    let capturedImage: HTMLImageElement | null = null;
    const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      get(this: HTMLImageElement) {
        return srcDescriptor.get!.call(this);
      },
      set(this: HTMLImageElement, value: string) {
        // Capturing the setter's `this` (the constructed <img>) is the point of this
        // test-only patch.
        // eslint-disable-next-line consistent-this
        capturedImage = this;
        srcDescriptor.set!.call(this, value);
      },
    });

    try {
      const widget = makeWidget({ kind: 'chart', title: 'My Chart' });
      exportChartToPng(widget, makeChartContainer());

      expect(capturedImage).not.toBeNull();
      expect(() => capturedImage!.onerror!(new Event('error'))).not.toThrow();
      expect(revokeSpy).toHaveBeenCalledWith('blob:fake-url');
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      Object.defineProperty(HTMLImageElement.prototype, 'src', srcDescriptor);
    }
  });

  // Regression coverage for the Tier 3 finding: `inlineComputedStyles` used to mutate the
  // LIVE, on-screen SVG's inline styles in place (to bake in computed CSS values before
  // rasterizing to PNG) BEFORE cloning it — permanently pinning stale computed colors onto
  // the live chart, which could survive a later light/dark theme toggle. The fix clones the
  // SVG FIRST and only ever writes the inlined styles onto the clone.
  it("does not mutate the live, on-screen SVG's inline styles", () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-url');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      scale: vi.fn(),
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);

    const container = document.createElement('div');
    // `color` set on the root <svg> (not on <text>) so <text>'s computed 'color' is
    // inherited — this exercises a real computed-style read, not just an already-inline one.
    container.innerHTML =
      '<svg class="MuiChartsSurface-root" width="100" height="50" style="color: rgb(9, 8, 7)"><text>Chart</text></svg>';
    document.body.appendChild(container);
    const liveText = container.querySelector('text')!;
    expect(liveText.getAttribute('style')).toBeNull();

    const widget = makeWidget({ kind: 'chart', title: 'My Chart' });
    // Guard against the assertion below passing vacuously because the export bailed early.
    expect(exportChartToPng(widget, container)).toBe(true);

    // The live, on-screen <text> must be untouched — `inlineComputedStyles` only ever
    // wrote onto the (detached, since-discarded) clone used for rasterization.
    expect(liveText.getAttribute('style')).toBeNull();

    document.body.innerHTML = '';
  });

  // Regression coverage for finding 9: MUI X Charts renders the legend as HTML (a `<ul>`,
  // `ChartsLegend`) OUTSIDE the `<svg>`, so capturing only `chartContainer.querySelector('svg')`
  // silently dropped the legend from every multi-series chart's exported PNG. The fix reads each
  // legend row's swatch colour + label text + real on-screen rect from the live DOM and redraws
  // them onto the export canvas alongside the chart image.
  function makeRect(partial: Partial<DOMRect>): DOMRect {
    return {
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
      ...partial,
    } as DOMRect;
  }

  it('composites the legend (swatch colour + label text) onto the exported canvas', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-url');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const fillRect = vi.fn();
    const fillText = vi.fn();
    const drawImage = vi.fn();
    const ctxMock: Record<string, unknown> = {
      scale: vi.fn(),
      fillRect,
      drawImage,
      fillText,
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctxMock as unknown as CanvasRenderingContext2D,
    );

    const container = document.createElement('div');
    container.innerHTML = `
      <svg class="MuiChartsSurface-root" width="100" height="50"></svg>
      <ul class="MuiChartsLegend-root">
        <li>
          <button class="MuiChartsLegend-series">
            <div class="MuiChartsLabelMark-root"><svg><rect fill="#ff0000" /></svg></div>
            <span class="MuiChartsLabel-root">Revenue</span>
          </button>
        </li>
      </ul>
    `;
    document.body.appendChild(container);

    const svg = container.querySelector('svg')!;
    svg.getBoundingClientRect = () =>
      makeRect({ left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50 });
    const markEl = container.querySelector('.MuiChartsLabelMark-root')!;
    markEl.getBoundingClientRect = () =>
      makeRect({ left: 5, top: 60, right: 19, bottom: 74, width: 14, height: 14 });
    const labelEl = container.querySelector('.MuiChartsLabel-root')!;
    labelEl.getBoundingClientRect = () =>
      makeRect({ left: 23, top: 62, right: 63, bottom: 72, width: 40, height: 10 });

    let capturedImage: HTMLImageElement | null = null;
    const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      get(this: HTMLImageElement) {
        return srcDescriptor.get!.call(this);
      },
      set(this: HTMLImageElement, value: string) {
        // eslint-disable-next-line consistent-this
        capturedImage = this;
        srcDescriptor.set!.call(this, value);
      },
    });

    try {
      const widget = makeWidget({ kind: 'chart', title: 'My Chart' });
      exportChartToPng(widget, container);

      expect(capturedImage).not.toBeNull();
      // Manually fire `onload` — jsdom never actually loads a `blob:` URL into an `<img>`
      // (see the `onerror` test above for the same workaround).
      capturedImage!.onload!(new Event('load'));

      // The chart SVG is drawn at its own (viewport) offset within the composed canvas —
      // here that's (0, 0) since the legend sits below/right of the SVG's origin.
      expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0);

      // The swatch is redrawn as a filled rect at the mark's real rect, in the resolved colour.
      expect(fillRect).toHaveBeenCalledWith(5, 60, 14, 14);

      // The label text is redrawn at the label's real rect (vertically centered).
      expect(fillText).toHaveBeenCalledWith('Revenue', 23, 67);
    } finally {
      Object.defineProperty(HTMLImageElement.prototype, 'src', srcDescriptor);
    }

    document.body.innerHTML = '';
  });

  it('falls back to exporting just the chart (no legend items) when no ChartsLegend is rendered', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-url');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const fillRect = vi.fn();
    const fillText = vi.fn();
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      scale: vi.fn(),
      fillRect,
      drawImage,
      fillText,
    } as unknown as CanvasRenderingContext2D);

    let capturedImage: HTMLImageElement | null = null;
    const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      get(this: HTMLImageElement) {
        return srcDescriptor.get!.call(this);
      },
      set(this: HTMLImageElement, value: string) {
        // eslint-disable-next-line consistent-this
        capturedImage = this;
        srcDescriptor.set!.call(this, value);
      },
    });

    try {
      const widget = makeWidget({ kind: 'chart', title: 'My Chart' });
      exportChartToPng(widget, makeChartContainer());
      capturedImage!.onload!(new Event('load'));

      expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0);
      // No `.MuiChartsLegend-root` in this container → no extra draws.
      expect(fillText).not.toHaveBeenCalled();
      // `fillRect` is still called once for the background fill, but never for a legend swatch.
      expect(fillRect).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(HTMLImageElement.prototype, 'src', srcDescriptor);
    }
  });

  // The surface lookup used to be an unscoped `chartContainer.querySelector('svg')`. `canExport`
  // is kind-derived, so the PNG button is offered for a chart that has no chart at all — and both
  // status overlays living inside `chartContainerRef` contain MUI `SvgIcon`s
  // (`StudioNoDataOverlay`'s `InboxOutlinedIcon`, `StudioWidgetErrorOverlay`'s `ErrorIcon`). The
  // unscoped lookup found those, so exporting a no-data or errored chart downloaded a 2x-scaled
  // PNG of a 32px inbox/error icon and presented it as a successful export. Resolve the surface
  // by class the same way `readLegendItems` resolves `.MuiChartsLegend-root`, and report failure
  // so callers can surface it.
  describe('chart surface scoping (.MuiChartsSurface-root)', () => {
    function stubCanvas() {
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-url');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
        scale: vi.fn(),
        fillRect: vi.fn(),
        drawImage: vi.fn(),
        fillText: vi.fn(),
      } as unknown as CanvasRenderingContext2D);
    }

    it('returns false for a null container', () => {
      const widget = makeWidget({ kind: 'chart', title: 'My Chart' });
      expect(exportChartToPng(widget, null)).toBe(false);
    });

    it('returns false (and rasterizes nothing) when only an overlay status icon is present', () => {
      stubCanvas();
      const createObjectURLSpy = vi.mocked(URL.createObjectURL);
      const container = document.createElement('div');
      // Exactly what a no-data / errored chart renders inside `chartContainerRef`: an
      // `SvgIcon`, no `ChartsSurface`.
      container.innerHTML =
        '<div class="MuiSvgIcon-root"><svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg></div>';
      document.body.appendChild(container);

      const widget = makeWidget({ kind: 'chart', title: 'My Chart' });
      expect(exportChartToPng(widget, container)).toBe(false);
      expect(createObjectURLSpy).not.toHaveBeenCalled();
    });

    it('returns false when the chart is unconfigured (no svg at all)', () => {
      stubCanvas();
      const container = document.createElement('div');
      container.innerHTML = '<p>Select a data source to configure this chart</p>';
      document.body.appendChild(container);

      const widget = makeWidget({ kind: 'chart', title: 'My Chart' });
      expect(exportChartToPng(widget, container)).toBe(false);
    });

    it('returns true and rasterizes the ChartsSurface even when overlay icons precede it', () => {
      stubCanvas();
      const container = document.createElement('div');
      // A tooltip/legend `SvgIcon` earlier in the subtree must not win over the real surface.
      container.innerHTML =
        '<div class="MuiSvgIcon-root"><svg viewBox="0 0 24 24"></svg></div>' +
        '<svg class="MuiChartsSurface-root" width="100" height="50"></svg>';
      document.body.appendChild(container);

      const serializeSpy = vi.spyOn(XMLSerializer.prototype, 'serializeToString');

      const widget = makeWidget({ kind: 'chart', title: 'My Chart' });
      expect(exportChartToPng(widget, container)).toBe(true);

      // The rasterized SVG is the chart surface, not the 24x24 icon.
      const serialized = serializeSpy.mock.results[0].value as string;
      expect(serialized).toContain('MuiChartsSurface-root');
      expect(serialized).not.toContain('0 0 24 24');
    });
  });
});

// ─── Locale token tests ────────────────────────────────────────────────────────

/** Build a StudioFilterState with a relative date value (requires `relative: true`). */

describe('createDefaultWidget', () => {
  it('text: returns kind=text with empty default textSubtitle and textBody', () => {
    const widget = createDefaultWidget('text');
    expect(widget.kind).toBe('text');
    expect(widget.config.textSubtitle).toBe('');
    expect(widget.config.textBody).toBe('');
  });

  it('grid without source: config.columns is []', () => {
    const widget = createDefaultWidget('grid');
    expect(widget.kind).toBe('grid');
    expect(widget.config.columns).toEqual([]);
    expect(widget.sourceId).toBeUndefined();
  });

  it('chart: config.chartType defaults to "bar"', () => {
    const widget = createDefaultWidget('chart');
    expect(widget.kind).toBe('chart');
    expect(widget.config.chartType).toBe('bar');
  });

  it('kpi: config.kpiAggregation defaults to "sum"', () => {
    const widget = createDefaultWidget('kpi');
    expect(widget.kind).toBe('kpi');
    expect(widget.config.kpiAggregation).toBe('sum');
  });

  it('filter: config.filterWidgetType defaults to "multi-select"', () => {
    const widget = createDefaultWidget('filter');
    expect(widget.kind).toBe('filter');
    expect(widget.config.filterWidgetType).toBe('multi-select');
  });

  it('generates a collision-resistant "widget-<timestamp>-..." id (not kind-scoped)', () => {
    // IDs are minted by the shared `createWidgetId()` generator (timestamp + a
    // monotonic counter + a random suffix) rather than embedding the widget kind,
    // so two same-kind widgets created in the same millisecond cannot collide.
    const widget = createDefaultWidget('kpi');
    expect(widget.id).toMatch(/^widget-\d+-/);
  });

  it('custom kind: returns minimal widget with customConfig', () => {
    const widget = createDefaultWidget('alert-banner', {
      title: 'My Alert',
      customConfig: { message: 'Hello', severity: 'info' },
    });
    expect(widget.kind).toBe('alert-banner');
    expect(widget.title).toBe('My Alert');
    expect(widget.config.customConfig).toEqual({ message: 'Hello', severity: 'info' });
  });

  it('overrides.title is used when provided', () => {
    const widget = createDefaultWidget('text', { title: 'Custom title' });
    expect(widget.title).toBe('Custom title');
  });
});

// ─── exportGridToCsv ──────────────────────────────────────────────────────────

describe('exportGridToCsv', () => {
  const source: StudioDataSource = {
    id: 'orders',
    label: 'Orders',
    fields: [{ id: 'id', label: 'Order ID', type: 'string' }],
    rows: [],
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns early without throwing when dataSource is undefined', () => {
    const widget: StudioWidget = { id: 'w1', kind: 'grid', title: 'Orders', config: {} };
    expect(() => exportGridToCsv(widget, undefined, [])).not.toThrow();
  });

  it('triggers a download (creates a link element)', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((el) => el);
    vi.spyOn(document.body, 'removeChild').mockImplementation((el) => el);

    const widget: StudioWidget = { id: 'w1', kind: 'grid', title: 'Orders', config: {} };
    exportGridToCsv(widget, source, [{ id: 'ORD-1' }]);

    expect(appendSpy).toHaveBeenCalledOnce();
  });

  // ─── Filename sanitization (architecture review 3.3) ─────────────────────────
  it('sanitizes non-alphanumeric characters out of the widget title in the download filename', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((el) => el);
    vi.spyOn(document.body, 'removeChild').mockImplementation((el) => el);

    const widget: StudioWidget = { id: 'w1', kind: 'grid', title: 'Q1 Orders/Report!', config: {} };
    exportGridToCsv(widget, source, [{ id: 'ORD-1' }]);

    const link = appendSpy.mock.calls[0][0] as unknown as HTMLAnchorElement;
    expect(link.download).toBe('Q1_Orders_Report__export.csv');
  });
});

describe('downloadCsv', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sanitizes the filename (preserving the extension), used by both the grid and pivot CSV export paths (finding 3.3)', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((el) => el);
    vi.spyOn(document.body, 'removeChild').mockImplementation((el) => el);

    downloadCsv('a,b\n1,2', 'Region: EMEA/Q1.csv');

    const link = appendSpy.mock.calls[0][0] as unknown as HTMLAnchorElement;
    expect(link.download).toBe('Region__EMEA_Q1.csv');
  });
});

// Regression coverage for finding 3.10: a failed SVG-blob `<img>` load had no `onerror`
// handler, so it silently no-oped AND leaked the `URL.createObjectURL` object URL that
// the (never-invoked) `onload` handler would otherwise have revoked.
