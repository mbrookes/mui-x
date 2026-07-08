'use client';
import * as React from 'react';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import {
  Divider,
  FormControl,
  IconButton,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useStudioController, useStudioLocaleText } from '../../../context';
import type { StudioChartAnnotation } from '../../../models';

function generateAnnotationId() {
  return `ann-${Math.random().toString(36).slice(2, 9)}`;
}

export interface AnnotationsEditorSectionProps {
  widgetId: string;
  // Annotations are shared by exactly the bar / line-area / mixed / scatter families,
  // so this section takes a minimal STRUCTURAL prop rather than one family's config —
  // the flat `StudioChartConfig` the parent passes satisfies it.
  config: { annotations?: StudioChartAnnotation[] };
}

/** Reference-line (annotation) editor: add/edit/remove Y or X reference lines. */
export function AnnotationsEditorSection({ widgetId, config }: AnnotationsEditorSectionProps) {
  const controller = useStudioController();
  const localeText = useStudioLocaleText();
  const annotations = config.annotations ?? [];

  return (
    <div>
      <Divider sx={{ mb: 1.5 }} />
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1, fontWeight: 600 }}>
          {localeText.chartSetupAnnotationsTitle}
        </Typography>
        <Tooltip title={localeText.chartSetupAddReferenceLine}>
          <IconButton
            size="small"
            onClick={() => {
              const newAnn: StudioChartAnnotation = {
                id: generateAnnotationId(),
                axis: 'y',
                value: 0,
                label: '',
              };
              controller.updateWidgetConfig(widgetId, {
                annotations: [...annotations, newAnn],
              });
            }}
          >
            <AddIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      {annotations.length === 0 && (
        <Typography variant="caption" color="text.disabled" sx={{ fontStyle: 'italic' }}>
          {localeText.chartSetupNoReferenceLines}
        </Typography>
      )}
      <Stack spacing={1}>
        {annotations.map((ann) => (
          <Stack key={ann.id} direction="row" spacing={0.5} sx={{ alignItems: 'flex-start' }}>
            <FormControl size="small" sx={{ width: 56 }}>
              <Select
                value={ann.axis}
                aria-label={localeText.chartAnnotationAxisAriaLabel}
                onChange={(event) => {
                  controller.updateWidgetConfig(widgetId, {
                    annotations: annotations.map((a) =>
                      a.id === ann.id ? { ...a, axis: event.target.value as 'y' | 'x' } : a,
                    ),
                  });
                }}
              >
                <MenuItem value="y">Y</MenuItem>
                <MenuItem value="x">X</MenuItem>
              </Select>
            </FormControl>
            <TextField
              size="small"
              label={localeText.chartSetupReferenceLineValueLabel}
              value={ann.value}
              onChange={(event) => {
                const raw = event.target.value;
                const num = Number(raw);
                controller.updateWidgetConfig(widgetId, {
                  annotations: annotations.map((a) =>
                    a.id === ann.id ? { ...a, value: Number.isNaN(num) ? raw : num } : a,
                  ),
                });
              }}
              sx={{ flexGrow: 1, minWidth: 0 }}
            />
            <TextField
              size="small"
              label={localeText.chartSetupReferenceLineLabelLabel}
              value={ann.label ?? ''}
              onChange={(event) => {
                controller.updateWidgetConfig(widgetId, {
                  annotations: annotations.map((a) =>
                    a.id === ann.id ? { ...a, label: event.target.value } : a,
                  ),
                });
              }}
              sx={{ flexGrow: 1, minWidth: 0 }}
            />
            <Tooltip title={localeText.chartSetupRemoveAnnotation}>
              <IconButton
                size="small"
                onClick={() => {
                  controller.updateWidgetConfig(widgetId, {
                    annotations: annotations.filter((a) => a.id !== ann.id),
                  });
                }}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        ))}
      </Stack>
    </div>
  );
}
