'use client';
import { Stack, Typography } from '@mui/material';
import { useStudioLocaleText } from '../../context';
import type { StudioDataSource, StudioFilterState } from '../../models';
import type { FieldOption, SimpleField } from './filterDrawerTypes';
import type { AvailableSeries } from './RankFilterInput';
import { PageFilterRow } from './PageFilterRow';
import { WidgetFilterRow } from './WidgetFilterRow';
import { CollapsibleSection } from '../../internals/CollapsibleSection';

// ─── Page filter section ──────────────────────────────────────────────────────

interface FilterSectionProps {
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
  const {
    fields,
    fieldOptions,
    filters,
    allFilters,
    onAddFilter,
    onRemoveFilter,
    title,
    emptyMessage,
  } = props;
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

interface WidgetFilterSectionProps {
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
