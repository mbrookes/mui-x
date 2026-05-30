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
      // AR has no data — it will be rendered as transparent
    ],
    label: 'Score',
  },
];

export default function ChoroplethWithMissingData() {
  return (
    <Box sx={{ width: '100%' }}>
      <ChoroplethChart
        geography={demoGeography}
        series={series}
        height={300}
        zAxis={[
          {
            colorMap: {
              type: 'continuous',
              min: 0,
              max: 100,
              color: ['#e0f3db', '#084081'],
            },
          },
        ]}
      />
    </Box>
  );
}
