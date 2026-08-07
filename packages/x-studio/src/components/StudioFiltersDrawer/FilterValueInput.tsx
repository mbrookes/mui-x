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
import type { FieldType } from '@mui/x-studio-core/engine';
import type { StudioFilterOperator } from '../../models';
import { useStudioLocaleText } from '../../context';
import { DateValueInput } from './DateValueInput';

const OPERATORS_WITH_AUTOCOMPLETE = new Set<StudioFilterOperator>(['equals', 'not_equals']);
const OPERATORS_NO_VALUE = new Set<StudioFilterOperator>(['is_empty', 'is_not_empty']);

/**
 * A numeric `between` bound input that buffers its text locally and only commits to the
 * store on blur / Enter. The raw `TextField`s used to call `onChange`
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

  // Buffered text for the plain TextField and Autocomplete paths. Typing updates only local
  // state; the store commit happens on blur / Enter / option pick — one undo entry per
  // editing gesture. The previous 150ms debounce committed at every typing pause, so
  // "Northern Europe" landed on the undo stack as `North`, `Northern`, `Northern Eur`, …, and
  // a commit still pending at unmount was dropped outright. Same buffer-and-commit contract as
  // `BufferedBoundInput` above and `StudioWidgetEditDialog/FilterRow`'s `BufferedTextField`.
  const [localText, setLocalText] = React.useState(strVal);
  const dirtyRef = React.useRef(false);

  // Sync local text when the external value changes programmatically (filter cleared, undo,
  // redo, preset apply, AI mutation) — the store is the source of truth, so an in-progress
  // uncommitted edit is discarded rather than allowed to disagree with it.
  const prevValueRef = React.useRef(value);
  if (prevValueRef.current !== value) {
    prevValueRef.current = value;
    setLocalText(strVal);
    dirtyRef.current = false;
  }

  // An operator switch (from the dropdown, or from `PageFilterRow`'s self-repair effect
  // after a data-source load race) changes the value SHAPE the input is editing, so an
  // uncommitted scalar edit must not survive it — it would otherwise land on e.g. a `between`
  // object filter. Re-sync to what is actually stored, exactly as the value branch does.
  const prevOperatorRef = React.useRef(operator);
  if (prevOperatorRef.current !== operator) {
    prevOperatorRef.current = operator;
    setLocalText(strVal);
    dirtyRef.current = false;
  }

  const commitLocalText = () => {
    if (!dirtyRef.current) {
      return;
    }
    dirtyRef.current = false;
    onChange(localText);
  };

  const bufferLocalText = (next: string) => {
    setLocalText(next);
    dirtyRef.current = true;
  };

  if (OPERATORS_NO_VALUE.has(operator)) {
    return null;
  }

  // `between` carries a `{ from, to }` object, so it needs a dedicated two-input editor:
  // the generic single-value paths below would stringify it to `[object Object]` and the
  // first keystroke would clobber the object into a scalar (1.10). Date/datetime fields
  // reuse the same `DateValueInput` picker twice (from + to); numeric fields get a pair of
  // number inputs.
  if (operator === 'between') {
    // PICK the two bounds rather than spreading the stored value wholesale. Spreading made
    // every non-array object the base of the next commit, so editing a `between` on top of a
    // relative date produced `{ relative: true, amount, unit, direction, from }` — a hybrid that
    // is neither shape, that `isRelativeDateValue` then mistook for a scalar relative date, and
    // that consequently disarmed every `between` ↔ scalar reset guard for good. Writing back
    // only `{ from, to }` keeps the committed value canonically `between`-shaped whatever the
    // doc happened to hold (host- or AI-authored filters included).
    const source =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as { from?: unknown; to?: unknown })
        : {};
    const betweenValue: { from?: unknown; to?: unknown } = { from: source.from, to: source.to };
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
        // Picking an option (or pressing Enter on free text) is a completed gesture: commit
        // straight away rather than waiting for the blur that a click on an option never fires.
        onChange={(_, next) => {
          const nextText = next ?? '';
          setLocalText(nextText);
          dirtyRef.current = false;
          if (nextText !== strVal) {
            onChange(nextText);
          }
        }}
        onInputChange={(_, newVal, reason) => {
          // 2.16: MUI's Autocomplete fires `onInputChange(value, 'reset')` whenever the
          // controlled `value` changes externally (undo, redo, preset apply, AI mutation).
          // Buffering that echo would mark the input dirty, so the next blur would re-commit
          // the content-identical value as a fresh, undoable, redo-clearing `updateFilter`.
          // Ignore the echo when it merely re-delivers the already-committed value.
          if (reason === 'reset' && newVal === strVal) {
            return;
          }
          bufferLocalText(newVal);
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            label={localeText.filterValueLabel}
            helperText={localeText.filterValueHelper}
            onBlur={commitLocalText}
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
      onChange={(event) => bufferLocalText(event.target.value)}
      onBlur={commitLocalText}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commitLocalText();
        }
      }}
      sx={{ minWidth: 80, flexGrow: 1 }}
    />
  );
}
