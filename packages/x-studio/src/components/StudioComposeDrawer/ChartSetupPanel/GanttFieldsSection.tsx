'use client';
import * as React from 'react';
import { Stack } from '@mui/material';
import { useStudioController, useStudioLocaleText } from '../../../context';
import type {
  StudioChartConfigOfType,
  StudioChartWidgetConfig,
  StudioFilterState,
  StudioRelationship,
} from '../../../models';
import { DataSourceFieldSelect, type DataSourceFieldEntry } from '../DataSourceFieldSelect';
import { collectStaleWidgetFilterIds } from '../collectStaleWidgetFilterIds';

export interface GanttFieldsSectionProps {
  widgetId: string;
  config: StudioChartConfigOfType<'gantt'>;
  allFields: DataSourceFieldEntry[];
  dateFields: DataSourceFieldEntry[];
  categoryFields: DataSourceFieldEntry[];
  /** The widget's current source id, used to detect a cross-source field pick. */
  widgetSourceId?: string;
  /** All filters in the doc — used to fold stale widget-scoped filter removal into the source switch. */
  allFilters?: StudioFilterState[];
  /** Declared relationships — used for source reachability when computing stale filters. */
  relationships?: StudioRelationship[];
}

/** Gantt / timeline chart setup: label, start/end date, and colour-by fields. */
export function GanttFieldsSection({
  widgetId,
  config,
  allFields,
  dateFields,
  categoryFields,
  widgetSourceId,
  allFilters,
  relationships,
}: GanttFieldsSectionProps) {
  const controller = useStudioController();
  const localeText = useStudioLocaleText();

  // Commit a gantt field pick. A from-scratch gantt widget has no source, and this
  // section holds the ONLY source-adopting controls the gantt panel offers (the shared
  // X-field picker is hidden for gantt), so each pick must adopt the picked field's
  // source or the widget can never acquire one and renders permanently blank
  // (finding 1.6). When the field belongs to a different source, adopt that source AND
  // write the field in ONE `updateWidget` commit so the cross-source pick is a single
  // undo step, and fold in the removal of any widget-scoped filter that no longer
  // resolves against the new source — mirroring the X-field / Gauge paths.
  const commitField = (configUpdate: Partial<StudioChartWidgetConfig>, sourceId: string) => {
    if (sourceId && sourceId !== widgetSourceId) {
      controller.updateWidget(
        widgetId,
        {
          sourceId,
          config: { ...config, ...configUpdate } as StudioChartWidgetConfig,
        },
        {
          removeFilterIds: collectStaleWidgetFilterIds(
            allFilters,
            widgetId,
            sourceId,
            allFields,
            relationships ?? [],
          ),
        },
      );
    } else {
      controller.updateWidgetConfig(widgetId, configUpdate);
    }
  };

  return (
    <Stack spacing={2}>
      <DataSourceFieldSelect
        value={config.ganttLabelField ?? ''}
        onChange={(fieldId, sourceId) =>
          commitField({ ganttLabelField: fieldId || undefined }, sourceId)
        }
        fields={allFields}
        label={localeText.chartSetupGanttLabelFieldLabel}
        helperText={localeText.chartSetupGanttLabelFieldHelperText}
        required
      />
      <DataSourceFieldSelect
        value={config.ganttStartField ?? ''}
        onChange={(fieldId, sourceId) =>
          commitField({ ganttStartField: fieldId || undefined }, sourceId)
        }
        fields={dateFields}
        label={localeText.chartSetupGanttStartDateLabel}
        helperText={localeText.chartSetupGanttStartDateHelperText}
        required
      />
      <DataSourceFieldSelect
        value={config.ganttEndField ?? ''}
        onChange={(fieldId, sourceId) =>
          commitField({ ganttEndField: fieldId || undefined }, sourceId)
        }
        fields={dateFields}
        label={localeText.chartSetupGanttEndDateLabel}
        helperText={localeText.chartSetupGanttEndDateHelperText}
        required
      />
      <DataSourceFieldSelect
        value={config.ganttColorField ?? ''}
        onChange={(fieldId, sourceId) =>
          commitField({ ganttColorField: fieldId || undefined }, sourceId)
        }
        fields={categoryFields}
        label={localeText.chartSetupGanttColourByLabel}
        helperText={localeText.chartSetupGanttColourByHelperText}
      />
    </Stack>
  );
}
