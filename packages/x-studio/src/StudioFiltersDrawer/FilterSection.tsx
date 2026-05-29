'use client';
import * as React from 'react';
import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import {
  useStudioController,
  useStudioSelector,
  useStudioLocaleText,
  selectWidgets,
  selectExpressionFields,
  selectDataSources,
} from '../context';
import type { StudioDataSource, StudioFilterState } from '../models';
import type { FieldOption, SimpleField } from './filterDrawerTypes';
import type { AvailableSeries } from './RankFilterInput';
import { PageFilterRow } from './PageFilterRow';
import { WidgetFilterRow } from './WidgetFilterRow';
import { CollapsibleSection } from '../internals/CollapsibleSection';

// ─── Page filter section ──────────────────────────────────────────────────────

export interface FilterSectionProps {
  title: string;
  filters: StudioFilterState[];
  /** All page filters (unfiltered by search) — used for dependency option discovery. */
  allFilters: StudioFilterState[];
  fields: SimpleField[];
  fieldOptions: FieldOption[];
  onAddFilter: () => void;
  onRemoveFilter: (id: string) => void;
  /** Overrides the default "No filters applied." empty message. Use when search is active. */
  emptyMessage?: string;
}

export function FilterSection(props: FilterSectionProps) {
  const { fields, fieldOptions, filters, allFilters, onAddFilter, onRemoveFilter, title, emptyMessage } = props;
  const localeText = useStudioLocaleText();

  return (
    <CollapsibleSection
      title={title}
      onAdd={onAddFilter}
      addDisabled={fields.length === 0}
      addTooltip={localeText.filtersAddFilterTooltip}
      count={filters.length}
    >
      {filters.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 0.5 }}>
          {emptyMessage ?? localeText.filtersSectionNoFilters}
        </Typography>
      ) : (
        <Stack spacing={1} sx={{ pt: 0.5 }}>
          {filters.map((filter) => (
            <PageFilterRow
              key={filter.id}
              filter={filter}
              fields={fields}
              fieldOptions={fieldOptions}
              onRemove={onRemoveFilter}
              allPageFilters={allFilters}
            />
          ))}
        </Stack>
      )}
    </CollapsibleSection>
  );
}

// ─── Widget filter section ────────────────────────────────────────────────────

export interface WidgetFilterSectionProps {
  title: string;
  filters: StudioFilterState[];
  widgetSourceId?: string;
  fieldOptions: FieldOption[];
  dataSources: Record<string, StudioDataSource>;
  onAddFilter: () => void;
  onRemoveFilter: (id: string) => void;
  chartXField?: string;
  chartYFieldLabel?: string;
  /** Available series for multi-series charts — enables "Rank by" selector in rank mode. */
  chartAvailableSeries?: AvailableSeries[];
  /** Overrides the default "No filters applied." empty message. Use when search is active. */
  emptyMessage?: string;
}

export function WidgetFilterSection(props: WidgetFilterSectionProps) {
  const {
    filters,
    widgetSourceId,
    fieldOptions,
    dataSources,
    onAddFilter,
    onRemoveFilter,
    title,
    chartXField,
    chartYFieldLabel,
    chartAvailableSeries,
    emptyMessage,
  } = props;
  const hasAnySources = Object.keys(dataSources).length > 0;
  const localeText = useStudioLocaleText();

  return (
    <CollapsibleSection
      title={title}
      onAdd={onAddFilter}
      addDisabled={!hasAnySources}
      addTooltip={localeText.filtersAddFilterTooltip}
      count={filters.length}
    >
      {filters.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 0.5 }}>
          {emptyMessage ?? localeText.filtersSectionNoFilters}
        </Typography>
      ) : (
        <Stack spacing={1} sx={{ pt: 0.5 }}>
          {filters.map((filter) => (
            <WidgetFilterRow
              key={filter.id}
              filter={filter}
              widgetSourceId={widgetSourceId}
              fieldOptions={fieldOptions}
              onRemove={onRemoveFilter}
              chartXField={chartXField}
              chartYFieldLabel={chartYFieldLabel}
              availableSeries={chartAvailableSeries}
            />
          ))}
        </Stack>
      )}
    </CollapsibleSection>
  );
}

// ─── Interactive filter section ───────────────────────────────────────────────

export function InteractiveFilterSection({ filters }: { filters: StudioFilterState[] }) {
  const controller = useStudioController();
  const widgets = useStudioSelector(selectWidgets);

  return (
    <CollapsibleSection title="Interactive filters">
      {filters.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 1, pb: 1 }}>
          No interactive filters active. Use filter widgets on the canvas to set filters.
        </Typography>
      ) : (
        <Stack spacing={1} sx={{ pb: 0.5 }}>
          {filters.map((filter: StudioFilterState) => {
            const widgetTitle = filter.sourceWidgetId
              ? (widgets[filter.sourceWidgetId]?.title ?? filter.sourceWidgetId)
              : null;
            let displayValue: string;
            if (Array.isArray(filter.value)) {
              displayValue = `${(filter.value as unknown[]).length} selected`;
            } else if (typeof filter.value === 'object' && filter.value !== null) {
              displayValue = Object.entries(filter.value as Record<string, unknown>)
                .flatMap(([k, v]) => (v != null ? [`${k}: ${String(v)}`] : []))
                .join(' – ');
            } else {
              displayValue = String(filter.value ?? '');
            }
            return (
              <Box
                key={filter.id}
                sx={{
                  position: 'relative',
                  p: 1,
                  pr: 4,
                  borderRadius: 1,
                  border: 1,
                  borderColor: 'divider',
                }}
              >
                {widgetTitle && (
                  <Typography variant="body2" sx={{ fontWeight: 'medium' }}>
                    {widgetTitle}
                  </Typography>
                )}
                <Typography variant="caption" color="text.secondary">
                  {displayValue}
                </Typography>
                <Tooltip title="Clear filter">
                  <IconButton
                    size="small"
                    onClick={() => controller.removeFilter(filter.id)}
                    aria-label="Clear interactive filter"
                    sx={{ position: 'absolute', top: 2, right: 2 }}
                  >
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
            );
          })}
        </Stack>
      )}
    </CollapsibleSection>
  );
}

export function CrossFilterSection({ filters }: { filters: StudioFilterState[] }) {
  const controller = useStudioController();
  const widgets = useStudioSelector(selectWidgets);
  const expressionFields = useStudioSelector(selectExpressionFields);
  const dataSources = useStudioSelector(selectDataSources);

  /** Resolve a human-readable label for a filter field ID. */
  function resolveFieldLabel(fieldId: string, filterSourceId?: string): string {
    const exprField = expressionFields.find((ef) => ef.id === fieldId);
    if (exprField) {
      return exprField.label;
    }
    if (filterSourceId) {
      const source = dataSources[filterSourceId];
      const dataField = source?.fields.find((f) => f.id === fieldId);
      if (dataField) {
        return dataField.label;
      }
    }
    return fieldId;
  }

  const clearAction =
    filters.length > 0 ? (
      <Tooltip title="Clear all cross-filters">
        <IconButton
          size="small"
          color="inherit"
          onClick={(event) => {
            event.stopPropagation();
            controller.clearAllCrossFilters();
          }}
          aria-label="Clear all cross-filters"
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    ) : undefined;

  return (
    <CollapsibleSection title="Cross-filters" secondaryAction={clearAction}>
      {filters.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 1, pb: 1 }}>
          No cross-filters active. Click on chart elements or select grid rows to create
          cross-filters.
        </Typography>
      ) : (
        <Stack spacing={1} sx={{ pb: 0.5 }}>
          {filters.map((filter: StudioFilterState) => {
            const fieldLabel = resolveFieldLabel(filter.field, filter.filterSourceId);
            const widgetTitle = filter.sourceWidgetId
              ? (widgets[filter.sourceWidgetId]?.title ?? filter.sourceWidgetId)
              : null;
            return (
              <Box
                key={filter.id}
                sx={{
                  position: 'relative',
                  p: 1,
                  pr: 4,
                  borderRadius: 1,
                  border: 1,
                  borderColor: 'divider',
                }}
              >
                <Typography variant="body2">
                  {fieldLabel} = {String(filter.value)}
                </Typography>
                {widgetTitle && (
                  <Typography variant="caption" color="text.secondary">
                    From: {widgetTitle}
                  </Typography>
                )}
                <Tooltip title="Remove cross-filter">
                  <IconButton
                    size="small"
                    onClick={() => controller.removeFilter(filter.id)}
                    aria-label="Remove cross-filter"
                    sx={{ position: 'absolute', top: 2, right: 2 }}
                  >
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
            );
          })}
        </Stack>
      )}
    </CollapsibleSection>
  );
}
