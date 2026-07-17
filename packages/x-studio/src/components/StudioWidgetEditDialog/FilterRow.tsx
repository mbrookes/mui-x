'use client';
import * as React from 'react';
import {
  Box,
  FormControl,
  IconButton,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
} from '@mui/material';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import type { StudioDataField, StudioFilterOperator, StudioFilterState } from '../../models';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';
import {
  getOperatorLabel,
  getOperatorsForFieldType,
} from '../StudioFiltersDrawer/filterOperatorMetadata';
import { isRelativeDateValue } from '../StudioFiltersDrawer/filterDrawerUtils';
import { formatDateFilterLabel } from '../../internals/widgetUtils';

export interface FieldOption {
  id: string;
  label: string;
  type: StudioDataField['type'];
  /** The source that owns this field. Undefined means the widget's own source. */
  sourceId?: string;
  sourceLabel?: string;
  /**
   * 3.15: mirrors `StudioDataField.hidden` — a hidden field is excluded from the OFFERED
   * options in the field Select (matching every other authoring picker: GridSetupPanel,
   * the filters drawer), but a filter already configured on a hidden field must keep
   * resolving (label/type lookup via `fieldMeta`, and it stays visible as this row's own
   * current selection) — only the pick list is filtered.
   */
  hidden?: boolean;
}

// ── Operator metadata ─────────────────────────────────────────────────────────
// Shared with `StudioFiltersDrawer/filterDrawerUtils.ts` via `filterOperatorMetadata.ts`
// so a filter created here (e.g. using `between`) round-trips correctly when
// re-edited in the filters drawer, and vice versa.

const NO_VALUE_OPERATORS = new Set<StudioFilterOperator>(['is_empty', 'is_not_empty']);

// Encode field selection as "sourceId::fieldId" when cross-source to keep Select value unique
const encodeValue = (f: FieldOption) => (f.sourceId ? `${f.sourceId}::${f.id}` : f.id);

// ── Buffered value input ────────────────────────────────────────────────────────
// Finding 2.3/2.8: the value inputs used to route every keystroke straight to
// `controller.updateFilter` (default `undoable: true`), so typing a 6-char value produced
// 6 undo entries + 6 full pipeline recomputes and Ctrl+Z un-typed one character at a time.
// Buffer locally and commit on blur / Enter — the pattern already used by
// `ConditionalFormatStringValueInput`, `SliderBoundInput`, and `AnnotationLabelInput`.
function BufferedTextField(props: {
  value: unknown;
  onCommit: (next: string) => void;
  placeholder?: string;
  type?: string;
  sx?: object;
}) {
  const { value, onCommit, placeholder, type, sx } = props;
  const initialText = value === undefined || value === null ? '' : String(value);
  const [text, setText] = React.useState(initialText);
  const [dirty, setDirty] = React.useState(false);

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- buffered text mirrors the committed filter value; resync on external change (field/operator swap, undo/redo)
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
      type={type}
      placeholder={placeholder}
      value={text}
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
      sx={sx}
    />
  );
}

// ── Filter row ────────────────────────────────────────────────────────────────

export function FilterRow(props: {
  filter: StudioFilterState;
  fieldOptions: FieldOption[];
  onRemove: () => void;
  onUpdate: (patch: Partial<StudioFilterState>) => void;
}) {
  const { filter, fieldOptions, onRemove, onUpdate } = props;
  const localeText = useStudioLocaleText();
  const fieldMeta = fieldOptions.find(
    (f) => f.id === filter.field && (f.sourceId ?? null) === (filter.filterSourceId ?? null),
  );
  const operators = getOperatorsForFieldType(fieldMeta?.type);
  // 2.16: the stored `operator` can be invalid for the current field type (a legacy /
  // AI / host-authored filter, or the field switched under it) — the drawer rows
  // (`PageFilterRow`/`WidgetFilterRow`) fall back to `operators[0]` for display so the
  // Select never renders an out-of-range value (blank + MUI dev warning) while the
  // engine keeps applying the stale operator. Mirror that fallback here.
  const activeOperator = operators.some((o) => o.value === filter.operator)
    ? filter.operator
    : operators[0].value;
  const noValue = NO_VALUE_OPERATORS.has(activeOperator);
  const isBetween = activeOperator === 'between';
  // A `between` filter's value is a `{ from, to }` object. Read the bounds defensively —
  // the value may be `null`/`undefined` or a legacy scalar if the filter was authored
  // under a different operator before switching to `between`.
  const betweenValue =
    filter.value !== null && typeof filter.value === 'object' && !Array.isArray(filter.value)
      ? (filter.value as { from?: unknown; to?: unknown })
      : {};
  const betweenInputType = fieldMeta?.type === 'number' ? 'number' : 'text';
  const toBoundString = (v: unknown) => (v === undefined || v === null ? '' : String(v));

  const currentValue = filter.filterSourceId
    ? `${filter.filterSourceId}::${filter.field}`
    : filter.field;

  // Group field options by source label. 3.15: a hidden field is excluded from the OFFERED
  // list (matching GridSetupPanel / the filters drawer) unless it's this row's own current
  // selection — that keeps an existing filter on a since-hidden field visible/resolvable in
  // its own row, without offering that hidden field for a fresh pick on any row.
  const isOffered = (f: FieldOption) => !f.hidden || encodeValue(f) === currentValue;
  const ownFields = fieldOptions.filter((f) => !f.sourceId && isOffered(f));
  const relatedSources = Array.from(
    fieldOptions.reduce((set, f) => {
      if (f.sourceId && isOffered(f)) {
        set.add(f.sourceId);
      }
      return set;
    }, new Set<string>()),
  );

  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
      {/* Field selector */}
      <FormControl size="small" sx={{ minWidth: 130 }}>
        <Select
          value={currentValue}
          onChange={(evt) => {
            const raw = evt.target.value as string;
            const sep = raw.indexOf('::');
            // 2.12: a field switch can leave a now-invalid operator/value combination — e.g.
            // switching a string `contains` filter to a number field leaves `operator:
            // 'contains'`, which isn't in `NUMBER_OPERATORS`, so the operator Select renders
            // an out-of-range value (blank + MUI dev warning) while the engine keeps applying
            // `contains` against numbers. Reset the operator to `equals` and clear the value,
            // matching the drawer's phase-1 field pickers (`PageFilterRow`/`WidgetFilterRow`).
            //
            // 2.10: this dialog has no second-condition UI, so a stale `operator2`/`value2`/
            // `conjunction` from before the switch would keep silently evaluating against the
            // NEW field (`filterUtils.ts` ANDs/ORs it in) with nothing on screen to show or
            // remove it. Clear the second condition too — this is the only surface that can
            // change an existing filter's field.
            const reset = {
              operator: 'equals' as StudioFilterOperator,
              value: '',
              operator2: undefined,
              value2: undefined,
              conjunction: undefined,
            };
            if (sep !== -1) {
              const srcId = raw.slice(0, sep);
              const fId = raw.slice(sep + 2);
              const meta = fieldOptions.find((f) => f.sourceId === srcId && f.id === fId);
              onUpdate({ field: fId, filterSourceId: srcId, fieldType: meta?.type, ...reset });
            } else {
              const meta = fieldOptions.find((f) => !f.sourceId && f.id === raw);
              onUpdate({ field: raw, filterSourceId: undefined, fieldType: meta?.type, ...reset });
            }
          }}
          displayEmpty
          renderValue={(v) => {
            const sep = (v as string).indexOf('::');
            const fId = sep !== -1 ? (v as string).slice(sep + 2) : (v as string);
            const srcId = sep !== -1 ? (v as string).slice(0, sep) : undefined;
            const opt = fieldOptions.find(
              (f) => f.id === fId && (f.sourceId ?? null) === (srcId ?? null),
            );
            if (!opt) {
              return fId;
            }
            return opt.sourceId ? `${opt.sourceLabel}: ${opt.label}` : opt.label;
          }}
        >
          {ownFields.map((f) => (
            <MenuItem key={f.id} value={encodeValue(f)}>
              {f.label}
            </MenuItem>
          ))}
          {relatedSources.map((srcId) => {
            const srcFields = fieldOptions.filter((f) => f.sourceId === srcId && isOffered(f));
            const srcLabel = srcFields[0]?.sourceLabel ?? srcId;
            return [
              <MenuItem
                key={`__group-${srcId}`}
                disabled
                sx={{ fontStyle: 'italic', opacity: 0.6 }}
              >
                {srcLabel}
              </MenuItem>,
              ...srcFields.map((f) => (
                <MenuItem key={encodeValue(f)} value={encodeValue(f)} sx={{ pl: 3 }}>
                  {f.label}
                </MenuItem>
              )),
            ];
          })}
        </Select>
      </FormControl>

      {/* Operator selector */}
      <FormControl size="small" sx={{ minWidth: 130 }}>
        <Select
          value={activeOperator}
          onChange={(evt) => {
            const nextOperator = evt.target.value as StudioFilterOperator;
            // 1.6: switching AWAY from `between` must not strand the `{ from, to }` object
            // value — `toComparable` would yield NaN (matching nothing) and the value input
            // would show "[object Object]". Reset the value when the new operator is
            // shape-incompatible with the object shape `between` uses.
            //
            // 1.14: a `RelativeDateValue` is also a non-array object but a valid scalar date
            // value, so exclude it from the reset predicate — otherwise switching operator on
            // a relative-date filter silently discards the configured relative value.
            const valueIsBetweenShape =
              filter.value !== null &&
              typeof filter.value === 'object' &&
              !Array.isArray(filter.value) &&
              !isRelativeDateValue(filter.value);
            onUpdate(
              nextOperator !== 'between' && valueIsBetweenShape
                ? { operator: nextOperator, value: '' }
                : { operator: nextOperator },
            );
          }}
        >
          {operators.map((op) => (
            <MenuItem key={op.value} value={op.value}>
              {getOperatorLabel(op.value, localeText, fieldMeta?.type)}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {/* Value input */}
      {!noValue && isBetween && (
        // Dedicated from/to editor: a `between` value is a `{ from, to }` object, so the
        // generic single-value TextField would stringify it to `[object Object]` and the
        // first keystroke would clobber it into a plain string (1.10). This dialog is the
        // lower-fidelity surface (finding 2.3), so a from/to pair of plain inputs — number
        // inputs for numeric fields — is the appropriately-scoped fix; a full date-range
        // picker unification is out of scope here.
        <Stack direction="row" spacing={1} sx={{ flex: 1, minWidth: 80 }}>
          <BufferedTextField
            type={betweenInputType}
            placeholder={localeText.filterWidgetDateFromLabel}
            value={toBoundString(betweenValue.from)}
            onCommit={(next) => onUpdate({ value: { ...betweenValue, from: next } })}
            sx={{ flex: 1, minWidth: 60 }}
          />
          <BufferedTextField
            type={betweenInputType}
            placeholder={localeText.filterWidgetDateToLabel}
            value={toBoundString(betweenValue.to)}
            onCommit={(next) => onUpdate({ value: { ...betweenValue, to: next } })}
            sx={{ flex: 1, minWidth: 60 }}
          />
        </Stack>
      )}
      {/* 2.11: a `RelativeDateValue` (`{ relative: true, amount, unit, direction }`) is a
          non-array object, not a scalar — `String(filter.value)` would render
          "[object Object]" and the first keystroke+blur would commit a plain string over it,
          silently converting e.g. "3 months ago" into a literal that never matches. This
          dialog is a condition-only editor with no relative-date UI (unlike the drawer's
          `RelativeDateInput`), so show a read-only summary instead of an editable field —
          editing a relative-date filter's value stays a drawer-only operation. */}
      {!noValue && !isBetween && isRelativeDateValue(filter.value) && (
        <TextField
          size="small"
          value={formatDateFilterLabel(filter, localeText)}
          slotProps={{ input: { readOnly: true } }}
          sx={{ flex: 1, minWidth: 80 }}
        />
      )}
      {!noValue && !isBetween && !isRelativeDateValue(filter.value) && (
        <BufferedTextField
          placeholder={localeText.filterValueLabel}
          value={filter.value === undefined || filter.value === null ? '' : String(filter.value)}
          onCommit={(next) => onUpdate({ value: next })}
          sx={{ flex: 1, minWidth: 80 }}
        />
      )}
      {noValue && <Box sx={{ flex: 1 }} />}

      {/* Remove */}
      <Tooltip title={localeText.filterRemoveAriaLabel}>
        <IconButton size="small" onClick={onRemove} aria-label={localeText.filterRemoveAriaLabel}>
          <DeleteOutlineOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}
