'use client';
import * as React from 'react';
import {
  Alert,
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
import {
  isRelativeDateValue,
  needsOperatorValueReset,
} from '../StudioFiltersDrawer/filterDrawerUtils';
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
  /** Accessible name. `placeholder` is only a last-resort accname source — always pass this. */
  ariaLabel: string;
  type?: string;
  sx?: object;
}) {
  const { value, onCommit, placeholder, ariaLabel, type, sx } = props;
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
      slotProps={{ htmlInput: { 'aria-label': ariaLabel } }}
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
  onUpdate: (patch: Partial<StudioFilterState>, options?: { undoable?: boolean }) => void;
}) {
  const { filter, fieldOptions, onRemove, onUpdate } = props;
  const localeText = useStudioLocaleText();
  const fieldMeta = fieldOptions.find(
    (f) => f.id === filter.field && (f.sourceId ?? null) === (filter.filterSourceId ?? null),
  );
  // The stamped `filter.fieldType` is authoritative and survives a field the catalog can't
  // resolve (a cross-source pick the panel doesn't list, a since-renamed column). Deriving the
  // type from the catalog alone silently degraded every such filter to STRING: a numeric
  // `greater_than` filter rendered "Equals", offered string operators, and picking one wrote
  // e.g. `contains` onto a number field, where `toNumericValue` yields NaN and the filter stops
  // matching. Resolve exactly as the drawer rows do.
  const resolvedFieldType = filter.fieldType ?? fieldMeta?.type;
  // Memoized so the repair effect below re-runs on a genuine type change only, not on every
  // unrelated re-render (`getOperatorsForFieldType` returns a stable array, but the identity
  // is what the effect's dependency array compares).
  const operators = React.useMemo(
    () => getOperatorsForFieldType(resolvedFieldType),
    [resolvedFieldType],
  );
  // 2.16: the stored `operator` can be invalid for the current field type (a legacy /
  // AI / host-authored filter, or the field switched under it) — the drawer rows
  // (`PageFilterRow`/`WidgetFilterRow`) fall back to `operators[0]` for display so the
  // Select never renders an out-of-range value (blank + MUI dev warning) while the
  // engine keeps applying the stale operator. Mirror that fallback here.
  const activeOperator = operators.some((o) => o.value === filter.operator)
    ? filter.operator
    : operators[0].value;

  // `activeOperator` above is DISPLAY-ONLY, so without this the dialog shows one operator
  // while the engine applies another, indefinitely. Reconcile the doc to what is rendered,
  // non-undoably — the write comes from rendering, not a user gesture, and self-terminates
  // once the stored operator is valid. Gated on a RESOLVED type: while the type is unknown
  // `getOperatorsForFieldType(undefined)` yields the string table, which would condemn a
  // perfectly valid `between`/`greater_than` to a permanent rewrite. Same contract as
  // `PageFilterRow`/`WidgetFilterRow`.
  //
  // `onUpdate` is rebuilt on every render by the panel's `.map(...)`, so it is held in a ref:
  // the effect must react to the resolved type and the stored operators, nothing else.
  const onUpdateRef = React.useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  React.useEffect(() => {
    if (resolvedFieldType === undefined) {
      return;
    }
    const repair: Partial<StudioFilterState> = {};
    if (filter.operator && !operators.some((o) => o.value === filter.operator)) {
      repair.operator = operators[0].value;
    }
    if (filter.operator2 && !operators.some((o) => o.value === filter.operator2)) {
      repair.operator2 = operators[0].value;
    }
    if (repair.operator !== undefined || repair.operator2 !== undefined) {
      onUpdateRef.current(repair, { undoable: false });
    }
  }, [resolvedFieldType, filter.operator, filter.operator2, operators]);

  const noValue = NO_VALUE_OPERATORS.has(activeOperator);
  const isBetween = activeOperator === 'between';
  // A `between` filter's value is a `{ from, to }` object. Read the bounds defensively —
  // the value may be `null`/`undefined` or a legacy scalar if the filter was authored
  // under a different operator before switching to `between`.
  //
  // H3/M9: PICK the two bounds rather than keeping the stored object as the spread base.
  // Spreading made every non-array object the base of the next commit, so editing a
  // `between` on top of a relative date produced
  // `{ relative: true, amount, unit, direction, from }` — a hybrid that is neither shape,
  // that `filterUtils`' loose `.relative === true` check then mistakes for a scalar relative
  // date (the widget keeps filtering on "3 months ago" while the dialog shows a range), and
  // that disarms every `between` ↔ scalar reset guard for good. Mirrors the drawer's
  // `FilterValueInput`.
  const betweenSource =
    filter.value !== null && typeof filter.value === 'object' && !Array.isArray(filter.value)
      ? (filter.value as { from?: unknown; to?: unknown })
      : {};
  const betweenValue: { from?: unknown; to?: unknown } = {
    from: betweenSource.from,
    to: betweenSource.to,
  };
  const betweenInputType = resolvedFieldType === 'number' ? 'number' : 'text';
  const toBoundString = (v: unknown) => (v === undefined || v === null ? '' : String(v));

  // `fieldOptions` is the COMPLETE catalog for this widget (own source + every reachable
  // source, hidden physical fields and expression fields included) — only `isOffered` below
  // narrows the pick list. So an id absent from it genuinely names no column: the filter
  // matches zero rows and the widget renders empty with nothing on screen saying why. The
  // non-empty guard keeps a data-load race from being reported as a broken filter.
  const isFieldUnresolved = !!filter.field && !fieldMeta && fieldOptions.length > 0;

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

  const conditionRow = (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
      {/* Field selector */}
      <FormControl size="small" sx={{ minWidth: 130 }}>
        <Select
          inputProps={{ 'aria-label': localeText.filterFieldLabel }}
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
              // Nothing in the catalog matches: say so instead of echoing the raw id, which
              // reads exactly like a legitimate column name.
              return localeText.dataSourceFieldUnavailableOption(fId);
            }
            return opt.sourceId ? `${opt.sourceLabel}: ${opt.label}` : opt.label;
          }}
        >
          {/* The stored field may match no catalog entry at all — schema drift (removed or
              renamed column), a cross-source pick this panel doesn't list, or a catalog that
              hasn't loaded yet. Without a MenuItem carrying it, the Select's `value` is
              out-of-range: MUI logs a dev warning and, but for `renderValue` above, would
              render the control blank — indistinguishable from "no field chosen". Carry the
              current selection as its own entry so the value always resolves; `renderValue`
              is what labels it "<id> (unavailable)". Mirrors `GridConditionalFormatSection`'s
              schema-drift MenuItem and `DataSourceFieldSelect`'s appended unresolved option. */}
          {!fieldMeta && filter.field && (
            <MenuItem value={currentValue} sx={{ fontStyle: 'italic' }}>
              {localeText.dataSourceFieldUnavailableOption(filter.field)}
            </MenuItem>
          )}
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
          inputProps={{ 'aria-label': localeText.filterOperatorLabel }}
          value={activeOperator}
          onChange={(evt) => {
            const nextOperator = evt.target.value as StudioFilterOperator;
            // 1.6 / 1.14 / H3: `between` carries a `{ from, to }` object value; every other
            // operator carries a scalar. The reset has to run in BOTH directions and is the
            // SHARED `needsOperatorValueReset` helper, never a per-handler copy — this row
            // used to re-implement it inline and fire only when leaving `between`, so
            // ENTERING `between` stranded the scalar: `amount equals 500` switched to
            // "Between" rendered two empty bound inputs over a stored `500` the user never
            // cleared, and a date filter holding a `RelativeDateValue` kept the relative
            // object as the base of the next bound commit.
            //
            // `activeOperator` — not `filter.operator` — is the "previous" operator, since it
            // is what the row actually rendered when a stored operator was invalid for the
            // field type. Same contract as the drawer's `FilterBody`.
            onUpdate(
              needsOperatorValueReset(activeOperator, nextOperator, filter.value)
                ? { operator: nextOperator, value: '' }
                : { operator: nextOperator },
            );
          }}
        >
          {operators.map((op) => (
            <MenuItem key={op.value} value={op.value}>
              {getOperatorLabel(op.value, localeText, resolvedFieldType)}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {/* Value input */}
      {!noValue && isBetween && (
        // Dedicated from/to editor: a `between` value is a `{ from, to }` object, so the
        // generic single-value TextField would stringify it to `[object Object]` and the
        // first keystroke would clobber it into a plain string (1.10). This dialog is the
        // lower-fidelity surface, so a from/to pair of plain inputs — number
        // inputs for numeric fields — is the appropriately-scoped fix; a full date-range
        // picker unification is out of scope here.
        <Stack direction="row" spacing={1} sx={{ flex: 1, minWidth: 80 }}>
          <BufferedTextField
            type={betweenInputType}
            placeholder={localeText.filterWidgetDateFromLabel}
            ariaLabel={localeText.filterWidgetDateFromLabel}
            value={toBoundString(betweenValue.from)}
            onCommit={(next) => onUpdate({ value: { ...betweenValue, from: next } })}
            sx={{ flex: 1, minWidth: 60 }}
          />
          <BufferedTextField
            type={betweenInputType}
            placeholder={localeText.filterWidgetDateToLabel}
            ariaLabel={localeText.filterWidgetDateToLabel}
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
          slotProps={{
            input: { readOnly: true },
            htmlInput: { 'aria-label': localeText.filterValueLabel },
          }}
          sx={{ flex: 1, minWidth: 80 }}
        />
      )}
      {!noValue && !isBetween && !isRelativeDateValue(filter.value) && (
        <BufferedTextField
          placeholder={localeText.filterValueLabel}
          ariaLabel={localeText.filterValueLabel}
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

  if (!isFieldUnresolved) {
    return conditionRow;
  }

  // The field names no column, so this filter matches nothing and the widget renders empty.
  // Keep the row editable (the field Select is the re-point affordance, the delete button the
  // removal one) and put the reason directly above it.
  return (
    <Stack spacing={0.5}>
      <Alert severity="warning" data-testid="filter-field-unresolved">
        {localeText.dataSourceFieldUnavailableHelperText(filter.field)}
      </Alert>
      {conditionRow}
    </Stack>
  );
}
