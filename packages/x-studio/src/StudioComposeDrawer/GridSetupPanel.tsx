'use client';
import * as React from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Divider,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { StudioGridSummaryAggregation } from '../models';
import { useStudioController, useStudioSelector } from '../context';
import { FieldTypeIcon } from '../internals/FieldTypeIcon';

const NUMERIC_AGGREGATIONS: StudioGridSummaryAggregation[] = ['sum', 'avg', 'min', 'max', 'count'];
const STRING_AGGREGATIONS: StudioGridSummaryAggregation[] = ['count'];

const AGG_LABELS: Record<StudioGridSummaryAggregation, string> = {
  sum: 'Sum',
  avg: 'Average',
  count: 'Count',
  min: 'Min',
  max: 'Max',
};

export function GridSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector((state) => state.widgets[widgetId]);
  const dataSources = useStudioSelector((state) => state.dataSources);

  const source = widget?.sourceId ? dataSources[widget.sourceId] : undefined;
  const allFields = (source?.fields ?? []).filter((f) => !f.hidden);
  const visibleColumns: string[] = widget?.config?.columns ?? allFields.map((f) => f.id);
  const crossFilterField = widget?.config?.crossFilterField ?? '';
  const summaryFields: Record<string, StudioGridSummaryAggregation> =
    widget?.config?.gridSummaryFields ?? {};

  const handleColumnToggle = (fieldId: string) => {
    const next = visibleColumns.includes(fieldId)
      ? visibleColumns.filter((c) => c !== fieldId)
      : [...visibleColumns, fieldId];
    controller.updateWidgetConfig(widgetId, { columns: next });
  };

  const handleSummaryChange = (fieldId: string, value: StudioGridSummaryAggregation | '') => {
    const next = { ...summaryFields };
    if (value === '') {
      delete next[fieldId];
    } else {
      next[fieldId] = value;
    }
    controller.updateWidgetConfig(widgetId, {
      gridSummaryFields: Object.keys(next).length > 0 ? next : undefined,
    });
  };

  if (!source) {
    return (
      <Alert severity="warning" sx={{ mt: 1 }}>
        No data source bound to this widget.
      </Alert>
    );
  }

  const crossFilterFieldOption = allFields.find((f) => f.id === crossFilterField) ?? null;

  return (
    <Stack spacing={2}>
      {/* Cross-filter field */}
      <Autocomplete
        size="small"
        fullWidth
        options={allFields}
        getOptionLabel={(option) => option.label}
        value={crossFilterFieldOption}
        onChange={(_e, newValue) =>
          controller.updateWidgetConfig(widgetId, { crossFilterField: newValue?.id ?? undefined })
        }
        renderInput={(params) => (
          <TextField
            {...params}
            label="Cross-filter field"
            helperText="Field applied to other widgets when a row is selected; defaults to the first visible column"
          />
        )}
        isOptionEqualToValue={(option, value) => option.id === value.id}
      />

      <Divider />

      <Typography variant="caption" color="text.secondary">
        Visible columns ({visibleColumns.length}/{allFields.length})
      </Typography>
      {allFields.map((field) => {
        const isNumeric = field.type === 'number';
        const availableAggs = isNumeric ? NUMERIC_AGGREGATIONS : STRING_AGGREGATIONS;
        const currentAgg = summaryFields[field.id] ?? '';
        const isVisible = visibleColumns.includes(field.id);

        return (
          <Box
            key={field.id}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              p: 1,
              borderRadius: 1,
              bgcolor: isVisible ? 'action.selected' : 'transparent',
              border: 1,
              borderColor: 'divider',
            }}
          >
            {/* Column visibility toggle */}
            <Box
              sx={{ display: 'flex', alignItems: 'center', flex: 1, gap: 0.5, cursor: 'pointer' }}
              onClick={() => handleColumnToggle(field.id)}
              role="checkbox"
              aria-checked={isVisible}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === ' ' || event.key === 'Enter') {
                  handleColumnToggle(field.id);
                }
              }}
            >
              <FieldTypeIcon type={field.type} generated={field.generated} size={14} />
              <Typography variant="body2">{field.label}</Typography>
            </Box>

            {/* Summary aggregation selector — only shown for visible columns */}
            {isVisible && (
              <Select
                size="small"
                displayEmpty
                value={currentAgg}
                onChange={(e) =>
                  handleSummaryChange(field.id, e.target.value as StudioGridSummaryAggregation | '')
                }
                sx={{ minWidth: 90, fontSize: '0.75rem' }}
                inputProps={{ 'aria-label': `Summary for ${field.label}` }}
              >
                <MenuItem value="">
                  <em>None</em>
                </MenuItem>
                {availableAggs.map((agg) => (
                  <MenuItem key={agg} value={agg}>
                    {AGG_LABELS[agg]}
                  </MenuItem>
                ))}
              </Select>
            )}
          </Box>
        );
      })}
    </Stack>
  );
}
