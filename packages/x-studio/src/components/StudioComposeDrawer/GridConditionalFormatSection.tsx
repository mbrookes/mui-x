'use client';
import * as React from 'react';
import { Box, Button, IconButton, MenuItem, Select, Stack, TextField } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import type { StudioConditionalFormat, StudioWidgetConfigForKind } from '../../models';
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
 * Numeric conditional-format value input (architecture review finding 1.14):
 * `Number(raw)` on every keystroke ate the in-progress decimal point ("0." rendered
 * back as "0") and committed `undefined` for a bare "-" before the user could finish
 * typing a negative number. Buffer the displayed text locally and only parse/commit
 * on blur, mirroring `FormatPanel.tsx`'s grid-height input.
 */
function ConditionalFormatValueInput(props: {
  value: unknown;
  ariaLabel: string;
  onCommit: (next: number | undefined) => void;
}) {
  const { value, ariaLabel, onCommit } = props;
  const initialText = value !== undefined && value !== null ? String(value) : '';
  const [text, setText] = React.useState(initialText);
  const [dirty, setDirty] = React.useState(false);

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- buffered text mirrors the committed rule value; resync on external change (field/operator swap, undo/redo)
  React.useEffect(() => {
    setText(initialText);
    setDirty(false);
  }, [initialText]);

  const commit = () => {
    if (!dirty) {
      return;
    }
    const raw = text.trim();
    const parsed = raw === '' ? NaN : Number(raw);
    const next = Number.isNaN(parsed) ? undefined : parsed;
    onCommit(next);
    setText(next !== undefined ? String(next) : '');
    setDirty(false);
  };

  return (
    <TextField
      size="small"
      value={text}
      placeholder="0"
      slotProps={{ htmlInput: { 'aria-label': ariaLabel } }}
      onChange={(event) => {
        setText(event.target.value);
        setDirty(true);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commit();
        }
      }}
      sx={{ flex: '1 1 60px', minWidth: 48, '& input': { fontSize: 12 } }}
    />
  );
}

/**
 * String-value conditional-format value input (architecture review finding 2.3):
 * this branch was missed by the earlier buffer-then-commit-on-blur pass above — it
 * called `controller.updateWidgetConfig` on every keystroke, so typing a multi-
 * character string value pushed one undoable commit (plus a mutation-log line, plus
 * a full pipeline recompute) PER CHARACTER, and Ctrl+Z un-typed one character at a
 * time. Buffer the displayed text locally and only commit on blur/Enter, mirroring
 * `ConditionalFormatValueInput` above (no numeric parsing needed here).
 */
function ConditionalFormatStringValueInput(props: {
  value: unknown;
  ariaLabel: string;
  onCommit: (next: string) => void;
}) {
  const { value, ariaLabel, onCommit } = props;
  const localeText = useStudioLocaleText();
  const initialText = value !== undefined && value !== null ? String(value) : '';
  const [text, setText] = React.useState(initialText);
  const [dirty, setDirty] = React.useState(false);

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- buffered text mirrors the committed rule value; resync on external change (field/operator swap, undo/redo)
  React.useEffect(() => {
    setText(initialText);
    setDirty(false);
  }, [initialText]);

  const commit = () => {
    if (!dirty) {
      return;
    }
    onCommit(text);
    setDirty(false);
  };

  return (
    <TextField
      size="small"
      value={text}
      placeholder={localeText.gridSetupCFValuePlaceholder}
      slotProps={{ htmlInput: { 'aria-label': ariaLabel } }}
      onChange={(event) => {
        setText(event.target.value);
        setDirty(true);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commit();
        }
      }}
      sx={{ flex: '1 1 60px', minWidth: 48, '& input': { fontSize: 12 } }}
    />
  );
}

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

  // `widget.sourceId` is doc-authored: guard the record index against inherited prototype keys
  // ("toString"/"constructor"/…) so a bare bracket lookup can't resolve a function off
  // `Object.prototype` instead of "not found" (prototype-chain key lookup fix).
  const source =
    widget?.sourceId && Object.hasOwn(dataSources, widget.sourceId)
      ? dataSources[widget.sourceId]
      : undefined;

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

  const gridConfig = widget?.config as StudioWidgetConfigForKind<'grid'> | undefined;
  const conditionalFormats: StudioConditionalFormat[] = gridConfig?.gridConditionalFormats ?? [];

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
              {!noValueOp &&
                (fieldEntry?.type === 'number' ? (
                  <ConditionalFormatValueInput
                    value={rule.value}
                    ariaLabel={localeText.gridConditionValueAriaLabel}
                    onCommit={(v) => {
                      const next = [...conditionalFormats];
                      next[i] = { ...rule, value: v };
                      controller.updateWidgetConfig(widgetId, { gridConditionalFormats: next });
                    }}
                  />
                ) : (
                  <ConditionalFormatStringValueInput
                    value={rule.value}
                    ariaLabel={localeText.gridConditionValueAriaLabel}
                    onCommit={(v) => {
                      const next = [...conditionalFormats];
                      next[i] = { ...rule, value: v };
                      controller.updateWidgetConfig(widgetId, { gridConditionalFormats: next });
                    }}
                  />
                ))}
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
