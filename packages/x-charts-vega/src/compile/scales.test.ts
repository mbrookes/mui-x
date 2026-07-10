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

  describe('band padding', () => {
    it('maps scale.paddingInner to categoryGapRatio with a partial gap', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal', scale: { paddingInner: 0.3 } },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect((compiled.xAxis?.config as { categoryGapRatio?: number }).categoryGapRatio).to.equal(
        0.3,
      );
      const gap = compiled.gaps.find((g) => g.code === 'scale:band-padding');
      expect(gap?.severity).to.equal('partial');
    });

    it('falls back to scale.padding when paddingInner is absent', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal', scale: { padding: 0.25 } },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect((compiled.xAxis?.config as { categoryGapRatio?: number }).categoryGapRatio).to.equal(
        0.25,
      );
    });

    it('reports a partial gap for paddingOuter alone (no categoryGapRatio)', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal', scale: { paddingOuter: 0.4 } },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect((compiled.xAxis?.config as { categoryGapRatio?: number }).categoryGapRatio).to.equal(
        undefined,
      );
      expect(compiled.gaps.some((g) => g.code === 'scale:band-padding')).to.equal(true);
    });

    it('does not set categoryGapRatio on a point scale', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'line',
        encoding: {
          x: { field: 'c', type: 'nominal', scale: { paddingInner: 0.3 } },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect(compiled.xAxis?.config.scaleType).to.equal('point');
      expect((compiled.xAxis?.config as { categoryGapRatio?: number }).categoryGapRatio).to.equal(
        undefined,
      );
      expect(compiled.gaps.some((g) => g.code === 'scale:band-padding')).to.equal(false);
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

    it('defaults numeric discrete categories to ascending order (no explicit sort)', () => {
      // An ordinal numeric field (e.g. `Cylinders` on a heatmap) has no
      // meaningful first-seen order; it should come out ascending, not scrambled.
      const compiled = compileSpec({
        data: {
          values: [
            { c: 8, v: 1 },
            { c: 4, v: 2 },
            { c: 6, v: 3 },
            { c: 3, v: 4 },
          ],
        },
        mark: 'rect',
        encoding: { x: { field: 'c', type: 'ordinal' }, y: { field: 'g', type: 'nominal' } },
      });
      expect(compiled.xAxis?.categories).to.deep.equal([3, 4, 6, 8]);
    });

    it('keeps string discrete categories in first-seen order by default', () => {
      // String categories often carry a deliberate semantic order (e.g. weather
      // sun/fog/drizzle/rain/snow), so data order is preserved, not alphabetized.
      const compiled = compileSpec({
        data: {
          values: [
            { c: 'sun', v: 1 },
            { c: 'fog', v: 2 },
            { c: 'rain', v: 3 },
          ],
        },
        mark: 'bar',
        encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v' } },
      });
      expect(compiled.xAxis?.categories).to.deep.equal(['sun', 'fog', 'rain']);
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

    it('maps scale.nice: true to a nice domain limit (no gap)', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 5 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal' },
          y: { field: 'v', type: 'quantitative', scale: { nice: true } },
        },
      });
      expect(compiled.yAxis?.config.domainLimit).to.equal('nice');
      expect(compiled.gaps.some((g) => g.code === 'scale:nice-count')).to.equal(false);
    });

    it('maps a numeric scale.nice to nice rounding with a partial tick-count gap', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 5 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal' },
          y: { field: 'v', type: 'quantitative', scale: { nice: 10 } },
        },
      });
      expect(compiled.yAxis?.config.domainLimit).to.equal('nice');
      const gap = compiled.gaps.find((g) => g.code === 'scale:nice-count');
      expect(gap?.severity).to.equal('partial');
    });

    it('maps scale.constant to the symlog axis constant', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 5 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal' },
          y: { field: 'v', type: 'quantitative', scale: { type: 'symlog', constant: 2 } },
        },
      });
      expect(compiled.yAxis?.config.scaleType).to.equal('symlog');
      expect((compiled.yAxis?.config as { constant?: number }).constant).to.equal(2);
    });

    it('ignores scale.constant on a non-symlog scale', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 5 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal' },
          y: { field: 'v', type: 'quantitative', scale: { constant: 2 } },
        },
      });
      expect((compiled.yAxis?.config as { constant?: number }).constant).to.equal(undefined);
    });

    it('pins min to 0 for scale.zero over all-positive data (partial gap)', () => {
      const compiled = compileSpec({
        data: {
          values: [
            { c: 'A', v: 5 },
            { c: 'B', v: 9 },
          ],
        },
        mark: 'line',
        encoding: {
          x: { field: 'c', type: 'nominal' },
          y: { field: 'v', type: 'quantitative', scale: { zero: true } },
        },
      });
      expect((compiled.yAxis?.config as { min?: number }).min).to.equal(0);
      expect((compiled.yAxis?.config as { max?: number }).max).to.equal(undefined);
      const gap = compiled.gaps.find((g) => g.code === 'scale:zero-approximation');
      expect(gap?.severity).to.equal('partial');
    });

    it('pins max to 0 for scale.zero over all-negative data', () => {
      const compiled = compileSpec({
        data: {
          values: [
            { c: 'A', v: -5 },
            { c: 'B', v: -9 },
          ],
        },
        mark: 'line',
        encoding: {
          x: { field: 'c', type: 'nominal' },
          y: { field: 'v', type: 'quantitative', scale: { zero: true } },
        },
      });
      expect((compiled.yAxis?.config as { max?: number }).max).to.equal(0);
      expect((compiled.yAxis?.config as { min?: number }).min).to.equal(undefined);
    });

    it('does not force a bound (or gap) for scale.zero over data straddling zero', () => {
      const compiled = compileSpec({
        data: {
          values: [
            { c: 'A', v: -5 },
            { c: 'B', v: 9 },
          ],
        },
        mark: 'line',
        encoding: {
          x: { field: 'c', type: 'nominal' },
          y: { field: 'v', type: 'quantitative', scale: { zero: true } },
        },
      });
      expect((compiled.yAxis?.config as { min?: number }).min).to.equal(undefined);
      expect((compiled.yAxis?.config as { max?: number }).max).to.equal(undefined);
      expect(compiled.gaps.some((g) => g.code === 'scale:zero-approximation')).to.equal(false);
    });

    it('lets an explicit scale.domain win over the scale.zero pin', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 5 }] },
        mark: 'line',
        encoding: {
          x: { field: 'c', type: 'nominal' },
          y: { field: 'v', type: 'quantitative', scale: { zero: true, domain: [2, 20] } },
        },
      });
      expect((compiled.yAxis?.config as { min?: number }).min).to.equal(2);
      expect((compiled.yAxis?.config as { max?: number }).max).to.equal(20);
      expect(compiled.gaps.some((g) => g.code === 'scale:zero-approximation')).to.equal(false);
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

    it('disables tick marks for axis.ticks: false', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal', axis: { ticks: false } },
          y: { field: 'v', type: 'quantitative', axis: { ticks: false } },
        },
      });
      expect((compiled.xAxis?.config as { disableTicks?: boolean }).disableTicks).to.equal(true);
      expect((compiled.yAxis?.config as { disableTicks?: boolean }).disableTicks).to.equal(true);
    });

    it('disables the axis line for axis.domain: false', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal', axis: { domain: false } },
          y: { field: 'v', type: 'quantitative', axis: { domain: false } },
        },
      });
      expect((compiled.xAxis?.config as { disableLine?: boolean }).disableLine).to.equal(true);
      expect((compiled.yAxis?.config as { disableLine?: boolean }).disableLine).to.equal(true);
    });

    it('leaves tick/line toggles unset when axis.ticks/axis.domain are not false', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal', axis: { ticks: true, domain: true } },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect((compiled.xAxis?.config as { disableTicks?: boolean }).disableTicks).to.equal(
        undefined,
      );
      expect((compiled.xAxis?.config as { disableLine?: boolean }).disableLine).to.equal(undefined);
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
    const sortedDates = [new Date('2020-01-01'), new Date('2020-02-01'), new Date('2020-03-01')];

    it('renders a continuous time scale over chronologically sorted dates with no fallback gap', () => {
      const compiled = compileSpec({
        data: { values: rows },
        mark: 'line',
        encoding: {
          x: { field: 'd', type: 'temporal' },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect(compiled.xAxis?.config.scaleType).to.equal('time');
      // The axis `data` (which x-charts indexes into to position points) is the
      // chronologically sorted Date domain.
      expect((compiled.xAxis?.config as { data?: unknown[] }).data).to.deep.equal(sortedDates);
      // categories/categoryKeys stay populated + index-aligned for the marks.
      expect(compiled.xAxis?.categories).to.deep.equal(sortedDates);
      expect(compiled.xAxis?.categoryKeys).to.have.length(3);
      expect(compiled.gaps.some((g) => g.code === 'scale:temporal-point-approximation')).to.equal(
        false,
      );
    });

    it('maps scale.type "utc" to a utc scale (no fallback gap)', () => {
      const compiled = compileSpec({
        data: { values: rows },
        mark: 'line',
        encoding: {
          x: { field: 'd', type: 'temporal', scale: { type: 'utc' } },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect(compiled.xAxis?.config.scaleType).to.equal('utc');
      expect(compiled.gaps.some((g) => g.code === 'scale:temporal-point-approximation')).to.equal(
        false,
      );
    });

    it('coerces scale.domain date strings to Date min/max on the continuous scale', () => {
      const compiled = compileSpec({
        data: { values: rows },
        mark: 'line',
        encoding: {
          x: { field: 'd', type: 'temporal', scale: { domain: ['2020-01-01', '2020-04-01'] } },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      const config = compiled.xAxis?.config as { min?: Date; max?: Date };
      expect(config.min).to.be.instanceOf(Date);
      expect(config.max).to.be.instanceOf(Date);
      expect(config.min?.getTime()).to.equal(new Date('2020-01-01').getTime());
      expect(config.max?.getTime()).to.equal(new Date('2020-04-01').getTime());
    });

    it('falls back to a band scale (with a gap) for bars over a temporal channel', () => {
      const compiled = compileSpec({
        data: { values: rows },
        mark: 'bar',
        encoding: {
          x: { field: 'd', type: 'temporal' },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect(compiled.xAxis?.config.scaleType).to.equal('band');
      const gap = compiled.gaps.find((g) => g.code === 'scale:temporal-point-approximation');
      expect(gap?.severity).to.equal('partial');
    });

    it('falls back to discrete (with a gap) when any layer draws bars over the temporal channel', () => {
      const compiled = compileSpec({
        data: { values: rows },
        encoding: { x: { field: 'd', type: 'temporal' } },
        layer: [
          { mark: 'line', encoding: { y: { field: 'v', type: 'quantitative' } } },
          { mark: 'bar', encoding: { y: { field: 'v', type: 'quantitative' } } },
        ],
      });
      expect(compiled.xAxis?.config.scaleType).to.equal('band');
      expect(compiled.gaps.some((g) => g.code === 'scale:temporal-point-approximation')).to.equal(
        true,
      );
    });

    it('falls back to a discrete scale (with a gap) for a boxplot over a temporal channel', () => {
      const compiled = compileSpec({
        data: { values: rows },
        mark: 'boxplot',
        encoding: {
          x: { field: 'd', type: 'temporal' },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect(compiled.xAxis?.config.scaleType).to.not.equal('time');
      expect(compiled.gaps.some((g) => g.code === 'scale:temporal-point-approximation')).to.equal(
        true,
      );
    });

    it('lets an explicit scale.type "point" force the discrete fallback (with a gap)', () => {
      const compiled = compileSpec({
        data: { values: rows },
        mark: 'line',
        encoding: {
          x: { field: 'd', type: 'temporal', scale: { type: 'point' } },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect(compiled.xAxis?.config.scaleType).to.equal('point');
      expect(compiled.gaps.some((g) => g.code === 'scale:temporal-point-approximation')).to.equal(
        true,
      );
    });

    it('keeps data order (discrete fallback + gap) for temporal sort: null', () => {
      const compiled = compileSpec({
        data: { values: rows },
        mark: 'line',
        encoding: {
          x: { field: 'd', type: 'temporal', sort: null },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect(compiled.xAxis?.config.scaleType).to.equal('point');
      expect(compiled.xAxis?.categories).to.deep.equal([
        new Date('2020-03-01'),
        new Date('2020-01-01'),
        new Date('2020-02-01'),
      ]);
      expect(compiled.gaps.some((g) => g.code === 'scale:temporal-point-approximation')).to.equal(
        true,
      );
    });

    it('applies sort: descending as a discrete fallback (with a gap)', () => {
      const compiled = compileSpec({
        data: { values: rows },
        mark: 'line',
        encoding: {
          x: { field: 'd', type: 'temporal', sort: 'descending' },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      expect(compiled.xAxis?.config.scaleType).to.equal('point');
      expect(compiled.xAxis?.categories).to.deep.equal([
        new Date('2020-03-01'),
        new Date('2020-02-01'),
        new Date('2020-01-01'),
      ]);
      expect(compiled.gaps.some((g) => g.code === 'scale:temporal-point-approximation')).to.equal(
        true,
      );
    });
  });

  describe('axis format (d3-format / d3-time-format)', () => {
    it('compiles a quantitative axis.format into a valueFormatter (no gap)', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal' },
          y: { field: 'v', type: 'quantitative', axis: { format: '.2f' } },
        },
      });
      const fmt = (compiled.yAxis?.config as { valueFormatter?: (v: unknown) => string })
        .valueFormatter;
      expect(fmt).to.be.a('function');
      expect(fmt!(1.234)).to.equal('1.23');
      expect(compiled.gaps.some((g) => g.code === 'scale:axis-format')).to.equal(false);
    });

    it('compiles a temporal axis.format into a valueFormatter (no gap)', () => {
      const compiled = compileSpec({
        data: { values: [{ d: new Date(2020, 4, 1), v: 1 }] },
        mark: 'line',
        encoding: {
          x: { field: 'd', type: 'temporal', axis: { format: '%Y-%m' } },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      const fmt = (compiled.xAxis?.config as { valueFormatter?: (v: unknown) => string })
        .valueFormatter;
      expect(fmt).to.be.a('function');
      expect(fmt!(new Date(2020, 4, 1))).to.equal('2020-05');
      expect(compiled.gaps.some((g) => g.code === 'scale:axis-format')).to.equal(false);
    });

    it('keeps the scale:axis-format gap for a nominal axis.format (untranslatable)', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal', axis: { format: '.2f' } },
          y: { field: 'v', type: 'quantitative' },
        },
      });
      const gap = compiled.gaps.find((g) => g.code === 'scale:axis-format');
      expect(gap?.severity).to.equal('partial');
    });

    it('keeps the scale:axis-format gap for an invalid d3 pattern', () => {
      const compiled = compileSpec({
        data: { values: [{ c: 'A', v: 1 }] },
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal' },
          y: { field: 'v', type: 'quantitative', axis: { format: '.f' } },
        },
      });
      const gap = compiled.gaps.find((g) => g.code === 'scale:axis-format');
      expect(gap?.severity).to.equal('partial');
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

    it('records an unsupported gap for x2/y2 channels on marks without range support', () => {
      const gaps = createGapCollector();
      const rows = [{ a: 1, b: 2, c: 5 }];
      const units = [
        makeUnit(
          'point',
          {
            x: { field: 'a', type: 'quantitative' },
            x2: { field: 'b' },
            y: { field: 'c', type: 'quantitative' },
          },
          rows,
        ),
      ];
      resolveAxes(units, gaps);
      const gap = gaps.list().find((g) => g.code === 'channel:x2');
      expect(gap?.severity).to.equal('unsupported');
    });

    it('does not double-report x2/y2 for marks that translate ranges themselves (bar/rule)', () => {
      const gaps = createGapCollector();
      const rows = [{ a: 1, b: 2, c: 'A' }];
      const units = [
        makeUnit(
          'bar',
          {
            x: { field: 'c', type: 'nominal' },
            y: { field: 'a', type: 'quantitative' },
            y2: { field: 'b' },
          },
          rows,
        ),
      ];
      resolveAxes(units, gaps);
      expect(gaps.list().find((g) => g.code === 'channel:y2')).to.equal(undefined);
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
