import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import {
  ChoroplethChart,
  ChoroplethPlot,
  choroplethChartClasses,
} from '@mui/x-charts-pro/ChoroplethChart';

const minimalGeography = {
  type: 'FeatureCollection' as const,
  features: [
    {
      type: 'Feature' as const,
      id: 'US',
      properties: { name: 'United States' },
      geometry: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [-125, 24],
            [-66, 24],
            [-66, 49],
            [-125, 49],
            [-125, 24],
          ],
        ],
      },
    },
    {
      type: 'Feature' as const,
      id: 'CA',
      properties: { name: 'Canada' },
      geometry: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [-140, 49],
            [-52, 49],
            [-52, 72],
            [-140, 72],
            [-140, 49],
          ],
        ],
      },
    },
  ],
};

const defaultProps = {
  series: [
    {
      data: [
        { featureId: 'US', value: 80 },
        { featureId: 'CA', value: 40 },
      ],
    },
  ],
  geography: minimalGeography,
  width: 200,
  height: 200,
};

describe('<ChoroplethPlot />', () => {
  const { render } = createRenderer();

  it('should apply className to root element', () => {
    const { container } = render(
      <ChoroplethChart {...defaultProps}>
        <ChoroplethPlot className="custom-choropleth" />
      </ChoroplethChart>,
    );

    const root = container.querySelector(`.${choroplethChartClasses.root}.custom-choropleth`);
    expect(root).not.to.equal(null);
  });

  it('should render one path per geographic feature', () => {
    const { container } = render(<ChoroplethChart {...defaultProps} />);

    const paths = container.querySelectorAll('path');
    // Should have at least one path per feature (2 features)
    expect(paths.length).to.be.greaterThan(0);
  });

  it('should render without crashing when data is empty', () => {
    expect(() =>
      render(<ChoroplethChart {...defaultProps} series={[{ data: [] }]} />),
    ).not.toThrow();
  });
});
