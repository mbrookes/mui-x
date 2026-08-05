'use client';
import * as React from 'react';
import {
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import {
  useStudioController,
  useStudioSelector,
  selectWidgets,
  selectDataSources,
  selectExpressionFields,
  selectFilters,
  selectRelationships,
  useStudioLocaleText,
} from '../../context';
import type { DataSourceFieldEntry } from './DataSourceFieldSelect';
import { DataSourceFieldSelect } from './DataSourceFieldSelect';
import type { StudioWidgetConfigForKind } from '../../models';
import { buildFieldCatalog, buildSourceFieldEntries } from '../../internals/fieldCatalog';
// The SAME resolver the pivot widget itself applies, so panel and canvas can never disagree
// about whether a stored `pivotAggregation` is one this build supports (M10).
import { resolvePivotAggregation } from '../widgets/StudioPivotWidget/pivotUtils';
import { collectStaleWidgetFilterIds } from './collectStaleWidgetFilterIds';

interface PivotSetupPanelProps {
  widgetId: string;
}

export function PivotSetupPanel({ widgetId }: PivotSetupPanelProps) {
  const controller = useStudioController();
  const widgets = useStudioSelector(selectWidgets);
  const dataSources = useStudioSelector(selectDataSources);
  const expressionFields = useStudioSelector(selectExpressionFields);
  const allFilters = useStudioSelector(selectFilters);
  const relationships = useStudioSelector(selectRelationships);
  const localeText = useStudioLocaleText();
  const widget = widgets[widgetId];
  // `widget` comes from a broad selector, so its `config` is the cross-kind union.
  // Narrow to the pivot config shape for reading pivot-specific keys.
  const config = (widget?.config ?? {}) as StudioWidgetConfigForKind<'pivot'>;

  // M10: read the aggregation through the SAME allow-list the widget applies
  // (`StudioPivotWidget` → `resolvePivotAggregation`), not a bare `?? 'sum'`. The key's VALUE
  // is never validated at the load/AI-tool boundary — only its name is — so an imported or
  // AI-authored `pivotAggregation: 'median'` reached the widget, resolved to `null` and
  // rendered every cell as `—`, while this panel simultaneously fed `'median'` to a `Select`
  // that has no such option (MUI renders an out-of-range value as blank) and went on showing
  // the value-field picker as if the config were fine. Now the panel says the same thing the
  // widget does: the stored value is surfaced as an explicit, italicised entry so the user can
  // see what is actually configured and replace it, and the value-field picker follows the
  // RESOLVED aggregation (an unsupported one is not `'count'`, so the picker stays visible —
  // it just no longer pretends the aggregation above it is valid).
  const resolvedAggFn = resolvePivotAggregation(config.pivotAggregation);
  const aggFn = resolvedAggFn ?? config.pivotAggregation ?? 'sum';
  const showTotals = config.pivotShowTotals ?? true;
  // MUI's `Select` only emits `aria-labelledby` when handed an explicit `labelId`, and
  // `InputLabel` does not derive an `id`/`htmlFor` from `FormControl` context (its `label`
  // prop only sizes the outline notch), so an unpaired combobox has no accessible name.
  // Unique per mount so two mounted `<Studio>` instances never emit duplicate DOM ids.
  const aggregationLabelId = React.useId();

  // When the widget has a sourceId: show same-source fields only (+ same-source
  // expression fields — cross-source fields are intentionally excluded: pivot has no
  // per-field source metadata, so mixing sources would cause silent data mismatches).
  // When there is no sourceId yet: show all fields from every non-hidden source so the
  // user can pick any field first — the sourceId is then inferred from that selection.
  // Both branches fold via `buildSourceFieldEntries` (rather than the whole-catalog
  // `buildFieldCatalog`) to preserve today's exact per-source interleaved ordering
  // (physical fields then that same source's expression fields, source by source, in
  // `Object.values(dataSources)` order — NOT alphabetically `sourceLabel`-sorted) and to
  // keep expression fields scoped to the source they're folded for.
  const allFields = React.useMemo<DataSourceFieldEntry[]>(() => {
    if (!widget?.sourceId) {
      const entries: DataSourceFieldEntry[] = [];
      Object.values(dataSources).forEach((ds) => {
        if (ds.hidden) {
          return;
        }
        entries.push(...buildSourceFieldEntries(ds, expressionFields, { expression: 'all' }));
      });
      return entries;
    }
    // `widget.sourceId` is doc-authored: guard the record index against inherited prototype
    // keys ("toString"/"constructor"/…) so a bare bracket lookup can't resolve a function off
    // `Object.prototype` instead of "not found" (prototype-chain key lookup fix).
    const source = Object.hasOwn(dataSources, widget.sourceId)
      ? dataSources[widget.sourceId]
      : undefined;
    if (!source) {
      return [];
    }
    return buildSourceFieldEntries(source, expressionFields, { expression: 'all' });
  }, [widget?.sourceId, dataSources, expressionFields]);

  const categoryFields = React.useMemo(
    () => allFields.filter((f) => f.type === 'string' || f.type === 'boolean'),
    [allFields],
  );

  const numericFields = React.useMemo(
    () => allFields.filter((f) => f.type === 'number'),
    [allFields],
  );

  // Full cross-source field catalog, used to detect widget-scoped filters that no longer
  // resolve after the pivot adopts a source — mirrors the sibling setup panels.
  const fieldCatalog = React.useMemo(
    () => buildFieldCatalog(dataSources, expressionFields),
    [dataSources, expressionFields],
  );

  /** Adopt sourceId from the first field selected when no source is set yet. */
  function handleFieldChange(
    fieldKey: 'pivotRowField' | 'pivotColField' | 'pivotValueField',
    fieldId: string,
    sourceId: string,
  ) {
    if (!widget) {
      return;
    }
    if (!fieldId) {
      controller.updateWidgetConfig(widgetId, { [fieldKey]: undefined });
      return;
    }
    if (!widget.sourceId) {
      // Adopt the picked field's source. Fold in the removal of any widget-scoped filter
      // that no longer resolves against the adopted source: a filter added to
      // this source-less pivot keeps matching by `widgetId`, and once its field is absent
      // from the new source's rows the `filterUtils.ts` branches exclude every row, silently
      // blanking the pivot. Every other source-adopting setup panel folds this into the same
      // commit.
      controller.updateWidget(
        widgetId,
        {
          sourceId,
          config: { ...config, [fieldKey]: fieldId },
        },
        {
          removeFilterIds: collectStaleWidgetFilterIds(
            allFilters,
            widgetId,
            sourceId,
            fieldCatalog,
            relationships,
          ),
        },
      );
    } else {
      controller.updateWidgetConfig(widgetId, { [fieldKey]: fieldId });
    }
  }

  if (!widget) {
    return null;
  }

  return (
    <Stack spacing={2}>
      <Typography variant="caption" color="text.secondary">
        {localeText.pivotSetupDescription}
      </Typography>

      <DataSourceFieldSelect
        value={config.pivotRowField ?? ''}
        onChange={(fieldId, sourceId) => handleFieldChange('pivotRowField', fieldId, sourceId)}
        fields={categoryFields}
        label={localeText.pivotSetupRowFieldLabel}
        helperText={localeText.pivotSetupRowFieldHelper}
        required
      />

      <DataSourceFieldSelect
        value={config.pivotColField ?? ''}
        onChange={(fieldId, sourceId) => handleFieldChange('pivotColField', fieldId, sourceId)}
        fields={categoryFields}
        label={localeText.pivotSetupColFieldLabel}
        helperText={localeText.pivotSetupColFieldHelper}
        required
      />

      <Divider />

      <FormControl size="small" fullWidth>
        <InputLabel id={aggregationLabelId}>{localeText.pivotSetupAggregationLabel}</InputLabel>
        <Select
          labelId={aggregationLabelId}
          label={localeText.pivotSetupAggregationLabel}
          value={aggFn}
          onChange={(evt) =>
            controller.updateWidgetConfig(widgetId, {
              pivotAggregation: evt.target.value as 'sum' | 'avg' | 'count' | 'min' | 'max',
            })
          }
        >
          <MenuItem value="sum">{localeText.aggFnSum}</MenuItem>
          <MenuItem value="avg">{localeText.aggFnAverage}</MenuItem>
          <MenuItem value="count">{localeText.aggFnCountRows}</MenuItem>
          <MenuItem value="min">{localeText.aggFnMin}</MenuItem>
          <MenuItem value="max">{localeText.aggFnMax}</MenuItem>
          {/* Schema drift: the persisted aggregation is not one this build supports. Without
              this entry the Select's value matches no MenuItem and MUI renders the control
              blank — indistinguishable from "not configured" — while the widget renders every
              cell as `—`. Mirrors the raw-id field fallback in `GridConditionalFormatSection`. */}
          {resolvedAggFn === null && (
            <MenuItem value={aggFn} sx={{ fontStyle: 'italic' }}>
              {aggFn}
            </MenuItem>
          )}
        </Select>
      </FormControl>

      {resolvedAggFn !== 'count' && (
        <DataSourceFieldSelect
          value={config.pivotValueField ?? ''}
          onChange={(fieldId, sourceId) => handleFieldChange('pivotValueField', fieldId, sourceId)}
          fields={numericFields}
          label={localeText.pivotSetupValueFieldLabel}
          helperText={localeText.pivotSetupValueFieldHelper}
          required
        />
      )}

      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={showTotals}
            onChange={(event) =>
              controller.updateWidgetConfig(widgetId, { pivotShowTotals: event.target.checked })
            }
          />
        }
        label={<Typography variant="caption">{localeText.pivotSetupShowTotals}</Typography>}
        sx={{ ml: 0 }}
      />
    </Stack>
  );
}
