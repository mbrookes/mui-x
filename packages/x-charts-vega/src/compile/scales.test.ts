import { compileSpec } from './index';
import { resolveAxes } from './scales';
import { createGapCollector } from '../gaps';
import type { NormalizedUnit } from '../normalize';
import type { DatasetRow, VegaEncoding, VegaMarkDef } from '../types';

/** Build a minimal NormalizedUnit + rows pair for direct resolveAxes tests. */
function makeUnit(
  mark: VegaMarkDef['type'],
  encoding: VegaEncoding,
  rows: readonly DatasetRow[],
  path = '$',
): { unit: NormalizedUnit; rows: readonly DatasetRow[] } {
  return {
    unit: { mark: { type: mark }, encoding, transform: [], rows, path },
    rows,
  };
}

describe('scales & axes', () => {
  describe('band vs point selection (per-channel)', () => {
    it('gives a vertical bar chart a band x axis and a linear y axis', () => {
      const compiled = compileSpec({
        data: {
          values: [
            { c: 'A', v: 1 },
            { c: 'B', v: 2 },
          ],
        },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal' },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect(compiled.xAxis?.config.scaleType).to.equal('band');
      expect(compiled.yAxis?.config.scaleType).to.equal('linear');
    });

    it('BUG FIX: gives a horizontal bar chart a band y axis (nominal y + bar mark)', () => {
      const compiled = compileSpec({
        data: {
          values: [
            { c: 'A', v: 1 },
            { c: 'B', v: 2 },
          ],
        },
        mark: 'bar',
        encoding: {
          x: { field: 'v', type: 'quantitative' },
          y: { field: 'c', type: 'nominal' },
        },
      });
      expect(compiled.yAxis?.config.scaleType).to.equal('band');
      expect(compiled.yAxis?.categories).to.deep.equal(['A', 'B']);
      expect(compiled.xAxis?.config.scaleType).to.equal('linear');
    });

    it('uses a point scale for a nominal channel drawn with a non-bar mark', () => {
      const compiled = compileSpec({
        data: {
          values: [
            { c: 'A', v: 1 },
            { c: 'B', v: 2 },
          ],
        },
        mark: 'line',
        encoding: {
          x: { field: 'c', type: 'nominal' },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect(compiled.xAxis?.config.scaleType).to.equal('point');
    });

    it('selects band when any layer with the channel is a bar mark', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        encoding: { x: { field: 'c', type: 'nominal' } },
        layer: [
          { mark: 'line', encoding: { y: { field: 'v', type: 'quantitative' } } },
          { mark: 'bar', encoding: { y: { field: 'v', type: 'quantitative' } } },
        ],
      });
      expect(compiled.xAxis?.config.scaleType).to.equal('band');
    });

    it('treats a rect mark like a bar for band selection', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'rect',
        encoding: {
          x: { field: 'c', type: 'nominal' },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect(compiled.xAxis?.config.scaleType).to.equal('band');
    });
  });

  describe('explicit scale.type on categorical channels', () => {
    it('lets scale.type: "point" win over the bar-mark band inference', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal', scale: { type: 'point' } },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect(compiled.xAxis?.config.scaleType).to.equal('point');
    });

    it('lets scale.type: "band" win for a non-bar mark', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'line',
        encoding: {
          x: { field: 'c', type: 'nominal', scale: { type: 'band' } },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect(compiled.xAxis?.config.scaleType).to.equal('band');
    });

    it('maps scale.type: "ordinal" to band', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'line',
        encoding: {
          x: { field: 'c', type: 'nominal', scale: { type: 'ordinal' } },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect(compiled.xAxis?.config.scaleType).to.equal('band');
    });
  });

  describe('discrete-axis sort', () => {
    const rows = [
      { c: 'B', v: 2 },
      { c: 'A', v: 1 },
      { c: 'C', v: 3 },
    ];

    it('keeps data order by default', () => {
      const compiled = compileSpec({
        data: { values: rows },
        mark: 'bar',
        encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v' } },
      });
      expect(compiled.xAxis?.categories).to.deep.equal(['B', 'A', 'C']);
    });

    it('sorts ascending lexicographically', () => {
      const compiled = compileSpec({
        data: { values: rows },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal', sort: 'ascending' },
          y: { field: 'v' },
        },
      });
      expect(compiled.xAxis?.categories).to.deep.equal(['A', 'B', 'C']);
    });

    it('sorts descending', () => {
      const compiled = compileSpec({
        data: { values: rows },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal', sort: 'descending' },
          y: { field: 'v' },
        },
      });
      expect(compiled.xAxis?.categories).to.deep.equal(['C', 'B', 'A']);
    });

    it('sorts numeric categories numerically, not lexicographically', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 10 }, { c: 2 }, { c: 1 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'ordinal', sort: 'ascending' },
          y: { aggregate: 'count' },
        },
      });
      expect(compiled.xAxis?.categories).to.deep.equal([1, 2, 10]);
    });

    it('respects an explicit array order and appends unlisted values in data order', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'B' }, { c: 'A' }, { c: 'D' }, { c: 'C' }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal', sort: ['C', 'A'] },
          y: { aggregate: 'count' },
        },
      });
      expect(compiled.xAxis?.categories).to.deep.equal(['C', 'A', 'B', 'D']);
    });

    it('sort: null keeps data order without a gap', () => {
      const compiled = compileSpec({
        data: { values: rows },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal', sort: null },
          y: { field: 'v' },
        },
      });
      expect(compiled.xAxis?.categories).to.deep.equal(['B', 'A', 'C']);
      expect(compiled.gaps.some((g) => g.code === 'scale:sort-by-field')).to.equal(false);
    });

    it('records a partial gap for field/op sort objects and keeps data order', () => {
      const compiled = compileSpec({
        data: { values: rows },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal', sort: { field: 'v', op: 'sum', order: 'descending' } },
          y: { field: 'v' },
        },
      });
      expect(compiled.xAxis?.categories).to.deep.equal(['B', 'A', 'C']);
      const gap = compiled.gaps.find((g) => g.code === 'scale:sort-by-field');
      expect(gap?.severity).to.equal('partial');
    });
  });

  describe('quantitative axis', () => {
    it('applies scale.domain [min, max]', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 5 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal' },
          y: { field: 'v', type: 'quantitative', scale: { domain: [0, 100] } },
        },
      });
      expect((compiled.yAxis?.config as { min?: number }).min).to.equal(0);
      expect((compiled.yAxis?.config as { max?: number }).max).to.equal(100);
    });

    it('maps scale.nice: false to a strict domain limit', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 5 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal' },
          y: { field: 'v', type: 'quantitative', scale: { nice: false } },
        },
      });
      expect(compiled.yAxis?.config.domainLimit).to.equal('strict');
    });

    it('leaves the domain unrestricted for scale.zero: false (no forced min)', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 5 }] },
        mark: 'line',
        encoding: {
          x: { field: 'c', type: 'nominal' },
          y: { field: 'v', type: 'quantitative', scale: { zero: false } },
        },
      });
      expect((compiled.yAxis?.config as { min?: number }).min).to.equal(undefined);
      expect(compiled.yAxis?.config.domainLimit).to.equal(undefined);
    });

    it('sets reverse from scale.reverse', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 5 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal' },
          y: { field: 'v', type: 'quantitative', scale: { reverse: true } },
        },
      });
      expect(compiled.yAxis?.config.reverse).to.equal(true);
    });

    it('maps log/pow/sqrt/symlog scale types', () => {
      for (const type of ['log', 'pow', 'sqrt', 'symlog'] as const) {
        const compiled = compileSpec({
          data: { values: [{ c: 'A', v: 5 }] },
          mark: 'bar',
          encoding: {
            x: { field: 'c', type: 'nominal' },
            y: { field: 'v', type: 'quantitative', scale: { type } },
          },
        });
        expect(compiled.yAxis?.config.scaleType).to.equal(type);
      }
    });

    it('records a partial gap for an untranslatable scale type and falls back to linear', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 5 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal' },
          y: { field: 'v', type: 'quantitative', scale: { type: 'quantile' } },
        },
      });
      expect(compiled.yAxis?.config.scaleType).to.equal('linear');
      expect(compiled.gaps.some((g) => g.code === 'scale:quantile')).to.equal(true);
    });
  });

  describe('axis config enrichment', () => {
    it('derives an axis title from the field, honoring title and title: null', () => {
      const withTitle = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal', title: 'Category' },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect(withTitle.xAxis?.config.label).to.equal('Category');

      const suppressed = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal', axis: { title: null } },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect(suppressed.xAxis?.config.label).to.equal(undefined);
    });

    it('lets axis.title override the field title', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal', title: 'Ignored', axis: { title: 'Axis Title' } },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect(compiled.xAxis?.config.label).to.equal('Axis Title');
    });

    it('maps labelAngle to tickLabelStyle.angle', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal', axis: { labelAngle: 45 } },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect(compiled.xAxis?.config.tickLabelStyle).to.deep.equal({ angle: 45 });
    });

    it('maps tickCount to tickNumber and values to tickInterval', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal' },
          y: { field: 'v', type: 'quantitative', axis: { tickCount: 4, values: [0, 5, 10] } },
        },
      });
      expect(compiled.yAxis?.config.tickNumber).to.equal(4);
      expect(compiled.yAxis?.config.tickInterval).to.deep.equal([0, 5, 10]);
    });

    it('hides tick labels for axis.labels: false via tickLabelStyle display none', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal', axis: { labels: false } },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect(compiled.xAxis?.config.tickLabelStyle).to.deep.equal({ display: 'none' });
    });

    it('records a partial gap for an axis.format string', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal' },
          y: { field: 'v', type: 'quantitative', axis: { format: '.2f' } },
        },
      });
      const gap = compiled.gaps.find((g) => g.code === 'scale:axis-format');
      expect(gap?.severity).to.equal('partial');
    });

    it('maps axis.orient to the axis position', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal', axis: { orient: 'top' } },
          y: { field: 'v', type: 'quantitative', axis: { orient: 'right' } },
        },
      });
      expect((compiled.xAxis?.config as { position?: string }).position).to.equal('top');
      expect((compiled.yAxis?.config as { position?: string }).position).to.equal('right');
    });

    it('ignores an orient that is invalid for the channel', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal', axis: { orient: 'left' } },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect((compiled.xAxis?.config as { position?: string }).position).to.equal(undefined);
    });

    it('hides the axis for axis: null via position none and suppresses its title', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal', axis: null },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect((compiled.xAxis?.config as { position?: string }).position).to.equal('none');
      expect(compiled.xAxis?.config.label).to.equal(undefined);
    });

    it('sets grid flags from axis.grid', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal', axis: { grid: true } },
          y: { field: 'v', type: 'quantitative', axis: { grid: true } },
        },
      });
      expect(compiled.grid).to.deep.equal({ vertical: true, horizontal: true });
    });
  });

  describe('temporal channels', () => {
    const rows = [
      { d: new Date('2020-03-01'), v: 3 },
      { d: new Date('2020-01-01'), v: 1 },
      { d: new Date('2020-02-01'), v: 2 },
    ];

    it('renders a point scale over chronologically sorted dates and records a partial gap', () => {
      const compiled = compileSpec({
        data: { values: rows },
        mark: 'line',
        encoding: {
          x: { field: 'd', type: 'temporal' },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect(compiled.xAxis?.config.scaleType).to.equal('point');
      expect(compiled.xAxis?.categories).to.deep.equal([
        new Date('2020-01-01'),
        new Date('2020-02-01'),
        new Date('2020-03-01'),
      ]);
      const gap = compiled.gaps.find((g) => g.code === 'scale:temporal-point-approximation');
      expect(gap?.severity).to.equal('partial');
    });

    it('uses a band scale for bars over a temporal channel', () => {
      const compiled = compileSpec({
        data: { values: rows },
        mark: 'bar',
        encoding: {
          x: { field: 'd', type: 'temporal' },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect(compiled.xAxis?.config.scaleType).to.equal('band');
    });

    it('keeps data order for temporal sort: null instead of sorting chronologically', () => {
      const compiled = compileSpec({
        data: { values: rows },
        mark: 'line',
        encoding: {
          x: { field: 'd', type: 'temporal', sort: null },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect(compiled.xAxis?.categories).to.deep.equal([
        new Date('2020-03-01'),
        new Date('2020-01-01'),
        new Date('2020-02-01'),
      ]);
    });

    it('applies sort: descending to reverse the temporal domain', () => {
      const compiled = compileSpec({
        data: { values: rows },
        mark: 'line',
        encoding: {
          x: { field: 'd', type: 'temporal', sort: 'descending' },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect(compiled.xAxis?.categories).to.deep.equal([
        new Date('2020-03-01'),
        new Date('2020-02-01'),
        new Date('2020-01-01'),
      ]);
    });
  });

  describe('resolve.scale independence and range channels', () => {
    it('records an unsupported gap for resolve.scale.y: independent', () => {
      const gaps = createGapCollector();
      const units = [
        makeUnit('line', { x: { field: 'c', type: 'nominal' }, y: { field: 'v' } }, [
          { c: 'A', v: 1 },
        ]),
      ];
      resolveAxes(units, gaps, { scale: { y: 'independent' } });
      const gap = gaps.list().find((g) => g.code === 'resolve:independent-scale');
      expect(gap?.severity).to.equal('unsupported');
      expect(gap?.path).to.equal('resolve.scale.y');
    });

    it('does not record the gap for shared scales', () => {
      const gaps = createGapCollector();
      const units = [
        makeUnit('line', { x: { field: 'c', type: 'nominal' }, y: { field: 'v' } }, [
          { c: 'A', v: 1 },
        ]),
      ];
      resolveAxes(units, gaps, { scale: { y: 'shared' } });
      expect(gaps.list().some((g) => g.code === 'resolve:independent-scale')).to.equal(false);
    });

    it('records an unsupported gap for x2/y2 channels', () => {
      const gaps = createGapCollector();
      const rows = [{ a: 1, b: 2, c: 'A' }];
      const units = [
        makeUnit(
          'bar',
          {
            x: { field: 'a', type: 'quantitative' },
            x2: { field: 'b' },
            y: { field: 'c', type: 'nominal' },
          },
          rows,
        ),
      ];
      resolveAxes(units, gaps);
      const gap = gaps.list().find((g) => g.code === 'channel:x2');
      expect(gap?.severity).to.equal('unsupported');
    });
  });

  describe('index alignment contract', () => {
    it('keeps categoryKeys index-aligned with categories after sorting', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'B' }, { c: 'A' }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal', sort: 'ascending' },
          y: { aggregate: 'count' },
        },
      });
      expect(compiled.xAxis?.categories).to.deep.equal(['A', 'B']);
      expect(compiled.xAxis?.categoryKeys).to.deep.equal(['string:A', 'string:B']);
    });
  });
});
