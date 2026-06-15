'use client';
import { Box } from '@mui/material';
import { SankeyChart } from '@mui/x-charts-pro/SankeyChart';
import { formatNumber } from '../../../internals/numberFormat';
import type { StudioNumberFormat } from '../../../models';
import type { SankeyAggregateData } from '../../../internals/chartAggregation';

interface StudioSankeyChartProps {
  /** Node ids and weighted links, as produced by `aggregateSankey`. */
  data: SankeyAggregateData;
  height: number;
  /** Where each link draws its colour from. @default 'source' */
  linkColor?: 'source' | 'target';
  /** Render the aggregated value as a label on each link. @default false */
  showValues?: boolean;
  valueFormat?: StudioNumberFormat;
  currencyCode?: string;
}

/**
 * Renders a Sankey flow diagram from aggregated node/link data, wrapping the
 * `@mui/x-charts-pro` `SankeyChart`. Layout knobs (iterations, alignment, curve
 * correction, sorting) use the chart defaults; Studio only exposes the field
 * mappings plus link colour and value-label toggles.
 */
export function StudioSankeyChart({
  data,
  height,
  linkColor = 'source',
  showValues = false,
  valueFormat,
  currencyCode,
}: StudioSankeyChartProps) {
  const formatter = (value: number) => formatNumber(value, valueFormat ?? 'decimal', currencyCode);
  // Text alternative summarizing the flow diagram for assistive technology.
  const ariaLabel = `Sankey flow diagram with ${data.nodes.length} ${
    data.nodes.length === 1 ? 'node' : 'nodes'
  } and ${data.links.length} ${data.links.length === 1 ? 'link' : 'links'}. ${data.links
    .map((l) => `${l.source} to ${l.target}: ${formatter(l.value)}`)
    .join('; ')}.`;

  return (
    <Box role="img" aria-label={ariaLabel} sx={{ width: '100%', height }}>
      <SankeyChart
        height={height}
        series={{
          data,
          linkOptions: { color: linkColor, showValues },
          valueFormatter: formatter,
        }}
      />
    </Box>
  );
}
