'use client';
import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import {
  useStudioController,
  useStudioSelector,
  useStudioLocaleText,
  selectWidgets,
  selectExpressionFields,
  selectDataSources,
} from '../../context';
import type { StudioFilterState } from '../../models';
import { CollapsibleSection } from '../../internals/CollapsibleSection';

export function CrossFilterSection({ filters }: { filters: StudioFilterState[] }) {
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
            const sourceWidgetId = filter.scopeV2.kind === 'cross-filter' ? filter.scopeV2.sourceWidgetId : undefined;
            const widgetTitle = sourceWidgetId
              ? (widgets[sourceWidgetId]?.title ?? sourceWidgetId)
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
                  {localeText.filterSectionValueDisplay(fieldLabel, String(filter.value))}
                </Typography>
                {widgetTitle && (
                  <Typography variant="caption" color="text.secondary">
                    {localeText.filterSectionSourcePrefix(widgetTitle)}
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
