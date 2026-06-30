'use client';
import * as React from 'react';
import { Box, Chip, IconButton, Tooltip } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import FilterListIcon from '@mui/icons-material/FilterList';
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
import { useStudioFeatures, useStudioUIConfig } from '../../internals/StudioUIConfigContext';

interface QuickFilterChipProps {
  /** Tooltip shown when hovering the chip body (toggles the filter enabled/disabled). */
  toggleTitle: string;
  /** Tooltip shown when hovering the close button (removes the filter). */
  removeTitle: string;
  /** Visible chip text. */
  label: React.ReactNode;
  /** Whether the filter is currently disabled (dimmed + outlined). */
  disabled?: boolean;
  /** Maximum width of the whole chip. */
  maxWidth: number;
  /** Maximum width of the truncating label span. */
  labelMaxWidth: number;
  onToggle: () => void;
  onRemove: () => void;
}

/**
 * A single quick-filter chip with two distinct hover affordances: hovering the body shows the
 * enable/disable tooltip, hovering the close button shows the remove tooltip. The body tooltip
 * is controlled so that only one tooltip is ever visible — hovering the close button suppresses
 * the body tooltip rather than showing both at once.
 */
function QuickFilterChip(props: QuickFilterChipProps) {
  const { toggleTitle, removeTitle, label, disabled, maxWidth, labelMaxWidth, onToggle, onRemove } =
    props;
  const [chipHovered, setChipHovered] = React.useState(false);
  const [closeHovered, setCloseHovered] = React.useState(false);

  return (
    <Tooltip title={toggleTitle} open={chipHovered && !closeHovered}>
      <Chip
        size="small"
        color={disabled ? undefined : 'primary'}
        variant={disabled ? 'outlined' : 'filled'}
        onMouseEnter={() => setChipHovered(true)}
        onMouseLeave={() => {
          setChipHovered(false);
          setCloseHovered(false);
        }}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
        sx={{
          maxWidth,
          opacity: disabled ? 0.55 : 1,
          cursor: 'pointer',
          '& .MuiChip-label': { overflow: 'visible', pr: 0.5 },
        }}
        label={
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Box
              component="span"
              sx={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
                maxWidth: labelMaxWidth,
              }}
            >
              {label}
            </Box>
            <Tooltip title={removeTitle}>
              <Box
                component="span"
                role="button"
                aria-label={removeTitle}
                onMouseEnter={() => setCloseHovered(true)}
                onMouseLeave={() => setCloseHovered(false)}
                onClick={(event: React.MouseEvent) => {
                  event.stopPropagation();
                  onRemove();
                }}
                sx={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  flexShrink: 0,
                  cursor: 'pointer',
                }}
              >
                <CloseIcon sx={{ fontSize: '0.75rem' }} />
              </Box>
            </Tooltip>
          </Box>
        }
      />
    </Tooltip>
  );
}

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
  const { onOpenFilterPanel } = useStudioUIConfig();
  const filters = useStudioSelector(selectFilters);
  const dataSources = useStudioSelector(selectDataSources);
  const activePageId = useStudioSelector(selectActivePageId);
  const pages = useStudioSelector(selectPages);
  const crossFilterAllPages = useStudioSelector(selectCrossFilterAllPages);
  const localeText = useStudioLocaleText();
  const features = useStudioFeatures();

  const pageFilters = (filters as StudioFilterState[]).filter(
    (f) =>
      (f.scope.kind === 'page' ||
        (f.scope.kind === 'dashboard-date-range' && !features.quickFilter)) &&
      ('pageId' in f.scope ? !f.scope.pageId || f.scope.pageId === activePageId : true),
  );

  // Chart-click cross-filters. When cross-page filtering is enabled, show all pages;
  // otherwise restrict to the active page only.
  type CrossFilterEntry = StudioFilterState & {
    scope: { kind: 'cross-filter'; sourceWidgetId: string; pageId: string };
  };
  const crossFilters = (filters as StudioFilterState[]).filter(
    (f): f is CrossFilterEntry =>
      f.scope.kind === 'cross-filter' && (crossFilterAllPages || f.scope.pageId === activePageId),
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
      if (f.scope.sourceWidgetId && !clearedWidgets.has(f.scope.sourceWidgetId)) {
        clearedWidgets.add(f.scope.sourceWidgetId);
        controller.clearCrossFilter(f.scope.sourceWidgetId);
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
      {onOpenFilterPanel && (
        <Tooltip title={localeText.quickFilterBarOpenFilters}>
          <IconButton
            size="small"
            onClick={onOpenFilterPanel}
            aria-label={localeText.quickFilterBarOpenFilters}
            sx={{ flexShrink: 0 }}
          >
            <FilterListIcon fontSize="small" color="action" />
          </IconButton>
        </Tooltip>
      )}

      {pageFilters.map((filter) => {
        const fieldLabel = fieldLabelMap.get(filter.field) ?? filter.field;
        const summary = summarizeFilter(filter);
        const chipLabel = fieldLabel ? `${fieldLabel}: ${summary}` : summary;
        return (
          <QuickFilterChip
            key={filter.id}
            toggleTitle={
              filter.disabled
                ? localeText.quickFilterBarEnableFilter
                : localeText.quickFilterBarDisableFilter
            }
            removeTitle={localeText.quickFilterBarRemoveFilter}
            label={chipLabel}
            disabled={filter.disabled}
            maxWidth={240}
            labelMaxWidth={190}
            onToggle={() => controller.toggleFilter(filter.id)}
            onRemove={() => controller.removeFilter(filter.id)}
          />
        );
      })}

      {crossFilters.map((filter) => {
        const fieldLabel = fieldLabelMap.get(filter.field ?? '') ?? filter.field ?? '';
        const summary = String(filter.value ?? '');
        const isFromOtherPage = filter.scope.pageId && filter.scope.pageId !== activePageId;
        const pageTitle = isFromOtherPage ? (pages[filter.scope.pageId]?.title ?? '') : '';
        const baseLabel = fieldLabel ? `${fieldLabel}: ${summary}` : summary;
        const chipLabel = pageTitle ? `${pageTitle} · ${baseLabel}` : baseLabel;
        return (
          <QuickFilterChip
            key={filter.id}
            toggleTitle={
              filter.disabled
                ? localeText.quickFilterBarEnableFilter
                : localeText.quickFilterBarDisableFilter
            }
            removeTitle={localeText.quickFilterBarRemoveFilter}
            label={chipLabel}
            disabled={filter.disabled}
            maxWidth={280}
            labelMaxWidth={230}
            onToggle={() => controller.toggleFilter(filter.id)}
            onRemove={() => {
              if (filter.scope.sourceWidgetId) {
                controller.clearCrossFilter(filter.scope.sourceWidgetId);
              } else {
                controller.removeFilter(filter.id);
              }
            }}
          />
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
