import * as React from 'react';
import { ScatterChart } from '@mui/x-charts/ScatterChart';

const data = [
  { x: 14, y: 0.06, size: 52000, id: 'PaperLine' },
  { x: 9, y: 0.13, size: 38000, id: 'StapleForge' },
  { x: 6, y: 0.18, size: 21000, id: 'InkWell' },
  { x: 11, y: 0.09, size: 44000, id: 'BindMaster' },
  { x: 4, y: 0.22, size: 15000, id: 'QuickClip' },
  { x: 8, y: 0.11, size: 29000, id: 'FolderMax' },
  { x: 16, y: 0.05, size: 67000, id: 'DeskSupply' },
  { x: 3, y: 0.25, size: 9000, id: 'NoteStack' },
  { x: 12, y: 0.08, size: 47000, id: 'PrintPro' },
  { x: 7, y: 0.15, size: 26000, id: 'ErgoDesk' },
];

export default function BubbleChart() {
  return (
    <ScatterChart
      series={[
        {
          data,
          label: 'Net Revenue by Brand',
          minBubbleRadius: 6,
          maxBubbleRadius: 48,
        },
      ]}
      xAxis={[{ label: 'Avg Quantity per Order' }]}
      yAxis={[{ label: 'Avg Discount Rate', min: 0, max: 0.3 }]}
      height={400}
    />
  );
}
