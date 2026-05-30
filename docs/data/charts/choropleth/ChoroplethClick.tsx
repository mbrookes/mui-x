import * as React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { ChoroplethChart } from '@mui/x-charts-pro/ChoroplethChart';
import type { ChoroplethItemIdentifier } from '@mui/x-charts-pro/models';
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
    label: 'Score',
  },
];

export default function ChoroplethClick() {
  const [clickData, setClickData] = React.useState<ChoroplethItemIdentifier | null>(null);

  return (
    <Box sx={{ width: '100%' }}>
      <ChoroplethChart
        geography={demoGeography}
        series={series}
        height={300}
        zAxis={[{ colorMap: { type: 'continuous', min: 0, max: 100, color: ['#ffffb2', '#b10026'] } }]}
        onItemClick={(_event, identifier) => {
          if (identifier.type === 'choropleth') {
            setClickData(identifier);
          }
        }}
      />
      {clickData && (
        <Typography variant="body2" sx={{ mt: 1, textAlign: 'center' }}>
          Clicked: <strong>{clickData.featureId}</strong> (series: {clickData.seriesId})
        </Typography>
      )}
    </Box>
  );
}
