/**
 * Pure widget helpers: kind predicates, inferred titles and subtitles, and CSV export.
 *
 * The counterpart to `widgetPresentation.tsx`, which holds the exports that return React
 * elements. Nothing here renders anything.
 *
 * **The split is not cosmetic.** `StudioController` reaches `inferWidgetTitles` through
 * `widgetConfigSanitization`, so while these helpers shared a file with thirty icon components,
 * the controller — and with it every module that imports it — could not be loaded without React.
 * That was the single import edge standing between this package and a framework-agnostic core.
 * See `docs/SYSTEM_ARCHITECTURE_REVIEW.md`, finding A1.
 */
import type {
  BuiltinStudioWidgetKind,
  StudioDataField,
  StudioDataSource,
  StudioDateRangePreset,
  StudioExpressionField,
  StudioFilterState,
  StudioGridColumn,
  StudioKpiAggregation,
  StudioWidget,
  StudioWidgetConfig,
  StudioWidgetKind,
} from '../models';
import { lookup } from '../utils/safeLookup';
import { isRelativeDateValue } from './filterUtils';
import { selectFiltersForWidget } from './filterScoping';
import type { RelativeDateValue } from './filterTypes';
import { formatFieldValue } from './numberFormat';
import { getStudioLocale } from './studioLocale';
import { escapeCsvCell } from './csvUtils';
import { DEFAULT_STUDIO_LOCALE_TEXT, type StudioLocaleText } from './localeText';
import { createDefaultWidget } from './widgetFactory';

// Re-exported so callers reaching for the widget factory alongside these helpers have one
// import. Pure — `widgetFactory.ts` builds a plain `StudioWidget`, it renders nothing.
export { createDefaultWidget };

/**
 * Kind-derived rule for the BUILT-IN widget kinds only: every built-in except `text` needs a
 * data source. Do not call this with a custom kind — it answers `true` for anything it doesn't
 * recognize, which is the opposite of `StudioCustomWidgetDef.requiresDataSource`'s documented
 * `@default false`. Use {@link resolveWidgetRequiresDataSource} whenever a custom kind can
 * reach the call site.
 */
export function widgetKindRequiresDataSource(kind: StudioWidgetKind) {
  return kind !== 'text';
}

/**
 * The finite set of built-in widget kinds. Typed as `Record<BuiltinStudioWidgetKind, true>` so
 * adding a built-in kind without listing it here is a compile error.
 */
const BUILTIN_WIDGET_KINDS: Record<BuiltinStudioWidgetKind, true> = {
  text: true,
  kpi: true,
  chart: true,
  grid: true,
  filter: true,
  pivot: true,
  map: true,
};

/** Whether `kind` is one of the seven built-in widget kinds (as opposed to a custom kind). */
export function isBuiltinWidgetKind(kind: StudioWidgetKind): kind is BuiltinStudioWidgetKind {
  // `Object.hasOwn`, not `in`: `widget.kind` is doc-authored (and reachable from an AI tool
  // call), so a bogus kind like `'constructor'` must not resolve through the prototype chain.
  return Object.hasOwn(BUILTIN_WIDGET_KINDS, kind);
}

/**
 * Single source of truth for "does creating/configuring a widget of this kind require a data
 * source?", for built-in AND custom kinds.
 *
 * A widget definition that declares `requiresDataSource` always wins. Otherwise the kind-derived
 * built-in rule applies to built-in kinds, and a custom kind falls back to `false` — matching
 * `StudioCustomWidgetDef.requiresDataSource`'s documented `@default false`. The pre-existing
 * `def?.requiresDataSource !== false` idiom got that backwards, refusing to create (and
 * permanently marking as "unconfigured") every source-less custom widget — banner/logo/iframe
 * tiles, the common case, which can never acquire a `sourceId`.
 *
 * @param kind The widget kind.
 * @param def The widget definition for `kind`, from the custom-widget map or the unified
 *   built-in+custom def map. `undefined` when the kind has no registered definition.
 */
export function resolveWidgetRequiresDataSource(
  kind: StudioWidgetKind,
  def: { requiresDataSource?: boolean } | undefined,
): boolean {
  if (def?.requiresDataSource !== undefined) {
    return def.requiresDataSource;
  }
  return isBuiltinWidgetKind(kind) ? widgetKindRequiresDataSource(kind) : false;
}

/** Extracts the `fieldId` strings from a `StudioGridColumn[]` for callers that only need IDs. */
function columnFieldIds(columns: StudioGridColumn[] | undefined): string[] {
  return columns?.map((c) => c.fieldId) ?? [];
}

const KPI_AGG_PREFIXES_DEFAULT: Record<StudioKpiAggregation, keyof StudioLocaleText> = {
  sum: 'widgetAggPrefixSum',
  avg: 'widgetAggPrefixAvg',
  count: 'widgetAggPrefixCount',
  count_non_null: 'widgetAggPrefixCountValues',
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
      // `dateRangePreset` is doc-authored: index through the prototype-chain-safe `lookup`
      // so a preset named after an `Object.prototype` member ("constructor"/"toString"/…)
      // resolves to `undefined` (falling through to the absolute-range formatting below)
      // instead of an inherited function that `localeText[localeKey]` renders as `undefined`.
      const localeKey = lookup(PRESET_LOCALE_KEY, filter.dateRangePreset);
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
  // `rel.unit` is doc/AI-authored and only checked by `isRelativeDateValue`'s `relative === true`
  // test, so it can be any string. Index through the prototype-chain-safe `lookup`: a unit named
  // after an `Object.prototype` member ("constructor"/"toString"/…) would otherwise resolve an
  // inherited function, pass the `singularKey ?` truthiness check, and render "Last 3 undefined".
  const singularKey = lookup(UNIT_SINGULAR_KEYS, rel.unit);
  const pluralKey = lookup(UNIT_PLURAL_KEYS, rel.unit);
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
  // already guards against for date-only values. Parse the Y/M/D
  // components directly and construct a LOCAL `Date` from them so the displayed
  // calendar date matches the stored one regardless of the viewer's offset.
  if (typeof value === 'string' && DATE_ONLY_RE.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString(getStudioLocale(), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) {
    return String(value);
  }
  return d.toLocaleDateString(getStudioLocale(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Returns an auto-generated subtitle for a KPI widget based on its date filter.
 * Returns `null` if no relevant date filter is found.
 *
 * The date-filter derivation is routed through `selectFiltersForWidget` — the single
 * filter-scoping authority the KPI's trend/sparkline/hover-summary paths already use — before
 * the `findDateFilter`-style matching below, so the auto subtitle honors the `pageId`, the
 * `disabled` flag, and the `dashboard-date-range` sourceId checks. Passing the
 * raw `doc.filters` partition previously let a KPI on page B render page A's "Last 12 months"
 * subtitle (whichever filter came first), or a disabled / different-source date filter, while
 * its value was computed under a different (correctly scoped) filter set. Callers thread the
 * widget's page id (and `crossFilterAllPages`) via `opts`.
 */
export function inferKpiDateSubtitle(
  widget: StudioWidget,
  filters: StudioFilterState[],
  opts: { activePageId?: string; crossFilterAllPages?: boolean } = {},
  localeText: StudioLocaleText = DEFAULT_STUDIO_LOCALE_TEXT,
): string | null {
  if (widget.kind !== 'kpi') {
    return null;
  }
  const scoped = selectFiltersForWidget(filters, {
    widgetId: widget.id,
    widgetSourceId: widget.sourceId,
    activePageId: opts.activePageId,
    crossFilterAllPages: opts.crossFilterAllPages,
  });
  // Narrow the already-scoped set to the same scope kinds + date types the renderer's
  // `findDateFilter` considers (page / dashboard-date-range / this widget's own), and take
  // the first — cross-filter / interactive entries `selectFiltersForWidget` also returns are
  // never surfaced as a subtitle.
  const dateFilter = scoped.find(
    (f) =>
      (f.scope.kind === 'page' ||
        f.scope.kind === 'dashboard-date-range' ||
        (f.scope.kind === 'widget' && f.scope.widgetId === widget.id)) &&
      (f.fieldType === 'date' || f.fieldType === 'datetime'),
  );
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
  // `widget.sourceId` is doc-authored (persisted load / AI `update_widget`), so index the
  // record through the prototype-chain-safe `lookup` — a bare bracket lookup on a source id
  // named after an `Object.prototype` member ("constructor"/"toString"/…) resolves an inherited
  // function whose `.fields` is `undefined`, which sails past every `source?.` check below and
  // throws inside `inferWidgetTitles` — a mutation-time call site (`StudioController.ts`), i.e.
  // above every error boundary.
  const source = lookup(dataSources, widget.sourceId);
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
      // Cross-source lookup (rare — e.g. KPI sparkline from related source). Same
      // doc-authored-key guard as `source` above — `config.filterWidgetSourceId` is the
      // AI-writable id that reaches here — plus an optional `?.fields?.` (matching the
      // `primaryFieldMap` line above) so a source object without a `fields` array can't throw.
      const ds = lookup(dataSources, sourceId);
      return ds?.fields?.find((f) => f.id === fieldId)?.label;
    }
    return primaryFieldMap.get(fieldId);
  };

  const aggPrefix = (agg: StudioKpiAggregation | undefined, fallback: StudioKpiAggregation) => {
    // `agg` is doc/AI-authored — guarded lookup, same reason as the maps above.
    const key = lookup(KPI_AGG_PREFIXES_DEFAULT, agg ?? fallback);
    return key ? ((localeText[key] as string) ?? '') : '';
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
      const groupByKey = lookup(CHART_GROUP_BY_PREFIX_KEYS, config.xGroupBy);
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
          : (source?.fields?.map((f) => f.id) ?? [])
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
 * export an empty column for any cross-source field.
 *
 * `expressionFields` (the widget's own-source calculated columns) are folded into the same
 * field-id → field-def lookup `dataSource.fields` uses, matching the on-screen grid's resolution
 * (`StudioGridWidget.tsx`'s column builder reads `dataSource.fields.find(...) ?? expressionFields.find(...)`).
 * Without this an expression-field column's CSV header fell back to the raw field id and its
 * values skipped number/currency/precision formatting entirely — the exported file silently
 * drifted from what the grid actually rendered (architecture review finding — grid CSV export
 * drifts from on-screen rendering for expression-field columns).
 *
 * `crossSourceFieldDefs` are the resolved field defs for the widget's cross-source columns (a
 * related source's physical field OR its calculated column), produced by `StudioGridWidget.tsx`'s
 * `resolveCrossSourceFieldDefs` — the SAME defs the on-screen grid's column builder uses. Folding
 * them into the lookup makes a cross-source column's CSV header label and number/currency
 * formatting match the rendered grid instead of drifting to the raw field id with no formatting.
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
  // gaps so a cross-source column's header/format matches the rendered grid.
  for (const def of crossSourceFieldDefs) {
    if (!fieldMap.has(def.id)) {
      fieldMap.set(def.id, def);
    }
  }
  // Header labels always come from user-configured field labels — always text, so always escaped
  // via `escapeCsvCell` (formula-injection neutralization). Row cells are escaped the same way
  // UNLESS the cell's RUNTIME value is a genuine `number` (a "number"-typed column can still hold a
  // non-numeric runtime value from dirty data or a misbehaving adapter, and that value must go
  // through the full formula-injection guard, not skip it based on the column's declared type). A
  // numeric cell is still wrapped in quotes (`Intl.NumberFormat`'s default thousands separator,
  // e.g. `1,234.50`, would otherwise split the row into an extra unquoted column) but is exempt
  // from `escapeCsvCell`'s leading-apostrophe rewrite: a genuine number can never itself be
  // interpreted as a spreadsheet formula, and the apostrophe would corrupt a legitimate leading `-`
  // (e.g. `-5`).
  const headers = visibleColumns.map((col) => escapeCsvCell(fieldMap.get(col)?.label ?? col));

  const csvRows = rows.map((row) =>
    visibleColumns
      .map((col) => {
        // `col` is a doc-authored column id: read the row through the prototype-chain-safe
        // `lookup` so a column named after an `Object.prototype` member can't export the
        // inherited function's source text as a cell value instead of an empty cell.
        const value = lookup(row, col);
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
 * Quote a CSV cell known to come from a genuine runtime `number` value, without applying
 * `escapeCsvCell`'s leading formula-injection apostrophe (see the comment in {@link
 * buildCsvContent}.2 & 1.3).
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
 * all. Applying it once inside the shared {@link downloadCsv}
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
 * between the two.
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
