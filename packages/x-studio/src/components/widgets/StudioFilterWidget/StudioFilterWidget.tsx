'use client';
import * as React from 'react';
import { Box, Typography } from '@mui/material';
import dayjs from 'dayjs';
import type { StudioWidget, StudioDataSource } from '../../../models';
import {
  useStudioController,
  useStudioLocaleText,
  useStudioSelector,
  selectDataSources,
  selectRelationships,
  makeSelectExpressionFieldsForSource,
  makeSelectActiveInteractiveFilter,
} from '../../../context';
import { getCachedEnrichedRows } from '../../../internals/enrichedRowsCache';
import { getCachedNormalizedDataSource } from '../../../internals/normalizedRowsCache';

import {
  DateRangeControl,
  type StudioFilterDateRangeControlProps,
} from './controls/DateRangeControl';
import {
  MultiSelectControl,
  type StudioFilterMultiSelectControlProps,
} from './controls/MultiSelectControl';
import { ToggleControl, type StudioFilterToggleControlProps } from './controls/ToggleControl';
import { SliderControl, type StudioFilterSliderControlProps } from './controls/SliderControl';

// Re-export control prop types so existing consumers remain unaffected
export type { StudioFilterDateRangeControlProps } from './controls/DateRangeControl';
export type { StudioFilterMultiSelectControlProps } from './controls/MultiSelectControl';
export type { StudioFilterToggleControlProps } from './controls/ToggleControl';
export type { StudioFilterSliderControlProps } from './controls/SliderControl';

// ─── Slot interfaces ──────────────────────────────────────────────────────────

export interface StudioFilterWidgetSlots {
  dateRangeControl?: React.ElementType<StudioFilterDateRangeControlProps>;
  multiSelectControl?: React.ElementType<StudioFilterMultiSelectControlProps>;
  toggleControl?: React.ElementType<StudioFilterToggleControlProps>;
  sliderControl?: React.ElementType<StudioFilterSliderControlProps>;
}

export interface StudioFilterWidgetSlotProps {
  dateRangeControl?: Partial<StudioFilterDateRangeControlProps>;
  multiSelectControl?: Partial<StudioFilterMultiSelectControlProps>;
  toggleControl?: Partial<StudioFilterToggleControlProps>;
  sliderControl?: Partial<StudioFilterSliderControlProps>;
}

export interface StudioFilterWidgetProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
  slots?: StudioFilterWidgetSlots;
  slotProps?: StudioFilterWidgetSlotProps;
}

// ─── Main filter widget ───────────────────────────────────────────────────────

export const StudioFilterWidget = React.memo(function StudioFilterWidget(
  props: StudioFilterWidgetProps,
) {
  const { widget, dataSource, slots, slotProps } = props;
  const { config } = widget;
  const controller = useStudioController();
  const localeText = useStudioLocaleText();
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  const selectExpressionFields = React.useMemo(
    () => makeSelectExpressionFieldsForSource(widget.sourceId ?? ''),
    [widget.sourceId],
  );
  const expressionFields = useStudioSelector(selectExpressionFields);

  const filterWidgetType = config.filterWidgetType ?? 'multi-select';
  const fieldId = config.filterWidgetField ?? '';

  // Normalize the data source lazily for just this filter field.
  // Provides pre-computed fieldDistinctValues[fieldId] for the fast path in
  // distinctValues below, without normalizing the entire source.
  const normalizedDataSource = React.useMemo(() => {
    if (!dataSource || !fieldId) {
      return dataSource;
    }
    return getCachedNormalizedDataSource(dataSource, new Set([fieldId]));
  }, [dataSource, fieldId]);

  // Resolve the field definition
  const field = React.useMemo(() => {
    if (!fieldId || !normalizedDataSource) {
      return undefined;
    }
    return (
      normalizedDataSource.fields.find((f) => f.id === fieldId) ??
      expressionFields.find((ef) => ef.id === fieldId && ef.sourceId === widget.sourceId)
    );
  }, [fieldId, normalizedDataSource, expressionFields, widget.sourceId]);

  const rows = React.useMemo(() => {
    if (!normalizedDataSource?.rows) {
      return [];
    }

    // Only enrich if the field being filtered on is a computed expression field.
    // Native fields (country, region, etc.) don't require enrichment — enriching
    // 100k rows just to scan a native field allocates N spread objects unnecessarily.
    const fieldIsExpression =
      fieldId !== '' &&
      expressionFields.some(
        (ef) => ef.id === fieldId && ef.sourceId === widget.sourceId && !ef.isMeasure,
      );

    if (!fieldIsExpression) {
      return normalizedDataSource.rows;
    }

    return getCachedEnrichedRows(
      normalizedDataSource.rows,
      widget.sourceId,
      expressionFields,
      dataSources,
      relationships,
      new Set([fieldId]),
    );
  }, [
    normalizedDataSource,
    expressionFields,
    fieldId,
    widget.sourceId,
    dataSources,
    relationships,
  ]);

  const label = widget.title || field?.label || fieldId || '';

  // Current interactive filter value for this widget (stable selector, not inline arrow)
  const selectActiveFilter = React.useMemo(
    () => makeSelectActiveInteractiveFilter(widget.id),
    [widget.id],
  );
  const activeFilter = useStudioSelector(selectActiveFilter);

  // Compute distinct values for select/toggle controls
  const distinctValues = React.useMemo(() => {
    if (
      (filterWidgetType !== 'multi-select' && filterWidgetType !== 'toggle') ||
      !fieldId ||
      rows.length === 0
    ) {
      return [];
    }
    // Fast path: use the pre-computed index built lazily for this filter field.
    // O(1) rather than O(N).
    const precomputed = normalizedDataSource?.fieldDistinctValues?.[fieldId];
    if (precomputed) {
      return precomputed;
    }
    // Slow path: scan enriched rows (required for expression fields).
    const seen = new Set<string>();
    for (const row of rows) {
      const v = row[fieldId];
      if (v != null && String(v) !== '') {
        seen.add(String(v));
      }
    }
    return Array.from(seen).sort();
  }, [filterWidgetType, fieldId, rows, normalizedDataSource?.fieldDistinctValues]);

  // Compute min/max for slider from data when not configured explicitly
  const isDateField =
    filterWidgetType === 'slider' && (field?.type === 'date' || field?.type === 'datetime');

  const { autoMin, autoMax } = React.useMemo(() => {
    if (filterWidgetType !== 'slider' || !fieldId || rows.length === 0) {
      return { autoMin: 0, autoMax: 100 };
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const row of rows) {
      const raw = row[fieldId];
      const v = isDateField ? dayjs(raw as string).valueOf() : Number(raw);
      if (Number.isFinite(v)) {
        if (v < lo) {
          lo = v;
        }
        if (v > hi) {
          hi = v;
        }
      }
    }
    return {
      autoMin: Number.isFinite(lo) ? lo : 0,
      autoMax: Number.isFinite(hi) ? hi : 100,
    };
  }, [filterWidgetType, fieldId, rows, isDateField]);

  const sliderMin = config.filterWidgetMin ?? autoMin;
  const sliderMax = config.filterWidgetMax ?? autoMax;
  const MS_PER_DAY = 86_400_000;
  const autoSliderStep =
    sliderMax - sliderMin > 100 ? Math.round((sliderMax - sliderMin) / 100) : 1;
  const sliderStep = config.filterWidgetStep ?? (isDateField ? MS_PER_DAY : autoSliderStep);

  const handleClear = React.useCallback(() => {
    controller.clearInteractiveFilter(widget.id);
  }, [controller, widget.id]);

  const DateRangeControlComponent = slots?.dateRangeControl ?? DateRangeControl;
  const MultiSelectControlComponent = slots?.multiSelectControl ?? MultiSelectControl;
  const ToggleControlComponent = slots?.toggleControl ?? ToggleControl;
  const SliderControlComponent = slots?.sliderControl ?? SliderControl;

  if (!fieldId) {
    return (
      <Box sx={{ p: 1 }}>
        <Typography variant="body2" color="text.secondary">
          {localeText.filterWidgetNoFieldConfigured}
        </Typography>
      </Box>
    );
  }

  // Always pass filterSourceId so cross-source filtering works when this widget's
  // source differs from a chart/KPI/grid's source (e.g. customers → orders join).
  const filterSourceId = widget.sourceId;

  if (filterWidgetType === 'date-range') {
    const val = (activeFilter?.value as { from?: string; to?: string } | null) ?? null;
    const managedOnApply = (value: { from?: string; to?: string }) => {
      if (!value.from && !value.to) {
        handleClear();
        return;
      }
      controller.applyInteractiveFilter(widget.id, fieldId, 'between', value, {
        fieldType: field?.type ?? 'date',
        filterSourceId,
      });
    };
    return (
      <DateRangeControlComponent
        label={label}
        currentValue={val}
        {...slotProps?.dateRangeControl}
        onApply={managedOnApply}
        onClear={handleClear}
      />
    );
  }

  if (filterWidgetType === 'multi-select') {
    const selected = (activeFilter?.value as string[] | undefined) ?? [];
    const exclude = activeFilter?.operator === 'not_in';
    const managedOnApply = (v: string[], op: 'in' | 'not_in' = exclude ? 'not_in' : 'in') => {
      if (v.length === 0) {
        handleClear();
        return;
      }
      controller.applyInteractiveFilter(widget.id, fieldId, op, v, {
        filterMode: 'selection',
        fieldType: field?.type ?? 'string',
        filterSourceId,
      });
    };
    const managedOnExcludeChange = (nextExclude: boolean) => {
      const op = nextExclude ? 'not_in' : 'in';
      if (selected.length > 0) {
        managedOnApply(selected, op);
      }
    };
    return (
      <MultiSelectControlComponent
        label={label}
        values={distinctValues}
        selected={selected}
        exclude={exclude}
        onExcludeChange={managedOnExcludeChange}
        {...slotProps?.multiSelectControl}
        onApply={managedOnApply}
        onClear={handleClear}
      />
    );
  }

  if (filterWidgetType === 'toggle') {
    const selected = (activeFilter?.value as string[] | undefined) ?? [];
    const managedOnApply = (v: string[]) => {
      controller.applyInteractiveFilter(widget.id, fieldId, 'in', v, {
        filterMode: 'selection',
        fieldType: field?.type ?? 'string',
        filterSourceId,
      });
    };
    return (
      <ToggleControlComponent
        label={label}
        values={distinctValues}
        selected={selected}
        {...slotProps?.toggleControl}
        onApply={managedOnApply}
        onClear={handleClear}
      />
    );
  }

  if (filterWidgetType === 'slider') {
    // The filter stores dates as ISO strings; convert back to timestamps for the numeric slider.
    const rawVal = activeFilter?.value as
      | { from?: string | number; to?: string | number }
      | null
      | undefined;
    let val: { from?: number; to?: number } | null;
    if (rawVal == null) {
      val = null;
    } else if (isDateField) {
      val = {
        from: rawVal.from != null ? dayjs(rawVal.from as string).valueOf() : undefined,
        to: rawVal.to != null ? dayjs(rawVal.to as string).valueOf() : undefined,
      };
    } else {
      val = rawVal as { from?: number; to?: number };
    }
    const fieldType = isDateField ? (field?.type ?? 'date') : 'number';
    const managedOnApply = (lo: number, hi: number) => {
      // For date sliders, convert timestamps back to ISO strings for filter matching
      const from = isDateField ? dayjs(lo).format('YYYY-MM-DD') : lo;
      const to = isDateField ? dayjs(hi).format('YYYY-MM-DD') : hi;
      controller.applyInteractiveFilter(
        widget.id,
        fieldId,
        'between',
        { from, to },
        {
          fieldType,
          filterSourceId,
        },
      );
    };
    return (
      <SliderControlComponent
        label={label}
        min={sliderMin}
        max={sliderMax}
        step={sliderStep}
        isDate={isDateField}
        currentValue={val ?? null}
        {...slotProps?.sliderControl}
        onApply={managedOnApply}
        onClear={handleClear}
      />
    );
  }

  return null;
});
