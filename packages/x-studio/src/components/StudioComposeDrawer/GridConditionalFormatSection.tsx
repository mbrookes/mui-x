'use client';
import * as React from 'react';
import { Box, Button, IconButton, MenuItem, Select, Stack, TextField } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import type { StudioConditionalFormat } from '../../models';
import {
  useStudioController,
  useStudioSelector,
  selectWidgets,
  selectDataSources,
  useStudioLocaleText,
} from '../../context';
import { useStudioFeatures } from '../../internals/StudioUIConfigContext';
import { SetupSection } from './SetupSection';

/**
 * Grid (table) conditional-formatting rule editor. Lives in the widget's **Format** tab
 * (rule-based cell colouring is a presentation concern, not a data-setup one). Renders
 * nothing when the source is unresolved or the `gridConditionalFormats` feature is off.
 */
export function GridConditionalFormatSection(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const features = useStudioFeatures();
  const widget = useStudioSelector(selectWidgets)[widgetId];
  const dataSources = useStudioSelector(selectDataSources);
  const localeText = useStudioLocaleText();

  const source = widget?.sourceId ? dataSources[widget.sourceId] : undefined;

  const cfOperators: { value: StudioConditionalFormat['operator']; label: string }[] = [
    { value: 'equals', label: '=' },
    { value: 'not_equals', label: '≠' },
    { value: 'greater_than', label: '>' },
    { value: 'greater_than_or_equal', label: '≥' },
    { value: 'less_than', label: '<' },
    { value: 'less_than_or_equal', label: '≤' },
    { value: 'contains', label: localeText.gridSetupCFContains },
    { value: 'is_empty', label: localeText.gridSetupCFIsEmpty },
    { value: 'is_not_empty', label: localeText.gridSetupCFNotEmpty },
  ];
  const cfStylePresets: { label: string; style: StudioConditionalFormat['style'] }[] = [
    {
      label: localeText.gridSetupCFStyleRed,
      style: { backgroundColor: '#ffcdd2', color: '#b71c1c' },
    },
    {
      label: localeText.gridSetupCFStyleGreen,
      style: { backgroundColor: '#c8e6c9', color: '#1b5e20' },
    },
    {
      label: localeText.gridSetupCFStyleYellow,
      style: { backgroundColor: '#fff9c4', color: '#f57f17' },
    },
    {
      label: localeText.gridSetupCFStyleBlue,
      style: { backgroundColor: '#bbdefb', color: '#0d47a1' },
    },
    { label: localeText.gridSetupCFStyleBold, style: { fontWeight: 'bold' } },
  ];

  if (!source || features.gridConditionalFormats === false) {
    return null;
  }

  const conditionalFormats: StudioConditionalFormat[] =
    widget?.config?.gridConditionalFormats ?? [];

  return (
    <SetupSection title={localeText.gridSetupConditionalFormattingTitle}>
      <Stack spacing={1}>
        {conditionalFormats.map((rule, i) => {
          const noValueOp = rule.operator === 'is_empty' || rule.operator === 'is_not_empty';
          const fieldEntry = source.fields.find((f) => f.id === rule.fieldId);
          const preset = cfStylePresets.find(
            (p) =>
              p.style.backgroundColor === rule.style.backgroundColor &&
              p.style.color === rule.style.color &&
              p.style.fontWeight === rule.style.fontWeight,
          );
          return (
            // react-doctor-disable-next-line react-doctor/no-array-index-as-key, react-doctor/no-array-index-key -- conditional format rules have no stable ID
            <Box key={i} sx={{ display: 'flex', gap: 0.5, alignItems: 'center', flexWrap: 'wrap' }}>
              <Select
                size="small"
                value={rule.fieldId}
                aria-label={localeText.gridConditionFieldAriaLabel}
                onChange={(event) => {
                  const next = [...conditionalFormats];
                  next[i] = { ...rule, fieldId: event.target.value };
                  controller.updateWidgetConfig(widgetId, { gridConditionalFormats: next });
                }}
                sx={{ fontSize: 12, flex: '1 1 80px', minWidth: 60 }}
              >
                {source.fields.map((f) => (
                  <MenuItem key={f.id} value={f.id} dense sx={{ fontSize: 12 }}>
                    {f.label}
                  </MenuItem>
                ))}
              </Select>
              <Select
                size="small"
                value={rule.operator}
                aria-label={localeText.gridConditionOperatorAriaLabel}
                onChange={(event) => {
                  const next = [...conditionalFormats];
                  next[i] = {
                    ...rule,
                    operator: event.target.value as StudioConditionalFormat['operator'],
                  };
                  controller.updateWidgetConfig(widgetId, { gridConditionalFormats: next });
                }}
                sx={{ fontSize: 12, flex: '0 0 auto', minWidth: 60 }}
              >
                {cfOperators.map((op) => (
                  <MenuItem key={op.value} value={op.value} dense sx={{ fontSize: 12 }}>
                    {op.label}
                  </MenuItem>
                ))}
              </Select>
              {!noValueOp && (
                <TextField
                  size="small"
                  value={rule.value !== undefined && rule.value !== null ? String(rule.value) : ''}
                  placeholder={fieldEntry?.type === 'number' ? '0' : 'value'}
                  slotProps={{
                    htmlInput: { 'aria-label': localeText.gridConditionValueAriaLabel },
                  }}
                  onChange={(event) => {
                    const next = [...conditionalFormats];
                    const v =
                      fieldEntry?.type === 'number'
                        ? Number(event.target.value)
                        : event.target.value;
                    next[i] = { ...rule, value: v };
                    controller.updateWidgetConfig(widgetId, { gridConditionalFormats: next });
                  }}
                  sx={{ flex: '1 1 60px', minWidth: 48, '& input': { fontSize: 12 } }}
                />
              )}
              <Select
                size="small"
                value={preset?.label ?? '__custom__'}
                aria-label={localeText.gridConditionStyleAriaLabel}
                onChange={(event) => {
                  const selected = cfStylePresets.find((p) => p.label === event.target.value);
                  if (selected) {
                    const next = [...conditionalFormats];
                    next[i] = { ...rule, style: selected.style };
                    controller.updateWidgetConfig(widgetId, { gridConditionalFormats: next });
                  }
                }}
                sx={{ fontSize: 12, flex: '0 0 auto', minWidth: 64 }}
              >
                {cfStylePresets.map((p) => (
                  <MenuItem key={p.label} value={p.label} dense sx={{ fontSize: 12 }}>
                    {p.label}
                  </MenuItem>
                ))}
                {!preset && (
                  <MenuItem value="__custom__" dense sx={{ fontSize: 12 }}>
                    {localeText.gridSetupConditionalCustom}
                  </MenuItem>
                )}
              </Select>
              <IconButton
                size="small"
                aria-label={localeText.gridSetupRemoveRuleAriaLabel}
                onClick={() => {
                  const next = conditionalFormats.filter((_, j) => j !== i);
                  controller.updateWidgetConfig(widgetId, {
                    gridConditionalFormats: next.length > 0 ? next : undefined,
                  });
                }}
              >
                <DeleteIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Box>
          );
        })}
        <Button
          size="small"
          startIcon={<AddIcon />}
          onClick={() => {
            const firstField = source.fields[0];
            if (!firstField) {
              return;
            }
            const next: StudioConditionalFormat[] = [
              ...conditionalFormats,
              {
                fieldId: firstField.id,
                operator: 'greater_than',
                value: 0,
                style: cfStylePresets[0].style,
              },
            ];
            controller.updateWidgetConfig(widgetId, { gridConditionalFormats: next });
          }}
          sx={{ alignSelf: 'flex-start', fontSize: 12 }}
        >
          {localeText.gridSetupAddRule}
        </Button>
      </Stack>
    </SetupSection>
  );
}
