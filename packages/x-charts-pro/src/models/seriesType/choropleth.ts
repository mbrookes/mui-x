import type { DefaultizedProps } from '@mui/x-internals/types';
import type { CommonDefaultizedProps, CommonSeriesType } from '@mui/x-charts/internals';
import type { SeriesId } from '@mui/x-charts/models';

/**
 * A single data item binding a geographic feature to a numeric value.
 */
export interface ChoroplethDataItem {
  /**
   * The feature identifier that matches the geographic feature.
   * By default, matched against `feature.id`.
   * Set `featureIdKey` on the series to match against a property instead.
   */
  featureId: string;
  /**
   * The numeric value driving the color scale.
   */
  value: number;
  /**
   * Optional label override for tooltip display.
   */
  label?: string;
}

/**
 * The identifier for a single choropleth item (a filled geographic region).
 */
export type ChoroplethItemIdentifier = {
  type: 'choropleth';
  /** The id of the series the item belongs to. */
  seriesId: SeriesId;
  /** The geographic feature id. */
  featureId: string;
};

/**
 * The item identifier with its associated data value.
 */
export type ChoroplethItemIdentifierWithData = ChoroplethItemIdentifier & {
  /** The numeric value of the item. Null if there is no data for this feature. */
  value: number | null;
};

export interface ChoroplethSeriesType extends Omit<
  CommonSeriesType<number | null, 'choropleth'>,
  'color' | 'colorGetter' | 'valueFormatter'
> {
  type: 'choropleth';
  /**
   * The data associated with the series.
   */
  data?: ChoroplethDataItem[];
  /**
   * The key in `feature.properties` to use as the feature identifier.
   * Defaults to using `feature.id`.
   */
  featureIdKey?: string;
  /**
   * The id of the `zAxis` to use for color mapping.
   * Defaults to the first zAxis.
   */
  zAxisId?: string;
  /**
   * The label to display on the tooltip or the legend.
   */
  label?: string | ((location: 'tooltip' | 'legend') => string);
  /**
   * Function that formats values to be displayed in a tooltip.
   * @param {number | null} value The series' value.
   * @param {{ featureId: string }} context The rendering context.
   * @param {string} context.featureId The geographic feature id.
   * @returns {string | null} The string to display.
   */
  valueFormatter?: (value: number | null, context: { featureId: string }) => string | null;
}

/**
 * A lookup map from featureId to numeric value, built by the series processor.
 */
export class ChoroplethValueMap {
  private lookup: Map<string, number>;

  constructor(data: ChoroplethDataItem[]) {
    this.lookup = new Map(data.map((d) => [d.featureId, d.value]));
  }

  getValue(featureId: string): number | null {
    return this.lookup.get(featureId) ?? null;
  }
}

export interface DefaultizedChoroplethSeriesType extends DefaultizedProps<
  ChoroplethSeriesType,
  CommonDefaultizedProps
> {
  /**
   * O(1) lookup map from featureId to value, built during series processing.
   */
  valueMap: ChoroplethValueMap;
}
