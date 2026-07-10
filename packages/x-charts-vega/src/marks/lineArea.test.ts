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

  it('approximates a gradient area fill by its last stop and reports an ignored gap', () => {
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
    // The solid fill approximates the gradient with its highest-offset stop.
    expect((compiled.series[0] as { color?: string }).color).to.equal('darkgreen');
    const gap = compiled.gaps.find((entry) => entry.code === 'mark:gradient-fill');
    expect(gap?.severity).to.equal('ignored');
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

  it('wires mark.strokeWidth and mark.strokeDash onto the series sx and emits no gap', () => {
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
    const series = compiled.series[0] as unknown as { id: string; sx: Record<string, unknown> };
    const selector = `.MuiLineElement-root[data-series-id="${series.id}"]`;
    expect(series.sx[selector]).to.deep.equal({ strokeWidth: 5, strokeDasharray: '4 2' });
  });

  it('does not set an sx or report an opacity gap when no stroke styling is present', () => {
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
    expect((compiled.series[0] as { sx?: unknown }).sx).to.equal(undefined);
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
});
