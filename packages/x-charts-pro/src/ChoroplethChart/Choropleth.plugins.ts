import {
  useChartZAxis,
  type UseChartZAxisSignature,
  useChartTooltip,
  type UseChartTooltipSignature,
  useChartInteraction,
  type UseChartInteractionSignature,
  useChartHighlight,
  type UseChartHighlightSignature,
  useChartItemClick,
  type UseChartItemClickSignature,
  useChartKeyboardNavigation,
  type UseChartKeyboardNavigationSignature,
  type ConvertSignaturesIntoPlugins,
} from '@mui/x-charts/internals';
import {
  useChartProExport,
  type UseChartProExportSignature,
} from '../internals/plugins/useChartProExport';
import { useChartGeo, type UseChartGeoSignature } from '../internals/plugins/useChartGeo';

export type ChoroplethPluginSignatures = [
  UseChartZAxisSignature,
  UseChartTooltipSignature<'choropleth'>,
  UseChartInteractionSignature,
  UseChartGeoSignature,
  UseChartHighlightSignature<'choropleth'>,
  UseChartProExportSignature,
  UseChartItemClickSignature<'choropleth'>,
  UseChartKeyboardNavigationSignature,
];

export const CHOROPLETH_PLUGINS = [
  useChartZAxis,
  useChartTooltip,
  useChartInteraction,
  useChartGeo,
  useChartHighlight,
  useChartProExport,
  useChartItemClick,
  useChartKeyboardNavigation,
] as ConvertSignaturesIntoPlugins<ChoroplethPluginSignatures>;
