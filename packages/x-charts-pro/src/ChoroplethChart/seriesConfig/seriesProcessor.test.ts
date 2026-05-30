import seriesProcessor from './seriesProcessor';
import { ChoroplethValueMap } from '../../models/seriesType/choropleth';

const mockSeriesOrder = ['series-1', 'series-2'];

const mockSeries = {
  'series-1': {
    type: 'choropleth' as const,
    id: 'series-1',
    color: '#ff0000',
    valueFormatter: (v: number | null) => String(v),
    data: [
      { featureId: 'US', value: 42 },
      { featureId: 'CA', value: 75 },
    ],
  },
  'series-2': {
    type: 'choropleth' as const,
    id: 'series-2',
    color: '#0000ff',
    valueFormatter: (v: number | null) => String(v),
    data: [],
  },
};

describe('Choropleth seriesProcessor', () => {
  it('should preserve series order', () => {
    const result = seriesProcessor({ series: mockSeries, seriesOrder: mockSeriesOrder });
    expect(result.seriesOrder).to.deep.equal(['series-1', 'series-2']);
  });

  it('should add a ChoroplethValueMap to each series', () => {
    const result = seriesProcessor({ series: mockSeries, seriesOrder: mockSeriesOrder });
    expect(result.series['series-1'].valueMap).to.be.instanceOf(ChoroplethValueMap);
    expect(result.series['series-2'].valueMap).to.be.instanceOf(ChoroplethValueMap);
  });

  it('should look up values from the valueMap correctly', () => {
    const result = seriesProcessor({ series: mockSeries, seriesOrder: mockSeriesOrder });
    expect(result.series['series-1'].valueMap.getValue('US')).to.equal(42);
    expect(result.series['series-1'].valueMap.getValue('CA')).to.equal(75);
    expect(result.series['series-1'].valueMap.getValue('MX')).to.equal(null);
  });

  it('should return null for features not in data', () => {
    const result = seriesProcessor({ series: mockSeries, seriesOrder: mockSeriesOrder });
    expect(result.series['series-2'].valueMap.getValue('US')).to.equal(null);
  });

  it('should set a default valueFormatter', () => {
    const seriesWithoutFormatter = {
      'series-1': {
        type: 'choropleth' as const,
        id: 'series-1',
        color: '#ff0000',
        data: [{ featureId: 'US', value: 99 }],
      },
    };
    const result = seriesProcessor({
      series: seriesWithoutFormatter,
      seriesOrder: ['series-1'],
    });
    expect(result.series['series-1'].valueFormatter(99, { featureId: 'US' })).to.equal('99');
    expect(result.series['series-1'].valueFormatter(null, { featureId: 'US' })).to.equal(null);
  });

  it('should set labelMarkType to "square" by default', () => {
    const result = seriesProcessor({ series: mockSeries, seriesOrder: mockSeriesOrder });
    expect(result.series['series-1'].labelMarkType).to.equal('square');
  });

  it('should not override user-provided labelMarkType', () => {
    const seriesWithMarkType = {
      'series-1': {
        ...mockSeries['series-1'],
        labelMarkType: 'circle' as const,
      },
    };
    const result = seriesProcessor({
      series: seriesWithMarkType,
      seriesOrder: ['series-1'],
    });
    expect(result.series['series-1'].labelMarkType).to.equal('circle');
  });

  it('should handle empty data array', () => {
    const seriesEmpty = {
      'series-1': {
        type: 'choropleth' as const,
        id: 'series-1',
        color: '#ff0000',
        valueFormatter: (v: number | null) => String(v),
      },
    };
    const result = seriesProcessor({ series: seriesEmpty, seriesOrder: ['series-1'] });
    expect(result.series['series-1'].data).to.deep.equal([]);
    expect(result.series['series-1'].valueMap.getValue('US')).to.equal(null);
  });
});
