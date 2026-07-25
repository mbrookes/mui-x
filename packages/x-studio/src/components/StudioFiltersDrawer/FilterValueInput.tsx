'use client';
import * as React from 'react';
import {
  Autocomplete,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
} from '@mui/material';
import type { StudioFilterOperator } from '../../models';
import type { FieldType } from './filterDrawerTypes';
import { useStudioLocaleText } from '../../context';
import { DateValueInput } from './DateValueInput';

const OPERATORS_WITH_AUTOCOMPLETE = new Set<StudioFilterOperator>(['equals', 'not_equals']);
const OPERATORS_NO_VALUE = new Set<StudioFilterOperator>(['is_empty', 'is_not_empty']);

/**
 * A numeric `between` bound input that buffers its text locally and only commits to the
 * store on blur / Enter (finding 1.17). The raw `TextField`s used to call `onChange`
 * (`controller.updateFilter`, undoable) on every keystroke, so typing "1500" produced 4
 * separate undoable commits + 4 full pipeline recomputes, and Ctrl+Z un-typed one digit at
 * a time. Mirrors the edit dialog's `BufferedTextField` for the identical `between` shape.
 */
function BufferedBoundInput(props: {
  value: unknown;
  onCommit: (next: string) => void;
  label: string;
}) {
  const { value, onCommit, label } = props;
  const initialText = value === undefined || value === null ? '' : String(value);
  const [text, setText] = React.useState(initialText);
  const [dirty, setDirty] = React.useState(false);

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- buffered text mirrors the committed bound; resync on external change (operator/field swap, undo/redo)
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
      type="number"
      label={label}
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
      sx={{ minWidth: 80, flexGrow: 1 }}
    />
  );
}

/** The value input appropriate for a field type and operator. */
export function FilterValueInput(props: {
  fieldType: FieldType | undefined;
  operator: StudioFilterOperator;
  value: unknown;
  onChange: (v: unknown) => void;
  fieldValues?: string[];
}) {
  const { fieldType, operator, value, onChange, fieldValues } = props;
  const localeText = useStudioLocaleText();
  const strVal = String(value ?? '');

  // Local text state for the plain TextField and Autocomplete inputs.
  // The local state updates immediately (fast UI feedback); the store dispatch
  // (onChange prop) is debounced by 150ms so rapid keystrokes don't trigger
  // full pipeline recalculations on every character.
  const [localText, setLocalText] = React.useState(strVal);
  const debounceTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  // Sync local text when external value changes programmatically (e.g., filter cleared).
  const prevValueRef = React.useRef(value);
  if (prevValueRef.current !== value) {
    prevValueRef.current = value;
    setLocalText(String(value ?? ''));
    clearTimeout(debounceTimer.current);
  }

  // 2.12: cancel any pending debounced commit when the operator changes. A mode/operator
  // switch within the 150ms window would otherwise let a stale commit fire `onChange` with
  // the OLD scalar text against the NEW operator's value shape (e.g. landing a scalar string
  // onto a `between` object filter, or vice versa).
  //
  // M4: dropping the pending commit is only half the job — `localText` must be re-synced to
  // the value that is actually committed, exactly as the value branch above does. Without it,
  // typing `bar` into an `Equals: foo` filter and switching the operator within 150ms (via the
  // dropdown, or via `PageFilterRow`'s self-repair effect firing after a data-source load
  // race) left the input rendering `bar` while the card summary and the query both used `foo`,
  // with nothing that would ever reconcile the two.
  const prevOperatorRef = React.useRef(operator);
  if (prevOperatorRef.current !== operator) {
    prevOperatorRef.current = operator;
    clearTimeout(debounceTimer.current);
    setLocalText(String(value ?? ''));
  }

  // 2.12: flush nothing but clear the timer on unmount so a debounced commit can't fire
  // against an unmounted component (React state update warning) or a since-changed filter.
  React.useEffect(() => () => clearTimeout(debounceTimer.current), []);

  const handleTextChange = React.useCallback(
    (newVal: string) => {
      setLocalText(newVal);
      clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        onChange(newVal);
      }, 150);
    },
    [onChange],
  );

  if (OPERATORS_NO_VALUE.has(operator)) {
    return null;
  }

  // `between` carries a `{ from, to }` object, so it needs a dedicated two-input editor:
  // the generic single-value paths below would stringify it to `[object Object]` and the
  // first keystroke would clobber the object into a scalar (1.10). Date/datetime fields
  // reuse the same `DateValueInput` picker twice (from + to); numeric fields get a pair of
  // number inputs.
  if (operator === 'between') {
    const betweenValue =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as { from?: unknown; to?: unknown })
        : {};
    const setBound = (key: 'from' | 'to') => (v: unknown) =>
      onChange({ ...betweenValue, [key]: v });
    if (fieldType === 'date' || fieldType === 'datetime') {
      return (
        <Stack direction="row" spacing={1} sx={{ flexGrow: 1, minWidth: 0 }}>
          <DateValueInput
            value={betweenValue.from}
            onChange={setBound('from')}
            label={localeText.filterWidgetDateFromLabel}
          />
          <DateValueInput
            value={betweenValue.to}
            onChange={setBound('to')}
            label={localeText.filterWidgetDateToLabel}
          />
        </Stack>
      );
    }
    return (
      <Stack direction="row" spacing={1} sx={{ flexGrow: 1, minWidth: 0 }}>
        <BufferedBoundInput
          label={localeText.filterWidgetDateFromLabel}
          value={betweenValue.from}
          onCommit={(next) => setBound('from')(next)}
        />
        <BufferedBoundInput
          label={localeText.filterWidgetDateToLabel}
          value={betweenValue.to}
          onCommit={(next) => setBound('to')(next)}
        />
      </Stack>
    );
  }

  if (fieldType === 'date' || fieldType === 'datetime') {
    return <DateValueInput value={value} onChange={onChange} />;
  }

  if (fieldType === 'boolean') {
    return (
      <FormControl size="small" sx={{ minWidth: 90, flexGrow: 1 }}>
        <InputLabel>{localeText.filterValueLabel}</InputLabel>
        <Select
          label={localeText.filterValueLabel}
          value={strVal}
          onChange={(event) => onChange(event.target.value)}
        >
          <MenuItem value="true">{localeText.filterBooleanTrue}</MenuItem>
          <MenuItem value="false">{localeText.filterBooleanFalse}</MenuItem>
        </Select>
      </FormControl>
    );
  }

  if (
    (fieldType === 'string' || fieldType === undefined) &&
    OPERATORS_WITH_AUTOCOMPLETE.has(operator) &&
    fieldValues &&
    fieldValues.length > 0
  ) {
    return (
      <Autocomplete
        freeSolo
        size="small"
        options={fieldValues}
        value={localText}
        onInputChange={(_, newVal, reason) => {
          // 2.16: MUI's Autocomplete fires `onInputChange(value, 'reset')` whenever the
          // controlled `value` changes externally (undo, redo, preset apply, AI mutation).
          // Scheduling the 150ms debounce for that echo would re-commit the content-identical
          // value as a fresh, undoable, redo-clearing `updateFilter` commit ~150ms after the
          // undo/redo. Ignore the reset echo when it merely re-delivers the already-committed
          // value (an option pick — also `reason: 'reset'` — carries a DIFFERENT value and
          // still commits).
          if (reason === 'reset' && newVal === strVal) {
            return;
          }
          handleTextChange(newVal);
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            label={localeText.filterValueLabel}
            helperText={localeText.filterValueHelper}
          />
        )}
        sx={{ minWidth: 80, flexGrow: 1 }}
      />
    );
  }

  return (
    <TextField
      size="small"
      label={localeText.filterValueLabel}
      helperText={localeText.filterValueHelper}
      value={localText}
      onChange={(event) => handleTextChange(event.target.value)}
      sx={{ minWidth: 80, flexGrow: 1 }}
    />
  );
}
