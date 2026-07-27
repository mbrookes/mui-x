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
import { commitChartConfigWithSource } from './commitConfigWithSource';

export interface GanttFieldsSectionProps {
  widgetId: string;
  config: StudioChartConfigOfType<'gantt'>;
  /** Fields OFFERED by the label picker — already narrowed to the reachable sources. */
  allFields: DataSourceFieldEntry[];
  /**
   * The FULL, unfiltered field catalog (`buildFieldCatalog`). `collectStaleWidgetFilterIds`
   * contractually takes every known field: it decides which widget-scoped filters still
   * resolve against the NEW source, so feeding it a catalog narrowed to the OLD source's
   * reachability set makes every field of the new (previously unreachable) source look
   * non-existent and over-deletes still-valid filters — inside an undoable commit, so the
   * loss is only visible after the fact. Defaults to `allFields` for callers that pass an
   * already-unfiltered list.
   */
  fieldCatalog?: DataSourceFieldEntry[];
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
  fieldCatalog,
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
  // (finding 1.6). The adoption and the field write are one undo step carrying only the
  // changed key, and any widget-scoped filter that no longer resolves against the new
  // source rides along — see `commitChartConfigWithSource`, shared with the X-field /
  // Gauge paths.
  const commitField = (configUpdate: Partial<StudioChartWidgetConfig>, sourceId: string) => {
    commitChartConfigWithSource({
      controller,
      widgetId,
      configPatch: configUpdate,
      sourceId,
      widgetSourceId,
      // Gantt hides the shared X-field picker, so these ARE the chart's source anchor: any
      // cross-source pick re-anchors the widget.
      adopt: 'anchor',
      removeFilterIds:
        sourceId && sourceId !== widgetSourceId
          ? collectStaleWidgetFilterIds(
              allFilters,
              widgetId,
              sourceId,
              // The FULL catalog, never the reachability-narrowed picker list — see the
              // `fieldCatalog` prop doc.
              fieldCatalog ?? allFields,
              relationships ?? [],
            )
          : undefined,
    });
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
