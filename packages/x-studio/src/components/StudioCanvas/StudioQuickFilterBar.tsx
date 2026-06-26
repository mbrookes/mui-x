'use client';
import * as React from 'react';
import { Box, Chip, IconButton, Tooltip } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import {
  useStudioController,
  useStudioSelector,
  useStudioLocaleText,
  selectFilters,
  selectDataSources,
  selectActivePageId,
  selectPages,
  selectCrossFilterAllPages,
} from '../../context';
import type { StudioFilterState } from '../../models';
import { summarizeFilter } from '../StudioFiltersDrawer/filterDrawerUtils';
import { useStudioFeatures } from '../../internals/StudioUIConfigContext';

/**
 * Compact row of chips pinned above the canvas showing active page filters.
 * Only rendered in view mode when at least one page filter is present.
 *
 * - Each chip shows "FieldLabel: summary"
 * - Clicking a chip toggles it enabled/disabled without removing it
 * - Disabled chips are shown outlined and dimmed
 * - "Clear all" button removes all page filters for the active page
 */
export function StudioQuickFilterBar() {
  const controller = useStudioController();
  const filters = useStudioSelector(selectFilters);
  const dataSources = useStudioSelector(selectDataSources);
  const activePageId = useStudioSelector(selectActivePageId);
  const pages = useStudioSelector(selectPages);
  const crossFilterAllPages = useStudioSelector(selectCrossFilterAllPages);
  const localeText = useStudioLocaleText();
  const features = useStudioFeatures();

  const pageFilters = (filters as StudioFilterState[]).filter(
    (f) =>
      f.scope === 'page' &&
      // When the date range bar is disabled, still show dashboard date-range filters
      // so they remain visible and clearable (avoids hidden active filters).
      (!f.isDashboardDateRange || !features.quickFilter) &&
      (!f.pageId || f.pageId === activePageId),
  );

  // Chart-click cross-filters. When cross-page filtering is enabled, show all pages;
  // otherwise restrict to the active page only.
  const crossFilters = (filters as StudioFilterState[]).filter(
    (f) => f.scope === 'cross-filter' && (crossFilterAllPages || f.pageId === activePageId),
  );

  if (pageFilters.length === 0 && crossFilters.length === 0) {
    return null;
  }

  // Build a flat field-id → label map across all sources
  const fieldLabelMap = new Map<string, string>();
  for (const source of Object.values(dataSources)) {
    for (const field of source.fields) {
      if (!fieldLabelMap.has(field.id)) {
        fieldLabelMap.set(field.id, field.label);
      }
    }
  }

  const handleClearAll = (event: React.MouseEvent) => {
    event.stopPropagation();
    for (const f of pageFilters) {
      controller.removeFilter(f.id);
    }
    const clearedWidgets = new Set<string>();
    for (const f of crossFilters) {
      if (f.sourceWidgetId && !clearedWidgets.has(f.sourceWidgetId)) {
        clearedWidgets.add(f.sourceWidgetId);
        controller.clearCrossFilter(f.sourceWidgetId);
      }
    }
  };

  const totalCount = pageFilters.length + crossFilters.length;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        flexWrap: 'wrap',
        px: 1,
        py: 0.5,
        borderBottom: 1,
        borderColor: 'divider',
        backgroundColor: 'action.hover',
      }}
    >
      {pageFilters.map((filter) => {
        const fieldLabel = fieldLabelMap.get(filter.field) ?? filter.field;
        const summary = summarizeFilter(filter);
        const label = fieldLabel ? `${fieldLabel}: ${summary}` : summary;
        return (
          <Tooltip
            key={filter.id}
            title={
              filter.disabled
                ? localeText.quickFilterBarEnableFilter
                : localeText.quickFilterBarDisableFilter
            }
          >
            <Chip
              label={label}
              size="small"
              color={filter.disabled ? undefined : 'primary'}
              variant={filter.disabled ? 'outlined' : 'filled'}
              onClick={(event) => {
                event.stopPropagation();
                controller.toggleFilter(filter.id);
              }}
              sx={{ maxWidth: 220, opacity: filter.disabled ? 0.55 : 1, cursor: 'pointer' }}
            />
          </Tooltip>
        );
      })}

      {crossFilters.map((filter) => {
        const fieldLabel = fieldLabelMap.get(filter.field ?? '') ?? filter.field ?? '';
        const summary = String(filter.value ?? '');
        const isFromOtherPage = filter.pageId && filter.pageId !== activePageId;
        const pageTitle = isFromOtherPage ? (pages[filter.pageId!]?.title ?? '') : '';
        const baseLabel = fieldLabel ? `${fieldLabel}: ${summary}` : summary;
        const label = pageTitle ? `${pageTitle} · ${baseLabel}` : baseLabel;
        return (
          <Tooltip
            key={filter.id}
            title={
              filter.disabled
                ? localeText.quickFilterBarEnableFilter
                : localeText.quickFilterBarDisableFilter
            }
          >
            <Chip
              label={label}
              size="small"
              color={filter.disabled ? undefined : 'primary'}
              variant={filter.disabled ? 'outlined' : 'filled'}
              onClick={(event) => {
                event.stopPropagation();
                controller.toggleFilter(filter.id);
              }}
              sx={{ maxWidth: 260, opacity: filter.disabled ? 0.55 : 1, cursor: 'pointer' }}
            />
          </Tooltip>
        );
      })}

      {totalCount > 1 && (
        <Tooltip title={localeText.quickFilterBarClearAll}>
          <IconButton
            size="small"
            onClick={handleClearAll}
            aria-label={localeText.quickFilterBarClearAll}
            sx={{ ml: 'auto', flexShrink: 0 }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );
}
