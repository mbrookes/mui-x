'use client';
import * as React from 'react';
import { Box, Chip, IconButton, Tooltip } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import FilterListIcon from '@mui/icons-material/FilterList';
import {
  summarizeFilter,
  formatCrossFilterValueLabel,
  buildFieldLabelMap,
} from '@mui/x-studio-core/engine';
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
  // Tracks hover OR keyboard focus on the chip body — the chip is already focusable (it's
  // clickable), so without the focus/blur handlers a keyboard user tabbing to it never sees
  // the tooltip describing the toggle/remove affordance (a11y gap).
  const [chipHovered, setChipHovered] = React.useState(false);
  const [closeHovered, setCloseHovered] = React.useState(false);

  return (
    <Tooltip title={toggleTitle} open={chipHovered && !closeHovered}>
      <Chip
        size="small"
        color={disabled ? undefined : 'primary'}
        variant={disabled ? 'outlined' : 'filled'}
        // The chip IS the enable/disable toggle, and its on/off state was carried by
        // colour, fill and opacity alone — nothing a screen reader or a low-vision user can
        // read. `aria-pressed` states it outright, matching `ToggleControl`'s value chips.
        aria-pressed={!disabled}
        onMouseEnter={() => setChipHovered(true)}
        onMouseLeave={() => {
          setChipHovered(false);
          setCloseHovered(false);
        }}
        onFocus={() => setChipHovered(true)}
        onBlur={() => {
          setChipHovered(false);
          setCloseHovered(false);
        }}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
        onDelete={(event) => {
          event.stopPropagation?.();
          onRemove();
        }}
        deleteIcon={
          <Tooltip title={removeTitle}>
            <CloseIcon
              role="button"
              aria-label={removeTitle}
              aria-hidden={false}
              onMouseEnter={() => setCloseHovered(true)}
              onMouseLeave={() => setCloseHovered(false)}
              sx={{ fontSize: '0.75rem' }}
            />
          </Tooltip>
        }
        sx={{
          maxWidth,
          opacity: disabled ? 0.55 : 1,
          cursor: 'pointer',
          '& .MuiChip-label': { overflow: 'visible', pr: 0.5 },
        }}
        label={
          <Box
            component="span"
            sx={{
              display: 'inline-block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
              maxWidth: labelMaxWidth,
            }}
          >
            {label}
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
  const fieldLabelMap = buildFieldLabelMap(dataSources);

  // This used to call `controller.removeFilter`/`clearCrossFilter` in a
  // loop — each is its own undoable commit, so one click on "Clear all" with N filters
  // pushed N separate undo entries, and a single Ctrl+Z only restored the last-removed
  // one. Batch the whole gesture into a single undo step by computing the final
  // `filters` array up front and committing it once via `controller.updateState` (a
  // partition-aware single-commit primitive already used elsewhere in the codebase),
  // instead of the private per-mutation `commitMutations` helper.
  const handleClearAll = (event: React.MouseEvent) => {
    event.stopPropagation();
    const removedFilterIds = new Set(pageFilters.map((f) => f.id));
    const clearedWidgetIds = new Set(
      crossFilters.map((f) => f.scope.sourceWidgetId).filter((id): id is string => Boolean(id)),
    );
    const nextFilters = (filters as StudioFilterState[]).filter((f) => {
      if (removedFilterIds.has(f.id)) {
        return false;
      }
      if (f.scope.kind === 'cross-filter' && clearedWidgetIds.has(f.scope.sourceWidgetId)) {
        return false;
      }
      return true;
    });
    if (nextFilters.length !== filters.length) {
      controller.updateState({ doc: { filters: nextFilters } });
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
        backgroundColor: 'background.paper',
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
        const summary = summarizeFilter(filter, localeText);
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
        const summary = formatCrossFilterValueLabel(filter.value);
        const otherPageId =
          filter.scope.pageId && filter.scope.pageId !== activePageId
            ? filter.scope.pageId
            : undefined;
        // `filter.scope.pageId` is doc-authored: guard the record index against inherited
        // keys ("toString"/"constructor"/…) so a bare bracket lookup can't resolve a function
        // off `Object.prototype` instead of "not found" (prototype-chain key lookup fix).
        const pageTitle =
          otherPageId && Object.hasOwn(pages, otherPageId) ? pages[otherPageId].title : '';
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
