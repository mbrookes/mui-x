'use client';
import { Chip } from '@mui/material';
import CancelIcon from '@mui/icons-material/Cancel';

import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';
import { formatFieldValue } from '../../internals/numberFormat';
import { getStudioLocale } from '../../internals/studioLocale';
import { resolveFieldDef } from '../widgets/StudioChartWidget/chartWidgetHelpers';
import type { StudioDataSource, StudioExpressionField } from '../../models';

export interface SliderFilterPillProps {
  filter: { field: string; value: unknown };
  /** The widget's data source, used to resolve the filtered field's label / type / format. */
  source: StudioDataSource | undefined;
  /** Expression (computed) fields, so a slider on a calculated field resolves too. */
  expressionFields?: StudioExpressionField[];
  onClear: () => void;
}

const EMPTY_EXPRESSION_FIELDS: StudioExpressionField[] = [];

/**
 * Header chip summarising the interactive range a slider filter widget has applied.
 *
 * The invariant this component upholds: the chip and the `SliderControl` that produced the
 * range must render the SAME range identically.
 *
 * - Dates go through `toLocaleDateString(undefined, …)`, the exact branch `SliderControl`
 *   uses. `dayjs(v).format('DD MMM YYYY')` was used here before; nothing in this package ever
 *   calls `dayjs.locale(...)`, so it always formatted through dayjs's unconfigured global
 *   default locale — fixed English month names in a fixed DMY order — while the control two
 *   lines below already resolved both from the runtime locale.
 * - Numbers go through `formatFieldValue` with the resolved field def, so a currency slider's
 *   chip reads `$1,000` like the grid and KPI rather than a bare `1,000`.
 * - The label is prefixed with the field label, matching the rank chip ("Top 5") and the
 *   cross-filter chip ("Field: value"): a bare `10 – 100` next to a delete affordance gave no
 *   indication of what clearing it would clear.
 */
export function SliderFilterPill({
  filter,
  source,
  expressionFields = EMPTY_EXPRESSION_FIELDS,
  onClear,
}: SliderFilterPillProps) {
  const localeText = useStudioLocaleText();
  const val = filter.value as { from?: string | number; to?: string | number } | null;
  const fieldDef = resolveFieldDef(filter.field, source, expressionFields);
  const isDate = fieldDef?.type === 'date' || fieldDef?.type === 'datetime';
  const fieldLabel = fieldDef?.label ?? filter.field;

  const fmt = (v: string | number | undefined) => {
    if (v == null) {
      return '';
    }
    if (isDate) {
      const date = new Date(v);
      // An unparseable bound must not render "Invalid Date" in the chip.
      return Number.isNaN(date.getTime())
        ? String(v)
        : date.toLocaleDateString(getStudioLocale(), {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          });
    }
    const numeric = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(numeric)) {
      return String(v);
    }
    // `formatFieldValue` only applies a field's format when the field is typed `number`; an
    // untyped/absent field def still gets locale-aware grouping. The format options are
    // copied into a fresh object because `StudioExpressionField.type` is optional, so the
    // union `resolveFieldDef` returns is not directly assignable to the `Pick` it takes.
    return fieldDef?.type === 'number'
      ? formatFieldValue(numeric, {
          type: 'number',
          format: fieldDef.format,
          currencyCode: fieldDef.currencyCode,
          precision: fieldDef.precision,
        })
      : numeric.toLocaleString(getStudioLocale());
  };

  if (!val) {
    return null;
  }

  const range = `${fmt(val.from)} – ${fmt(val.to)}`;
  return (
    <Chip
      size="small"
      label={fieldLabel ? `${fieldLabel}: ${range}` : range}
      onDelete={onClear}
      // MUI's default `Chip` delete icon is an unlabeled `<svg>` with no role, so the only
      // control that clears this filter had no accessible name. Same treatment (and the same
      // locale token) as `QuickFilterChip` in `StudioQuickFilterBar`.
      deleteIcon={
        <CancelIcon
          role="button"
          aria-label={localeText.quickFilterBarRemoveFilter}
          aria-hidden={false}
        />
      }
      color="primary"
      variant="outlined"
      sx={{ flexShrink: 0, height: 20, fontSize: 11 }}
    />
  );
}
