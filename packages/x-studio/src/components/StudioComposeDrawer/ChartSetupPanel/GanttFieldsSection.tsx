'use client';
import * as React from 'react';
import { Stack } from '@mui/material';
import { useStudioController, useStudioLocaleText } from '../../../context';
import type { StudioChartConfigOfType } from '../../../models';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from '../DataSourceFieldSelect';

export interface GanttFieldsSectionProps {
  widgetId: string;
  config: StudioChartConfigOfType<'gantt'>;
  allFields: DataSourceFieldEntry[];
  dateFields: DataSourceFieldEntry[];
  categoryFields: DataSourceFieldEntry[];
}

/** Gantt / timeline chart setup: label, start/end date, and colour-by fields. */
export function GanttFieldsSection({
  widgetId,
  config,
  allFields,
  dateFields,
  categoryFields,
}: GanttFieldsSectionProps) {
  const controller = useStudioController();
  const localeText = useStudioLocaleText();

  return (
    <Stack spacing={2}>
      <DataSourceFieldSelect
        value={config.ganttLabelField ?? ''}
        onChange={(fieldId) =>
          controller.updateWidgetConfig(widgetId, { ganttLabelField: fieldId || undefined })
        }
        fields={allFields}
        label={localeText.chartSetupGanttLabelFieldLabel}
        helperText={localeText.chartSetupGanttLabelFieldHelperText}
        required
      />
      <DataSourceFieldSelect
        value={config.ganttStartField ?? ''}
        onChange={(fieldId) =>
          controller.updateWidgetConfig(widgetId, { ganttStartField: fieldId || undefined })
        }
        fields={dateFields}
        label={localeText.chartSetupGanttStartDateLabel}
        helperText={localeText.chartSetupGanttStartDateHelperText}
        required
      />
      <DataSourceFieldSelect
        value={config.ganttEndField ?? ''}
        onChange={(fieldId) =>
          controller.updateWidgetConfig(widgetId, { ganttEndField: fieldId || undefined })
        }
        fields={dateFields}
        label={localeText.chartSetupGanttEndDateLabel}
        helperText={localeText.chartSetupGanttEndDateHelperText}
        required
      />
      <DataSourceFieldSelect
        value={config.ganttColorField ?? ''}
        onChange={(fieldId) =>
          controller.updateWidgetConfig(widgetId, { ganttColorField: fieldId || undefined })
        }
        fields={categoryFields}
        label={localeText.chartSetupGanttColourByLabel}
        helperText={localeText.chartSetupGanttColourByHelperText}
      />
    </Stack>
  );
}
