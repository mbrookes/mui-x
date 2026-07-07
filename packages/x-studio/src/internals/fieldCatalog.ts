import type { StudioDataField, StudioDataSource, StudioExpressionField } from '../models';

/**
 * A field entry annotated with its source context. Superset of `DataSourceFieldEntry`
 * (`components/StudioComposeDrawer/DataSourceFieldSelect.tsx`), so catalog entries feed
 * `DataSourceFieldSelect.fields` and `fieldsForCapability<T extends StudioDataField>`
 * (`utils/fieldCapabilities.ts`) unchanged.
 */
export interface FieldCatalogEntry extends StudioDataField {
  sourceId: string;
  sourceLabel: string;
}

/**
 * Which expression fields to include when folding a source's calculated columns in:
 * - `'all'` — every non-hidden expression field (Chart/KPI value pickers can target
 *   either calculated columns or measures).
 * - `'non-measure'` — exclude measures (`ef.isMeasure`) — Grid's column list only
 *   ever shows per-row calculated columns, never single-value measures.
 * - `'none'` — no expression fields at all.
 */
export type FieldCatalogExpressionPolicy = 'all' | 'non-measure' | 'none';

function includeExpressionField(
  ef: StudioExpressionField,
  policy: FieldCatalogExpressionPolicy,
): boolean {
  if (ef.hidden || policy === 'none') {
    return false;
  }
  if (policy === 'non-measure') {
    return !ef.isMeasure;
  }
  return true;
}

/**
 * Fold a single data source's physical fields plus its own (non-hidden) expression
 * fields into `FieldCatalogEntry[]`.
 *
 * This is the shared per-source inner fold previously hand-rolled independently in
 * `GridSetupPanel.tsx` (four times) and inlined (for the whole-catalog case) in
 * `ChartSetupPanel.tsx` / `KpiSetupPanel.tsx` — see finding 2.4 in the remediation plan.
 *
 * Always skips hidden physical fields (`field.hidden`) and hidden expression fields
 * (`ef.hidden`) — this matches every existing per-source caller. Callers that need to
 * include hidden fields (e.g. `StudioFiltersDrawer`) do not use this helper; see
 * `buildFieldCatalog`'s `includeHidden` option instead.
 */
export function buildSourceFieldEntries(
  source: StudioDataSource,
  expressionFields: StudioExpressionField[],
  options?: { expression?: FieldCatalogExpressionPolicy },
): FieldCatalogEntry[] {
  const expressionPolicy = options?.expression ?? 'all';

  const physicalFields: FieldCatalogEntry[] = source.fields.flatMap((f) =>
    f.hidden ? [] : [{ ...f, sourceId: source.id, sourceLabel: source.label }],
  );

  const exprFields: FieldCatalogEntry[] = expressionFields.flatMap((ef) => {
    if (ef.sourceId !== source.id || !includeExpressionField(ef, expressionPolicy)) {
      return [];
    }
    return [
      {
        id: ef.id,
        label: ef.label,
        description: ef.description,
        type: ef.type ?? ('number' as const),
        format: ef.format,
        precision: ef.precision,
        currencyCode: ef.currencyCode,
        generated: true,
        sourceId: ef.sourceId,
        sourceLabel: source.label,
      },
    ];
  });

  return [...physicalFields, ...exprFields];
}

/**
 * Fold every data source's physical + expression fields into a single flat
 * `FieldCatalogEntry[]` — the whole-catalog fold used by `ChartSetupPanel` and
 * `KpiSetupPanel`'s field pickers, and (with `includeHidden: true`) by
 * `StudioFiltersDrawer`'s field list.
 *
 * - `options.expression` (default `'all'`) — see `FieldCatalogExpressionPolicy`.
 * - `options.sort` (default `true`) — sort the result by `sourceLabel` (`localeCompare`).
 * - `options.includeHidden` (default `false`) — when `false` (the Chart/KPI default),
 *   hidden sources AND hidden fields are excluded, matching the original Chart/KPI
 *   folds. When `true` (the `StudioFiltersDrawer` case), hidden sources and hidden
 *   fields are both included — the drawer must list every field so existing filters on
 *   now-hidden fields still resolve a label.
 *
 * An expression field whose `sourceId` does not match any known data source (an
 * "orphaned" expression field) still gets an entry — its `sourceLabel` falls back to
 * the raw `sourceId` (preserves the original Chart/KPI fallback behavior). Note that
 * expression-field inclusion is gated only by `ef.hidden`/`options.expression`, NOT by
 * whether its owning source is hidden — this also matches the original Chart/KPI
 * behavior (a subtle asymmetry with the physical-field fold, preserved as-is).
 */
export function buildFieldCatalog(
  dataSources: Record<string, StudioDataSource>,
  expressionFields: StudioExpressionField[],
  options?: {
    expression?: FieldCatalogExpressionPolicy;
    sort?: boolean;
    includeHidden?: boolean;
  },
): FieldCatalogEntry[] {
  const expressionPolicy = options?.expression ?? 'all';
  const includeHidden = options?.includeHidden ?? false;
  const sort = options?.sort ?? true;

  const physicalFields: FieldCatalogEntry[] = Object.values(dataSources).flatMap((ds) => {
    if (ds.hidden && !includeHidden) {
      return [];
    }
    return ds.fields.flatMap((f) => {
      if (f.hidden && !includeHidden) {
        return [];
      }
      return [{ ...f, sourceId: ds.id, sourceLabel: ds.label }];
    });
  });

  const exprFields: FieldCatalogEntry[] =
    expressionPolicy === 'none'
      ? []
      : expressionFields.flatMap((ef) => {
          if (!includeExpressionField(ef, expressionPolicy)) {
            return [];
          }
          const ds = dataSources[ef.sourceId];
          return [
            {
              id: ef.id,
              label: ef.label,
              description: ef.description,
              type: ef.type ?? ('number' as const),
              format: ef.format,
              precision: ef.precision,
              currencyCode: ef.currencyCode,
              generated: true,
              sourceId: ef.sourceId,
              sourceLabel: ds?.label ?? ef.sourceId,
            },
          ];
        });

  const all = [...physicalFields, ...exprFields];
  return sort ? all.sort((a, b) => a.sourceLabel.localeCompare(b.sourceLabel)) : all;
}

/**
 * Build a flat `fieldId → label` map across all data sources.
 *
 * KNOWN LIMITATION (documented, not fixed here — see finding 2.4): duplicate field
 * ids across two different sources resolve first-writer-wins, in `Object.values`
 * iteration order. E.g. if both an "orders" and a "customers" source expose a
 * `country` field, whichever source is encountered first in `Object.values(dataSources)`
 * wins the label for every reference to `country` — a filter chip for the other
 * source's `country` field silently shows the wrong source's label. This mirrors the
 * pre-existing behavior of every fold this helper replaces.
 *
 * Hidden fields (`field.hidden`) ARE included — this map is used to label existing
 * filter chips/summaries, which must resolve even for fields the user has since hidden
 * from pickers.
 *
 * Expression-field labels are appended only when `expressionFields` is passed
 * (omit to match callers, like `StudioQuickFilterBar`, that don't label expression
 * fields).
 */
export function buildFieldLabelMap(
  dataSources: Record<string, StudioDataSource>,
  expressionFields?: StudioExpressionField[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const source of Object.values(dataSources)) {
    for (const field of source.fields) {
      if (!map.has(field.id)) {
        map.set(field.id, field.label);
      }
    }
  }
  if (expressionFields) {
    for (const ef of expressionFields) {
      if (!map.has(ef.id)) {
        map.set(ef.id, ef.label);
      }
    }
  }
  return map;
}
