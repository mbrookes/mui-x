import * as React from 'react';
import { ScatterChart } from '@mui/x-charts/ScatterChart';

const dataset = [
  { brand: 'PaperLine', avgQty: 14, avgDiscount: 0.06, netRevenue: 52000 },
  { brand: 'StapleForge', avgQty: 9, avgDiscount: 0.13, netRevenue: 38000 },
  { brand: 'InkWell', avgQty: 6, avgDiscount: 0.18, netRevenue: 21000 },
  { brand: 'BindMaster', avgQty: 11, avgDiscount: 0.09, netRevenue: 44000 },
  { brand: 'QuickClip', avgQty: 4, avgDiscount: 0.22, netRevenue: 15000 },
  { brand: 'FolderMax', avgQty: 8, avgDiscount: 0.11, netRevenue: 29000 },
  { brand: 'DeskSupply', avgQty: 16, avgDiscount: 0.05, netRevenue: 67000 },
  { brand: 'NoteStack', avgQty: 3, avgDiscount: 0.25, netRevenue: 9000 },
  { brand: 'PrintPro', avgQty: 12, avgDiscount: 0.08, netRevenue: 47000 },
  { brand: 'ErgoDesk', avgQty: 7, avgDiscount: 0.15, netRevenue: 26000 },
];

export default function BubbleChartDataset() {
  return (
    <ScatterChart
      dataset={dataset}
      series={[
        {
          label: 'Net Revenue by Brand',
          datasetKeys: { x: 'avgQty', y: 'avgDiscount', id: 'brand', size: 'netRevenue' },
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
