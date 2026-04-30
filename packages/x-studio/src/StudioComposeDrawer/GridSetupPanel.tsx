'use client';
import * as React from 'react';
import { Alert, Autocomplete, Box, Divider, Stack, TextField, Typography } from '@mui/material';
import { useStudioController, useStudioSelector } from '../context';
import { FieldTypeIcon } from '../internals/FieldTypeIcon';

export function GridSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector((state) => state.widgets[widgetId]);
  const dataSources = useStudioSelector((state) => state.dataSources);

  const source = widget?.sourceId ? dataSources[widget.sourceId] : undefined;
  const allFields = (source?.fields ?? []).filter((f) => !f.hidden);
  const visibleColumns: string[] = widget?.config?.columns ?? allFields.map((f) => f.id);
  const crossFilterField = widget?.config?.crossFilterField ?? '';

  const handleColumnToggle = (fieldId: string) => {
    const next = visibleColumns.includes(fieldId)
      ? visibleColumns.filter((c) => c !== fieldId)
      : [...visibleColumns, fieldId];
    controller.updateWidgetConfig(widgetId, { columns: next });
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
            helperText="Field applied to other widgets when a row is selected"
          />
        )}
        isOptionEqualToValue={(option, value) => option.id === value.id}
      />

      <Divider />

      <Typography variant="caption" color="text.secondary">
        Visible columns ({visibleColumns.length}/{allFields.length})
      </Typography>
      {allFields.map((field) => (
        <Box
          key={field.id}
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: 'pointer',
            p: 1,
            borderRadius: 1,
            bgcolor: visibleColumns.includes(field.id) ? 'action.selected' : 'transparent',
            border: 1,
            borderColor: 'divider',
          }}
          onClick={() => handleColumnToggle(field.id)}
          role="checkbox"
          aria-checked={visibleColumns.includes(field.id)}
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
      ))}
    </Stack>
  );
}
