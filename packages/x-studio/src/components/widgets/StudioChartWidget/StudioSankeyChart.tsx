'use client';
import { Box } from '@mui/material';
import { SankeyChart } from '@mui/x-charts-pro/SankeyChart';
import { formatNumber } from '@mui/x-studio-core/engine';
import type { SankeyAggregateData } from '@mui/x-studio-core/engine';
import { useStudioLocaleText } from '../../../internals/StudioUIConfigContext';
import type { StudioNumberFormat } from '../../../models';

// Cap on how many links get spelled out in the `aria-label` text alternative.
const ARIA_LABEL_MAX_LINKS = 15;

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
  const localeText = useStudioLocaleText();
  const formatter = (value: number) => formatNumber(value, valueFormat ?? 'decimal', currencyCode);
  // Text alternative summarizing the flow diagram for assistive technology. Cap the
  // enumerated links to `ARIA_LABEL_MAX_LINKS` and append a total count for the
  // remainder — joining every link (potentially thousands for a large diagram) rebuilds
  // a multi-hundred-KB string every render and is not a usable screen-reader
  // announcement anyway.
  const describedLinks = data.links.slice(0, ARIA_LABEL_MAX_LINKS);
  const describedCount = data.links.length - describedLinks.length;
  const ariaLabelDetails =
    describedLinks
      // Interpolated INTO the localized `sankeyChartAriaLabel`, so the per-link detail has to
      // be localized as well — a literal `" to "` made every translated announcement a
      // mixed-language sentence ("Paris to Lyon : 1 234").
      .map((l) => localeText.sankeyLinkAriaLabel(l.source, l.target, formatter(l.value)))
      .join('; ') +
    (describedCount > 0 ? `; ${localeText.filterSummaryAndMore(describedCount)}` : '');
  const ariaLabel = localeText.sankeyChartAriaLabel(
    data.nodes.length,
    data.links.length,
    ariaLabelDetails,
  );

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
