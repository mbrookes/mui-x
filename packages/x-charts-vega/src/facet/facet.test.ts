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

  it('plans a malformed repeat mapping as a composition:repeat gap with no cells', () => {
    // `{repeat: {field: [...]}}` uses no `row`/`column`/`layer` arrays.
    const plan = planFacets(
      { repeat: { field: ['a', 'b'] }, spec: { mark: 'bar' } } as unknown as VegaLiteSpec,
      SIZE,
    )!;
    expect(plan).not.to.equal(null);
    expect(plan.cells).to.have.length(0);
    expect(plan.gaps.map((gap) => gap.code)).to.deep.equal(['composition:repeat']);
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

  it('applies top-level transforms before partitioning on a derived facet field', () => {
    // The facet field (`gender`) is produced by a `calculate` transform and the
    // rows are narrowed by a `filter`; both must run on the whole dataset before
    // faceting partitions it. Without that, partitioning on the not-yet-derived
    // field finds no values and every cell is empty (the trellis-bar bug).
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { year: 2000, sex: 1, age: 0, people: 10 },
          { year: 2000, sex: 2, age: 0, people: 8 },
          { year: 1990, sex: 1, age: 0, people: 99 },
        ],
      },
      transform: [
        { filter: 'datum.year == 2000' },
        { calculate: "datum.sex == 2 ? 'Female' : 'Male'", as: 'gender' },
      ],
      mark: 'bar',
      encoding: {
        row: { field: 'gender' },
        x: { field: 'age' },
        y: { aggregate: 'sum', field: 'people' },
      },
    };
    const plan = planFacets(spec, SIZE)!;
    expect(plan).not.to.equal(null);
    // One row per derived gender value; the 1990 row was filtered out. Facet
    // values are ordered ascending by default (Vega-Lite's default), so
    // 'Female' precedes 'Male' regardless of first-seen data order.
    expect(plan.cells).to.have.length(2);
    expect(plan.cells.map((cell) => cell.header)).to.deep.equal(['Female', 'Male']);
    // Each cell holds only its (already-transformed) partition and drops the
    // top-level transform so it does not re-run per cell.
    const first = plan.cells[0].spec;
    expect((first.data as { values: unknown[] }).values).to.have.length(1);
    expect(first.transform).to.equal(undefined);
    expect(plan.gaps.filter((gap) => gap.code.startsWith('transform:'))).to.have.length(0);
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

  it("applies a concat spec's own top-level transform before handing rows to each cell", () => {
    // The top-level `transform` is shared preprocessing (a `calculate`-derived
    // field here) that must run once before every concatenated view sees the
    // rows — mirroring the facet/repeat behavior above. Without it, a cell
    // relying on the derived field sees only the raw, untransformed rows.
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 1 }, { x: 2 }] },
      transform: [{ calculate: 'datum.x * 10', as: 'y' }],
      hconcat: [
        { mark: 'bar', encoding: { x: { field: 'y' } } },
        { mark: 'line', encoding: { x: { field: 'y' } } },
      ],
    } as unknown as VegaLiteSpec;
    const plan = planFacets(spec, SIZE)!;
    expect(plan.cells).to.have.length(2);
    for (const cell of plan.cells) {
      const rows = (cell.spec.data as { values: Array<Record<string, unknown>> }).values;
      expect(rows).to.deep.equal([
        { x: 1, y: 10 },
        { x: 2, y: 20 },
      ]);
      expect(cell.spec.transform).to.equal(undefined);
    }
    expect(plan.gaps.filter((gap) => gap.code.startsWith('transform:'))).to.have.length(0);
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

  it('injects a shared union domain across concat cells when `resolve.scale.x` is "shared"', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x: 1, y: 2 },
          { x: 9, y: 4 },
        ],
      },
      hconcat: [
        { mark: 'bar', encoding: { x: { field: 'x', type: 'quantitative' } } },
        { mark: 'point', encoding: { x: { field: 'y', type: 'quantitative' } } },
      ],
      resolve: { scale: { x: 'shared' } },
    } as unknown as VegaLiteSpec;
    const plan = planFacets(spec, SIZE)!;
    // The union of [0, 9] (x, zero-anchored) and [0, 4] (y, zero-anchored) is
    // [0, 9] — both cells get it, even though they plot different fields.
    expect(domainOf(plan.cells[0].spec, 'x')).to.deep.equal([0, 9]);
    expect(domainOf(plan.cells[1].spec, 'x')).to.deep.equal([0, 9]);
  });

  it("keeps concat cells independent when `resolve.scale` is absent (Vega-Lite's own default)", () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x: 1, y: 2 },
          { x: 9, y: 4 },
        ],
      },
      hconcat: [
        { mark: 'bar', encoding: { x: { field: 'x', type: 'quantitative' } } },
        { mark: 'point', encoding: { x: { field: 'y', type: 'quantitative' } } },
      ],
    } as unknown as VegaLiteSpec;
    const plan = planFacets(spec, SIZE)!;
    expect(domainOf(plan.cells[0].spec, 'x')).to.equal(undefined);
    expect(domainOf(plan.cells[1].spec, 'x')).to.equal(undefined);
  });

  it('respects an explicit `scale.domain` on one concat cell instead of overwriting it with the shared union', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x: 1, y: 2 },
          { x: 9, y: 4 },
        ],
      },
      hconcat: [
        {
          mark: 'bar',
          encoding: { x: { field: 'x', type: 'quantitative', scale: { domain: [0, 100] } } },
        },
        { mark: 'point', encoding: { x: { field: 'y', type: 'quantitative' } } },
      ],
      resolve: { scale: { x: 'shared' } },
    } as unknown as VegaLiteSpec;
    const plan = planFacets(spec, SIZE)!;
    expect(domainOf(plan.cells[0].spec, 'x')).to.deep.equal([0, 100]);
    // The other cell still gets the union of the OTHER (non-explicit)
    // occurrences only — here just its own [0, 4].
    expect(domainOf(plan.cells[1].spec, 'x')).to.deep.equal([0, 4]);
  });

  it("shares a domain across a `layer` concat cell's own layers (a mosaic-style rect+label pair)", () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { nx: 0, nx2: 0.4 },
          { nx: 0.4, nx2: 1 },
        ],
      },
      vconcat: [
        {
          mark: { type: 'text' },
          encoding: { x: { aggregate: 'min', field: 'nx', type: 'quantitative' } },
        },
        {
          layer: [
            {
              mark: 'rect',
              encoding: {
                x: { field: 'nx', type: 'quantitative' },
                x2: { field: 'nx2' },
              },
            },
            { mark: 'text', encoding: { x: { field: 'nx', type: 'quantitative' } } },
          ],
        },
      ],
      resolve: { scale: { x: 'shared' } },
    } as unknown as VegaLiteSpec;
    const plan = planFacets(spec, SIZE)!;
    // The `x2` companion field isn't itself examined for domain purposes (only
    // `x`/`y` are, matching the same scope limitation `resolve.scale` already
    // has elsewhere in this wrapper) — the union here is over the plain `nx`
    // field's own values ([0, 0.4]) across all three occurrences.
    expect(domainOf(plan.cells[0].spec, 'x')).to.deep.equal([0, 0.4]);
    const layerCell = plan.cells[1].spec as unknown as {
      layer: Array<{ encoding: { x: { scale?: { domain?: unknown } } } }>;
    };
    expect(layerCell.layer[0].encoding.x.scale?.domain).to.deep.equal([0, 0.4]);
    expect(layerCell.layer[1].encoding.x.scale?.domain).to.deep.equal([0, 0.4]);
  });

  it('sizes each concat cell to its own natural dimensions (flush subplots, not shrunk)', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 1 }] },
      vconcat: [{ mark: 'bar' }, { mark: 'point' }],
    } as unknown as VegaLiteSpec;
    const plan = planFacets(spec, SIZE)!;
    // Concat views keep their own intrinsic size and butt together (Vega-Lite's
    // `bounds: "flush"`) rather than each stretching to the whole composition, so
    // a cell is NOT the full panel size — it's its own (default view) size.
    for (const cell of plan.cells) {
      expect(cell.width).to.be.lessThan(SIZE.width);
      expect(cell.height).to.be.greaterThan(0);
      expect(cell.width).to.equal(plan.cells[0].width);
    }
  });

  it('sizes a layered concat cell from its layer fields, not as an encoding-less default view', () => {
    // The view level declares the shared scale/axis while the layers supply the
    // actual fields (`concat_layer_voyager_result`-shaped). Reading only the
    // entry's own encoding sees no field on either channel, so the cell claims
    // the 200px continuous default on both axes and reserves no axis room.
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { lo: -2, hi: 2, mean: 0, study: 'A' },
          { lo: -1, hi: 1, mean: 0, study: 'B' },
        ],
      },
      vconcat: [
        {
          encoding: {
            y: { field: 'study', type: 'nominal' },
            x: { type: 'quantitative', scale: { domain: [-3, 3] } },
          },
          layer: [
            { mark: 'rule', encoding: { x: { field: 'lo' }, x2: { field: 'hi' } } },
            { mark: 'circle', encoding: { x: { field: 'mean' } } },
          ],
        },
      ],
    } as unknown as VegaLiteSpec;
    const [cell] = planFacets(spec, SIZE)!.cells;
    // Two `study` categories at the default 20px step, plus the allowance the
    // layer-supplied (and therefore genuinely drawn) x axis needs on both sides.
    expect(cell.height).to.equal(2 * 20 + 40 + 24);
  });

  it('sizes an entirely absent positional channel of a concat cell as one implicit band', () => {
    // Vega-Lite's own compiler emits `concat_1_height: 20` for a y-less concat
    // child (`bandspace(1) * step`), NOT the 200px continuous default a
    // standalone unit would get — so such a strip must not out-size its siblings.
    const spec: VegaLiteSpec = {
      data: { values: [{ from: -1, to: 1 }] },
      vconcat: [
        {
          mark: 'rule',
          encoding: { x: { field: 'from', type: 'quantitative' }, x2: { field: 'to' } },
        },
      ],
    } as unknown as VegaLiteSpec;
    const [cell] = planFacets(spec, SIZE)!.cells;
    // 20px band + the drawn x-axis allowance, well under the 200px default view.
    expect(cell.height).to.equal(20 + 40 + 24);
    expect(cell.height).to.be.lessThan(200);
  });

  it('budgets the margin opposite a drawn concat axis so the plot never collapses', () => {
    // A single-band plot has no slack: budgeting only the labelled side left
    // `concat_bar_scales_discretize`'s circle strips with a NEGATIVE drawing
    // area, so x-charts rendered no marks at all. The cell must be wide enough
    // for the y-axis labels AND the plot itself.
    const spec: VegaLiteSpec = {
      data: { values: [{ b: 28 }, { b: 55 }] },
      hconcat: [
        { mark: 'circle', encoding: { y: { field: 'b', type: 'nominal' } } },
        { mark: 'circle', encoding: { y: { field: 'b', type: 'nominal' } } },
      ],
    } as unknown as VegaLiteSpec;
    const [cell] = planFacets(spec, SIZE)!.cells;
    // The y axis is drawn, so its label allowance (>= 60) plus the far-side pad
    // sit on top of the 20px single-band plot.
    expect(cell.width).to.be.greaterThan(60 + 20);
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

  it('sizes facet cells intrinsically (Vega-like) and grows the grid instead of clamping', () => {
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
    // Each cell keeps a full, uniform size (the grid overflows the 400px total
    // and the shell scrolls, matching Vega) rather than being clamped to fit.
    expect(plan.cells).to.have.length(10);
    const first = plan.cells[0];
    expect(first.width).to.be.greaterThan(100);
    expect(plan.cells.every((cell) => cell.width === first.width)).to.equal(true);
    expect(plan.gaps.map((gap) => gap.code)).to.not.include('facet:min-cell-size');
  });
});

describe('planFacets — repeat', () => {
  const ROWS = [
    { a: 1, b: 10, c: 'x' },
    { a: 2, b: 20, c: 'y' },
  ];

  it('substitutes a flat repeat into one cell per field, wrapping to `columns`', () => {
    const spec = {
      data: { values: ROWS },
      columns: 2,
      repeat: ['a', 'b', 'c'],
      spec: {
        mark: 'bar',
        encoding: {
          x: { field: { repeat: 'repeat' }, type: 'quantitative' },
          y: { field: 'b', type: 'quantitative' },
        },
      },
    } as unknown as VegaLiteSpec;
    const plan = planFacets(spec, SIZE)!;
    expect(plan.columns).to.equal(2);
    expect(plan.rows).to.equal(2);
    expect(plan.cells).to.have.length(3);
    expect(plan.cells.map((cell) => cell.header)).to.deep.equal(['a', 'b', 'c']);
    // The `{repeat:'repeat'}` ref resolves to each field in turn.
    expect((plan.cells[0].spec.encoding?.x as VegaFieldDef).field).to.equal('a');
    expect((plan.cells[1].spec.encoding?.x as VegaFieldDef).field).to.equal('b');
    // Every cell plots the full dataset (repeat does not partition).
    expect((plan.cells[0].spec.data as { values: unknown[] }).values).to.deep.equal(ROWS);
  });

  it('defaults the wrap column count when `columns` is absent', () => {
    const spec = {
      data: { values: ROWS },
      repeat: ['a', 'b', 'c', 'a'],
      spec: { mark: 'bar', encoding: { x: { field: { repeat: 'repeat' } } } },
    } as unknown as VegaLiteSpec;
    const plan = planFacets(spec, SIZE)!;
    // sqrt(4) => 2 columns, 2 rows.
    expect(plan.columns).to.equal(2);
    expect(plan.rows).to.equal(2);
    expect(plan.cells).to.have.length(4);
  });

  it('builds a row × column repeat matrix with combined headers', () => {
    const spec = {
      data: { values: ROWS },
      repeat: { row: ['a', 'b'], column: ['c'] },
      spec: {
        mark: 'point',
        encoding: {
          x: { field: { repeat: 'column' }, type: 'nominal' },
          y: { field: { repeat: 'row' }, type: 'quantitative' },
        },
      },
    } as unknown as VegaLiteSpec;
    const plan = planFacets(spec, SIZE)!;
    expect(plan.rows).to.equal(2);
    expect(plan.columns).to.equal(1);
    expect(plan.cells).to.have.length(2);
    expect(plan.cells.map((cell) => cell.header)).to.deep.equal(['c × a', 'c × b']);
    expect((plan.cells[0].spec.encoding?.x as VegaFieldDef).field).to.equal('c');
    expect((plan.cells[0].spec.encoding?.y as VegaFieldDef).field).to.equal('a');
    expect((plan.cells[1].spec.encoding?.y as VegaFieldDef).field).to.equal('b');
    expect(plan.cells.map((cell) => cell.key)).to.deep.equal(['repeat-0-0', 'repeat-1-0']);
  });

  it('expands a layer repeat into a single 1×1 layered cell with hoisted data', () => {
    const spec = {
      data: { values: ROWS },
      repeat: { layer: ['a', 'b'] },
      spec: {
        mark: 'line',
        encoding: {
          x: { field: 'c', type: 'nominal' },
          y: { field: { repeat: 'layer' }, type: 'quantitative' },
        },
      },
    } as unknown as VegaLiteSpec;
    const plan = planFacets(spec, SIZE)!;
    expect(plan.rows).to.equal(1);
    expect(plan.columns).to.equal(1);
    expect(plan.cells).to.have.length(1);
    const cell = plan.cells[0].spec as { data: { values: unknown[] }; layer: VegaLiteSpec[] };
    // Data is hoisted onto the wrapper; each layer copy drops its own data.
    expect(cell.data.values).to.deep.equal(ROWS);
    expect(cell.layer).to.have.length(2);
    expect((cell.layer[0].encoding?.y as VegaFieldDef).field).to.equal('a');
    expect((cell.layer[1].encoding?.y as VegaFieldDef).field).to.equal('b');
    expect(cell.layer[0].data).to.equal(undefined);
  });

  it('substitutes deeply and never touches values under `data`', () => {
    const spec = {
      // A data row literally holding a `{repeat:'row'}`-shaped value must survive.
      spec: {
        data: { values: [{ meta: { repeat: 'row' }, v: 1 }] },
        mark: 'bar',
        encoding: {
          x: { field: { repeat: 'column' }, type: 'nominal' },
          tooltip: [{ field: { repeat: 'row' } }],
        },
      },
      repeat: { row: ['a'], column: ['b'] },
    } as unknown as VegaLiteSpec;
    const plan = planFacets(spec, SIZE)!;
    const cell = plan.cells[0].spec;
    expect((cell.encoding?.x as VegaFieldDef).field).to.equal('b');
    // Array channel recursed element-wise.
    expect((cell.encoding?.tooltip as VegaFieldDef[])[0].field).to.equal('a');
    // The data payload is copied verbatim — the inner {repeat:'row'} is untouched.
    expect((cell.data as { values: { meta: unknown }[] }).values[0].meta).to.deep.equal({
      repeat: 'row',
    });
  });

  it('drops an unresolved `{repeat}` ref and records a repeat:unresolved-ref gap', () => {
    const spec = {
      data: { values: ROWS },
      repeat: { column: ['b'] },
      spec: {
        mark: 'bar',
        encoding: {
          x: { field: { repeat: 'column' } },
          // `{repeat:'row'}` is never bound — the channel is dropped.
          y: { field: { repeat: 'row' }, type: 'quantitative' },
        },
      },
    } as unknown as VegaLiteSpec;
    const plan = planFacets(spec, SIZE)!;
    expect(plan.gaps.map((gap) => gap.code)).to.include('repeat:unresolved-ref');
    // The unresolved ref drops the `field` entry (the channel keeps its other keys).
    expect((plan.cells[0].spec.encoding?.y as VegaFieldDef).field).to.equal(undefined);
    expect((plan.cells[0].spec.encoding?.x as VegaFieldDef).field).to.equal('b');
  });

  it('reports a composition:repeat gap when the `spec` template is missing', () => {
    const plan = planFacets({ repeat: ['a', 'b'] } as unknown as VegaLiteSpec, SIZE)!;
    expect(plan.cells).to.have.length(0);
    expect(plan.gaps.map((gap) => gap.code)).to.deep.equal(['composition:repeat']);
  });

  it('injects no shared domain into repeat cells (independent scales)', () => {
    const spec = {
      data: {
        values: [
          { a: 10, b: 40 },
          { a: 20, b: 5 },
        ],
      },
      repeat: ['a', 'b'],
      spec: {
        mark: 'bar',
        encoding: { y: { field: { repeat: 'repeat' }, type: 'quantitative' } },
      },
    } as unknown as VegaLiteSpec;
    const plan = planFacets(spec, SIZE)!;
    for (const cell of plan.cells) {
      expect(domainOf(cell.spec, 'y')).to.equal(undefined);
    }
  });
});

describe('planFacets — facet sort', () => {
  const SORT_ROWS = [
    { g: 'X', s: 'mid', v: 5 },
    { g: 'Y', s: 'low', v: 1 },
    { g: 'Z', s: 'high', v: 9 },
  ];

  const sortSpec = (columnDef: VegaFieldDef): VegaLiteSpec =>
    ({
      data: { values: SORT_ROWS },
      mark: 'bar',
      encoding: {
        x: { field: 's', type: 'nominal' },
        y: { field: 'v', type: 'quantitative' },
        column: columnDef,
      },
    }) as VegaLiteSpec;

  it('orders facet headers and partitions by `sort: "descending"`', () => {
    const plan = planFacets(sortSpec({ field: 'g', type: 'nominal', sort: 'descending' }), SIZE)!;
    expect(plan.cells.map((cell) => cell.header)).to.deep.equal(['Z', 'Y', 'X']);
    // The partition rows follow the header order.
    expect((plan.cells[0].spec.data as { values: { g: string }[] }).values[0].g).to.equal('Z');
  });

  it('applies an explicit value array, trailing unlisted values in data order', () => {
    const plan = planFacets(sortSpec({ field: 'g', type: 'nominal', sort: ['Y', 'X'] }), SIZE)!;
    // Y, X listed first (array order); Z unlisted trails in data order.
    expect(plan.cells.map((cell) => cell.header)).to.deep.equal(['Y', 'X', 'Z']);
  });

  it('orders facets by a `{field, op, order}` aggregate rule', () => {
    const plan = planFacets(
      sortSpec({
        field: 'g',
        type: 'nominal',
        sort: { field: 'v', op: 'max', order: 'descending' },
      }),
      SIZE,
    )!;
    // max(v) per group: Z=9, X=5, Y=1 → descending Z, X, Y.
    expect(plan.cells.map((cell) => cell.header)).to.deep.equal(['Z', 'X', 'Y']);
  });

  it('defaults the aggregate op to `min` for a bare `{field}` sort', () => {
    const rows = [
      { g: 'X', v: 8 },
      { g: 'X', v: 3 },
      { g: 'Y', v: 5 },
    ];
    const spec = {
      data: { values: rows },
      mark: 'bar',
      encoding: {
        y: { field: 'v', type: 'quantitative' },
        column: { field: 'g', type: 'nominal', sort: { field: 'v' } },
      },
    } as VegaLiteSpec;
    const plan = planFacets(spec, SIZE)!;
    // min(v): X=3, Y=5 → ascending X, Y.
    expect(plan.cells.map((cell) => cell.header)).to.deep.equal(['X', 'Y']);
  });

  it('honors sort on the `facet` operator mapping', () => {
    const spec = {
      data: { values: SORT_ROWS },
      facet: { field: 'g', type: 'nominal', sort: 'descending' },
      spec: { mark: 'bar', encoding: { y: { field: 'v', type: 'quantitative' } } },
    } as unknown as VegaLiteSpec;
    const plan = planFacets(spec, SIZE)!;
    expect(plan.cells.map((cell) => cell.header)).to.deep.equal(['Z', 'Y', 'X']);
  });

  it('sorts a matrix with row descending and column ascending independently', () => {
    const rows = [
      { r: 'r2', c: 'c1', v: 1 },
      { r: 'r1', c: 'c2', v: 2 },
    ];
    const spec = {
      data: { values: rows },
      mark: 'point',
      encoding: {
        x: { field: 'v', type: 'quantitative' },
        row: { field: 'r', type: 'nominal', sort: 'descending' },
        column: { field: 'c', type: 'nominal', sort: 'ascending' },
      },
    } as VegaLiteSpec;
    const plan = planFacets(spec, SIZE)!;
    // rows descending (r2, r1), columns ascending (c1, c2), row-major.
    expect(plan.cells.map((cell) => cell.header)).to.deep.equal([
      'c1 × r2',
      'c2 × r2',
      'c1 × r1',
      'c2 × r1',
    ]);
  });

  it('reports a facet:sort gap for an unsupported sort form and keeps data order', () => {
    const plan = planFacets(
      sortSpec({ field: 'g', type: 'nominal', sort: '-v' as unknown as string }),
      SIZE,
    )!;
    expect(plan.gaps.map((gap) => gap.code)).to.include('facet:sort');
    expect(plan.cells.map((cell) => cell.header)).to.deep.equal(['X', 'Y', 'Z']);
  });

  it('keeps first-seen data order (no gap) when sort is null', () => {
    const plan = planFacets(sortSpec({ field: 'g', type: 'nominal', sort: null }), SIZE)!;
    expect(plan.cells.map((cell) => cell.header)).to.deep.equal(['X', 'Y', 'Z']);
    expect(plan.gaps.map((gap) => gap.code)).not.to.include('facet:sort');
  });
});
