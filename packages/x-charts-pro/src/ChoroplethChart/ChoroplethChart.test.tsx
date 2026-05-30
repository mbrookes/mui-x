import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { LicenseInfo } from '@mui/x-license';
import { clearLicenseStatusCache } from '@mui/x-license/internals';
import { ChoroplethChart } from './ChoroplethChart';

/** Minimal GeoJSON FeatureCollection for testing — a single square polygon. */
const minimalGeography = {
  type: 'FeatureCollection' as const,
  features: [
    {
      type: 'Feature' as const,
      id: 'TEST',
      properties: { name: 'Test Region' },
      geometry: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
        ],
      },
    },
  ],
};

const defaultProps = {
  series: [{ data: [{ featureId: 'TEST', value: 50 }] }],
  geography: minimalGeography,
  width: 200,
  height: 200,
};

describe('<ChoroplethChart /> - License', () => {
  const { render } = createRenderer();

  it('should render watermark when the license is missing', async () => {
    clearLicenseStatusCache();
    LicenseInfo.setLicenseKey('');

    expect(() => render(<ChoroplethChart {...defaultProps} />)).toErrorDev([
      'MUI X: Missing license key.',
    ]);

    expect(await screen.findAllByText('MUI X Missing license key')).not.to.equal(null);
  });
});

describe('<ChoroplethChart /> - Rendering', () => {
  const { render } = createRenderer();

  it('should render "No data to display" when series array is empty', () => {
    render(<ChoroplethChart {...defaultProps} series={[]} />);
    expect(screen.getByText('No data to display')).toBeVisible();
  });

  it('should render without crashing when valid geography and series are provided', () => {
    expect(() => render(<ChoroplethChart {...defaultProps} />)).not.toThrow();
  });
});
