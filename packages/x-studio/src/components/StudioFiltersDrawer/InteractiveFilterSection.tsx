'use client';
import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import {
  useStudioController,
  useStudioSelector,
  useStudioLocaleText,
  selectWidgets,
} from '../../context';
import type { StudioFilterState } from '../../models';
import { CollapsibleSection } from '../../internals/CollapsibleSection';

export function InteractiveFilterSection({ filters }: { filters: StudioFilterState[] }) {
  const controller = useStudioController();
  const widgets = useStudioSelector(selectWidgets);
  const localeText = useStudioLocaleText();

  return (
    <CollapsibleSection title={localeText.filterInteractiveSectionTitle}>
      {filters.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 1, pb: 1 }}>
          {localeText.filterSectionNoInteractiveFilters}
        </Typography>
      ) : (
        <Stack spacing={1} sx={{ pb: 0.5 }}>
          {filters.map((filter: StudioFilterState) => {
            const sourceWidgetId = filter.scopeV2.kind === 'interactive' ? filter.scopeV2.sourceWidgetId : undefined;
            const widgetTitle = sourceWidgetId
              ? (widgets[sourceWidgetId]?.title ?? sourceWidgetId)
              : null;
            let displayValue: string;
            if (Array.isArray(filter.value)) {
              displayValue = localeText.filterSectionSelectedCount(
                (filter.value as unknown[]).length,
              );
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
                <Tooltip title={localeText.filterClearFilter}>
                  <IconButton
                    size="small"
                    onClick={() => controller.removeFilter(filter.id)}
                    aria-label={localeText.filterClearInteractiveAriaLabel}
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
