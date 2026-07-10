import * as React from 'react';

import type {
  StudioDataField,
  StudioDataSource,
  StudioChartConfig,
  StudioDateRangePreset,
  StudioExpressionField,
  StudioFilterState,
  StudioGridColumn,
  StudioKpiAggregation,
  StudioWidget,
  StudioWidgetConfig,
  StudioWidgetKind,
} from '../models';
import { isWidgetOfKind } from '../models';
import { isRelativeDateValue } from './filterUtils';
import type { RelativeDateValue } from './filterTypes';
import { formatFieldValue } from './numberFormat';
import { escapeCsvCell } from './csvUtils';
import { DEFAULT_STUDIO_LOCALE_TEXT, type StudioLocaleText } from './StudioUIConfigContext';
import { TextWidgetIcon } from '../icons/TextWidgetIcon';
import { KpiWidgetIcon } from '../icons/KpiWidgetIcon';
import { TableWidgetIcon } from '../icons/TableWidgetIcon';
import { BarGroupedIcon } from '../icons/charts/BarGroupedIcon';
import { BarStackedIcon } from '../icons/charts/BarStackedIcon';
import { Bar100Icon } from '../icons/charts/Bar100Icon';
import { BarHorizontalIcon } from '../icons/charts/BarHorizontalIcon';
import { BarStackedHorizontalIcon } from '../icons/charts/BarStackedHorizontalIcon';
import { Bar100HorizontalIcon } from '../icons/charts/Bar100HorizontalIcon';
import { LineIcon } from '../icons/charts/LineIcon';
import { AreaIcon } from '../icons/charts/AreaIcon';
import { AreaStackedIcon } from '../icons/charts/AreaStackedIcon';
import { Area100Icon } from '../icons/charts/Area100Icon';
import { ScatterIcon } from '../icons/charts/ScatterIcon';
import { PieIcon } from '../icons/charts/PieIcon';
import { DonutIcon } from '../icons/charts/DonutIcon';
import { ListFilterWidgetIcon } from '../icons/ListFilterWidgetIcon';
import { ButtonFilterWidgetIcon } from '../icons/ButtonFilterWidgetIcon';
import { DateFilterWidgetIcon } from '../icons/DateFilterWidgetIcon';
import { PivotWidgetIcon } from '../icons/PivotWidgetIcon';
import { MapWidgetIcon } from '../icons/MapWidgetIcon';

// createDefaultWidget — pure factory, no React dependency.
export { createDefaultWidget } from './widgetFactory';

export const WIDGET_TYPES: {
  kind: StudioWidgetKind;
  label: string;
  description: string;
  icon: React.ReactNode;
}[] = [
  {
    kind: 'text',
    label: 'Text',
    description: 'Title, subtitle, and body copy',
    icon: <TextWidgetIcon size={28} />,
  },
  {
    kind: 'kpi',
    label: 'KPI',
    description: 'Single metric with aggregation',
    icon: <KpiWidgetIcon size={28} />,
  },
  {
    kind: 'chart',
    label: 'Chart',
    description: 'Visualise data with a configurable chart',
    icon: <BarGroupedIcon size={28} />,
  },
  {
    kind: 'grid',
    label: 'Table',
    description: 'Data grid with sorting & filtering',
    icon: <TableWidgetIcon size={28} />,
  },
  {
    kind: 'filter',
    label: 'Filter',
    description: 'Interactive filter control for view mode',
    icon: <ListFilterWidgetIcon size={28} />,
  },
  {
    kind: 'pivot',
    label: 'Pivot Table',
    description: 'Cross-tabulation with row/column dimensions',
    icon: <PivotWidgetIcon size={28} />,
  },
  {
    kind: 'map',
    label: 'Map',
    description: 'Choropleth world map by country',
    icon: <MapWidgetIcon size={28} />,
  },
];

export function widgetKindRequiresDataSource(kind: StudioWidgetKind) {
  return kind !== 'text';
}

/** Extracts the `fieldId` strings from a `StudioGridColumn[]` for callers that only need IDs. */
function columnFieldIds(columns: StudioGridColumn[] | undefined): string[] {
  return columns?.map((c) => c.fieldId) ?? [];
}

/** Returns a small (16px) icon representing the specific sub-type of a widget. */
export function getWidgetSubtypeIcon(widget: StudioWidget, size = 16): React.ReactNode {
  if (isWidgetOfKind(widget, 'chart')) {
    // Reads `barLayout` (a bar-family key) alongside `chartType`, so widen to the
    // flat cross-family config type rather than narrowing to one chart family.
    const config = widget.config as StudioChartConfig;
    const chartType = config.chartType ?? 'bar';
    const horizontal = config.barLayout === 'horizontal';
    switch (chartType) {
      case 'bar':
        return horizontal ? <BarHorizontalIcon size={size} /> : <BarGroupedIcon size={size} />;
      case 'bar-stacked':
        return horizontal ? (
          <BarStackedHorizontalIcon size={size} />
        ) : (
          <BarStackedIcon size={size} />
        );
      case 'bar-100':
        return horizontal ? <Bar100HorizontalIcon size={size} /> : <Bar100Icon size={size} />;
      case 'line':
        return <LineIcon size={size} />;
      case 'area':
        return <AreaIcon size={size} />;
      case 'area-stacked':
        return <AreaStackedIcon size={size} />;
      case 'area-100':
        return <Area100Icon size={size} />;
      case 'scatter':
        return <ScatterIcon size={size} />;
      case 'pie':
        return <PieIcon size={size} />;
      case 'donut':
        return <DonutIcon size={size} />;
      default:
        return <BarGroupedIcon size={size} />;
    }
  }
  if (isWidgetOfKind(widget, 'filter')) {
    const filterType = widget.config.filterWidgetType ?? 'multi-select';
    switch (filterType) {
      case 'toggle':
        return <ButtonFilterWidgetIcon size={size} />;
      case 'date-range':
      case 'slider':
        return <DateFilterWidgetIcon size={size} />;
      default:
        return <ListFilterWidgetIcon size={size} />;
    }
  }
  if (widget.kind === 'kpi') {
    return <KpiWidgetIcon size={size} />;
  }
  if (widget.kind === 'grid') {
    return <TableWidgetIcon size={size} />;
  }
  if (widget.kind === 'text') {
    return <TextWidgetIcon size={size} />;
  }
  if (widget.kind === 'pivot') {
    return <PivotWidgetIcon size={size} />;
  }
  if (widget.kind === 'map') {
    return <MapWidgetIcon size={size} />;
  }
  return null;
}

const KPI_AGG_PREFIXES_DEFAULT: Record<StudioKpiAggregation, keyof StudioLocaleText> = {
  sum: 'widgetAggPrefixSum',
  avg: 'widgetAggPrefixAvg',
  count: 'widgetAggPrefixCount',
  min: 'widgetAggPrefixMin',
  max: 'widgetAggPrefixMax',
  count_distinct: 'widgetAggPrefixCountDistinct',
};

const CHART_GROUP_BY_PREFIX_KEYS: Record<string, keyof StudioLocaleText> = {
  day: 'widgetGroupByPrefixDay',
  week: 'widgetGroupByPrefixWeek',
  month: 'widgetGroupByPrefixMonth',
  quarter: 'widgetGroupByPrefixQuarter',
  year: 'widgetGroupByPrefixYear',
};

function summarizeFieldLabels(labels: string[], localeText: StudioLocaleText, maxVisible = 3) {
  if (labels.length <= maxVisible) {
    return labels.join(', ');
  }

  return `${labels.slice(0, maxVisible).join(', ')} ${localeText.widgetAutoTitleMoreFields(labels.length - maxVisible)}`;
}

type UnitKey = RelativeDateValue['unit'];

const UNIT_SINGULAR_KEYS: Record<UnitKey, keyof StudioLocaleText> = {
  year: 'dateFilterUnitYear',
  month: 'dateFilterUnitMonth',
  week: 'dateFilterUnitWeek',
  day: 'dateFilterUnitDay',
  hour: 'dateFilterUnitHour',
  minute: 'dateFilterUnitMinute',
  second: 'dateFilterUnitSecond',
};

const UNIT_PLURAL_KEYS: Record<UnitKey, keyof StudioLocaleText> = {
  year: 'dateFilterUnitYears',
  month: 'dateFilterUnitMonths',
  week: 'dateFilterUnitWeeks',
  day: 'dateFilterUnitDays',
  hour: 'dateFilterUnitHours',
  minute: 'dateFilterUnitMinutes',
  second: 'dateFilterUnitSeconds',
};

/**
 * Returns a compact human-readable label for a date filter value,
 * e.g. "Last 12 months", "Next 7 days", or a formatted absolute date.
 */
export function formatDateFilterLabel(
  filter: StudioFilterState,
  localeText: StudioLocaleText = DEFAULT_STUDIO_LOCALE_TEXT,
): string {
  const { value, value2, operator } = filter;

  if (operator === 'between') {
    // Named presets (e.g. "Last 12 months") — show the preset label directly.
    if (
      filter.scope.kind === 'dashboard-date-range' &&
      filter.dateRangePreset &&
      filter.dateRangePreset !== 'custom'
    ) {
      const PRESET_LOCALE_KEY: Partial<Record<StudioDateRangePreset, keyof StudioLocaleText>> = {
        this_month: 'dateRangePresetThisMonth',
        last_3_months: 'dateRangePresetLast3Months',
        last_12_months: 'dateRangePresetLast12Months',
        ytd: 'dateRangePresetYTD',
      };
      const localeKey = PRESET_LOCALE_KEY[filter.dateRangePreset];
      if (localeKey) {
        return localeText[localeKey] as string;
      }
    }
    let resolvedFrom: unknown;
    let resolvedTo: unknown;
    {
      const range = value as { from?: unknown; to?: unknown } | null;
      resolvedFrom = range?.from;
      resolvedTo = range?.to;
    }
    const from = resolvedFrom;
    const to = resolvedTo;
    if (isRelativeDateValue(from) && isRelativeDateValue(to)) {
      return `${formatRelativeDateValue(from, localeText)} \u2013 ${formatRelativeDateValue(to, localeText)}`;
    }
    if (from && to) {
      return `${formatAbsoluteDate(from)} \u2013 ${formatAbsoluteDate(to)}`;
    }
    if (from) {
      return localeText.dateFilterFrom(
        isRelativeDateValue(from)
          ? formatRelativeDateValue(from, localeText)
          : formatAbsoluteDate(from),
      );
    }
    return '';
  }

  if (isRelativeDateValue(value)) {
    const label = formatRelativeDateValue(value, localeText);
    if (operator === 'less_than_or_equal' || operator === 'less_than') {
      return localeText.dateFilterUpTo(label.toLowerCase());
    }
    return label;
  }

  if (operator === 'greater_than_or_equal' || operator === 'greater_than') {
    return localeText.dateFilterSince(formatAbsoluteDate(value));
  }
  if (operator === 'less_than_or_equal' || operator === 'less_than') {
    if (value2 !== undefined && value2 !== null) {
      return `${formatAbsoluteDate(value)} \u2013 ${formatAbsoluteDate(value2)}`;
    }
    return localeText.dateFilterUntil(formatAbsoluteDate(value));
  }

  return '';
}

function formatRelativeDateValue(rel: RelativeDateValue, localeText: StudioLocaleText): string {
  const singularKey = UNIT_SINGULAR_KEYS[rel.unit];
  const pluralKey = UNIT_PLURAL_KEYS[rel.unit];
  const singular = singularKey ? (localeText[singularKey] as string) : rel.unit;
  const plural = pluralKey ? (localeText[pluralKey] as string) : `${rel.unit}s`;
  const unitLabel = rel.amount === 1 ? singular : plural;
  if (rel.direction === 'past') {
    return localeText.dateFilterLast(rel.amount, unitLabel);
  }
  return localeText.dateFilterNext(rel.amount, unitLabel);
}

/** Matches a canonical date-only cell value, e.g. `'2024-03-15'`. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function formatAbsoluteDate(value: unknown): string {
  if (!value) {
    return '';
  }
  // A canonical date-only string is anchored to UTC midnight by `new Date(...)`;
  // formatting that instant through the LOCAL calendar (`toLocaleDateString`) below
  // day-shifts it for any viewer west of UTC (e.g. `2024-03-15` renders as "Mar 14") —
  // the display-side twin of the ingestion day-shift bug class `temporalUtils.ts`
  // already guards against for date-only values (finding 2.15). Parse the Y/M/D
  // components directly and construct a LOCAL `Date` from them so the displayed
  // calendar date matches the stored one regardless of the viewer's offset.
  if (typeof value === 'string' && DATE_ONLY_RE.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) {
    return String(value);
  }
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Returns an auto-generated subtitle for a KPI widget based on its date filter.
 * Returns `null` if no relevant date filter is found.
 */
export function inferKpiDateSubtitle(
  widget: StudioWidget,
  filters: StudioFilterState[],
  localeText: StudioLocaleText = DEFAULT_STUDIO_LOCALE_TEXT,
): string | null {
  if (widget.kind !== 'kpi') {
    return null;
  }
  const relevant = filters.filter(
    (f) =>
      (f.scope.kind === 'page' ||
        f.scope.kind === 'dashboard-date-range' ||
        (f.scope.kind === 'widget' && f.scope.widgetId === widget.id)) &&
      (f.fieldType === 'date' || f.fieldType === 'datetime'),
  );
  const dateFilter = relevant[0];
  if (!dateFilter) {
    return null;
  }
  return formatDateFilterLabel(dateFilter, localeText) || null;
}

/**
 * Infer a human-readable title and subtitle for a widget based on its current config.
 * Used when titleMode/subtitleMode is 'auto' (the default).
 */
export function inferWidgetTitles(
  widget: StudioWidget,
  dataSources: Record<string, StudioDataSource>,
  localeText: StudioLocaleText = DEFAULT_STUDIO_LOCALE_TEXT,
): { title: string; subtitle: string } {
  const source = widget.sourceId ? dataSources[widget.sourceId] : undefined;
  // This builder branches on `widget.kind` but reads a single pre-extracted
  // `config` local across every case, so it operates across kinds by design —
  // read it through the flat cross-kind `StudioWidgetConfig` patch type.
  const config: StudioWidgetConfig = widget.config;

  // Pre-build a Map for O(1) field lookups on the primary source (avoids O(F) per field)
  const primaryFieldMap = new Map(source?.fields?.map((f) => [f.id, f.label]) ?? []);

  const findFieldLabel = (fieldId: string | undefined, sourceId?: string): string | undefined => {
    if (!fieldId) {
      return undefined;
    }
    if (sourceId) {
      // Cross-source lookup (rare — e.g. KPI sparkline from related source)
      const ds = dataSources[sourceId];
      return ds?.fields.find((f) => f.id === fieldId)?.label;
    }
    return primaryFieldMap.get(fieldId);
  };

  const aggPrefix = (agg: StudioKpiAggregation | undefined, fallback: StudioKpiAggregation) => {
    const key = KPI_AGG_PREFIXES_DEFAULT[agg ?? fallback];
    return (localeText[key] as string) ?? '';
  };

  switch (widget.kind) {
    case 'chart': {
      const xLabel = findFieldLabel(config.xField);
      const yLabels = (
        config.ySeries ?? (config.yField ? [{ fieldId: config.yField }] : [])
      ).flatMap((s) => {
        const label = findFieldLabel(s.fieldId);
        return label ? [label] : [];
      });

      const seriesLabel = findFieldLabel(config.seriesField);
      const chartType = config.chartType ?? 'bar';
      const isScatter = chartType === 'scatter';
      const groupByKey = config.xGroupBy ? CHART_GROUP_BY_PREFIX_KEYS[config.xGroupBy] : undefined;
      const groupByTitlePrefix = groupByKey ? (localeText[groupByKey] as string) : undefined;

      let title = source
        ? `${source.label} ${localeText.widgetAutoTitleSourceSuffixChart}`
        : localeText.widgetAutoTitleChart;
      if (isScatter && xLabel && yLabels.length > 0) {
        title = `${yLabels[0]} ${localeText.widgetAutoTitleVs} ${xLabel}`;
      } else if (groupByTitlePrefix) {
        const metricLabel = yLabels.length > 0 ? yLabels.join(', ') : title;
        title = `${groupByTitlePrefix} ${metricLabel}`;
        if (seriesLabel) {
          title = `${title} ${localeText.widgetAutoTitleBy} ${seriesLabel}`;
        }
      } else if (yLabels.length > 0 && xLabel) {
        title = `${yLabels.join(', ')} ${localeText.widgetAutoTitleBy} ${xLabel}`;
      } else if (yLabels.length > 0) {
        title = yLabels.join(', ');
      }

      const splitLabel =
        seriesLabel && !groupByTitlePrefix
          ? `${localeText.widgetAutoTitleSplitBy} ${seriesLabel}`
          : '';
      const subtitleParts = [source?.label, splitLabel].filter(Boolean);
      const subtitle = subtitleParts.join(' · ');

      return { title, subtitle };
    }

    case 'kpi': {
      const fieldLabel = findFieldLabel(config.kpiValueField);
      const prefix = aggPrefix(config.kpiAggregation, 'sum');
      const fallbackTitle = source
        ? `${source.label} ${localeText.widgetAutoTitleSourceSuffixKpi}`
        : localeText.widgetAutoTitleKpi;
      const title = fieldLabel ? `${prefix} ${fieldLabel}`.trim() : fallbackTitle;
      return { title, subtitle: '' };
    }

    case 'grid': {
      const title = source?.label ?? localeText.widgetAutoTitleTable;
      const visibleColumnLabels = (
        config.columns?.length
          ? columnFieldIds(config.columns)
          : (source?.fields.map((f) => f.id) ?? [])
      ).flatMap((fieldId) => {
        const label = findFieldLabel(fieldId);
        return label ? [label] : [];
      });

      const subtitle =
        visibleColumnLabels.length > 0 ? summarizeFieldLabels(visibleColumnLabels, localeText) : '';

      return { title, subtitle };
    }

    case 'filter': {
      const fieldLabel = findFieldLabel(config.filterWidgetField, config.filterWidgetSourceId);
      const title = fieldLabel
        ? `${localeText.widgetAutoTitleFilterPrefix}: ${fieldLabel}`
        : localeText.widgetAutoTitleFilter;
      return { title, subtitle: '' };
    }

    case 'pivot': {
      const rowLabel = findFieldLabel(config.pivotRowField);
      const colLabel = findFieldLabel(config.pivotColField);
      let title = localeText.widgetAutoTitlePivot;
      if (rowLabel && colLabel) {
        title = `${rowLabel} ${localeText.widgetAutoTitleBy} ${colLabel}`;
      } else if (source) {
        title = `${source.label} ${localeText.widgetAutoTitleSourceSuffixPivot}`;
      }
      return { title, subtitle: source?.label ?? '' };
    }

    case 'map': {
      const valueLabel = findFieldLabel(config.mapValueField);
      const prefix = aggPrefix(config.mapAggregation, 'sum');
      let title = localeText.widgetAutoTitleMap;
      if (valueLabel) {
        title = `${prefix} ${valueLabel} ${localeText.widgetAutoTitleByCountry}`.trim();
      } else if (source) {
        title = `${source.label} ${localeText.widgetAutoTitleSourceSuffixMap}`;
      }
      return { title, subtitle: source?.label ?? '' };
    }

    case 'text':
      return {
        title: widget.title || localeText.widgetAutoTitleDefault,
        subtitle: widget.subtitle ?? '',
      };

    default:
      return {
        title: widget.title || widget.kind || localeText.widgetAutoTitleDefault,
        subtitle: widget.subtitle ?? '',
      };
  }
}

/**
 * Export grid data as CSV
 */
/**
 * Build a CSV string for the given widget/source/rows without triggering a download.
 * Exported for testing.
 *
 * `rows` must already reflect any cross-source display-column enrichment (see
 * `internals/crossSourceEnrichment.ts`'s `enrichWithCrossSourceFields`, applied for display by
 * `useWidgetRows.ts` and mirrored for export by `StudioWidgetCard/widgetExport.ts`'s
 * `runWidgetExport`) — this function has no knowledge of relationships/data sources and simply
 * reads `row[col]` for each configured column, so a caller that forgets to enrich will silently
 * export an empty column for any cross-source field (finding 2.19).
 *
 * `expressionFields` (the widget's own-source calculated columns) are folded into the same
 * field-id → field-def lookup `dataSource.fields` uses, matching the on-screen grid's resolution
 * (`StudioGridWidget.tsx`'s column builder reads `dataSource.fields.find(...) ?? expressionFields.find(...)`).
 * Without this an expression-field column's CSV header fell back to the raw field id and its
 * values skipped number/currency/precision formatting entirely — the exported file silently
 * drifted from what the grid actually rendered (architecture review finding — grid CSV export
 * drifts from on-screen rendering for expression-field columns).
 *
 * `crossSourceFieldDefs` are the resolved field defs for the widget's cross-source columns
 * (a related source's physical field OR its calculated column), produced by
 * `StudioGridWidget.tsx`'s `resolveCrossSourceFieldDefs` — the SAME defs the on-screen grid's
 * column builder uses. Folding them into the lookup makes a cross-source column's CSV header
 * label and number/currency formatting match the rendered grid instead of drifting to the raw
 * field id with no formatting (architecture review finding 2.6).
 */
export function buildCsvContent(
  widget: StudioWidget,
  dataSource: StudioDataSource,
  rows: Record<string, unknown>[],
  expressionFields: StudioExpressionField[] = [],
  crossSourceFieldDefs: StudioDataField[] = [],
): string {
  // CSV export is a grid concern, but the param is typed as the broad
  // `StudioWidget`; read `columns` through the flat cross-kind config type.
  const config = widget.config as StudioWidgetConfig;
  const visibleColumns = config.columns?.length
    ? columnFieldIds(config.columns)
    : dataSource.fields.map((f) => f.id);

  const fieldMap = new Map<string, StudioDataField>(dataSource.fields.map((f) => [f.id, f]));
  // Physical fields take priority (the `has` guard below only fills gaps) — an
  // expression-field id colliding with a real field id should never happen, but this
  // keeps the physical definition authoritative if it does. Expression fields are
  // normalized to the `StudioDataField` shape (defaulting the type-inference-only
  // `type` to `'string'` when absent) rather than widening the map's value type, so
  // this stays a drop-in extension of the existing `fieldMap.get(col)` call sites below.
  for (const ef of expressionFields) {
    if (!fieldMap.has(ef.id)) {
      fieldMap.set(ef.id, {
        id: ef.id,
        label: ef.label,
        type: ef.type ?? 'string',
        format: ef.format,
        precision: ef.precision,
        currencyCode: ef.currencyCode,
      });
    }
  }
  // Cross-source column defs (already normalized to `StudioDataField`) fill the remaining
  // gaps so a cross-source column's header/format matches the rendered grid (finding 2.6).
  for (const def of crossSourceFieldDefs) {
    if (!fieldMap.has(def.id)) {
      fieldMap.set(def.id, def);
    }
  }
  // Header labels always come from user-configured field labels — always text,
  // so always escaped via `escapeCsvCell` (formula-injection neutralization,
  // finding 1.8). Row cells are escaped the same way UNLESS the cell's RUNTIME
  // value is a genuine `number` (finding 1.3 — a "number"-typed column can still
  // hold a non-numeric runtime value from dirty data or a misbehaving adapter,
  // and that value must go through the full formula-injection guard, not skip it
  // based on the column's declared type). A numeric cell is still wrapped in
  // quotes (finding 1.2 — `Intl.NumberFormat`'s default thousands separator, e.g.
  // `1,234.50`, would otherwise split the row into an extra unquoted column) but
  // is exempt from `escapeCsvCell`'s leading-apostrophe rewrite: a genuine number
  // can never itself be interpreted as a spreadsheet formula, and the apostrophe
  // would corrupt a legitimate leading `-` (e.g. `-5`).
  const headers = visibleColumns.map((col) => escapeCsvCell(fieldMap.get(col)?.label ?? col));

  const csvRows = rows.map((row) =>
    visibleColumns
      .map((col) => {
        const value = row[col];
        const field = fieldMap.get(col);
        const strVal = formatFieldValue(value, field);
        if (typeof value === 'number') {
          return quoteNumericCsvCell(strVal);
        }
        return escapeCsvCell(strVal);
      })
      .join(','),
  );

  return [headers.join(','), ...csvRows].join('\n');
}

/**
 * Quote a CSV cell known to come from a genuine runtime `number` value, without
 * applying `escapeCsvCell`'s leading formula-injection apostrophe (see the
 * comment in {@link buildCsvContent} — findings 1.2 & 1.3).
 */
function quoteNumericCsvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Sanitize a filename for download: strips every non-alphanumeric character from
 * the name (collapsing each to `_`), preserving the final `.ext` untouched. This
 * is the "safer" of the two filename-sanitization behaviors previously found
 * across the two CSV export call sites — the grid path stripped non-alphanumeric
 * characters from its filename, the pivot path didn't sanitize `widget.title` at
 * all (finding 3.3). Applying it once inside the shared {@link downloadCsv}
 * keeps every current and future caller consistent without each one having to
 * remember to sanitize its own title.
 */
function sanitizeDownloadFilename(filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex <= 0) {
    return filename.replace(/[^a-z0-9]/gi, '_');
  }
  return `${filename.slice(0, dotIndex).replace(/[^a-z0-9]/gi, '_')}${filename.slice(dotIndex)}`;
}

/**
 * Trigger a browser download of `csv` as a file named `filename` (sanitized via
 * {@link sanitizeDownloadFilename}).
 *
 * Shared by grid CSV export ({@link exportGridToCsv}) and the pivot widget's CSV
 * export (`StudioPivotWidget/pivotUtils.ts`'s `downloadCsv` re-export) — the
 * Blob/`createObjectURL`/anchor-click dance was previously duplicated
 * near-line-for-line in both places, with inconsistent filename sanitization
 * between the two (finding 3.3).
 */
export function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = sanitizeDownloadFilename(filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function exportGridToCsv(
  widget: StudioWidget,
  dataSource: StudioDataSource | undefined,
  rows: Record<string, unknown>[],
  expressionFields: StudioExpressionField[] = [],
  crossSourceFieldDefs: StudioDataField[] = [],
): void {
  if (!dataSource) {
    return;
  }

  const csvContent = buildCsvContent(
    widget,
    dataSource,
    rows,
    expressionFields,
    crossSourceFieldDefs,
  );
  downloadCsv(csvContent, `${widget.title}_export.csv`);
}

/**
 * Export chart as PNG image
 */
/**
 * Walk all elements in an SVG and inline their computed styles.
 * This ensures fonts, colors, and other CSS-driven properties survive serialization
 * into a standalone SVG/PNG (where stylesheets and CSS variables are unavailable).
 */
function inlineComputedStyles(svgElement: SVGElement): void {
  // Properties that need to be inlined for a faithful export
  const STYLE_PROPS = [
    'fill',
    'fill-opacity',
    'stroke',
    'stroke-opacity',
    'stroke-width',
    'stroke-dasharray',
    'opacity',
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'text-anchor',
    'dominant-baseline',
    'color',
    'letter-spacing',
  ];

  const elements = svgElement.querySelectorAll('*');
  elements.forEach((el) => {
    if (!(el instanceof Element)) {
      return;
    }
    const computed = window.getComputedStyle(el);
    const existing = (el as SVGElement).style;
    for (const prop of STYLE_PROPS) {
      const value = computed.getPropertyValue(prop);
      if (value && !existing.getPropertyValue(prop)) {
        existing.setProperty(prop, value);
      }
    }
  });
}

/**
 * Walk up from `el` and return the first ancestor's computed background colour that is not
 * fully transparent — i.e. the surface the chart visually sits on. Returns `undefined` when
 * nothing opaque is found (or outside the browser), so callers can fall back.
 */
function resolveOpaqueBackground(el: HTMLElement | null): string | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  // Matches a fully-transparent colour: `transparent`, or an rgba() whose alpha is 0. A pure
  // opaque `rgb(0, 0, 0)` (no alpha component) is intentionally not matched.
  const isTransparent = (bg: string): boolean =>
    bg === 'transparent' || /^rgba\(\s*[\d.]+,\s*[\d.]+,\s*[\d.]+,\s*0(\.0+)?\s*\)$/.test(bg);
  let node: HTMLElement | null = el;
  while (node) {
    const bg = window.getComputedStyle(node).backgroundColor;
    if (bg && !isTransparent(bg)) {
      return bg;
    }
    node = node.parentElement;
  }
  return undefined;
}

export function exportChartToPng(
  widget: StudioWidget,
  chartContainer: HTMLElement | null,
  backgroundColor?: string,
): void {
  if (!chartContainer) {
    return;
  }

  const svg = chartContainer.querySelector('svg');
  if (!svg) {
    return;
  }

  // Inline computed styles on the live SVG elements before cloning so that
  // theme fonts and MUI CSS variables are captured in the serialized output.
  inlineComputedStyles(svg);

  // Clone the SVG to avoid modifying the original
  const clonedSvg = svg.cloneNode(true) as SVGElement;

  const svgRect = svg.getBoundingClientRect();
  clonedSvg.setAttribute('width', String(svgRect.width));
  clonedSvg.setAttribute('height', String(svgRect.height));

  // Serialize SVG to string
  const serializer = new XMLSerializer();
  const svgString = serializer.serializeToString(clonedSvg);

  // Create a canvas
  const canvas = document.createElement('canvas');
  const scale = 2; // Higher resolution
  canvas.width = svgRect.width * scale;
  canvas.height = svgRect.height * scale;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }

  ctx.scale(scale, scale);
  // Resolve the fill from the live DOM (the first opaque ancestor behind the chart, i.e. the
  // widget card) rather than a theme value. Under `cssVariables` themes `theme.palette.*` is
  // pinned to the default (light) colour scheme, so a passed-in value would export a light
  // background even in dark mode — making light chart text unreadable. The DOM-resolved colour
  // always reflects the active scheme. Fall back to the passed colour, then white.
  ctx.fillStyle = resolveOpaqueBackground(chartContainer) ?? backgroundColor ?? 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Convert SVG to image
  const img = new Image();
  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  img.onload = () => {
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);

    // Download the PNG
    const pngUrl = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = pngUrl;
    link.download = `${widget.title.replace(/[^a-z0-9]/gi, '_')}_chart.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  // Without an error handler, a failed SVG-blob image load (e.g. the browser rejects the
  // serialized SVG) silently no-ops AND leaks the object URL `onload` would have revoked
  // (finding 3.10). There's no existing user-facing error surface for this export path, so
  // a console warning is the best available signal short of adding new UI.
  img.onerror = () => {
    URL.revokeObjectURL(url);
    console.warn('MUI X Studio: failed to export chart to PNG (image failed to load).');
  };

  img.src = url;
}
