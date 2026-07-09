import { planFacets } from './index';
import type { VegaFieldDef, VegaLiteSpec } from '../types';

const SIZE = { width: 800, height: 400 } as const;

/** Reads the `scale.domain` off a cell's positional channel. */
function domainOf(spec: VegaLiteSpec, channel: 'x' | 'y'): unknown {
  const def = spec.encoding?.[channel] as VegaFieldDef | undefined;
  return def?.scale && typeof def.scale === 'object'
    ? (def.scale as { domain?: unknown }).domain
    : undefined;
}

/** Reads the injected `sort` array off a cell's positional channel. */
function sortOf(spec: VegaLiteSpec, channel: 'x' | 'y'): unknown {
  const def = spec.encoding?.[channel] as VegaFieldDef | undefined;
  return def?.sort;
}

describe('planFacets', () => {
  it('returns null for a plain unit spec', () => {
    const plan = planFacets({ mark: 'bar', encoding: {} } as VegaLiteSpec, SIZE);
    expect(plan).to.equal(null);
  });

  it('returns null for a repeat composition (kept as a compiler gap)', () => {
    const plan = planFacets(
      { repeat: { field: ['a', 'b'] }, spec: {} } as unknown as VegaLiteSpec,
      SIZE,
    );
    expect(plan).to.equal(null);
  });

  it('partitions a column-faceted spec into one cell per distinct value', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { g: 'X', c: 'a', v: 1 },
          { g: 'X', c: 'b', v: 2 },
          { g: 'Y', c: 'a', v: 3 },
          { g: 'Z', c: 'a', v: 4 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'c', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
        column: { field: 'g', type: 'nominal' },
      },
    };
    const plan = planFacets(spec, SIZE)!;
    expect(plan).not.to.equal(null);
    expect(plan.columns).to.equal(3);
    expect(plan.rows).to.equal(1);
    expect(plan.cells).to.have.length(3);
    // Each cell only holds its partition's rows and drops the facet channel.
    const first = plan.cells[0].spec;
    expect((first.data as { values: unknown[] }).values).to.have.length(2);
    expect(first.encoding?.column).to.equal(undefined);
    expect(plan.cells.map((cell) => cell.header)).to.deep.equal(['X', 'Y', 'Z']);
  });

  it('builds a matrix for combined row + column facets', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { r: 'R1', c: 'C1', v: 1 },
          { r: 'R1', c: 'C2', v: 2 },
          { r: 'R2', c: 'C1', v: 3 },
          { r: 'R2', c: 'C2', v: 4 },
        ],
      },
      mark: 'point',
      encoding: {
        x: { field: 'v', type: 'quantitative' },
        row: { field: 'r', type: 'nominal' },
        column: { field: 'c', type: 'nominal' },
      },
    };
    const plan = planFacets(spec, SIZE)!;
    expect(plan.columns).to.equal(2);
    expect(plan.rows).to.equal(2);
    expect(plan.cells).to.have.length(4);
    // Row-major: (R1,C1), (R1,C2), (R2,C1), (R2,C2).
    expect(plan.cells.map((cell) => cell.header)).to.deep.equal([
      'C1 × R1',
      'C2 × R1',
      'C1 × R2',
      'C2 × R2',
    ]);
    expect((plan.cells[0].spec.data as { values: unknown[] }).values).to.have.length(1);
  });

  it('injects a shared quantitative domain (incl. zero) into every cell', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { g: 'X', c: 'a', v: 10 },
          { g: 'Y', c: 'a', v: 40 },
          { g: 'Z', c: 'a', v: 25 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'c', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
        column: { field: 'g', type: 'nominal' },
      },
    };
    const plan = planFacets(spec, SIZE)!;
    for (const cell of plan.cells) {
      expect(domainOf(cell.spec, 'y')).to.deep.equal([0, 40]);
    }
  });

  it('computes the shared domain over aggregated group values, not raw rows', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { g: 'X', c: 'a', v: 5 },
          { g: 'X', c: 'a', v: 5 },
          { g: 'Y', c: 'a', v: 3 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'c', type: 'nominal' },
        y: { field: 'v', type: 'quantitative', aggregate: 'sum' },
        column: { field: 'g', type: 'nominal' },
      },
    };
    const plan = planFacets(spec, SIZE)!;
    // group (X,a) sums to 10 — the raw max value is only 5.
    expect(domainOf(plan.cells[0].spec, 'y')).to.deep.equal([0, 10]);
  });

  it('sums the shared domain across a stack-splitting channel (no clipping)', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { g: 'A', m: 'm1', p: 'p1', v: 100 },
          { g: 'A', m: 'm1', p: 'p2', v: 300 },
          { g: 'A', m: 'm2', p: 'p1', v: 50 },
          { g: 'B', m: 'm1', p: 'p1', v: 10 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'm', type: 'nominal' },
        y: { field: 'v', type: 'quantitative', aggregate: 'sum' },
        color: { field: 'p', type: 'nominal' },
        column: { field: 'g', type: 'nominal' },
      },
    };
    const plan = planFacets(spec, SIZE)!;
    // Stack total at (A, m1) is 100 + 300 = 400 — not the tallest segment (300).
    expect(domainOf(plan.cells[0].spec, 'y')).to.deep.equal([0, 400]);
  });

  it('respects an explicit domain instead of overriding it', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ g: 'X', c: 'a', v: 1 }] },
      mark: 'bar',
      encoding: {
        x: { field: 'c', type: 'nominal' },
        y: { field: 'v', type: 'quantitative', scale: { domain: [0, 100] } },
        column: { field: 'g', type: 'nominal' },
      },
    };
    const plan = planFacets(spec, SIZE)!;
    expect(domainOf(plan.cells[0].spec, 'y')).to.deep.equal([0, 100]);
  });

  it('injects the union category order as `sort` on discrete channels', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { g: 'X', c: 'a', v: 1 },
          { g: 'X', c: 'b', v: 2 },
          { g: 'Y', c: 'c', v: 3 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'c', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
        column: { field: 'g', type: 'nominal' },
      },
    };
    const plan = planFacets(spec, SIZE)!;
    for (const cell of plan.cells) {
      expect(sortOf(cell.spec, 'x')).to.deep.equal(['a', 'b', 'c']);
    }
  });

  it('plans hconcat entries as independent cells inheriting top-level data', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 1, y: 2 }] },
      hconcat: [
        { mark: 'bar', encoding: { x: { field: 'x' } } },
        { mark: 'line', encoding: { x: { field: 'y' } } },
      ],
    } as unknown as VegaLiteSpec;
    const plan = planFacets(spec, SIZE)!;
    expect(plan.columns).to.equal(2);
    expect(plan.rows).to.equal(1);
    expect(plan.cells).to.have.length(2);
    // No shared domain for concat, and each entry inherits the top-level rows.
    for (const cell of plan.cells) {
      expect((cell.spec.data as { values: unknown[] }).values).to.deep.equal([{ x: 1, y: 2 }]);
    }
    expect((plan.cells[0].spec as { mark: unknown }).mark).to.equal('bar');
    expect((plan.cells[1].spec as { mark: unknown }).mark).to.equal('line');
  });

  it('keeps a concat entry that declares its own data', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 1 }] },
      vconcat: [{ data: { values: [{ own: 9 }] }, mark: 'bar' }, { mark: 'line' }],
    } as unknown as VegaLiteSpec;
    const plan = planFacets(spec, SIZE)!;
    expect(plan.columns).to.equal(1);
    expect(plan.rows).to.equal(2);
    expect((plan.cells[0].spec.data as { values: unknown[] }).values).to.deep.equal([{ own: 9 }]);
    expect((plan.cells[1].spec.data as { values: unknown[] }).values).to.deep.equal([{ x: 1 }]);
  });

  it('wraps a `concat` grid to the requested column count', () => {
    const spec: VegaLiteSpec = {
      columns: 2,
      concat: [{ mark: 'bar' }, { mark: 'line' }, { mark: 'point' }],
    } as unknown as VegaLiteSpec;
    const plan = planFacets(spec, SIZE)!;
    expect(plan.columns).to.equal(2);
    expect(plan.rows).to.equal(2);
    expect(plan.cells).to.have.length(3);
  });

  it('supports the `facet` operator with a wrapping field + columns', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { g: 'X', c: 'a', v: 1 },
          { g: 'Y', c: 'a', v: 2 },
          { g: 'Z', c: 'a', v: 3 },
        ],
      },
      columns: 2,
      facet: { field: 'g', type: 'nominal' },
      spec: {
        mark: 'bar',
        encoding: {
          x: { field: 'c', type: 'nominal' },
          y: { field: 'v', type: 'quantitative' },
        },
      },
    } as unknown as VegaLiteSpec;
    const plan = planFacets(spec, SIZE)!;
    expect(plan.columns).to.equal(2);
    expect(plan.rows).to.equal(2);
    expect(plan.cells).to.have.length(3);
    expect(plan.cells.map((cell) => cell.header)).to.deep.equal(['X', 'Y', 'Z']);
    // Shared domain injected into the operator's inner spec too.
    expect(domainOf(plan.cells[0].spec, 'y')).to.deep.equal([0, 3]);
  });

  it('reports a no-data gap when a faceted spec resolves no rows', () => {
    const spec: VegaLiteSpec = {
      data: { url: '/sales.csv' },
      mark: 'bar',
      encoding: {
        x: { field: 'cat', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
        column: { field: 'g', type: 'nominal' },
      },
    } as unknown as VegaLiteSpec;
    const plan = planFacets(spec, SIZE)!;
    expect(plan.gaps.map((gap) => gap.code)).to.include('facet:no-data');
  });

  it('reports a min-cell-size gap when the grid cannot fit', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: Array.from({ length: 10 }, (_, i) => ({ g: `g${i}`, c: 'a', v: i })),
      },
      mark: 'bar',
      encoding: {
        x: { field: 'c', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
        column: { field: 'g', type: 'nominal' },
      },
    };
    const plan = planFacets(spec, { width: 400, height: 300 })!;
    expect(plan.gaps.map((gap) => gap.code)).to.include('facet:min-cell-size');
  });
});
