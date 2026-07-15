import { createGapCollector } from '../gaps';
import { applyLookupTransform } from './lookup';
import { compileSpec } from '../compile';
import type { VegaLookupTransform } from '../types';

describe('applyLookupTransform', () => {
  it('joins listed fields renamed via a parallel `as` array', () => {
    const gaps = createGapCollector();
    const rows = [{ state: 'CA' }, { state: 'NY' }];
    const transform: VegaLookupTransform = {
      lookup: 'state',
      from: {
        data: {
          values: [
            { code: 'CA', pop: 39, capital: 'Sacramento' },
            { code: 'NY', pop: 19, capital: 'Albany' },
          ],
        },
        key: 'code',
        fields: ['pop', 'capital'],
      },
      as: ['population', 'capitalCity'],
    };
    const result = applyLookupTransform(rows, transform, gaps, '$.transform[0]');
    expect(result).to.deep.equal([
      { state: 'CA', population: 39, capitalCity: 'Sacramento' },
      { state: 'NY', population: 19, capitalCity: 'Albany' },
    ]);
    expect(gaps.list()).to.have.length(0);
  });

  it('joins a single field renamed via a single string `as`', () => {
    const gaps = createGapCollector();
    const rows = [{ state: 'CA' }];
    const transform: VegaLookupTransform = {
      lookup: 'state',
      from: {
        data: { values: [{ code: 'CA', pop: 39 }] },
        key: 'code',
        fields: ['pop'],
      },
      as: 'population',
    };
    const result = applyLookupTransform(rows, transform, gaps, '$.transform[0]');
    expect(result).to.deep.equal([{ state: 'CA', population: 39 }]);
    expect(gaps.list()).to.have.length(0);
  });

  it('keeps original field names when `fields` is given without `as`', () => {
    const gaps = createGapCollector();
    const rows = [{ state: 'CA' }];
    const transform: VegaLookupTransform = {
      lookup: 'state',
      from: {
        data: { values: [{ state: 'CA', pop: 39 }] },
        key: 'state',
        fields: ['pop'],
      },
    };
    const result = applyLookupTransform(rows, transform, gaps, '$.transform[0]');
    expect(result).to.deep.equal([{ state: 'CA', pop: 39 }]);
    expect(gaps.list()).to.have.length(0);
  });

  it('stores the whole matched datum under `as` when `fields` is omitted', () => {
    const gaps = createGapCollector();
    const rows = [{ state: 'CA' }];
    const transform: VegaLookupTransform = {
      lookup: 'state',
      from: {
        data: { values: [{ state: 'CA', pop: 39, capital: 'Sacramento' }] },
        key: 'state',
      },
      as: 'details',
    };
    const result = applyLookupTransform(rows, transform, gaps, '$.transform[0]');
    expect(result).to.deep.equal([
      { state: 'CA', details: { state: 'CA', pop: 39, capital: 'Sacramento' } },
    ]);
    expect(gaps.list()).to.have.length(0);
  });

  it('merges all matched fields directly and reports a partial gap when both `fields` and `as` are omitted', () => {
    const gaps = createGapCollector();
    const rows = [{ state: 'CA' }, { state: 'TX' }];
    const transform: VegaLookupTransform = {
      lookup: 'state',
      from: {
        data: {
          values: [{ state: 'CA', pop: 39, capital: 'Sacramento' }],
        },
        key: 'state',
      },
    };
    const result = applyLookupTransform(rows, transform, gaps, '$.transform[0]');
    expect(result).to.deep.equal([
      { state: 'CA', pop: 39, capital: 'Sacramento' },
      // Unmatched row still gets the known secondary schema defaulted.
      { state: 'TX', pop: null, capital: null },
    ]);
    const gap = gaps.list().find((entry) => entry.code === 'transform:lookup-implicit-merge');
    expect(gap?.severity).to.equal('partial');
  });

  it('writes `default` (or null) for non-matching rows', () => {
    const gaps = createGapCollector();
    const rows = [{ state: 'CA' }, { state: 'ZZ' }];
    const transform: VegaLookupTransform = {
      lookup: 'state',
      from: {
        data: { values: [{ state: 'CA', pop: 39 }] },
        key: 'state',
        fields: ['pop'],
      },
      as: 'population',
      default: -1,
    };
    const result = applyLookupTransform(rows, transform, gaps, '$.transform[0]');
    expect(result).to.deep.equal([
      { state: 'CA', population: 39 },
      { state: 'ZZ', population: -1 },
    ]);

    const gapsNoDefault = createGapCollector();
    const noDefaultTransform: VegaLookupTransform = {
      lookup: 'state',
      from: {
        data: { values: [{ state: 'CA', pop: 39 }] },
        key: 'state',
        fields: ['pop'],
      },
      as: 'population',
    };
    const resultNoDefault = applyLookupTransform(rows, noDefaultTransform, gapsNoDefault, '$');
    expect(resultNoDefault).to.deep.equal([
      { state: 'CA', population: 39 },
      { state: 'ZZ', population: null },
    ]);
  });

  it('resolves a dotted-path lookup key on Feature-shaped rows and writes joined fields at the top level', () => {
    const gaps = createGapCollector();
    const features = [
      { type: 'Feature', properties: { name: 'California' }, geometry: null },
      { type: 'Feature', properties: { name: 'Nevada' }, geometry: null },
    ];
    const transform: VegaLookupTransform = {
      lookup: 'properties.name',
      from: {
        data: { values: [{ state: 'California', pop: 39 }] },
        key: 'state',
        fields: ['pop'],
      },
      as: 'population',
    };
    const result = applyLookupTransform(features, transform, gaps, '$.transform[0]');
    expect(result[0]).to.deep.equal({
      type: 'Feature',
      properties: { name: 'California' },
      geometry: null,
      population: 39,
    });
    expect(result[1]).to.deep.equal({
      type: 'Feature',
      properties: { name: 'Nevada' },
      geometry: null,
      population: null,
    });
    // The original feature objects must not be mutated (shallow clone).
    expect((features[0] as { population?: unknown }).population).to.equal(undefined);
  });

  it('falls back to `properties.<field>` for an undotted lookup field on Feature-shaped rows', () => {
    const gaps = createGapCollector();
    const features = [{ type: 'Feature', properties: { name: 'California' }, geometry: null }];
    const transform: VegaLookupTransform = {
      lookup: 'name',
      from: {
        data: { values: [{ name: 'California', pop: 39 }] },
        key: 'name',
        fields: ['pop'],
      },
      as: 'population',
    };
    const result = applyLookupTransform(features, transform, gaps, '$.transform[0]');
    expect((result[0] as { population?: unknown }).population).to.equal(39);
  });

  it('never matches a row whose lookup value is missing/unresolvable, even against a secondary row that also lacks the key field', () => {
    const gaps = createGapCollector();
    // Neither row has a `state` field, so the primary lookup value and the
    // first secondary row's key value are both `undefined` — they must not
    // be treated as a match.
    const rows = [{ label: 'no state here' }];
    const transform: VegaLookupTransform = {
      lookup: 'state',
      from: {
        data: { values: [{ pop: 999 }, { state: 'CA', pop: 39 }] },
        key: 'state',
        fields: ['pop'],
      },
      as: 'population',
    };
    const result = applyLookupTransform(rows, transform, gaps, '$.transform[0]');
    expect(result).to.deep.equal([{ label: 'no state here', population: null }]);
  });

  it('first-match-wins on duplicate keys in the secondary dataset', () => {
    const gaps = createGapCollector();
    const rows = [{ state: 'CA' }];
    const transform: VegaLookupTransform = {
      lookup: 'state',
      from: {
        data: {
          values: [
            { state: 'CA', pop: 39 },
            { state: 'CA', pop: 999 },
          ],
        },
        key: 'state',
        fields: ['pop'],
      },
      as: 'population',
    };
    const result = applyLookupTransform(rows, transform, gaps, '$.transform[0]');
    expect(result).to.deep.equal([{ state: 'CA', population: 39 }]);
  });

  it('reports an unsupported gap for a `url` secondary dataset and passes rows through with defaults', () => {
    const gaps = createGapCollector();
    const rows = [{ state: 'CA' }];
    const transform: VegaLookupTransform = {
      lookup: 'state',
      from: {
        data: { url: 'https://example.com/population.json' },
        key: 'state',
        fields: ['pop'],
      },
      as: 'population',
    };
    const result = applyLookupTransform(rows, transform, gaps, '$.transform[0]');
    expect(result).to.deep.equal([{ state: 'CA', population: null }]);
    const gap = gaps.list().find((entry) => entry.code === 'transform:lookup-url');
    expect(gap?.severity).to.equal('unsupported');
  });

  it('reports an unsupported gap for a named-dataset secondary source and passes rows through unchanged when the output shape is unknown', () => {
    const gaps = createGapCollector();
    const rows = [{ state: 'CA' }];
    const transform: VegaLookupTransform = {
      lookup: 'state',
      from: {
        data: { name: 'population-table' },
        key: 'state',
      },
    };
    const result = applyLookupTransform(rows, transform, gaps, '$.transform[0]');
    // Both `fields` and `as` are omitted and there's no secondary data to
    // infer a schema from, so nothing can be safely defaulted.
    expect(result).to.deep.equal([{ state: 'CA' }]);
    const namedGap = gaps.list().find((entry) => entry.code === 'transform:lookup-named-dataset');
    expect(namedGap?.severity).to.equal('unsupported');
    const mergeGap = gaps.list().find((entry) => entry.code === 'transform:lookup-implicit-merge');
    expect(mergeGap?.severity).to.equal('partial');
  });

  it('reports an unsupported gap when `from.data` has neither `values`, `url`, nor `name`', () => {
    const gaps = createGapCollector();
    const rows = [{ state: 'CA' }];
    const transform: VegaLookupTransform = {
      lookup: 'state',
      from: { data: {}, key: 'state', fields: ['pop'] },
      as: 'population',
    };
    const result = applyLookupTransform(rows, transform, gaps, '$.transform[0]');
    expect(result).to.deep.equal([{ state: 'CA', population: null }]);
    const gap = gaps.list().find((entry) => entry.code === 'transform:lookup-no-data');
    expect(gap?.severity).to.equal('unsupported');
  });

  it('runs a lookup transform inside a full bar spec compile pipeline', () => {
    const compiled = compileSpec({
      data: {
        values: [
          { state: 'CA', sales: 10 },
          { state: 'NY', sales: 20 },
        ],
      },
      transform: [
        {
          lookup: 'state',
          from: {
            data: {
              values: [
                { code: 'CA', region: 'West' },
                { code: 'NY', region: 'East' },
              ],
            },
            key: 'code',
            fields: ['region'],
          },
        } as unknown as VegaLookupTransform,
      ],
      mark: 'bar',
      encoding: {
        x: { field: 'region', type: 'nominal' },
        y: { field: 'sales', type: 'quantitative' },
      },
    });
    expect(compiled.xAxis?.categories).to.deep.equal(['East', 'West']);
    expect(compiled.gaps.filter((gap) => gap.code.startsWith('transform:lookup'))).to.have.length(
      0,
    );
  });
});
