import Box from '@mui/material/Box';
import { ChoroplethChart } from '@mui/x-charts-pro/ChoroplethChart';
import { demoGeography } from './demoGeography';

const series = [
  {
    data: [
      { featureId: 'US', value: 82 },
      { featureId: 'CA', value: 65 },
      { featureId: 'MX', value: 48 },
      { featureId: 'BR', value: 71 },
      { featureId: 'AR', value: 39 },
    ],
    label: 'Risk level',
  },
];

export default function PiecewiseChoropleth() {
  return (
    <Box sx={{ width: '100%' }}>
      <ChoroplethChart
        geography={demoGeography}
        series={series}
        height={300}
        zAxis={[
          {
            colorMap: {
              type: 'piecewise',
              thresholds: [40, 60, 80],
              colors: ['#2c7bb6', '#abd9e9', '#fdae61', '#d7191c'],
            },
          },
        ]}
      />
    </Box>
  );
}
