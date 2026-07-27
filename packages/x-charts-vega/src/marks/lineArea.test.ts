import { compileSpec } from '../compile';

describe('compileLineAreaMark', () => {
  it('compiles a simple line mark with data index-aligned to x categories, filling gaps with null', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { day: 'Mon', temp: 10 },
          { day: 'Wed', temp: 14 },
        ],
      },
      mark: 'line',
      encoding: {
        x: { field: 'day', type: 'nominal', sort: null },
        y: { field: 'temp', type: 'quantitative' },
      },
    });

    expect(compiled.xAxis?.categories).to.deep.equal(['Mon', 'Wed']);
    expect(compiled.plots).to.deep.equal(['line']);
    expect(compiled.series).to.have.length(1);
    const series = compiled.series[0] as { type: string; data: unknown[]; area?: boolean };
    expect(series.type).to.equal('line');
    expect(series.area).to.equal(false);
    expect(series.data).to.deep.equal([10, 14]);
  });

  it('produces a null hole when a category has no matching row for the series', () => {
    const compiled = compileSpec({
      data: {
        values: [{ day: 'A', temp: 1 }],
      },
      layer: [
        {
          mark: 'point',
          encoding: {
            x: { field: 'day', type: 'nominal' },
            y: { field: 'temp', type: 'quantitative' },
          },
        },
        {
          data: { values: [{ day: 'B', temp: 2 }] },
          mark: 'line',
          encoding: {
            x: { field: 'day', type: 'nominal' },
            y: { field: 'temp', type: 'quantitative' },
          },
        },
      ],
    });

    // Axis categories come from both layers: ['A', 'B'].
    expect(compiled.xAxis?.categories).to.deep.equal(['A', 'B']);
    const lineSeries = compiled.series.find(
      (entry) => (entry as { type: string }).type === 'line',
    ) as {
      data: unknown[];
    };
    expect(lineSeries.data).to.deep.equal([null, 2]);
  });

  it('mark "area" sets area: true and renders both area and line plots', () => {
    const compiled = compileSpec({
      data: { values: [{ day: 'A', temp: 1 }] },
      mark: 'area',
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative' },
      },
    });
    expect(compiled.plots.slice().sort()).to.deep.equal(['area', 'line']);
    expect((compiled.series[0] as { area: boolean }).area).to.equal(true);
  });

  it('renders a gradient area fill as an SVG linear gradient (no gap)', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { day: 'A', temp: 1 },
          { day: 'B', temp: 3 },
        ],
      },
      mark: {
        type: 'area',
        color: {
          gradient: 'linear',
          stops: [
            { offset: 0, color: 'white' },
            { offset: 1, color: 'darkgreen' },
          ],
        },
      },
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative' },
      },
    } as never);
    // The area fill references an SVG gradient by id, and the gradient carries
    // the spec's stops — no approximation, no gap. A literal opaque-white stop
    // is reinterpreted as a transparent version of the other (solid) stop, so
    // the fade reads as "fade to nothing" against any background rather than
    // painting a literal white patch outside a plain white page.
    const gradientId = (compiled.gradients ?? [])[0]?.id;
    expect(gradientId).to.be.a('string');
    expect((compiled.series[0] as { color?: string }).color).to.equal(`url(#${gradientId})`);
    expect(compiled.gradients?.[0]?.stops).to.deep.equal([
      { offset: 0, color: 'rgba(0, 100, 0, 0)' },
      { offset: 1, color: 'darkgreen' },
    ]);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:gradient-fill');
    expect(gap).to.equal(undefined);
  });

  it('mark "trail" behaves like a line and records a partial gap for width-by-field', () => {
    const compiled = compileSpec({
      data: { values: [{ day: 'A', temp: 1 }] },
      mark: 'trail',
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative' },
      },
    });
    expect(compiled.plots).to.deep.equal(['line']);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:trail-width');
    expect(gap?.severity).to.equal('partial');
  });

  it('splits into one series per color group, respecting explicit domain order', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { day: 'A', temp: 1, city: 'NY' },
          { day: 'A', temp: 5, city: 'LA' },
          { day: 'B', temp: 2, city: 'NY' },
          { day: 'B', temp: 6, city: 'LA' },
        ],
      },
      mark: 'line',
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative' },
        color: {
          field: 'city',
          type: 'nominal',
          scale: { domain: ['LA', 'NY'], range: ['#111', '#222'] },
        },
      },
    });

    expect(compiled.series).to.have.length(2);
    const [first, second] = compiled.series as Array<{
      label?: string;
      data: unknown[];
      color?: string;
    }>;
    expect(first.label).to.equal('LA');
    expect(first.data).to.deep.equal([5, 6]);
    expect(first.color).to.equal('#111');
    expect(second.label).to.equal('NY');
    expect(second.data).to.deep.equal([1, 2]);
    expect(second.color).to.equal('#222');
  });

  it('maps mark.interpolate to the matching CurveType', () => {
    const curveOf = (interpolate: string) => {
      const compiled = compileSpec({
        data: { values: [{ day: 'A', temp: 1 }] },
        mark: { type: 'line', interpolate },
        encoding: {
          x: { field: 'day', type: 'nominal' },
          y: { field: 'temp', type: 'quantitative' },
        },
      });
      return (compiled.series[0] as { curve: string }).curve;
    };
    expect(curveOf('monotone')).to.equal('monotoneX');
    expect(curveOf('natural')).to.equal('natural');
    expect(curveOf('step')).to.equal('step');
    expect(curveOf('step-before')).to.equal('stepBefore');
    expect(curveOf('step-after')).to.equal('stepAfter');
    expect(curveOf('linear')).to.equal('linear');
  });

  it('approximates basis/cardinal/bundle/catmull-rom interpolation with a partial gap', () => {
    const compiled = compileSpec({
      data: { values: [{ day: 'A', temp: 1 }] },
      mark: { type: 'line', interpolate: 'basis' },
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative' },
      },
    });
    expect((compiled.series[0] as { curve: string }).curve).to.equal('catmullRom');
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:interpolate-approximate');
    expect(gap?.severity).to.equal('partial');
  });

  it('mark.point enables showMark and the marks plot; a styling object is an ignored gap', () => {
    const compiled = compileSpec({
      data: { values: [{ day: 'A', temp: 1 }] },
      mark: { type: 'line', point: { size: 100, filled: false } },
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative' },
      },
    });
    expect(compiled.plots.slice().sort()).to.deep.equal(['line', 'marks']);
    expect((compiled.series[0] as { showMark: boolean }).showMark).to.equal(true);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:point-styling');
    expect(gap?.severity).to.equal('ignored');
  });

  it('mark.point false leaves showMark false and does not add the marks plot', () => {
    const compiled = compileSpec({
      data: { values: [{ day: 'A', temp: 1 }] },
      mark: 'line',
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative' },
      },
    });
    expect(compiled.plots).to.deep.equal(['line']);
    expect((compiled.series[0] as { showMark: boolean }).showMark).to.equal(false);
  });

  it('stacks an area mark with a color split by default (stack: zero) even without an explicit y.stack', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { day: 'A', temp: 1, city: 'NY' },
          { day: 'A', temp: 5, city: 'LA' },
        ],
      },
      mark: 'area',
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative' },
        color: { field: 'city', type: 'nominal' },
      },
    });
    const [first, second] = compiled.series as Array<{ stack?: string; stackOffset?: string }>;
    expect(first.stack).to.be.a('string').and.not.equal('');
    expect(first.stack).to.equal(second.stack);
    expect(first.stackOffset).to.equal('none');
  });

  it("reverses the stack draw order for a data-derived color domain (Vega's descending-by-value sort)", () => {
    const compiled = compileSpec({
      data: {
        values: [
          { day: 'A', temp: 1, city: 'NY' },
          { day: 'A', temp: 5, city: 'LA' },
        ],
      },
      mark: 'area',
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative' },
        color: { field: 'city', type: 'nominal' },
      },
    });
    const series = compiled.series as Array<{ stackOrder?: string }>;
    expect(series.every((s) => s.stackOrder === 'reverse')).to.equal(true);
  });

  it('does not reverse the stack for an explicit, custom-ordered color domain, and reports a gap', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { day: 'A', temp: 1, city: 'NY' },
          { day: 'A', temp: 5, city: 'LA' },
        ],
      },
      mark: 'area',
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative' },
        color: {
          field: 'city',
          type: 'nominal',
          scale: { domain: ['NY', 'LA'], range: ['#111111', '#222222'] },
        },
      },
    });
    const series = compiled.series as Array<{ stackOrder?: string }>;
    expect(series.every((s) => s.stackOrder === undefined)).to.equal(true);
    expect(compiled.gaps.map((gap) => gap.code)).to.include('mark:stack-order-explicit-domain');
  });

  it('maps y.stack normalize/center to expand/silhouette stackOffset', () => {
    const specFor = (stack: 'normalize' | 'center' | null) =>
      compileSpec({
        data: {
          values: [
            { day: 'A', temp: 1, city: 'NY' },
            { day: 'A', temp: 5, city: 'LA' },
          ],
        },
        mark: 'area',
        encoding: {
          x: { field: 'day', type: 'nominal' },
          y: { field: 'temp', type: 'quantitative', stack },
          color: { field: 'city', type: 'nominal' },
        },
      });

    const normalized = specFor('normalize').series[0] as { stackOffset?: string };
    expect(normalized.stackOffset).to.equal('expand');

    const centered = specFor('center').series[0] as { stackOffset?: string };
    expect(centered.stackOffset).to.equal('silhouette');

    const unstacked = specFor(null).series[0] as { stack?: string; stackOffset?: string };
    expect(unstacked.stack).to.equal(undefined);
    expect(unstacked.stackOffset).to.equal(undefined);
  });

  it('lines default to unstacked even with a color split', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { day: 'A', temp: 1, city: 'NY' },
          { day: 'A', temp: 5, city: 'LA' },
        ],
      },
      mark: 'line',
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative' },
        color: { field: 'city', type: 'nominal' },
      },
    });
    const [first] = compiled.series as Array<{ stack?: string }>;
    expect(first.stack).to.equal(undefined);
  });

  it('wires mark.strokeWidth and mark.strokeDash into compiled.lineStyle and emits no gap', () => {
    const compiled = compileSpec({
      data: { values: [{ day: 'A', temp: 1 }] },
      mark: { type: 'line', strokeDash: [4, 2], strokeWidth: 5 },
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative' },
      },
    });
    const codes = compiled.gaps.map((gap) => gap.code);
    expect(codes).not.to.include('mark:strokeDash');
    expect(codes).not.to.include('mark:strokeWidth');
    const series = compiled.series[0] as unknown as { id: string };
    expect(compiled.lineStyle?.[series.id]).to.deep.equal({
      strokeWidth: 5,
      strokeDasharray: '4 2',
    });
  });

  it('does not set lineStyle or report an opacity gap when no stroke styling is present', () => {
    const compiled = compileSpec({
      data: { values: [{ day: 'A', temp: 1 }] },
      mark: { type: 'line', opacity: 0.5 },
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative' },
      },
    });
    const codes = compiled.gaps.map((gap) => gap.code);
    expect(codes).not.to.include('mark:opacity');
    expect(codes).not.to.include('encoding:opacity');
    expect(compiled.lineStyle).to.equal(undefined);
  });

  it('still reports strokeOpacity as an ignored gap (no separate stroke alpha)', () => {
    const compiled = compileSpec({
      data: { values: [{ day: 'A', temp: 1 }] },
      mark: { type: 'line', strokeOpacity: 0.4 },
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative' },
      },
    });
    const gap = compiled.gaps.find((entry) => entry.code === 'encoding:opacity');
    expect(gap?.severity).to.equal('ignored');
  });

  it('always sets connectNulls: false and reports impute as an unsupported gap', () => {
    const compiled = compileSpec({
      data: { values: [{ day: 'A', temp: 1 }] },
      mark: 'line',
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative', impute: { value: 0 } },
      },
    });
    expect((compiled.series[0] as { connectNulls: boolean }).connectNulls).to.equal(false);
    const gap = compiled.gaps.find((entry) => entry.code === 'encoding:impute');
    expect(gap?.severity).to.equal('unsupported');
  });

  it('uses a static color from mark.stroke when there is no color encoding', () => {
    const compiled = compileSpec({
      data: { values: [{ day: 'A', temp: 1 }] },
      mark: { type: 'line', stroke: '#abcdef' },
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative' },
      },
    });
    expect((compiled.series[0] as { color?: string }).color).to.equal('#abcdef');
  });

  it('renders a line over a continuous quantitative x axis as a segments overlay', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { a: 2, b: 4 },
          { a: 1, b: 2 },
          { a: 3, b: 9 },
        ],
      },
      mark: 'line',
      encoding: {
        x: { field: 'a', type: 'quantitative' },
        y: { field: 'b', type: 'quantitative' },
      },
    });
    // No line series (no index-aligned category domain) and no gap: the layer
    // becomes a polyline through the segments overlay instead of being dropped.
    expect(compiled.series).to.have.length(0);
    expect(compiled.gaps.find((entry) => entry.code === 'mark:line-continuous-x')).to.equal(
      undefined,
    );
    const segments = compiled.overlays.find((overlay) => overlay.kind === 'segments');
    if (!segments || segments.kind !== 'segments') {
      throw new Error('expected a segments overlay');
    }
    // Points are x-sorted before connecting: (1,2)→(2,4)→(3,9) = two segments.
    expect(segments.items).to.have.length(2);
    expect(segments.items[0]).to.include({ x1: 1, y1: 2, x2: 2, y2: 4 });
    // x-charts has no line series over a continuous x axis — this must still
    // surface as an ignored, x-charts-origin gap (a real limitation, not a
    // silently-native render), even though the layer isn't dropped.
    const overlayGap = compiled.gaps.find(
      (entry) => entry.code === 'mark:line-continuous-x-custom-overlay',
    );
    expect(overlayGap?.severity).to.equal('ignored');
    expect(overlayGap?.origin).to.equal('x-charts');
  });

  it('renders a line over continuous x with a categorical y as a segments overlay (bump chart)', () => {
    // line_bump's shape: continuous x (build number), nominal y (PASSED/
    // FAILED/SKIPPED) — the mirror image of the usual index-aligned-x case.
    const compiled = compileSpec({
      data: {
        values: [
          { build: 1, result: 'PASSED' },
          { build: 2, result: 'FAILED' },
          { build: 3, result: 'PASSED' },
        ],
      },
      mark: { type: 'line', point: true },
      encoding: {
        x: { field: 'build', type: 'quantitative' },
        y: { field: 'result', type: 'nominal' },
      },
    });
    expect(compiled.series).to.have.length(0);
    expect(compiled.gaps.find((entry) => entry.code === 'mark:line-continuous-x')).to.equal(
      undefined,
    );
    const segments = compiled.overlays.find((overlay) => overlay.kind === 'segments');
    if (!segments || segments.kind !== 'segments') {
      throw new Error('expected a segments overlay');
    }
    expect(segments.items).to.have.length(2);
    // y keeps the raw category value — resolved to a pixel position by the
    // band scale at render time (scalePosition already centers within it).
    expect(segments.items[0]).to.include({ x1: 1, y1: 'PASSED', x2: 2, y2: 'FAILED' });
    expect(segments.items[1]).to.include({ x1: 2, y1: 'FAILED', x2: 3, y2: 'PASSED' });
  });

  it("reads its OWN field, not a sibling layer's, when the shared x axis was resolved from a different field name", () => {
    // layer_falkensee's shape: a rect layer defines x from `start` (first,
    // so it "wins" AxisResolution.field); a sibling line layer defines x from
    // a DIFFERENT raw field, `year` — each gets its own distinctly-named
    // synthetic `__timeUnit_...` column post-transform. The line mark must
    // read ITS OWN column, not the rect's, or every row looks up an
    // undefined key and the whole series silently goes all-null.
    const compiled = compileSpec({
      layer: [
        {
          data: { values: [{ start: '1933', end: '1945', event: 'X' }] },
          mark: 'rect',
          encoding: {
            x: { field: 'start', timeUnit: 'year' },
            x2: { field: 'end', timeUnit: 'year' },
            color: { field: 'event', type: 'nominal' },
          },
        },
        {
          data: {
            values: [
              { year: '1875', population: 1309 },
              { year: '1890', population: 1558 },
            ],
          },
          mark: 'line',
          encoding: {
            x: { field: 'year', timeUnit: 'year' },
            y: { field: 'population', type: 'quantitative' },
          },
        },
      ],
    });
    const line = compiled.series.find((entry) => (entry as { type?: string }).type === 'line') as
      { data?: Array<number | null> } | undefined;
    expect(line?.data).to.not.include(undefined);
    expect(line?.data?.filter((value) => value != null)).to.deep.equal([1309, 1558]);
  });

  it('gives sibling continuous-x line layers distinct colors and a legend when they share one color field', () => {
    // layer_line_window's shape: two sibling `line` layers, each `calculate`-ing
    // its OWN constant value for the color field ("system") from its own
    // dataset — no single layer's rows ever carry more than one distinct
    // value, so each layer's local color-domain resolution previously landed
    // on index 0 and both lines rendered identically, with no legend at all.
    const compiled = compileSpec({
      encoding: {
        x: { field: 'row', type: 'quantitative' },
        y: { field: 'value', type: 'quantitative' },
        color: { field: 'system', type: 'nominal' },
      },
      layer: [
        {
          data: { values: [{ value: 1 }, { value: 2 }] },
          transform: [
            { window: [{ op: 'row_number', as: 'row' }] },
            { calculate: "'Falcon'", as: 'system' },
          ],
          mark: 'line',
        },
        {
          data: { values: [{ value: 3 }, { value: 4 }] },
          transform: [
            { window: [{ op: 'row_number', as: 'row' }] },
            { calculate: "'Square'", as: 'system' },
          ],
          mark: 'line',
        },
      ],
    });
    const segmentOverlays = compiled.overlays.filter(
      (overlay): overlay is Extract<typeof overlay, { kind: 'segments' }> =>
        overlay.kind === 'segments',
    );
    expect(segmentOverlays).to.have.length(2);
    const colors = segmentOverlays.map((overlay) => overlay.items[0]?.style?.stroke);
    expect(colors[0]).to.not.equal(colors[1]);
    expect(compiled.overlayLegend).to.deep.equal([
      { label: 'Falcon', color: colors[0] },
      { label: 'Square', color: colors[1] },
    ]);
  });

  it('pins the y domain to include 0 for a continuous-x line, matching a native line series default', () => {
    // Vega-Lite's `zero: true` default applies to line/area marks regardless
    // of how x-charts ends up rendering them; a continuous-x line renders
    // through a `segments` overlay (no native `line` series for
    // `applyOverlayDomains`'s existing check to see), so it needs its own
    // `lineMarkZeroBaseline` flag to still get the zero pin (`layer_point_
    // line_regression`'s y-axis previously started at the data min, ~2,
    // instead of 0 like the reference).
    const compiled = compileSpec({
      data: {
        values: [
          { a: 10, b: 5 },
          { a: 20, b: 6 },
          { a: 30, b: 8 },
        ],
      },
      mark: 'line',
      encoding: {
        x: { field: 'a', type: 'quantitative' },
        y: { field: 'b', type: 'quantitative' },
      },
    });
    expect((compiled.yAxis?.config as { min?: number }).min).to.equal(0);
  });

  it('does not pin a log-scaled y domain to 0 (log(0) is undefined)', () => {
    // layer_line_window's shape: a continuous-x line over a log-scaled y.
    // Vega-Lite requires `zero: false` for a log scale (it can never include
    // 0), so the zero-baseline default from the test above must not apply
    // here — pinning `min` to 0 fed an invalid [0, max] domain straight into
    // d3's log scale, degenerating to a totally blank chart.
    const compiled = compileSpec({
      data: {
        values: [
          { a: 1, b: 50 },
          { a: 2, b: 20 },
          { a: 3, b: 80 },
        ],
      },
      mark: 'line',
      encoding: {
        x: { field: 'a', type: 'quantitative' },
        y: { field: 'b', type: 'quantitative', scale: { type: 'log' } },
      },
    });
    const config = compiled.yAxis?.config as { min?: number; scaleType?: string };
    expect(config.scaleType).to.equal('log');
    expect(config.min).to.be.greaterThan(0);
  });

  it('renders an area mark over a continuous quantitative x axis as a band overlay', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { a: 2, b: 4 },
          { a: 1, b: 2 },
          { a: 3, b: 9 },
        ],
      },
      mark: 'area',
      encoding: {
        x: { field: 'a', type: 'quantitative' },
        y: { field: 'b', type: 'quantitative' },
      },
    });
    // No area series (no index-aligned category domain) and no gap: the layer
    // becomes a filled band overlay instead of being dropped.
    expect(compiled.series).to.have.length(0);
    expect(compiled.gaps.find((entry) => entry.code === 'mark:line-continuous-x')).to.equal(
      undefined,
    );
    const band = compiled.overlays.find((overlay) => overlay.kind === 'band');
    if (!band || band.kind !== 'band') {
      throw new Error('expected a band overlay');
    }
    // Upper edge is the y value, lower edge is the zero baseline; x-sorted.
    expect(band.orientation).to.equal('vertical');
    expect(band.points).to.deep.equal([
      { x: 1, lower: 0, upper: 2 },
      { x: 2, lower: 0, upper: 4 },
      { x: 3, lower: 0, upper: 9 },
    ]);
    // x-charts has no area series over a continuous x axis — this must still
    // surface as an ignored, x-charts-origin gap.
    const overlayGap = compiled.gaps.find(
      (entry) => entry.code === 'mark:area-continuous-x-custom-overlay',
    );
    expect(overlayGap?.severity).to.equal('ignored');
    expect(overlayGap?.origin).to.equal('x-charts');
  });

  it('splits a continuous-x area into one band overlay per color group', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { a: 1, b: 2, city: 'NY' },
          { a: 2, b: 4, city: 'NY' },
          { a: 1, b: 3, city: 'LA' },
          { a: 2, b: 6, city: 'LA' },
        ],
      },
      mark: 'area',
      encoding: {
        x: { field: 'a', type: 'quantitative' },
        y: { field: 'b', type: 'quantitative' },
        color: { field: 'city', type: 'nominal' },
      },
    });
    const bands = compiled.overlays.filter((overlay) => overlay.kind === 'band');
    expect(bands).to.have.length(2);
  });

  it('drops a continuous-x area with fewer than two points per group with a gap', () => {
    const compiled = compileSpec({
      data: { values: [{ a: 1, b: 2 }] },
      mark: 'area',
      encoding: {
        x: { field: 'a', type: 'quantitative' },
        y: { field: 'b', type: 'quantitative' },
      },
    });
    expect(compiled.overlays).to.have.length(0);
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:line-continuous-x');
    expect(gap?.severity).to.equal('unsupported');
  });

  it('labels a line from a constant color: {datum} encoding, as a `repeat` layer produces', () => {
    const compiled = compileSpec({
      data: { values: [{ day: 'A', temp: 1 }] },
      mark: 'line',
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative' },
        color: { datum: 'AAPL', type: 'nominal' },
      },
    });
    expect(compiled.series).to.have.length(1);
    expect((compiled.series[0] as { label?: string }).label).to.equal('AAPL');
  });

  it('labels a line from a constant stroke: {datum} encoding just as color: {datum} does', () => {
    const compiled = compileSpec({
      data: { values: [{ day: 'A', temp: 1 }] },
      mark: 'line',
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative' },
        stroke: { datum: 'AAPL', type: 'nominal' },
      },
    });
    expect(compiled.series).to.have.length(1);
    expect((compiled.series[0] as { label?: string }).label).to.equal('AAPL');
  });

  describe('geo-projected (longitude/latitude) lines', () => {
    it('draws a geoSegments overlay connecting rows in `order` (geo_line-shaped)', () => {
      const compiled = compileSpec({
        projection: { type: 'albersUsa' },
        data: {
          values: [
            { airport: 'SEA', order: 1, lon: -122.3, lat: 47.4 },
            { airport: 'SFO', order: 2, lon: -122.4, lat: 37.6 },
            { airport: 'LAX', order: 3, lon: -118.4, lat: 33.9 },
          ],
        },
        mark: 'line',
        encoding: {
          longitude: { field: 'lon', type: 'quantitative' },
          latitude: { field: 'lat', type: 'quantitative' },
          order: { field: 'order' },
        },
      });
      const overlay = compiled.overlays.find((entry) => entry.kind === 'geoSegments') as
        Extract<(typeof compiled.overlays)[number], { kind: 'geoSegments' }> | undefined;
      // 3 ordered points -> 2 consecutive segments.
      expect(overlay?.items).to.deep.equal([
        { lon1: -122.3, lat1: 47.4, lon2: -122.4, lat2: 37.6, style: overlay?.items[0].style },
        { lon1: -122.4, lat1: 37.6, lon2: -118.4, lat2: 33.9, style: overlay?.items[1].style },
      ]);
      expect(compiled.gaps.map((gap) => gap.code)).to.include(
        'mark:line-geo-projected-custom-overlay',
      );
    });

    it('connects rows out of their input order, following the `order` field', () => {
      const compiled = compileSpec({
        projection: { type: 'albersUsa' },
        data: {
          values: [
            { order: 2, lon: 2, lat: 2 },
            { order: 1, lon: 1, lat: 1 },
          ],
        },
        mark: 'line',
        encoding: {
          longitude: { field: 'lon', type: 'quantitative' },
          latitude: { field: 'lat', type: 'quantitative' },
          order: { field: 'order' },
        },
      });
      const overlay = compiled.overlays.find((entry) => entry.kind === 'geoSegments') as
        Extract<(typeof compiled.overlays)[number], { kind: 'geoSegments' }> | undefined;
      expect(overlay?.items).to.deep.equal([
        { lon1: 1, lat1: 1, lon2: 2, lat2: 2, style: overlay?.items[0].style },
      ]);
    });

    it('reports mark:line-geo-missing-fields and drops the layer when fewer than two rows resolve', () => {
      const compiled = compileSpec({
        projection: { type: 'albersUsa' },
        data: { values: [{ lon: 1, lat: 1 }] },
        mark: 'line',
        encoding: {
          longitude: { field: 'lon', type: 'quantitative' },
          latitude: { field: 'lat', type: 'quantitative' },
        },
      });
      expect(compiled.overlays).to.have.length(0);
      expect(compiled.gaps.map((gap) => gap.code)).to.include('mark:line-geo-missing-fields');
    });
  });

  describe('detail channel', () => {
    const rows = [
      { key: 'a', v: 1, id: 1, g: 'X' },
      { key: 'b', v: 2, id: 1, g: 'X' },
      { key: 'a', v: 3, id: 2, g: 'X' },
      { key: 'b', v: 4, id: 2, g: 'X' },
      { key: 'a', v: 5, id: 3, g: 'Y' },
      { key: 'b', v: 6, id: 3, g: 'Y' },
    ];

    it('splits a line into one series per detail value, crossed with the color split', () => {
      // `parallel_coordinate`-shaped: one line per record (`detail`), coloured
      // by a separate grouping field. Grouping on colour alone collapsed ~340
      // penguin lines into 3.
      const compiled = compileSpec({
        data: { values: rows },
        mark: 'line',
        encoding: {
          x: { field: 'key', type: 'nominal' },
          y: { field: 'v', type: 'quantitative' },
          color: { field: 'g', type: 'nominal' },
          detail: { field: 'id', type: 'nominal' },
        },
      } as never);
      // Three (colour, detail) pairs: (X,1), (X,2), (Y,3).
      expect(compiled.series).to.have.length(3);
      // `detail` contributes no legend entries of its own — one label per colour.
      const labels = compiled.series.map((s) => (s as { label?: string }).label);
      expect(labels.filter(Boolean)).to.deep.equal(['X', 'Y']);
      // Every line of a colour group shares that group's colour, and it is
      // explicit: the per-series auto-assignment would otherwise give each of
      // them its own.
      const colors = compiled.series.map((s) => (s as { color?: string }).color);
      expect(colors[0]).to.equal(colors[1]);
      expect(colors[0]).to.not.equal(undefined);
      expect(colors[2]).to.not.equal(colors[0]);
    });

    it('splits on detail alone when there is no color encoding', () => {
      const compiled = compileSpec({
        data: { values: rows },
        mark: 'line',
        encoding: {
          x: { field: 'key', type: 'nominal' },
          y: { field: 'v', type: 'quantitative' },
          detail: { field: 'id', type: 'nominal' },
        },
      } as never);
      expect(compiled.series).to.have.length(3);
    });

    it('ignores an aggregate-only detail that names no field', () => {
      // `{detail: {aggregate: "count"}}` groups nothing (parallel_coordinate's
      // axis-rule layer uses it purely to collapse rows).
      const compiled = compileSpec({
        data: { values: rows },
        mark: 'line',
        encoding: {
          x: { field: 'key', type: 'nominal' },
          y: { field: 'v', type: 'quantitative' },
          detail: { aggregate: 'count' },
        },
      } as never);
      expect(compiled.series).to.have.length(1);
    });
  });
});
