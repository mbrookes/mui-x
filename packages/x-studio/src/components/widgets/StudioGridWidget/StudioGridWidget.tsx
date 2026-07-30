'use client';
import * as React from 'react';
import { Alert } from '@mui/material';
import {
  DataGridPremium,
  useGridApiRef,
  GRID_ROW_GROUPING_SINGLE_GROUPING_FIELD,
  type GridColDef,
  type GridCellParams,
  type GridAggregationFunction,
  type GridAggregationModel,
  type GridRowClassNameParams,
  type GridValidRowModel,
  type GridSortModel,
} from '@mui/x-data-grid-premium';

import type {
  StudioConditionalFormat,
  StudioDataField,
  StudioDataSource,
  StudioDoc,
  StudioExpressionField,
  StudioGridSummaryAggregation,
  StudioRelationship,
  StudioWidgetConfig,
  StudioWidgetOf,
} from '../../../models';
import {
  useStudioController,
  useStudioSelector,
  useStudioLocaleText,
  selectDataSources,
  selectMode,
  selectRelationships,
  selectGlobalCrossFilterMode,
  makeSelectExpressionFieldsForSources,
  makeSelectWidgetActiveCrossFilter,
} from '../../../context';
import { formatFieldValue } from '../../../internals/numberFormat';
import {
  sanitizeCssColor,
  isSafeFontWeightKeyword,
  sanitizeCssIdentifierToken,
  sanitizeFiniteNumber,
} from '../../../internals/cssValueValidation';

import { columnAggKey, computeGridSummary } from '../../../utils/gridSummary';
import { aggregateValues } from '../../../utils/gridGrouping';
import { useWidgetRows } from '../../../internals/useWidgetRows';
import { getRowIdentity } from '../../../internals/rowIdentity';
import {
  buildManyToOneRelationshipIndex,
  getReachableSourceIds,
} from '../../../internals/dataSourceGraph';
import { normalizeJoinKey } from '../../../internals/joinKeys';
import { StudioNoDataOverlay } from '../../../internals/StudioNoDataOverlay';
import { StudioWidgetErrorOverlay } from '../../../internals/StudioWidgetErrorOverlay';
import { crossFilterValueEquals } from '../StudioChartWidget/chartWidgetHelpers';
import { setGridViewSortModel, clearGridViewSortModel } from './gridViewSortRegistry';

/** Maps our model's aggregation names to DataGridPremium built-in function names. */
function toGridAggFn(fn: string): string {
  return fn === 'count' ? 'size' : fn;
}

/**
 * `config.gridSummaryFields`/`config.gridAggregations` are keyed by the composite
 * column key (`sourceId/fieldId` for a cross-source column, bare `fieldId` for a
 * primary one — see `utils/gridSummary.ts`'s shared `columnAggKey`, which
 * `GridSetupPanel` writes with), so that two selected columns sharing a bare field id
 * across sources get independent aggregation-menu entries instead of silently
 * colliding (architecture review: per-column aggregation collision). Aggregating an
 * actual row only ever needs the bare field id though — every row's cell lives under
 * the plain field name regardless of which source it was cross-source-enriched from,
 * and DataGridPremium's own `GridColDef.field`/pinned-summary-row keys are always
 * the bare field id too — so translate composite keys back to their bare field id
 * here, at the single point both the native `aggregationModel` and the
 * summary-row computation read from `config.gridAggregations`/
 * `config.gridSummaryFields`.
 *
 * The translation is driven by `config.columns` — the exact list the producer derived
 * its keys from — never by string surgery on the key itself. Re-deriving the bare id
 * with `key.slice(key.indexOf('/') + 1)` was wrong twice over:
 *
 * - It collapsed `{ total: 'sum', 'customers/total': 'avg' }` back to `{ total: 'avg' }`
 *   (last write wins), so configuring the RELATED column's aggregation silently flipped
 *   the PRIMARY column's footer — re-introducing the very collision the composite key
 *   was introduced to fix. Own-source columns are applied last here, so an own column
 *   always wins a bare-id tie, matching every other own-field-wins guard in this file.
 * - It mangled a field id that legitimately contains a slash: a primary column named
 *   `P/L` (composite key `P/L`, no `sourceId` prefix) resolved to a bare `L`, so its
 *   footer disappeared and an unrelated `L` column inherited its aggregation.
 *
 * A key no configured column claims is passed through untouched (a widget with no
 * explicit `config.columns` renders every source field, and its entries are bare field
 * ids with no column entry to match), but never overwrites a column-resolved entry.
 */
export function resolveAggregationFieldKeys<T>(
  aggregations: Record<string, T> | undefined,
  configColumns: StudioWidgetConfig['columns'],
): Record<string, T> {
  if (!aggregations) {
    return {};
  }
  const resolved = new Map<string, T>();
  const claimedKeys = new Set<string>();
  const columns = configColumns ?? [];
  // Cross-source columns first so an own-source column's entry always wins a tie on
  // the bare field id both resolve to.
  for (const col of [...columns.filter((c) => c.sourceId), ...columns.filter((c) => !c.sourceId)]) {
    const key = columnAggKey(col);
    // `key` is doc-authored, so guard the record index against inherited
    // `Object.prototype` members ("toString"/"constructor"/…) — a bare `in`/bracket
    // lookup would otherwise resolve a function off the prototype chain and configure
    // the column with it as its aggregation.
    if (!Object.hasOwn(aggregations, key)) {
      continue;
    }
    claimedKeys.add(key);
    resolved.set(col.fieldId, aggregations[key]);
  }
  for (const [key, value] of Object.entries(aggregations)) {
    if (!claimedKeys.has(key) && !resolved.has(key)) {
      resolved.set(key, value);
    }
  }
  return Object.fromEntries(resolved) as Record<string, T>;
}

/**
 * fieldId → FK field (on the widget's own source) for every configured column that
 * is cross-source (many-to-one related) AND fanned out by row enrichment
 * (`useWidgetRows.ts`'s `enrichWithCrossSourceFields`) — i.e. the exact set of
 * columns whose value is duplicated across every row sharing the same FK. Mirrors
 * `utils/gridGrouping.ts`'s `crossSourceMeta` construction in `buildGroupedGridRows`.
 *
 * Used by `makeFanoutSafeAggregationFunction` below to dedupe by FK before reducing,
 * so grouping+aggregating a fanned-out column (e.g. summing `orders.total` on an
 * `order_items` grid grouped by category) counts each linked one-side record once,
 * not once per many-side row (architecture review finding 2.7).
 *
 * `ownFieldIds` is the widget's own (primary-source + own expression-field) field id
 * set. A cross-source configured column can share a bare `fieldId` with one of the
 * widget's own fields (e.g. an `order_items` grid's own `total` column plus a related
 * `customers.total` column) — without this guard the FK-dedupe entry keyed by that bare
 * id would apply to the OWN column too, deduping it down to one row per related record
 * and silently dropping the true per-row total (finding 7). Mirrors the own-field-wins
 * guard `buildGridColumnDefs`'s `!field && !expressionField` check, `computeOrderedFieldIds`'s
 * first-occurrence dedupe, and `crossSourceEnrichment.ts`'s `fieldId in row` check already
 * apply at their respective sites.
 */
export function resolveCrossSourceFkFields(
  configColumns: StudioWidgetConfig['columns'],
  widgetSourceId: string | undefined,
  relationships: StudioRelationship[],
  ownFieldIds: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const map = new Map<string, string>();
  if (!widgetSourceId) {
    return map;
  }
  const relIndex = buildManyToOneRelationshipIndex(widgetSourceId, relationships);
  for (const c of configColumns ?? []) {
    if (!c.sourceId || c.sourceId === widgetSourceId) {
      continue;
    }
    // Own/primary field wins on a same-named collision — see the doc comment above.
    if (ownFieldIds.has(c.fieldId)) {
      continue;
    }
    const rel = relIndex.get(c.sourceId);
    if (rel) {
      map.set(c.fieldId, rel.sourceField);
    }
  }
  return map;
}

/**
 * A `GridAggregationFunction` that dedupes fanned-out cross-source values before
 * reducing, so the native DataGridPremium `rowGroupingModel`/`aggregationModel`
 * path no longer double-counts a many-to-one joined column the way a naive per-row
 * sum would (architecture review finding 2.7). Also used for the widget's OWN
 * (non-cross-source) fields — for those, `crossSourceFkFields` has no entry, so the
 * dedupe key falls back to the row's own (always-unique, see the `rows` memo
 * below) id, making the dedupe pass a no-op and preserving prior behaviour exactly.
 *
 * The own-field fallback key is the row's `__rowId` (the always-unique grid row identity
 * stamped by the `rows` memo below), NOT `row.id` — a nullable/duplicated `id` column
 * would otherwise make every own-field value share one dedupe key (or be dropped entirely
 * as an unlinked null FK), collapsing the aggregation to a single row.
 *
 * `getCellValue` extracts a `(dedupeKey, value)` pair per row instead of the raw
 * cell value (DataGridPremium's supported extensibility point for aggregating from
 * more than one row field — see `GridAggregationFunction.getCellValue`); `apply`
 * dedupes by that key using the same join-key coercion policy as the rest of the
 * pipeline (`normalizeJoinKey`) before delegating to the shared reducer
 * (`utils/gridGrouping.ts`'s `aggregateValues`, the same one `symmetricAggregate`
 * uses) — a missing FK contributes nothing, matching `symmetricAggregate`.
 */
export function makeFanoutSafeAggregationFunction(
  fn: StudioGridSummaryAggregation,
  crossSourceFkFields: Map<string, string>,
  columnTypes?: string[],
): GridAggregationFunction<{ dedupeKey: unknown; value: unknown }, number | null> {
  return {
    getCellValue: ({ row, field }) => {
      const fkField = crossSourceFkFields.get(field);
      const record = row as Record<string, unknown>;
      return {
        // eslint-disable-next-line no-underscore-dangle -- internal grid row identity (see the doc comment above)
        dedupeKey: fkField ? record[fkField] : (record.__rowId ?? record.id),
        value: record[field],
      };
    },
    apply: ({ values }) => {
      const seen = new Set<string>();
      const deduped: unknown[] = [];
      for (const entry of values) {
        if (!entry) {
          continue;
        }
        // A missing/unlinked FK never joins (matches `symmetricAggregate`'s
        // null-FK-drops-nothing policy) — contribute nothing rather than guess.
        const key = normalizeJoinKey(entry.dedupeKey);
        if (key === null || seen.has(key)) {
          continue;
        }
        seen.add(key);
        deduped.push(entry.value);
      }
      return aggregateValues(deduped, fn);
    },
    columnTypes,
    // Aggregated count/distinct-count values aren't in the same unit as the
    // underlying field (e.g. a currency column's count is a plain integer), so
    // the column's own value formatter must not apply — mirrors DataGridPremium's
    // native `size` function.
    // All three counts are tallies, not quantities in the column's unit, so none of them
    // carries the column's currency/percent formatting.
    hasCellUnit: fn !== 'count' && fn !== 'count_non_null' && fn !== 'count_distinct',
  };
}

/**
 * Column render order follows the user-configured order (`configColumns`, as
 * authored via drag-and-drop / keyboard reorder in `GridSetupPanel`), not the
 * data-source field order — configured fields first (in their stored order),
 * then any remaining fields not yet added to `config.columns`. (Finding 1.2:
 * `config.columns` used to drive only visibility, never order.)
 *
 * Bare field ids are de-duplicated: two configured columns can share a bare
 * `fieldId` when a cross-source column collides with a primary one (e.g. a primary
 * `name` plus a related `customers.name`). Emitting the id twice would build two
 * `GridColDef`s with the same `field` — a duplicate React key with undefined
 * DataGridPremium behaviour (finding T1.2). The first occurrence wins, so the
 * primary column (whose own-source cell value the enrichment guard now preserves)
 * renders and the colliding cross-source duplicate is dropped.
 */
export function computeOrderedFieldIds(
  configColumns: StudioWidgetConfig['columns'],
  allFieldIds: string[],
): string[] {
  const configuredSet = new Set<string>();
  const configuredIds: string[] = [];
  for (const c of configColumns ?? []) {
    if (allFieldIds.includes(c.fieldId) && !configuredSet.has(c.fieldId)) {
      configuredSet.add(c.fieldId);
      configuredIds.push(c.fieldId);
    }
  }
  const remaining = allFieldIds.filter((id) => !configuredSet.has(id));
  return [...configuredIds, ...remaining];
}

/**
 * Resolves the field definition for every CROSS-SOURCE configured column (a
 * `config.columns` entry whose `sourceId` differs from the widget's own source) by
 * looking it up on `dataSources[c.sourceId]` — the exact same resolution
 * `useWidgetRows.ts`'s row enrichment already performs for the VALUES of these
 * columns (see `enrichWithCrossSourceFields`).
 *
 * Before this, `computeOrderedFieldIds` only ever saw the widget's own source's
 * field ids plus expression-field ids (`allFieldIds`), so a configured cross-source
 * column's id never appeared there and was silently filtered out — the column had
 * a real, enriched value on every row, but no `GridColDef` was ever built for it and
 * it never rendered (architecture review finding 1.1). Exported so both the
 * component and its tests exercise the identical resolution.
 *
 * A related source's **calculated column** (an expression field owned by `c.sourceId`)
 * is also offered by `GridSetupPanel`, but has no physical field def — it is resolved
 * here by falling back to the related source's non-measure `expressionFields`, normalized
 * to the `StudioDataField` shape (so its label/format/type feed the column def and CSV
 * export the same way a physical cross-source column does). Without this the calculated
 * cross-source column was selectable but produced no column def, so it never rendered
 * (architecture review finding 2.3).
 */
export function resolveCrossSourceFieldDefs(
  configColumns: StudioWidgetConfig['columns'],
  ownSourceId: string | undefined,
  dataSources: Record<string, StudioDataSource>,
  expressionFields: StudioExpressionField[] = [],
): Map<string, StudioDataField> {
  const map = new Map<string, StudioDataField>();
  for (const c of configColumns ?? []) {
    if (!c.sourceId || c.sourceId === ownSourceId) {
      continue;
    }
    // `c.sourceId` is doc-authored (part of `StudioWidgetConfig['columns']`), so guard the
    // record index against inherited keys: a key like "toString"/"constructor" would otherwise
    // resolve a function off `Object.prototype` instead of "not found", and that truthy
    // non-source object slips past `?.fields` and throws (prototype-chain key lookup fix,
    // matching `makeSelectWidgetSource` in `context/selectors.ts`).
    const source = Object.hasOwn(dataSources, c.sourceId) ? dataSources[c.sourceId] : undefined;
    const field = source?.fields.find((f) => f.id === c.fieldId);
    if (field) {
      map.set(c.fieldId, field);
      continue;
    }
    // Related-source calculated column (finding 2.3) — resolve from the related source's
    // own non-measure expression fields.
    const ef = expressionFields.find(
      (candidate) =>
        candidate.id === c.fieldId && candidate.sourceId === c.sourceId && !candidate.isMeasure,
    );
    if (ef) {
      map.set(c.fieldId, {
        id: ef.id,
        label: ef.label,
        type: ef.type ?? 'number',
        format: ef.format,
        precision: ef.precision,
        currencyCode: ef.currencyCode,
      });
    }
  }
  return map;
}

/**
 * Row id stamped onto the single pinned bottom row that carries the grid's summary.
 * Its cells hold pre-formatted strings from `computeGridSummary` (which returns a
 * `Record<string, string>`), so they must bypass the columns' own value formatting.
 */
export const GRID_SUMMARY_ROW_ID = '__summary__';

/**
 * Reads a cell as a number for display formatting, or `null` when it is not numeric.
 *
 * CSV/JSON sources have no native number type, so a `type: 'number'` measure routinely
 * arrives as a numeric string (see `coerceAggregateValue`'s note in `aggregate.ts`), and
 * L1 `normalizeDataSourceRows` canonicalizes only `date`/`datetime` — numbers are never
 * coerced. Deliberately narrower than `coerceAggregateValue`: booleans are left alone
 * here, because rendering `true` as `$1.00` in a cell would invent a quantity rather than
 * present one.
 */
function readCellNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isNaN(value) ? null : value;
  }
  // `Number('')` and `Number('  ')` are both `0`, so a blank cell must not become a zero.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Builds the grid's `GridColDef[]` for the given (already-ordered) field ids,
 * resolving each field's definition from — in priority order — the widget's own
 * data source, its (own-source) expression fields, and finally
 * `crossSourceFieldDefs` (see {@link resolveCrossSourceFieldDefs}).
 *
 * Exported so a test can assert the production column-def path actually produces a
 * `GridColDef` for a configured cross-source column, without bypassing it via a
 * `slotProps.dataGrid.columns` override (architecture review finding 1.1's
 * regression-test gap).
 */
export function buildGridColumnDefs(
  orderedFieldIds: string[],
  dataSource: StudioDataSource | undefined,
  expressionFields: StudioExpressionField[],
  crossSourceFieldDefs: Map<string, StudioDataField>,
  isEditable: boolean,
  pkField: string | undefined,
): GridColDef[] {
  return orderedFieldIds.map((fieldName) => {
    const field = dataSource?.fields.find((candidate) => candidate.id === fieldName);
    const expressionField = expressionFields.find((candidate) => candidate.id === fieldName);
    const crossSourceField =
      !field && !expressionField ? crossSourceFieldDefs.get(fieldName) : undefined;
    const fieldType = field?.type ?? expressionField?.type ?? crossSourceField?.type;
    const fieldFormat = field?.format ?? expressionField?.format ?? crossSourceField?.format;
    const fieldPrecision =
      field?.precision ?? expressionField?.precision ?? crossSourceField?.precision;

    return {
      field: fieldName,
      flex: 1,
      headerName: field?.label ?? expressionField?.label ?? crossSourceField?.label ?? fieldName,
      minWidth: 140,
      type: fieldType === 'number' ? 'number' : 'string',
      // Enable editing for non-PK columns when write-back is configured. Cross-source
      // display columns are never editable — write-back only targets the widget's own
      // (primary) table via `gridPkField`, and a cross-source column's value lives on a
      // different table entirely.
      editable: isEditable && fieldName !== pkField && !crossSourceField,
      valueFormatter:
        fieldType === 'number' && fieldFormat
          ? (value: unknown, row: GridValidRowModel) => {
              // Discriminate on the ROW, not on the value's runtime type. The pinned
              // summary row's cells hold pre-formatted strings (e.g. "Total: $1,234") and
              // must pass through untouched — but so did every ordinary data cell holding a
              // numeric STRING, which is exactly how CSV/JSON sources deliver measures. The
              // body then rendered a bare `1234.5` while the summary row and a KPI over the
              // same field both rendered `$1,234.50`.
              // eslint-disable-next-line no-underscore-dangle -- internal grid row identity
              if (row?.__rowId === GRID_SUMMARY_ROW_ID) {
                return typeof value === 'string' ? value : String(value ?? '');
              }
              const numericValue = readCellNumber(value);
              return formatFieldValue(numericValue ?? value, {
                type: 'number',
                format: fieldFormat,
                precision: fieldPrecision,
                currencyCode:
                  field?.currencyCode ??
                  expressionField?.currencyCode ??
                  crossSourceField?.currencyCode,
              });
            }
          : undefined,
    };
  });
}

type EnrichedMutationError = Error & { gridRowId: string; gridField: string };

/**
 * Tags a write-back failure with the row/field being edited so
 * `onProcessRowUpdateError` can revert the stuck cell. Used both for adapter
 * rejections (thrown/rejected `submitMutation` calls) and graceful `{ ok: false }`
 * results, so both failure shapes revert identically.
 */
function toEnrichedMutationError(
  err: unknown,
  rowId: string,
  field: string,
): EnrichedMutationError {
  const error = (err instanceof Error ? err : new Error(String(err))) as EnrichedMutationError;
  error.gridRowId = rowId;
  error.gridField = field;
  return error;
}

export function evalConditionalFormat(rule: StudioConditionalFormat, cellValue: unknown): boolean {
  const { operator, value } = rule;
  if (operator === 'is_empty') {
    return cellValue === null || cellValue === undefined || cellValue === '';
  }
  if (operator === 'is_not_empty') {
    return cellValue !== null && cellValue !== undefined && cellValue !== '';
  }
  if (value === undefined || value === null) {
    return false;
  }
  switch (operator) {
    case 'equals':
    case 'not_equals': {
      // A boolean column's rule value is committed as the STRING "true"/"false"
      // (`GridConditionalFormatSection` routes non-number fields through a plain string
      // text input), while `cellValue` for a boolean column is a raw JS boolean. Loose
      // equality (`true == "true"`) is `false` under JS coercion rules, so an
      // equals/not_equals rule on a boolean column never matched (and not_equals matched
      // every row). Mirrors `filterUtils.ts`'s boolean-as-string branch
      // (`compileSingleCondition`'s `fieldType === 'boolean'` case): coerce a boolean
      // cellValue to its string form before comparing against the string-committed value.
      // An empty cell is matched only by `is_empty`, never by `equals`/`not_equals` — the
      // same rule the numeric comparisons below already enforce. Without this, the loose
      // comparison below made `equals ""` true for a cell holding `0` (`0 == ''`), and
      // `equals 0` true for a cell holding `''`, so a rule meant to flag blanks highlighted
      // every genuine zero in the column.
      if (cellValue === null || cellValue === undefined || cellValue === '') {
        return operator === 'not_equals';
      }
      const isMatch =
        typeof cellValue === 'boolean'
          ? String(cellValue) === String(value)
          : // Loose by design: a rule value committed as a string ("5") must still match a
            // numeric cell (`5`). The empty-cell cases that made `==` unsafe are excluded
            // above, so the remaining coercions are the intended ones.
            // eslint-disable-next-line eqeqeq
            cellValue == value;
      return operator === 'equals' ? isMatch : !isMatch;
    }
    case 'greater_than':
    case 'less_than':
    case 'greater_than_or_equal':
    case 'less_than_or_equal': {
      // A numeric comparison must never match an empty cell: `Number(null)`/`Number('')`
      // coerce to 0, so a `less_than 5` rule would spuriously highlight genuinely empty
      // cells as if they held 0 (finding 3.5). Empty cells are matched only by `is_empty`.
      if (cellValue === null || cellValue === undefined || cellValue === '') {
        return false;
      }
      const cell = Number(cellValue);
      const bound = Number(value);
      if (operator === 'greater_than') {
        return cell > bound;
      }
      if (operator === 'less_than') {
        return cell < bound;
      }
      if (operator === 'greater_than_or_equal') {
        return cell >= bound;
      }
      return cell <= bound;
    }
    case 'contains':
      return String(cellValue ?? '')
        .toLowerCase()
        .includes(String(value).toLowerCase());
    default:
      return false;
  }
}

export interface StudioGridWidgetProps {
  widget: StudioWidgetOf<'grid'>;
  dataSource?: StudioDataSource;
  /** ID of the page this widget belongs to. Used to scope cross-filters to the correct page. */
  pageId: string;
  /** Props forwarded to the underlying `DataGridPremium`. */
  slotProps?: {
    dataGrid?: Partial<import('@mui/x-data-grid-premium').DataGridPremiumProps>;
  };
}

export const StudioGridWidget = React.memo(function StudioGridWidget(props: StudioGridWidgetProps) {
  const { dataSource, widget, pageId, slotProps } = props;
  const controller = useStudioController();
  const localeText = useStudioLocaleText();
  // Full data-source map — needed to resolve cross-source configured columns'
  // field definitions (finding 1.1), the same way `useWidgetRows.ts`'s row
  // enrichment resolves their VALUES.
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  // Header-click sorting is authoring in edit mode and a transient viewing aid in view
  // mode — see `handleSortModelChange` below for the persistence split this drives.
  const mode = useStudioSelector(selectMode);
  // Expression fields for the widget's own source AND every one-hop related source.
  // The related-source subset is needed so a cross-source column that is a related
  // source's calculated column (`GridSetupPanel` offers these) can be resolved to a
  // column def and enriched with a real value (finding 2.3); mirrors the own+related
  // scoping `useWidgetRows` already subscribes to.
  const relevantSourceIds = React.useMemo(
    () =>
      widget.sourceId ? getReachableSourceIds(widget.sourceId, relationships) : new Set<string>(),
    [widget.sourceId, relationships],
  );
  const selectExpressionFields = React.useMemo(
    () => makeSelectExpressionFieldsForSources(relevantSourceIds),
    [relevantSourceIds],
  );
  const allExpressionFields = useStudioSelector(selectExpressionFields);
  // Own-source expression fields only — these are the widget's own calculated columns,
  // resolved/rendered as native columns. Related-source expression fields must NOT leak
  // into this list, or `buildGridColumnDefs`/`allFieldIds` would treat them as own columns.
  const expressionFields = React.useMemo(
    () => allExpressionFields.filter((ef) => ef.sourceId === widget.sourceId),
    [allExpressionFields, widget.sourceId],
  );
  const visibleFields = React.useMemo(
    () =>
      widget.config.columns?.length
        ? widget.config.columns.map((c) => c.fieldId)
        : (dataSource?.fields.map((f) => f.id) ?? []),
    [widget.config.columns, dataSource?.fields],
  );

  // Check if this widget has an active cross-filter (on its own page). Routes through
  // the shared `makeSelectWidgetActiveCrossFilter` selector (finding 3.8) so the grid
  // can no longer diverge from chart/map on the `disabled` flag: a cross-filter that
  // was disabled via the quick-filter-bar chip must NOT count as active here (otherwise
  // the emitting grid still row-highlights it and clicking the same cell would clear the
  // disabled filter instead of applying a fresh enabled one).
  const selectActiveCrossFilter = React.useMemo(
    () => makeSelectWidgetActiveCrossFilter(widget.id, pageId),
    [widget.id, pageId],
  );
  const activeCrossFilter = useStudioSelector(selectActiveCrossFilter);

  // Write-back: enabled when the adapter implements submitMutation and gridPkField is set.
  const pkField = widget.config.gridPkField;
  const isEditable = Boolean(dataSource?.adapter?.submitMutation && pkField);

  // Surfaces failures from `processRowUpdate` (write-back mutation errors) since
  // there is no snackbar/toast in x-studio — see `onProcessRowUpdateError` below.
  const [mutationError, setMutationError] = React.useState<string | null>(null);
  const apiRef = useGridApiRef();

  const crossSourceFieldDefs = React.useMemo(
    () =>
      resolveCrossSourceFieldDefs(
        widget.config.columns,
        widget.sourceId,
        dataSources,
        allExpressionFields,
      ),
    [widget.config.columns, widget.sourceId, dataSources, allExpressionFields],
  );

  // fieldId → declared type, across own-source fields, own-source expression columns,
  // and resolvable cross-source columns. Used by `handleCellClick` to tag a cross-filter
  // emitted from a date/datetime cell with `fieldType` (finding 1.1) so the downstream
  // `compileSingleCondition` day-normalizes both sides — otherwise an `equals` on an
  // L1-normalized date cell (`'2024-01-15'`) never matches a full-ISO/Date value.
  //
  // Own-source fields/expression columns are seeded FIRST, and the cross-source pass below
  // only fills in an id that isn't already present — a cross-source column can share a bare
  // `fieldId` with a primary column (e.g. a primary `total` plus a related `customers.total`),
  // and letting the cross-source def win on that collision would report the OWN column's type
  // as the related column's type (finding 7). Mirrors `buildGridColumnDefs`'s
  // `!field && !expressionField` own-field-wins guard.
  const fieldTypeById = React.useMemo(() => {
    const map = new Map<string, StudioDataField['type']>();
    for (const f of dataSource?.fields ?? []) {
      map.set(f.id, f.type);
    }
    for (const ef of expressionFields) {
      if (ef.type) {
        map.set(ef.id, ef.type);
      }
    }
    for (const [id, def] of crossSourceFieldDefs) {
      if (!map.has(id)) {
        map.set(id, def.type);
      }
    }
    return map;
  }, [dataSource?.fields, expressionFields, crossSourceFieldDefs]);

  // The widget's own (primary-source + own expression-field) field ids — the "primary wins"
  // set used to guard `resolveCrossSourceFkFields` below against a cross-source column that
  // shares a bare fieldId with one of the widget's own fields (finding 7).
  const ownFieldIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const f of dataSource?.fields ?? []) {
      ids.add(f.id);
    }
    for (const ef of expressionFields) {
      ids.add(ef.id);
    }
    return ids;
  }, [dataSource?.fields, expressionFields]);

  // fieldId → FK field, for every configured cross-source column that is fanned out
  // by row enrichment — used to dedupe fan-out double-counting in the native
  // grouping aggregation below (finding 2.7) and the footer summary (finding 1.2).
  // `ownFieldIds` guards against a same-named own-field collision (finding 7).
  const crossSourceFkFields = React.useMemo(
    () =>
      resolveCrossSourceFkFields(
        widget.config.columns,
        widget.sourceId,
        relationships,
        ownFieldIds,
      ),
    [widget.config.columns, widget.sourceId, relationships, ownFieldIds],
  );

  // Related-source EXPRESSION columns (finding 1.1): the shared `useWidgetRows` cross-source
  // enrichment now threads `expressionFields`, so a related-source *calculated* column is
  // L2-enriched and joined onto the widget rows on the shared path — no widget-local
  // supplemental pass is needed here. (This module previously carried its own
  // `enrichRelatedExpressionColumns` pass to patch the gap the shared call left; it was
  // removed once the shared path covered it, to avoid redundant sibling-drift.)

  const aggregationFunctions = React.useMemo<Record<string, GridAggregationFunction>>(
    () => ({
      sum: makeFanoutSafeAggregationFunction('sum', crossSourceFkFields, ['number']),
      avg: makeFanoutSafeAggregationFunction('avg', crossSourceFkFields, ['number']),
      // `number` only — the shared reducer routes every value through
      // `coerceAggregateValue`, which maps a `Date`/date-string to `null` (finding
      // T3.6). Claiming `date`/`dateTime` here made this fan-out-safe override the
      // registered function for those columns, so an AI-/host-configured date
      // min/max resolved to a blank cell instead of the min/max date. The fan-out
      // dedup is irrelevant for dates (they never coerce), so restrict to `number`.
      min: makeFanoutSafeAggregationFunction('min', crossSourceFkFields, ['number']),
      max: makeFanoutSafeAggregationFunction('max', crossSourceFkFields, ['number']),
      // `toGridAggFn` maps our 'count' to the DataGridPremium built-in name 'size'.
      size: makeFanoutSafeAggregationFunction('count', crossSourceFkFields),
      // Not a DataGridPremium built-in — registering it here also fixes the
      // separate (previously silent) gap where `count_distinct` passed through
      // `toGridAggFn` unchanged but had no matching aggregation function, so a
      // `count_distinct` group aggregation rendered nothing.
      count_distinct: {
        ...makeFanoutSafeAggregationFunction('count_distinct', crossSourceFkFields),
        label: localeText.gridSummaryLabelCountDistinct,
      },
      // Also not a DataGridPremium built-in, and for the same reason as `count_distinct` it
      // must be registered here or a `count_non_null` group aggregation renders nothing:
      // `toGridAggFn` passes it through unchanged and the grid finds no matching function.
      count_non_null: {
        ...makeFanoutSafeAggregationFunction('count_non_null', crossSourceFkFields),
        label: localeText.gridSummaryLabelCountValues,
      },
    }),
    [
      crossSourceFkFields,
      localeText.gridSummaryLabelCountDistinct,
      localeText.gridSummaryLabelCountValues,
    ],
  );

  // Build column defs for ALL data source fields (own source + expression fields +
  // resolvable cross-source configured columns) so any field can be used for
  // grouping without dynamically adding/removing column definitions (which causes
  // DataGridPremium to pollute its internal column visibility state).
  const allFieldIds = React.useMemo(() => {
    const ids = [
      ...(dataSource?.fields.map((f) => f.id) ?? []),
      ...expressionFields.map((f) => f.id),
    ];
    const seen = new Set(ids);
    for (const id of crossSourceFieldDefs.keys()) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    return ids;
  }, [dataSource?.fields, expressionFields, crossSourceFieldDefs]);

  const orderedFieldIds = React.useMemo(
    () => computeOrderedFieldIds(widget.config.columns, allFieldIds),
    [widget.config.columns, allFieldIds],
  );

  const columns = React.useMemo<GridColDef[]>(
    () =>
      buildGridColumnDefs(
        orderedFieldIds,
        dataSource,
        expressionFields,
        crossSourceFieldDefs,
        isEditable,
        pkField,
      ),
    [dataSource, expressionFields, orderedFieldIds, crossSourceFieldDefs, isEditable, pkField],
  );

  const {
    filteredRows,
    filteredRowsNoChartCross,
    hasChartCrossFilters,
    isLoading,
    isError,
    errorMessage,
  } = useWidgetRows(widget, dataSource, pageId);

  // `crossFilterMode` is a cross-kind key (declared on the chart config but honored
  // by grids too), so it is read via the flat cross-kind `StudioWidgetConfig`. The
  // dashboard-wide `globalCrossFilterMode` override takes precedence over the
  // widget's own config, mirroring the exact precedence `useWidgetRows` already
  // applies internally to compute `effectiveRows` (finding 1.6) — every other
  // widget kind (chart/KPI/map/pivot) is global-mode-aware; the grid used to
  // resolve its mode locally and ignore both the 'none' setting and the
  // dashboard-wide toggle.
  const globalCrossFilterMode = useStudioSelector(selectGlobalCrossFilterMode);
  const crossFilterMode =
    globalCrossFilterMode ??
    (widget.config as StudioWidgetConfig).crossFilterMode ??
    'cross-highlight';

  // In 'none' mode, only chart-click CROSS-FILTERS must be ignored — matching
  // `useWidgetRows`'s `effectiveRows` resolution (`filteredRowsNoChartCross`).
  // `crossFilterMode` governs widget-to-widget cross-filtering only; it must NOT
  // suppress page/widget filters or an explicit Filter-widget (interactive) selection,
  // which always hard-filter regardless of this widget's cross-filter mode (BI norm —
  // see `filteredRowsNoChartCross`'s doc in useWidgetRows.ts). Using `filteredRowsNoCross`
  // here was a bug: it additionally stripped interactive filter-widget filters, so setting
  // a dashboard's/widget's crossFilterMode to 'none' wrongly made the grid ignore an
  // explicit Filter-widget selection too (Tier 2 finding — architecture review iteration 22).
  // In cross-highlight mode, show all baseline rows (hard-filtered by page/widget/interactive)
  // and dim the non-matching ones. In cross-filter mode, use the fully filtered rows.
  let baseRows: typeof filteredRows;
  if (crossFilterMode === 'none') {
    baseRows = filteredRowsNoChartCross;
  } else if (hasChartCrossFilters && crossFilterMode === 'cross-highlight') {
    baseRows = filteredRowsNoChartCross;
  } else {
    baseRows = filteredRows;
  }

  // Per-row match keys for the chart cross-filter — used to decide which rows to highlight.
  //
  // We can't key on `row.id`: it is `undefined` for id-less data sources (an explicitly
  // supported case — see the synthetic-id fallback in `rows` below), which would make every
  // row appear "unmatched" and get dimmed regardless of whether it actually passed the filter.
  //
  // `filteredRows` and `baseRows` (`filteredRowsNoChartCross` in cross-highlight mode) are
  // both filtered from the *same* underlying pipeline-cached row array (see
  // `useWidgetRows`/`resolveRowsCached`). For a widget with NO cross-source display column
  // that means a row in `filteredRows` is the exact same JS object as its counterpart in
  // `baseRows`, so raw reference identity is a valid match key. But when a cross-source column
  // IS configured, `enrichWithCrossSourceFields` clones (`{ ...row }`) each row that receives a
  // cross-source value, and it does so in a *separate* pass per baseline — so the two baselines
  // hold different instances for the same logical row and raw reference matching silently fails
  // (everything dimmed, nothing highlighted). To survive that clone we key on the stable
  // identity token that cross-source enrichment stamps onto every row (see rowIdentity.ts),
  // falling back to the row object itself when no token is present (the no-cross-source case).
  const rowMatchKey = React.useCallback(
    (row: Record<string, unknown>): number | Record<string, unknown> => getRowIdentity(row) ?? row,
    [],
  );

  const highlightedRowKeys = React.useMemo((): Set<number | Record<string, unknown>> | null => {
    if (!hasChartCrossFilters || crossFilterMode !== 'cross-highlight') {
      return null;
    }
    return new Set(filteredRows.map(rowMatchKey));
  }, [hasChartCrossFilters, crossFilterMode, filteredRows, rowMatchKey]);

  const rows = React.useMemo(() => {
    // `baseRows` already carries related-source calculated columns — the shared `useWidgetRows`
    // enrichment now L2-enriches and joins them (finding 1.1), so no local pass is needed here.
    // Track the ids already handed out (as `getRowId` stringifies them) so two data rows sharing
    // the same non-null `id` — plausible with real host data — don't produce duplicate `getRowId`
    // results, which is undefined behavior for DataGridPremium (finding).
    const seenIds = new Set<string>();
    return baseRows.map((row, index) => {
      // The grid's row identity is stamped on `__rowId` — the internal identity field
      // `getRowId` already reads first (and the pinned summary row already uses) — and NEVER
      // onto `row.id`.
      //
      // Writing the synthetic/deduped identity over `row.id` clobbered the row's real data
      // value with an internal token, which then leaked into everything that reads the row:
      // the rendered `id` column, `handleCellClick`'s emitted cross-filter value, conditional
      // formats evaluated on `id`, and — worst — write-back's `where: [{ column: pkField,
      // value: newRow[pkField] }]`. With `gridPkField: 'id'` on a source whose `id` column is
      // nullable or non-unique, the mutation ran `WHERE id = 'w3-7'`, matched zero rows, and
      // most adapters report a 0-row update as `{ ok: true }` — so `processRowUpdate` resolved
      // and the grid painted the edit as committed while nothing was persisted (silent data
      // loss). Keeping the synthetic token off `row.id` leaves every consumer reading the real
      // value.
      //
      // The synthetic fallback covers a row whose `id` property is null/undefined (a nullable
      // database id column) as well as an id-less source (finding 1.9).
      let rowId = String(row.id ?? `${widget.id}-${index}`);
      // On a collision (a duplicate non-null id, or a synthetic id that happens to match a real
      // one), fall back to a synthetic per-index unique id so every rendered row keeps a distinct
      // getRowId value.
      if (seenIds.has(rowId)) {
        rowId = `${widget.id}-dup-${index}`;
      }
      seenIds.add(rowId);
      return {
        ...row,
        __rowId: rowId,
        // Stashed during this same pass (while `row` still has its original identity) so
        // `getRowClassName` below never needs to re-derive matching from `row.id`.
        __highlighted: highlightedRowKeys ? highlightedRowKeys.has(rowMatchKey(row)) : undefined,
      };
    });
  }, [baseRows, widget.id, highlightedRowKeys, rowMatchKey]);

  // Native DataGridPremium row grouping
  const rowGroupingModel = React.useMemo(
    () => (widget.config.gridGroupByField ? [widget.config.gridGroupByField] : []),
    [widget.config.gridGroupByField],
  );

  const aggregationModel = React.useMemo<GridAggregationModel>(() => {
    const resolved = resolveAggregationFieldKeys(
      widget.config.gridAggregations,
      widget.config.columns,
    );
    return Object.fromEntries(
      Object.entries(resolved).map(([field, fn]) => [field, toGridAggFn(fn)]),
    );
  }, [widget.config.gridAggregations, widget.config.columns]);

  // Drive sorting externally (like `rowGroupingModel`/`aggregationModel` above) so a
  // config-only edit to `gridSortField`/`gridSortDirection` takes effect immediately.
  // `initialState.sorting` is only read once at mount by DataGridPremium, so a later edit
  // to the config had no effect until the grid happened to remount.
  const configSortModel = React.useMemo<GridSortModel>(
    () =>
      widget.config.gridSortField
        ? [{ field: widget.config.gridSortField, sort: widget.config.gridSortDirection ?? 'asc' }]
        : [],
    [widget.config.gridSortField, widget.config.gridSortDirection],
  );

  // View-mode sort override. `null` means "no viewer sort yet — follow the authored
  // config", so a dashboard that ships with `gridSortField` set still opens sorted.
  // A viewer's own header click lives here and NOWHERE else: `doc` is the authored
  // document, and a read-only viewer must not be able to rewrite it (see
  // `handleSortModelChange`).
  const [viewSortModel, setViewSortModel] = React.useState<GridSortModel | null>(null);

  // Open edit-mode sort gesture, if any: the doc reference to fold back to, the column the
  // cycle belongs to, and the doc reference our own last commit produced. See
  // `handleSortModelChange`. Never read during render — only inside the event handler.
  const sortGestureRef = React.useRef<{
    field: string;
    baselineDoc: StudioDoc;
    committedDoc: StudioDoc;
  } | null>(null);

  // Switching modes drops any viewer-local sort so the grid re-reads the authored
  // config, rather than resurrecting a stale view-mode sort on the next view/edit toggle.
  // It also closes any open edit-mode sort gesture (see `sortGestureRef`) — a mode toggle is
  // a gesture boundary. The gesture's own doc-identity guard would already refuse to fold
  // across one, but leaving a stale baseline pinned in the ref is needless.
  React.useEffect(() => {
    setViewSortModel(null);
    sortGestureRef.current = null;
  }, [mode]);

  const sortModel = mode === 'edit' ? configSortModel : (viewSortModel ?? configSortModel);

  // Publish the view-mode sort so the CSV export — dispatched a level up in
  // `StudioWidgetCard`, which cannot see this component's local state — orders the file the
  // way the viewer is looking at the grid (see `gridViewSortRegistry`). Only view mode needs
  // this: an edit-mode sort is committed to `gridSortField`/`gridSortDirection` below, which
  // the export reads straight off the doc. The cleanup runs on unmount AND whenever the grid
  // leaves view mode, so a stale viewer sort can never be applied to a later export.
  React.useEffect(() => {
    if (mode === 'edit') {
      return undefined;
    }
    setGridViewSortModel(widget.id, sortModel);
    return () => clearGridViewSortModel(widget.id);
  }, [mode, widget.id, sortModel]);

  // Both directions of the controlled `sortModel` must work: a controlled model with no
  // `onSortModelChange` makes DataGridPremium ignore header clicks entirely, so headers
  // look clickable but do nothing. Where the resulting sort is STORED depends on mode:
  //
  // - edit mode: commit into `gridSortField`/`gridSortDirection`, the same two config keys
  //   `GridSetupPanel`'s sort controls write, so an author's header click is a real edit
  //   that survives a save — and, like every other authored edit, an UNDOABLE one.
  // - view mode: keep it in component state only. `doc` is the persisted, undoable
  //   partition; a read-only viewer's transient sort must not be baked into the authored
  //   dashboard, must not push undo entries, and must not clear a pending redo.
  //
  // Coalescing (F2). One logical sort gesture is DataGridPremium's asc -> desc -> none cycle:
  // three separate `onSortModelChange` calls. This used to be committed `{ undoable: false }`
  // so the cycle didn't cost three Ctrl+Z's — but that made it a standalone NON-undoable write
  // into `doc.widgets`, and `carryTransientDocState` carries only `filters`, three `dashboard`
  // keys and `ai` across an undo's doc swap. So an unrelated Ctrl+Z swapped in a doc
  // snapshotted before the sort and silently discarded it, with no redo entry to get it back
  // (and `getRecentMutations()` kept reporting a sort the doc no longer held, because a
  // non-undoable commit has no paired `undoMutationLog` entry for `undo()` to retract).
  //
  // Carrying the two keys in `carryTransientDocState` the way `doc.ai` is carried would not
  // work here: unlike `ai`, these keys are ALSO written undoably by `GridSetupPanel`'s sort
  // controls, so overlaying the current value onto every swapped-in doc would make those edits
  // un-undoable. Instead the gesture is coalesced at the source: every click commits normally
  // (undoable, labeled), and a click that CONTINUES the same gesture folds itself into the
  // gesture's first undo entry via `foldUndoHistorySince`. Net effect: the sort is a first-class
  // citizen of the undo timeline, and one gesture is still exactly one Ctrl+Z.
  //
  // "Continues the same gesture" is deliberately strict — `foldUndoHistorySince` truncates the
  // undo stack past its baseline, so a stale baseline would DESTROY any edit made in between.
  // Both must hold: the click targets the same column the open gesture does, and the current
  // doc is still exactly the one our previous commit produced (so nothing — an unrelated edit,
  // an AI mutation, an undo — has landed since). Otherwise the click simply starts a new
  // gesture and costs its own undo step.
  const handleSortModelChange = React.useCallback(
    (model: GridSortModel) => {
      if (mode !== 'edit') {
        setViewSortModel(model);
        return;
      }
      const [first] = model;
      // The column whose cycle this event belongs to. On the cycle's final "none" call the
      // model is empty, so fall back to the field that is still sorted in the config.
      const cycleField = first?.field ?? widget.config.gridSortField;
      const preCommitDoc = controller.getState().doc;
      const gesture = sortGestureRef.current;
      const continues =
        gesture !== null && gesture.field === cycleField && gesture.committedDoc === preCommitDoc;
      const baselineDoc = continues ? gesture.baselineDoc : preCommitDoc;

      controller.updateWidgetConfig(widget.id, {
        gridSortField: first?.field,
        gridSortDirection: first?.sort ?? undefined,
      });

      if (continues) {
        controller.foldUndoHistorySince(baselineDoc);
      }
      // A completed cycle (empty model) closes the gesture; anything else stays open so the
      // next click on the same column can fold into it.
      sortGestureRef.current = first
        ? { field: first.field, baselineDoc, committedDoc: controller.getState().doc }
        : null;
    },
    [controller, widget.id, widget.config.gridSortField, mode],
  );

  // Drive column visibility externally so toggling always reflects widget config,
  // even when a field has previously been used as a group-by column.
  // Grouped columns must be hidden from the data view (DataGridPremium renders them
  // as the group cell instead); we enforce that here since we own the model.
  const columnVisibilityModel = React.useMemo(
    () =>
      Object.fromEntries(
        allFieldIds.map((id) => [id, visibleFields.includes(id) && !rowGroupingModel.includes(id)]),
      ),
    [allFieldIds, visibleFields, rowGroupingModel],
  );

  const processRowUpdate = React.useCallback(
    async (newRow: GridValidRowModel, oldRow: GridValidRowModel): Promise<GridValidRowModel> => {
      if (!dataSource?.adapter?.submitMutation || !pkField) {
        return oldRow;
      }
      const changedValues: Record<string, unknown> = {};
      for (const key of Object.keys(newRow)) {
        // `__rowId`/`__highlighted` are internal render-time fields stamped by the `rows`
        // memo, not columns of the underlying table — they must never reach the adapter's
        // `values` payload.
        if (key.startsWith('__')) {
          continue;
        }
        if (newRow[key] !== oldRow[key]) {
          changedValues[key] = newRow[key];
        }
      }
      if (Object.keys(changedValues).length === 0) {
        return newRow;
      }
      // The grid row identity, used only to revert the stuck cell in
      // `onProcessRowUpdateError` — deliberately `__rowId` (what `getRowId` returns), not
      // `newRow.id`, which is the row's real (possibly null/duplicated) data value.
      // eslint-disable-next-line no-underscore-dangle -- internal grid row identity
      const rowId = String(newRow.__rowId ?? newRow.id);
      const [changedField] = Object.keys(changedValues);
      const pkValue = newRow[pkField];
      // A row whose PK cell is null/undefined addresses no database row: the mutation's
      // `WHERE <pk> IS NULL`-equivalent matches nothing, and most adapters report a 0-row
      // update as `{ ok: true }` — so the edit would be painted as committed while nothing
      // was persisted. Fail loudly (and revert the cell) instead of silently losing the edit.
      if (pkValue === null || pkValue === undefined) {
        throw toEnrichedMutationError(new Error(localeText.gridMutationError), rowId, changedField);
      }
      let result;
      try {
        result = await dataSource.adapter.submitMutation({
          operation: 'update',
          table: dataSource.tableName ?? dataSource.id,
          values: changedValues,
          where: [{ column: pkField, operator: 'eq', value: pkValue }],
        });
      } catch (err) {
        // Adapter rejected/threw — enrich with the row/field being edited so
        // `onProcessRowUpdateError` can revert the stuck cell (same as the
        // graceful `{ ok: false }` branch below).
        throw toEnrichedMutationError(err, rowId, changedField);
      }
      if (!result.ok) {
        throw toEnrichedMutationError(
          // `result.error` is the adapter's own (already host-authored) message; the fallback
          // must come from locale text, not a hardcoded English literal — it is rendered
          // verbatim in the Alert above the grid.
          new Error(result.error ?? localeText.gridMutationError),
          rowId,
          changedField,
        );
      }
      setMutationError(null);
      return newRow;
    },
    [dataSource, pkField, localeText.gridMutationError],
  );

  const handleProcessRowUpdateError = React.useCallback(
    (error: unknown) => {
      const enrichedError = error as Partial<EnrichedMutationError> | null | undefined;
      setMutationError(enrichedError?.message || localeText.gridMutationError);

      const rowId = enrichedError?.gridRowId;
      const field = enrichedError?.gridField;
      if (
        rowId !== undefined &&
        field !== undefined &&
        apiRef.current?.getCellMode(rowId, field) === 'edit'
      ) {
        apiRef.current.stopCellEditMode({ id: rowId, field, ignoreModifications: true });
      }
    },
    [apiRef, localeText],
  );

  const handleCellClick = React.useCallback(
    (params: GridCellParams) => {
      // Don't cross-filter from the summary pinned row
      if (params.id === GRID_SUMMARY_ROW_ID) {
        return;
      }
      // Only leaf rows carry real field values. A grouping cell (with `gridGroupByField`,
      // DataGridPremium renders a `group`/`pinned` node backed by the internal
      // `__row_group_by_columns_group__` field) would otherwise emit a filter on a field
      // no source owns — blanking every same-source widget (finding 1.1).
      if (params.rowNode.type !== 'leaf') {
        return;
      }
      // With `gridGroupByField` set, LEAF rows ALSO render a cell in the internal grouping
      // column (`GRID_ROW_GROUPING_SINGLE_GROUPING_FIELD`) — DataGridPremium's expand/collapse
      // toggle + group-path cell shown at the start of every row, leaf or not. That cell
      // passes the `type !== 'leaf'` guard above (the row node IS a leaf), so clicking it used
      // to fall through and emit `applyCrossFilter(widget.id, '__row_group_by_columns_group__',
      // <value>, ...)` — a field no source owns. Depending on the value, that either matches
      // every row (loose-equality quirk for `undefined`) or matches none, blanking every
      // same-source widget (finding 7). Exclude clicks on that column regardless of row type.
      if (params.field === GRID_ROW_GROUPING_SINGLE_GROUPING_FIELD) {
        return;
      }

      const cfField = widget.config.crossFilterField;
      const fieldId = cfField ?? params.field;
      // When a cross-filter field is configured, the emitted value must be that
      // field's value on the clicked ROW — not the clicked cell's own value —
      // otherwise clicking any non-configured column emits nonsense filter values.
      const value = cfField ? (params.row as Record<string, unknown>)[cfField] : params.value;

      // Resolve the source that OWNS the clicked field (finding 1.1). A configured
      // cross-source column carries its own `sourceId`; a related-source calculated
      // column is resolved via its expression-field owner; everything else is native to
      // the widget's own source. Passing the true owner (not `widget.sourceId`
      // unconditionally) stops a cross-source cell from emitting a filter that reads an
      // un-enriched `undefined` value at L3 and drops every row.
      const exprOwner = allExpressionFields.find((ef) => ef.id === fieldId);
      const filterSourceId =
        widget.config.columns?.find((c) => c.fieldId === fieldId)?.sourceId ??
        exprOwner?.sourceId ??
        widget.sourceId;

      // Tag date/datetime fields so downstream `compileSingleCondition` day-normalizes
      // both sides (mirrors the chart's period path).
      const columnType = fieldTypeById.get(fieldId);
      const fieldType = columnType === 'date' || columnType === 'datetime' ? columnType : undefined;

      // Toggle: clicking the same field+value clears the filter
      if (
        activeCrossFilter &&
        activeCrossFilter.field === fieldId &&
        crossFilterValueEquals(activeCrossFilter.value, value)
      ) {
        controller.clearCrossFilter(widget.id);
      } else {
        controller.applyCrossFilter(widget.id, fieldId, value, filterSourceId, 'equals', fieldType);
      }
    },
    [
      controller,
      widget.id,
      widget.sourceId,
      widget.config.columns,
      activeCrossFilter,
      widget.config.crossFilterField,
      allExpressionFields,
      fieldTypeById,
    ],
  );

  // Conditional formatting: build an index of CSS class name → style for injection.
  // Each rule gets a deterministic CSS class name based on its index.
  const conditionalFormats = React.useMemo(
    () => widget.config.gridConditionalFormats ?? [],
    [widget.config.gridConditionalFormats],
  );
  // `widget.id` is normally minted by `createWidgetId` and always identifier-safe, but the
  // persisted-doc load boundary only screens ids for prototype-pollution-unsafe keys, not
  // CSS-selector-safety — sanitize the local token used to build the conditional-format
  // class name (finding 5) without touching `widget.id` itself anywhere else it's used.
  const safeWidgetIdForCss = sanitizeCssIdentifierToken(widget.id);
  const conditionalFormatSx = React.useMemo(() => {
    const sx: Record<string, Record<string, unknown>> = {};
    conditionalFormats.forEach((rule, i) => {
      const cls = `.StudioGrid-cf-${safeWidgetIdForCss}-${i}`;
      // Sanitized before reaching `sx` (finding 1): `gridConditionalFormats` is
      // doc-authored config reachable via `loadSerializedState`/the AI `update_widget`
      // tool call, and Emotion does not escape interpolated `sx` property values.
      const safeBackgroundColor = sanitizeCssColor(rule.style.backgroundColor);
      const safeColor = sanitizeCssColor(rule.style.color);
      const safeFontWeight = isSafeFontWeightKeyword(rule.style.fontWeight)
        ? rule.style.fontWeight
        : undefined;
      sx[`& ${cls}`] = {
        ...(safeBackgroundColor ? { bgcolor: safeBackgroundColor } : {}),
        ...(safeColor ? { color: safeColor } : {}),
        ...(safeFontWeight ? { fontWeight: safeFontWeight } : {}),
      };
    });
    return sx;
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- safeWidgetIdForCss is a stable primitive
  }, [conditionalFormats, safeWidgetIdForCss]);

  const getCellClassName = React.useCallback(
    (params: GridCellParams) => {
      if (params.id === GRID_SUMMARY_ROW_ID || conditionalFormats.length === 0) {
        return '';
      }
      const classes: string[] = [];
      conditionalFormats.forEach((rule, i) => {
        if (rule.fieldId !== params.field) {
          return;
        }
        if (evalConditionalFormat(rule, params.value)) {
          classes.push(`StudioGrid-cf-${safeWidgetIdForCss}-${i}`);
        }
      });
      return classes.join(' ');
    },
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- safeWidgetIdForCss is a stable primitive
    [conditionalFormats, safeWidgetIdForCss],
  );

  // Only shown when grouping is not active (DataGridPremium aggregation handles it otherwise).
  //
  // In cross-highlight mode the grid body shows ALL baseline rows but dims non-matching ones.
  // The summary should reflect only the highlighted (cross-filter-inclusive) subset so the
  // totals agree with what the user is focusing on. In all other modes use `rows` directly.
  //
  // Memoized: an unmemoized object literal changed identity on every render, so
  // `summaryValues` re-scanned every row and `pinnedRows` handed DataGridPremium a brand
  // new pinned-row array each time.
  const summaryConfig = React.useMemo(
    () =>
      widget.config.gridGroupByField
        ? undefined
        : resolveAggregationFieldKeys(widget.config.gridSummaryFields, widget.config.columns),
    [widget.config.gridGroupByField, widget.config.gridSummaryFields, widget.config.columns],
  );
  const summaryBasisRows = React.useMemo(
    () =>
      hasChartCrossFilters && crossFilterMode === 'cross-highlight'
        ? // `filteredRows` already carries related-source calculated columns via the shared
          // `useWidgetRows` enrichment (finding 1.1) — no local pass needed.
          filteredRows
        : rows,
    [hasChartCrossFilters, crossFilterMode, filteredRows, rows],
  );

  // Field defs the footer summary resolves against — the widget's own physical fields,
  // its own calculated columns, AND resolvable cross-source columns (finding 1.2). Without
  // the last two a configured `sum`/`avg`/`min`/`max` on a cross-source or expression-field
  // column found no def, resolved as non-numeric, and silently degraded to a `count`.
  //
  // `computeGridSummary` indexes this array by `id` via `new Map(fields.map((f) => [f.id, f]))`,
  // which is last-write-wins — so a cross-source def pushed after an own field/expression def
  // sharing its bare id would silently shadow the primary def there, routing the footer
  // aggregation for the widget's OWN column through the cross-source FK-dedupe and dropping all
  // but one row per related record (finding 7). Skip a cross-source def whose id collides with
  // an own field/expression column so the own def always wins, mirroring `buildGridColumnDefs`'s
  // `!field && !expressionField` own-field-wins guard.
  const summaryFieldDefs = React.useMemo<StudioDataField[]>(() => {
    const defs: StudioDataField[] = [...(dataSource?.fields ?? [])];
    for (const ef of expressionFields) {
      defs.push({
        id: ef.id,
        label: ef.label,
        type: ef.type ?? 'number',
        format: ef.format,
        precision: ef.precision,
        currencyCode: ef.currencyCode,
      });
    }
    for (const [id, def] of crossSourceFieldDefs) {
      if (!ownFieldIds.has(id)) {
        defs.push(def);
      }
    }
    return defs;
  }, [dataSource?.fields, expressionFields, crossSourceFieldDefs, ownFieldIds]);

  const summaryValues = React.useMemo(() => {
    if (!summaryConfig || Object.keys(summaryConfig).length === 0 || !dataSource) {
      return null;
    }
    return computeGridSummary(
      summaryBasisRows,
      summaryFieldDefs,
      { fields: summaryConfig },
      localeText,
      // FK-dedup a fanned-out cross-source footer sum the same way the group totals do.
      crossSourceFkFields,
    );
  }, [
    summaryBasisRows,
    dataSource,
    summaryFieldDefs,
    summaryConfig,
    localeText,
    crossSourceFkFields,
  ]);

  // Build a pinned bottom row for DataGridPremium using the summary values.
  // We use a separate `__rowId` field for the row identity so that the `id`
  // data column still shows the summary count (e.g. "Count: 460,000").
  const pinnedRows = React.useMemo(() => {
    if (!summaryValues) {
      return undefined;
    }
    return { bottom: [{ ...summaryValues, __rowId: GRID_SUMMARY_ROW_ID }] };
  }, [summaryValues]);

  return (
    <div>
      {isError && <StudioWidgetErrorOverlay message={errorMessage} sx={{ py: 1 }} />}
      {mutationError && (
        <Alert severity="error" onClose={() => setMutationError(null)} sx={{ mb: 1 }}>
          {mutationError}
        </Alert>
      )}
      <DataGridPremium
        density="compact"
        columns={columns}
        disableColumnMenu
        rows={rows}
        pinnedRows={pinnedRows}
        getRowId={(row: GridValidRowModel) => {
          return String(
            // eslint-disable-next-line no-underscore-dangle -- summary rows use an internal synthetic identifier
            (row as Record<string, unknown>).__rowId ?? (row as Record<string, unknown>).id,
          );
        }}
        hideFooter
        loading={isLoading}
        disableRowSelectionOnClick
        slots={{ noRowsOverlay: StudioNoDataOverlay }}
        rowGroupingModel={rowGroupingModel}
        onRowGroupingModelChange={() => {}}
        aggregationModel={aggregationModel}
        onAggregationModelChange={() => {}}
        aggregationFunctions={aggregationFunctions}
        columnVisibilityModel={columnVisibilityModel}
        onColumnVisibilityModelChange={() => {}}
        sx={{
          height: sanitizeFiniteNumber(widget.config.gridHeight, 1) ?? 400,
          '& .MuiDataGrid-cell': { cursor: 'default' },
          '& .StudioGrid-crossFilterMatch': {
            bgcolor: 'action.selected',
          },
          '& .StudioGrid-dimmed': {
            opacity: 0.3,
          },
          // Pinned rows (summary) must never be dimmed — they are always visible.
          '& .MuiDataGrid-pinnedRows .StudioGrid-dimmed': {
            opacity: 1,
          },
          ...conditionalFormatSx,
        }}
        getCellClassName={getCellClassName}
        getRowClassName={(params: GridRowClassNameParams) => {
          if (params.id === GRID_SUMMARY_ROW_ID) {
            return '';
          }
          // Incoming chart cross-highlight: dim rows that don't match the cross-filter.
          if (highlightedRowKeys !== null) {
            // eslint-disable-next-line no-underscore-dangle -- internal synthetic flag stashed in `rows` above
            return (params.row as Record<string, unknown>).__highlighted ? '' : 'StudioGrid-dimmed';
          }
          // Outgoing cross-filter: highlight the row this table is filtering on.
          if (activeCrossFilter) {
            const rowValue = (params.row as Record<string, unknown>)[activeCrossFilter.field];
            return crossFilterValueEquals(rowValue, activeCrossFilter.value)
              ? 'StudioGrid-crossFilterMatch'
              : '';
          }
          return '';
        }}
        sortModel={sortModel}
        onSortModelChange={handleSortModelChange}
        // Edit mode stores the sort in `gridSortField` / `gridSortDirection` — two scalar
        // config keys that can express exactly ONE sorted column, so `handleSortModelChange`
        // keeps only `model[0]`. The Data Grid's shift-click multi-sort was still enabled
        // though, so an author shift-clicking a second header saw absolutely nothing happen
        // while the identical gesture worked in view mode (finding M18). Turn the gesture off
        // where the model cannot hold it, so the UI and the storage agree instead of failing
        // silently. View mode keeps multi-sort: `viewSortModel` holds the full model.
        //
        // The alternative — a `gridSortModel` array on the config — is a schema change
        // spanning `x-studio-schema`, `configKeyValidation`, `chartTypeRegistry`'s field
        // collection, `GridSetupPanel` and the AI middleware's config metadata; it is the
        // right long-term fix and is reported as a follow-up rather than done here.
        disableMultipleColumnsSorting={mode === 'edit'}
        // Use controlled layout mode so the pinned summary row uses `position: absolute`
        // rather than `position: sticky`. At very large row counts (~470k+), the total
        // content height can exceed CSS height limits in some browsers, causing sticky
        // positioning to fail and the summary row to disappear.
        experimentalFeatures={{ virtualizerLayoutMode: 'controlled' }}
        onCellClick={handleCellClick}
        processRowUpdate={isEditable ? processRowUpdate : undefined}
        onProcessRowUpdateError={isEditable ? handleProcessRowUpdateError : undefined}
        {...slotProps?.dataGrid}
        // Forced after the spread so a host-supplied `slotProps.dataGrid.apiRef`
        // cannot silently disconnect `onProcessRowUpdateError`'s revert handler.
        apiRef={apiRef}
      />
    </div>
  );
});
