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
import { useBufferedInput } from './useBufferedInput';

/**
 * Stable per-rule identity (M13).
 *
 * `StudioConditionalFormat` carries no id and adding one is a persisted-schema change, so
 * the identity is minted lazily against the rule OBJECT and memoised in a `WeakMap`. The
 * doc stores rules by reference (`updateWidgetConfig` shallow-merges the config patch, the
 * undo/redo stacks snapshot `StudioDoc` by reference, and nothing sanitises or rebuilds
 * `gridConditionalFormats`), so a rule object survives every edit to a SIBLING rule — which
 * is exactly the case an index cannot express. Editing a rule replaces its object and
 * therefore mints a new id, which is the correct outcome: the row now describes a different
 * condition and any half-typed value belongs to the old one.
 *
 * A `WeakMap` keeps the entry collectable with the rule, so nothing accumulates.
 */
const ruleIds = new WeakMap<StudioConditionalFormat, string>();
let nextRuleId = 0;

function getRuleId(rule: StudioConditionalFormat): string {
  let id = ruleIds.get(rule);
  if (id === undefined) {
    nextRuleId += 1;
    id = `cf${nextRuleId}`;
    ruleIds.set(rule, id);
  }
  return id;
}

/**
 * Numeric conditional-format value input (architecture review finding 1.14):
 * `Number(raw)` on every keystroke ate the in-progress decimal point ("0." rendered
 * back as "0") and committed `undefined` for a bare "-" before the user could finish
 * typing a negative number. Buffer the displayed text locally and only parse/commit
 * on blur, mirroring `FormatPanel.tsx`'s grid-height input.
 */
function ConditionalFormatValueInput(props: {
  widgetId: string;
  /** Stable identity of this rule (see `getRuleId`), used together with `widgetId` to gate
   * the resync so switching which rule/widget is being edited always resyncs the buffer,
   * even when the two rules/widgets happen to share the same value. Deliberately NOT the
   * array index: deleting a rule renumbers its survivors without changing the identity
   * string, so a still-dirty buffer would commit onto a different rule (M13). */
  ruleId: string;
  value: unknown;
  ariaLabel: string;
  onCommit: (next: number | undefined) => void;
}) {
  const { widgetId, ruleId, value, ariaLabel, onCommit } = props;
  const initialText = value !== undefined && value !== null ? String(value) : '';
  // Shared dirty-aware buffer (M15), keyed on widget AND rule identity so switching to a
  // different widget or a different rule carrying the same value still discards an
  // uncommitted edit.
  const {
    value: text,
    dirty,
    setValue,
    settle,
  } = useBufferedInput(initialText, `${widgetId}:cfValue:${ruleId}`);

  const commit = () => {
    if (!dirty) {
      return;
    }
    const raw = text.trim();
    const parsed = raw === '' ? NaN : Number(raw);
    const next = Number.isNaN(parsed) ? undefined : parsed;
    // "Dirty" only means the buffer was TYPED IN, not that its parsed value differs from
    // what is stored: typing `5` over a stored `10` and deleting back to `10` before
    // tabbing away leaves `dirty` set with an identical value. Committing that pushes an
    // undoable entry whose content matches its predecessor, so a later Ctrl+Z appears to do
    // nothing at all. Commit only a genuine change — the same guard `TextSetupPanel` and
    // `SliderBoundInput` already apply.
    if (next !== value) {
      onCommit(next);
    }
    settle(next !== undefined ? String(next) : '');
  };

  return (
    <TextField
      size="small"
      value={text}
      placeholder="0"
      slotProps={{ htmlInput: { 'aria-label': ariaLabel } }}
      onChange={(event) => {
        setValue(event.target.value);
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
  widgetId: string;
  /** Stable identity of this rule — see `ConditionalFormatValueInput` above (M13). */
  ruleId: string;
  value: unknown;
  ariaLabel: string;
  onCommit: (next: string) => void;
}) {
  const { widgetId, ruleId, value, ariaLabel, onCommit } = props;
  const localeText = useStudioLocaleText();
  const initialText = value !== undefined && value !== null ? String(value) : '';
  // Shared dirty-aware buffer (M15) — see `ConditionalFormatValueInput` above.
  const {
    value: text,
    dirty,
    setValue,
    settle,
  } = useBufferedInput(initialText, `${widgetId}:cfStringValue:${ruleId}`);

  const commit = () => {
    if (!dirty) {
      return;
    }
    // Same no-op guard as `ConditionalFormatValueInput` above: a buffer that was typed in
    // and then restored to the stored value must not push an undo entry with identical
    // content. Compared against `initialText` (not the raw `value`) so an absent/`undefined`
    // stored value and an empty buffer count as unchanged, rather than writing `''` into a
    // rule that never had the key.
    if (text !== initialText) {
      onCommit(text);
    }
    settle(text);
  };

  return (
    <TextField
      size="small"
      value={text}
      placeholder={localeText.gridSetupCFValuePlaceholder}
      slotProps={{ htmlInput: { 'aria-label': ariaLabel } }}
      onChange={(event) => {
        setValue(event.target.value);
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
          const ruleId = getRuleId(rule);
          const noValueOp = rule.operator === 'is_empty' || rule.operator === 'is_not_empty';
          const fieldEntry = source.fields.find((f) => f.id === rule.fieldId);
          const preset = cfStylePresets.find(
            (p) =>
              p.style.backgroundColor === rule.style.backgroundColor &&
              p.style.color === rule.style.color &&
              p.style.fontWeight === rule.style.fontWeight,
          );
          return (
            // Keyed by the rule's stable identity, not its array index (M13). With an index
            // key, deleting a rule renumbered the survivors and React RE-USED the surviving
            // row's mounted inputs for a different rule — carrying a half-typed, still-dirty
            // buffer across with them. The AI chat's `update_widget` can delete a rule while
            // the user is typing, so this is reachable even though clicking Delete blurs
            // (and therefore commits) first.
            <Box
              key={ruleId}
              sx={{ display: 'flex', gap: 0.5, alignItems: 'center', flexWrap: 'wrap' }}
            >
              <Select
                size="small"
                value={rule.fieldId}
                // MUI's `Select` does NOT forward a bare `aria-label` to the element that
                // carries `role="combobox"` — `SelectInput` reads it off `inputProps`, which
                // is what `Select`'s own `inputProps` prop feeds. Passed as a plain prop it
                // landed on the hidden native input instead, leaving all three comboboxes in
                // this row with no accessible name. Same pattern as `FilterRow.tsx`.
                inputProps={{ 'aria-label': localeText.gridConditionFieldAriaLabel }}
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
                {/* Schema drift: the persisted rule references a field id no longer present
                    on the source (e.g. the field was removed/renamed after the rule was
                    saved). Without this, the Select's value matches no MenuItem and MUI
                    renders the control blank — indistinguishable from an unset field, even
                    though `rule.fieldId` is still set. Mirrors the `fieldInfo?.label ?? col.fieldId`
                    raw-id fallback in `GridSetupPanel`'s column list. */}
                {!fieldEntry && (
                  <MenuItem value={rule.fieldId} dense sx={{ fontSize: 12, fontStyle: 'italic' }}>
                    {rule.fieldId}
                  </MenuItem>
                )}
              </Select>
              <Select
                size="small"
                value={rule.operator}
                inputProps={{ 'aria-label': localeText.gridConditionOperatorAriaLabel }}
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
                    widgetId={widgetId}
                    ruleId={ruleId}
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
                    widgetId={widgetId}
                    ruleId={ruleId}
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
                inputProps={{ 'aria-label': localeText.gridConditionStyleAriaLabel }}
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
