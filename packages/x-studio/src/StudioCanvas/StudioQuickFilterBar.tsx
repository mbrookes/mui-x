'use client';
import * as React from 'react';
import { Box, Chip, IconButton, Tooltip, Typography } from '@mui/material';
import FilterListIcon from '@mui/icons-material/FilterList';
import CloseIcon from '@mui/icons-material/Close';
import {
  useStudioController,
  useStudioSelector,
  useStudioLocaleText,
  selectFilters,
  selectDataSources,
  selectActivePageId,
} from '../context';
import type { StudioFilterState } from '../models';
import { summarizeFilter } from '../StudioFiltersDrawer/filterDrawerUtils';
import { useStudioFeatures } from '../internals/StudioUIConfigContext';

/**
 * Compact row of chips pinned above the canvas showing active page filters.
 * Only rendered in view mode when at least one page filter is active.
 *
 * - Each chip shows "FieldLabel: summary"
 * - Clicking a chip opens the filters drawer
 * - "Clear all" button removes all page filters for the active page
 */
export function StudioQuickFilterBar() {
  const controller = useStudioController();
  const filters = useStudioSelector(selectFilters);
  const dataSources = useStudioSelector(selectDataSources);
  const activePageId = useStudioSelector(selectActivePageId);
  const localeText = useStudioLocaleText();
  const features = useStudioFeatures();

  const pageFilters = (filters as StudioFilterState[]).filter(
    (f) =>
      f.scope === 'page' &&
      // When the date range bar is disabled, still show dashboard date-range filters
      // so they remain visible and clearable (avoids hidden active filters).
      (!f.isDashboardDateRange || !features.dateRangeBar) &&
      (!f.pageId || f.pageId === activePageId),
  );

  if (pageFilters.length === 0) {
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

  const openFiltersDrawer = () => {
    controller.setDrawerOpen('filters', true);
  };

  const handleClearAll = (event: React.MouseEvent) => {
    event.stopPropagation();
    for (const f of pageFilters) {
      controller.removeFilter(f.id);
    }
  };

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
        cursor: 'pointer',
      }}
      onClick={openFiltersDrawer}
    >
      <Tooltip title={localeText.quickFilterBarOpenFilters}>
        <FilterListIcon fontSize="small" color="action" sx={{ flexShrink: 0 }} />
      </Tooltip>

      {pageFilters.map((filter) => {
        const fieldLabel = fieldLabelMap.get(filter.field) ?? filter.field;
        const summary = summarizeFilter(filter);
        const label = fieldLabel ? `${fieldLabel}: ${summary}` : summary;
        return (
          <Chip
            key={filter.id}
            label={label}
            size="small"
            onDelete={(event) => {
              event.stopPropagation();
              controller.removeFilter(filter.id);
            }}
            deleteIcon={<CloseIcon />}
            sx={{ maxWidth: 220 }}
          />
        );
      })}

      {pageFilters.length > 1 && (
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

      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ ml: pageFilters.length > 1 ? 0 : 'auto' }}
      >
        Filtered
      </Typography>
    </Box>
  );
}
