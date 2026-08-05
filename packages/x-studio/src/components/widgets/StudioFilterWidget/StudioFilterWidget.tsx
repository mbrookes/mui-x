'use client';
import * as React from 'react';
import { Box, CircularProgress, Stack, Typography } from '@mui/material';
import dayjs from 'dayjs';
import type { StudioWidgetOf, StudioDataSource } from '../../../models';
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
  getDataSourceRowState,
  isAwaitingDataSourceRows,
} from '../../../internals/dataSourceRowState';

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
  widget: StudioWidgetOf<'filter'>;
  dataSource?: StudioDataSource;
  /** ID of the page this filter widget belongs to. Scopes the active-interactive-filter lookup. */
  pageId: string;
  slots?: StudioFilterWidgetSlots;
  slotProps?: StudioFilterWidgetSlotProps;
}

// ─── Main filter widget ───────────────────────────────────────────────────────

export const StudioFilterWidget = React.memo(function StudioFilterWidget(
  props: StudioFilterWidgetProps,
) {
  const { widget, dataSource, pageId, slots, slotProps } = props;
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

  // H1: `dataSource.rows` is `undefined` — not `[]` — for an adapter-backed source until the host
  // imperatively calls `setDataSourceRows`; the adapter path resolves rows per-widget into
  // `studioRequestCache` (`useAdapterRows`) and never writes them back onto the source. Every
  // row-derived rendering below (`distinctValues`, `autoMin`/`autoMax`) previously read that
  // `undefined` as "measured, and there is nothing", producing a permanently empty dropdown and a
  // slider whose range was a meaningless 0–100 that the user could nevertheless drag and commit.
  // `'unavailable'` is kept distinct from `'empty'` so those two renderings can differ.
  const rowState = getDataSourceRowState(dataSource);
  const awaitingRows = isAwaitingDataSourceRows(dataSource);

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
    () => makeSelectActiveInteractiveFilter(widget.id, pageId),
    [widget.id, pageId],
  );
  const activeFilter = useStudioSelector(selectActiveFilter);

  // Pending Exclude-toggle intent for the multi-select control, held locally until a
  // selection exists to apply it to. `null` means "no pending intent — defer to the active
  // filter's operator". Without this, toggling Exclude while nothing is selected was a silent
  // no-op: the button couldn't reflect the user's intent and the choice was lost.
  const [pendingExclude, setPendingExclude] = React.useState<boolean | null>(null);

  // L16: the pending intent is scoped to the field (and control type) it was expressed on.
  // Changing `config.filterWidgetField` does NOT remount this component, so an "Exclude"
  // clicked with nothing selected used to survive the switch and silently commit the FIRST
  // selection on the NEW field as `not_in`. Drop it whenever the target changes, using the
  // render-time previous-value guard React documents for adjusting state on prop change (the
  // same idiom as `FilterValueInput`'s `prevOperatorRef`) so the stale intent can never be
  // read by the render that observes the new field.
  const prevExcludeFieldRef = React.useRef(fieldId);
  const prevExcludeTypeRef = React.useRef(filterWidgetType);
  if (prevExcludeFieldRef.current !== fieldId || prevExcludeTypeRef.current !== filterWidgetType) {
    prevExcludeFieldRef.current = fieldId;
    prevExcludeTypeRef.current = filterWidgetType;
    if (pendingExclude !== null) {
      setPendingExclude(null);
    }
  }

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
    // O(1) rather than O(N). `fieldId` is doc/AI-authored (`config.filterWidgetField`)
    // with no closed-enum validation, so guard the record index against inherited
    // keys: a hostile id like "constructor"/"toString" would otherwise resolve
    // `Object.prototype`'s function off the prototype chain instead of `undefined`,
    // which the `MultiSelectControl`/`ToggleControl` consumers would then throw on
    // when calling `.filter`/`.map` on it. Mirrors `StudioMapWidget`'s
    // `Object.hasOwn(allGeographies, mapGeography)` guard for the same bug class.
    const fieldDistinctValues = normalizedDataSource?.fieldDistinctValues;
    const precomputed =
      fieldDistinctValues && Object.hasOwn(fieldDistinctValues, fieldId)
        ? fieldDistinctValues[fieldId]
        : undefined;
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
      // For date fields, floor to local midnight: the committed filter
      // value is always persisted as a 'YYYY-MM-DD' string (`managedOnApply` below),
      // which re-parses to local midnight. If min/max instead kept the raw row
      // timestamp's time-of-day, the round-tripped `currentValue` the sync effect
      // receives after a commit would differ from wherever the user released the
      // slider, snapping the handles to a new position ~immediately after release.
      // Aligning min/max to the same date precision the store persists closes that gap.
      const v = isDateField
        ? dayjs(raw as string)
            .startOf('day')
            .valueOf()
        : Number(raw);
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

  // Sanitize the doc-authored slider config. `filterWidgetMin`/`filterWidgetMax`/`filterWidgetStep`
  // are typed as `number` but that type is NOT enforced at the load/AI-tool boundary, and a bad
  // pair reaches the MUI `Slider` (via `SliderControl`) directly: `min >= max` yields an inverted,
  // unusable range, and `step <= 0`/`NaN` makes the slider's internal rounding produce NaN thumb
  // positions and `aria-valuenow`. `finiteOr` allows negative bounds (unlike `sanitizeFiniteNumber`,
  // which floors at 0), so it can't be reused here (finding).
  const finiteOr = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  let sliderMin = finiteOr(config.filterWidgetMin, autoMin);
  let sliderMax = finiteOr(config.filterWidgetMax, autoMax);
  if (sliderMin > sliderMax) {
    // Inverted range → swap so the slider stays usable.
    [sliderMin, sliderMax] = [sliderMax, sliderMin];
  }
  if (sliderMin === sliderMax) {
    // Zero-width range → fall back to a sane default range.
    sliderMin = 0;
    sliderMax = 100;
  }
  const MS_PER_DAY = 86_400_000;
  const autoSliderStep =
    sliderMax - sliderMin > 100 ? Math.round((sliderMax - sliderMin) / 100) : 1;
  // `step` must be a finite number > 0 (a `0`/`NaN`/negative step produces NaN thumb positions);
  // fall back to the sensible auto default otherwise.
  const rawStep = config.filterWidgetStep;
  const fallbackStep = isDateField ? MS_PER_DAY : autoSliderStep;
  const sliderStep =
    typeof rawStep === 'number' && Number.isFinite(rawStep) && rawStep > 0 ? rawStep : fallbackStep;

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

  // H1: the value-driven control types (multi-select, toggle, slider) derive their entire visible
  // state from rows. When the rows were never delivered there is nothing honest to render: "No
  // options" and a 0–100 slider are both positive claims about data nobody has read. Say so
  // instead — and keep saying it rather than flickering to a wrong control — until rows arrive.
  // (The date-range control derives nothing from rows, so it is deliberately not gated.)
  //
  // DECLINED here, deliberately: routing this widget through `useWidgetRows` — which would make
  // the adapter actually FETCH the values — needs a `filter` entry in
  // `internals/chartTypeRegistry.ts`'s `widgetKindRegistry`. Without one, `getDescriptor` falls
  // back to `xyDescriptor`, whose `collectFields` reads chart config keys a filter widget doesn't
  // have, so the query descriptor would omit `config.filterWidgetField` and the fetched rows
  // would not carry the column being filtered on. That registry file is out of scope for this
  // change; until it gains a filter descriptor, this widget reports the absence rather than
  // fabricating a value list.
  const isValueDrivenControl =
    filterWidgetType === 'multi-select' ||
    filterWidgetType === 'toggle' ||
    filterWidgetType === 'slider';
  if (isValueDrivenControl && rowState === 'unavailable') {
    return (
      <Box sx={{ p: 1 }}>
        <Typography variant="subtitle2" noWrap>
          {label}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 0.5 }}>
          {awaitingRows && <CircularProgress size={14} />}
          <Typography variant="body2" color="text.secondary">
            {awaitingRows ? localeText.widgetLoadingLabel : localeText.widgetNoData}
          </Typography>
        </Stack>
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
        fieldId={fieldId}
        currentValue={val}
        {...slotProps?.dateRangeControl}
        onApply={managedOnApply}
        onClear={handleClear}
      />
    );
  }

  if (filterWidgetType === 'multi-select') {
    const selected = (activeFilter?.value as string[] | undefined) ?? [];
    // The displayed Exclude state prefers a not-yet-applied pending intent (chosen while
    // nothing was selected) over the active filter's operator, so the toggle reflects what
    // the user clicked even before a selection exists.
    const activeExclude = activeFilter?.operator === 'not_in';
    const exclude = pendingExclude ?? activeExclude;
    const managedOnApply = (v: string[], op: 'in' | 'not_in' = exclude ? 'not_in' : 'in') => {
      if (v.length === 0) {
        handleClear();
        return;
      }
      // The pending intent is now realized in the applied filter's operator — stop
      // overriding so the control tracks the store again.
      setPendingExclude(null);
      controller.applyInteractiveFilter(widget.id, fieldId, op, v, {
        filterMode: 'selection',
        fieldType: field?.type ?? 'string',
        filterSourceId,
      });
    };
    const managedOnExcludeChange = (nextExclude: boolean) => {
      if (selected.length > 0) {
        // A selection already exists — apply the new operator immediately.
        managedOnApply(selected, nextExclude ? 'not_in' : 'in');
      } else {
        // Nothing selected yet — remember the intent so the toggle reflects it and the next
        // selection is applied with this operator, instead of silently dropping the choice.
        setPendingExclude(nextExclude);
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
    // Reconstruct a date-slider day key by CALENDAR arithmetic from the min anchor rather than
    // formatting the raw slider timestamp. Slider positions advance in fixed `MS_PER_DAY` steps,
    // but a local calendar day is 23h/25h across a DST transition, so past a fall-back change
    // `min + k·86_400_000` lands at 23:00 of the previous local day and `dayjs(v).format(...)`
    // commits one day early. Counting whole days from `sliderMin` and adding them
    // as calendar days keeps the key on the intended day regardless of DST offsets.
    const sliderValueToDayKey = (v: number) =>
      dayjs(sliderMin)
        .add(Math.round((v - sliderMin) / MS_PER_DAY), 'day')
        .format('YYYY-MM-DD');
    const managedOnApply = (lo: number, hi: number) => {
      // For date sliders, convert timestamps back to ISO strings for filter matching
      const from = isDateField ? sliderValueToDayKey(lo) : lo;
      const to = isDateField ? sliderValueToDayKey(hi) : hi;
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
