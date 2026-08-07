'use client';
import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { formatCrossFilterValueLabel } from '@mui/x-studio-core/engine';
import {
  useStudioController,
  useStudioSelector,
  useStudioLocaleText,
  selectWidgets,
  selectExpressionFields,
  selectDataSources,
} from '../../context';
import type { StudioFilterState, StudioPage } from '../../models';
import { CollapsibleSection } from '../../internals/CollapsibleSection';

export function CrossFilterSection({
  filters,
  pages,
  activePageId,
}: {
  filters: StudioFilterState[];
  pages?: Record<string, StudioPage>;
  activePageId?: string;
}) {
  const controller = useStudioController();
  const localeText = useStudioLocaleText();
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
      // `filterSourceId` is doc-authored (persisted `StudioFilterState.filterSourceId`, also
      // reachable via `loadSerializedState`/the AI tool loop), so guard the record index against
      // inherited keys ("toString"/"constructor"/…) so a bare bracket lookup can't resolve a
      // function off `Object.prototype` instead of "not found" and then throw on `.fields.find`
      // (same prototype-chain-safe-lookup convention as `StudioFiltersDrawer.tsx`).
      const source = Object.hasOwn(dataSources, filterSourceId)
        ? dataSources[filterSourceId]
        : undefined;
      const dataField = source?.fields.find((f) => f.id === fieldId);
      if (dataField) {
        return dataField.label;
      }
    }
    return fieldId;
  }

  const clearAction =
    filters.length > 0 ? (
      <Tooltip title={localeText.filterClearAllCrossFilters}>
        <IconButton
          size="small"
          color="inherit"
          onClick={(event) => {
            event.stopPropagation();
            controller.clearAllCrossFilters();
          }}
          aria-label={localeText.filterClearAllCrossFilters}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    ) : undefined;

  return (
    <CollapsibleSection title={localeText.filterCrossSectionTitle} secondaryAction={clearAction}>
      {filters.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 1, pb: 1 }}>
          {localeText.filterSectionNoCrossFilters}
        </Typography>
      ) : (
        <Stack spacing={1} sx={{ pb: 0.5 }}>
          {filters.map((filter: StudioFilterState) => {
            const fieldLabel = resolveFieldLabel(filter.field, filter.filterSourceId);
            const sourceWidgetId =
              filter.scope.kind === 'cross-filter' ? filter.scope.sourceWidgetId : undefined;
            const widgetTitle = sourceWidgetId
              ? (widgets[sourceWidgetId]?.title ?? sourceWidgetId)
              : null;
            const filterPageId =
              filter.scope.kind === 'cross-filter' ? filter.scope.pageId : undefined;
            const isFromOtherPage =
              pages && activePageId && filterPageId && filterPageId !== activePageId;
            const pageTitle = isFromOtherPage ? (pages[filterPageId!]?.title ?? null) : null;
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
                  {localeText.filterSectionValueDisplay(
                    fieldLabel,
                    formatCrossFilterValueLabel(filter.value),
                  )}
                </Typography>
                {widgetTitle && (
                  <Typography variant="caption" color="text.secondary">
                    {localeText.filterSectionSourcePrefix(widgetTitle)}
                  </Typography>
                )}
                {pageTitle && (
                  <Typography variant="caption" color="text.disabled" sx={{ display: 'block' }}>
                    {pageTitle}
                  </Typography>
                )}
                <Tooltip title={localeText.filterRemoveCrossFilter}>
                  <IconButton
                    size="small"
                    onClick={() => controller.removeFilter(filter.id)}
                    aria-label={localeText.filterRemoveCrossFilter}
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
