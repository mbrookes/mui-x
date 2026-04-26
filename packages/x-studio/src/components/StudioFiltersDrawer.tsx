'use client';
import * as React from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Collapse,
  Divider,
  FormControl,
  FormControlLabel,
  IconButton,
  InputAdornment,
  InputLabel,
  ListSubheader,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import SearchIcon from '@mui/icons-material/Search';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';

import { useStudioController, useStudioSelector } from '../context';
import { getReachableSourceIds } from './chartUtils';
import type { RelativeDateUnit, RelativeDateValue } from './filterTypes';
import type {
  StudioDataField,
  StudioDataSource,
  StudioFilterOperator,
  StudioFilterState,
} from '../models';

type FieldType = StudioDataField['type'];

const OPERATORS_BY_TYPE: Record<FieldType, { value: StudioFilterOperator; label: string }[]> = {
  string: [
    { value: 'equals', label: 'Equals' },
    { value: 'not_equals', label: 'Not equals' },
    { value: 'contains', label: 'Contains' },
    { value: 'does_not_contain', label: 'Does not contain' },
    { value: 'starts_with', label: 'Starts with' },
    { value: 'not_starts_with', label: 'Does not start with' },
    { value: 'ends_with', label: 'Ends with' },
    { value: 'not_ends_with', label: 'Does not end with' },
    { value: 'is_empty', label: 'Is empty' },
    { value: 'is_not_empty', label: 'Is not empty' },
  ],
  number: [
    { value: 'equals', label: '=' },
    { value: 'not_equals', label: '≠' },
    { value: 'greater_than', label: '>' },
    { value: 'less_than', label: '<' },
    { value: 'greater_than_or_equal', label: '≥' },
    { value: 'less_than_or_equal', label: '≤' },
  ],
  date: [
    { value: 'equals', label: 'On' },
    { value: 'not_equals', label: 'Not on' },
    { value: 'less_than', label: 'Before' },
    { value: 'greater_than', label: 'After' },
    { value: 'less_than_or_equal', label: 'On or before' },
    { value: 'greater_than_or_equal', label: 'On or after' },
  ],
  datetime: [
    { value: 'equals', label: 'At' },
    { value: 'not_equals', label: 'Not at' },
    { value: 'greater_than', label: 'After' },
    { value: 'less_than', label: 'Before' },
    { value: 'greater_than_or_equal', label: 'At or after' },
    { value: 'less_than_or_equal', label: 'At or before' },
  ],
  boolean: [
    { value: 'equals', label: 'Is' },
    { value: 'not_equals', label: 'Is not' },
  ],
};

function getOperators(fieldType: FieldType | undefined) {
  return OPERATORS_BY_TYPE[fieldType ?? 'string'] ?? OPERATORS_BY_TYPE.string;
}

function generateId() {
  return `filter-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

type FieldOption = {
  id: string;
  label: string;
  fieldType: FieldType;
  sourceId: string;
  sourceLabel: string;
};

/** Build a flat list of field options across all sources, annotated with source and type info. */
function buildFieldOptions(dataSources: Record<string, StudioDataSource>): FieldOption[] {
  return Object.values(dataSources as Record<string, StudioDataSource>).flatMap((ds) =>
    ds.fields
      .filter((f) => !f.hidden)
      .map((f) => ({
        id: f.id,
        label: f.label,
        fieldType: f.type,
        sourceId: ds.id,
        sourceLabel: ds.label,
      })),
  );
}

function isRelativeDateValue(value: unknown): value is RelativeDateValue {
  return (
    typeof value === 'object' && value !== null && (value as RelativeDateValue).relative === true
  );
}

function absoluteToRelative(dateStr: string): RelativeDateValue {
  const date = dayjs(dateStr);
  const now = dayjs();
  if (!date.isValid()) {
    return { relative: true, amount: 1, unit: 'day', direction: 'past' };
  }
  const direction = date.isAfter(now) ? 'next' : 'past';
  const days = Math.max(1, Math.abs(date.diff(now, 'day')));
  return { relative: true, amount: days, unit: 'day', direction };
}

function relativeToAbsolute(rel: RelativeDateValue): string {
  const now = dayjs();
  const result =
    rel.direction === 'past' ? now.subtract(rel.amount, rel.unit) : now.add(rel.amount, rel.unit);
  return result.format('YYYY-MM-DD');
}

const RELATIVE_UNITS: { value: RelativeDateUnit; label: string }[] = [
  { value: 'second', label: 'seconds' },
  { value: 'minute', label: 'minutes' },
  { value: 'hour', label: 'hours' },
  { value: 'day', label: 'days' },
  { value: 'week', label: 'weeks' },
  { value: 'month', label: 'months' },
  { value: 'year', label: 'years' },
];

function RelativeDateInput({
  value,
  onChange,
}: {
  value: RelativeDateValue;
  onChange: (v: RelativeDateValue) => void;
}) {
  return (
    <Stack spacing={0.75} sx={{ flexGrow: 1, minWidth: 0 }}>
      <TextField
        size="small"
        type="number"
        label="Amount"
        value={value.amount}
        onChange={(event) =>
          onChange({ ...value, amount: Math.max(1, parseInt(event.target.value, 10) || 1) })
        }
        fullWidth
        slotProps={{ htmlInput: { min: 1 } }}
      />
      <FormControl size="small" fullWidth>
        <Select
          value={value.unit}
          onChange={(event) => onChange({ ...value, unit: event.target.value as RelativeDateUnit })}
        >
          {RELATIVE_UNITS.map((u) => (
            <MenuItem key={u.value} value={u.value}>
              {u.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <FormControl size="small" fullWidth>
        <Select
          value={value.direction}
          onChange={(event) =>
            onChange({ ...value, direction: event.target.value as 'past' | 'next' })
          }
        >
          <MenuItem value="past">ago</MenuItem>
          <MenuItem value="next">from now</MenuItem>
        </Select>
      </FormControl>
    </Stack>
  );
}

/**
 * A single date value input that supports toggling between an absolute date picker
 * and a relative expression (e.g. "5 days ago").
 */
function DateValueInput({
  value,
  onChange,
  label,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  label?: string;
}) {
  const isRel = isRelativeDateValue(value);
  const mode = isRel ? 'relative' : 'absolute';

  const handleModeChange = (_: React.MouseEvent, newMode: 'absolute' | 'relative' | null) => {
    if (!newMode || newMode === mode) {
      return;
    }
    if (newMode === 'relative') {
      onChange(absoluteToRelative(String(value ?? '')));
    } else {
      onChange(relativeToAbsolute(value as RelativeDateValue));
    }
  };

  const dayjsVal: Dayjs | null =
    !isRel && value && typeof value === 'string' ? dayjs(value as string) : null;

  return (
    <Stack spacing={1} sx={{ flexGrow: 1, minWidth: 0 }}>
      <ToggleButtonGroup
        exclusive
        value={mode}
        onChange={handleModeChange}
        sx={{ alignSelf: 'center' }}
      >
        <Tooltip title="Absolute date">
          <ToggleButton value="absolute" sx={{ px: 1.5, py: 0.5 }}>
            <CalendarTodayIcon sx={{ fontSize: 18 }} />
          </ToggleButton>
        </Tooltip>
        <Tooltip title="Relative date">
          <ToggleButton value="relative" sx={{ px: 1.5, py: 0.5 }}>
            <AccessTimeIcon sx={{ fontSize: 18 }} />
          </ToggleButton>
        </Tooltip>
      </ToggleButtonGroup>

      {isRel ? (
        <RelativeDateInput value={value as RelativeDateValue} onChange={onChange} />
      ) : (
        <DatePicker
          label={label ?? 'Date'}
          value={dayjsVal?.isValid() ? dayjsVal : null}
          onChange={(d) => onChange(d?.isValid() ? d.format('YYYY-MM-DD') : '')}
          slotProps={{ textField: { size: 'small' } }}
          sx={{ flexGrow: 1, minWidth: 130 }}
        />
      )}
    </Stack>
  );
}

/** Build sorted unique string values for a field across all data sources. */
function useFieldValues(fieldId: string, fieldType: FieldType | undefined): string[] {
  const dataSources = useStudioSelector((state) => state.dataSources);
  return React.useMemo(() => {
    if (fieldType !== 'string' && fieldType !== undefined) {
      return [];
    }
    const seen = new Set<string>();
    for (const ds of Object.values(dataSources) as StudioDataSource[]) {
      if (ds.fields.some((f) => f.id === fieldId)) {
        for (const row of ds.rows ?? []) {
          const val = row[fieldId];
          if (val != null && val !== '') {
            seen.add(String(val));
          }
        }
      }
    }
    return Array.from(seen).sort();
  }, [dataSources, fieldId, fieldType]);
}

const OPERATORS_WITH_AUTOCOMPLETE = new Set<StudioFilterOperator>(['equals', 'not_equals']);
const OPERATORS_NO_VALUE = new Set<StudioFilterOperator>(['is_empty', 'is_not_empty']);

/** The value input appropriate for a field type and operator. */
function FilterValueInput(props: {
  fieldType: FieldType | undefined;
  operator: StudioFilterOperator;
  value: unknown;
  onChange: (v: unknown) => void;
  fieldValues?: string[];
}) {
  const { fieldType, operator, value, onChange, fieldValues } = props;
  const strVal = String(value ?? '');

  if (OPERATORS_NO_VALUE.has(operator)) {
    return null;
  }

  if (fieldType === 'date' || fieldType === 'datetime') {
    return <DateValueInput value={value} onChange={onChange} />;
  }

  if (fieldType === 'boolean') {
    return (
      <FormControl size="small" sx={{ minWidth: 90, flexGrow: 1 }}>
        <InputLabel>Value</InputLabel>
        <Select label="Value" value={strVal} onChange={(event) => onChange(event.target.value)}>
          <MenuItem value="true">True</MenuItem>
          <MenuItem value="false">False</MenuItem>
        </Select>
      </FormControl>
    );
  }

  // Searchable autocomplete for equals/not_equals on string fields
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
        value={strVal}
        onInputChange={(_, newVal) => onChange(newVal)}
        renderInput={(params) => <TextField {...params} label="Value" />}
        sx={{ minWidth: 80, flexGrow: 1 }}
      />
    );
  }

  return (
    <TextField
      size="small"
      label="Value"
      value={strVal}
      onChange={(event) => onChange(event.target.value)}
      sx={{ minWidth: 80, flexGrow: 1 }}
    />
  );
}

type SimpleField = { id: string; label: string; fieldType: FieldType };

// ─── Filter summary ──────────────────────────────────────────────────────────

function formatFilterValue(value: unknown, _fieldType: FieldType | undefined): string {
  if (isRelativeDateValue(value)) {
    const { amount, unit, direction } = value;
    const plural = amount === 1 ? unit : `${unit}s`;
    return direction === 'past' ? `${amount} ${plural} ago` : `${amount} ${plural} from now`;
  }
  if (typeof value === 'string') {
    return value;
  }
  return String(value ?? '');
}

function summarizeFilter(filter: StudioFilterState): string {
  const mode = filter.filterMode ?? 'condition';

  if (mode === 'selection') {
    const selected = Array.isArray(filter.value) ? (filter.value as string[]) : [];
    if (selected.length === 0) {
      return 'any value';
    }
    const MAX_SHOWN = 3;
    const MAX_LEN = 20;
    const truncate = (v: string) => (v.length > MAX_LEN ? `${v.slice(0, MAX_LEN)}…` : v);
    const shown = selected.slice(0, MAX_SHOWN).map(truncate).join(', ');
    const rest = selected.length - MAX_SHOWN;
    return rest > 0 ? `is one of: ${shown} and ${rest} more` : `is one of: ${shown}`;
  }

  if (mode === 'rank') {
    const dir = filter.rankDirection === 'bottom' ? 'Bottom' : 'Top';
    const n = filter.value ? String(filter.value) : '?';
    return `${dir} ${n}`;
  }

  function summarizeCondition(op: StudioFilterOperator, value: unknown): string {
    if (op === 'is_empty') {
      return 'is empty';
    }
    if (op === 'is_not_empty') {
      return 'is not empty';
    }
    const opLabel = getOperators(filter.fieldType).find((o) => o.value === op)?.label ?? op;
    if (op === 'between') {
      const range = value as { from?: unknown; to?: unknown } | null;
      const from = range?.from ? formatFilterValue(range.from, filter.fieldType) : '';
      const to = range?.to ? formatFilterValue(range.to, filter.fieldType) : '';
      if (from && to) {
        return `${opLabel}: ${from} — ${to}`;
      }
      if (from) {
        return `from ${from}`;
      }
      if (to) {
        return `until ${to}`;
      }
      return opLabel;
    }
    const valStr = formatFilterValue(value, filter.fieldType);
    if (!valStr) {
      return opLabel;
    }
    return `${opLabel}: ${valStr}`;
  }

  const primary = summarizeCondition(filter.operator, filter.value);
  if (!filter.operator2) {
    return primary;
  }
  const conj = (filter.conjunction ?? 'and').toUpperCase();
  const secondary = summarizeCondition(filter.operator2, filter.value2);
  return `${primary} ${conj} ${secondary}`;
}

// ─── Filter mode toggle ───────────────────────────────────────────────────────

type FilterMode = 'condition' | 'selection' | 'rank';

function FilterModeToggle({
  mode,
  onChange,
}: {
  mode: FilterMode;
  onChange: (m: FilterMode) => void;
}) {
  return (
    <ToggleButtonGroup
      exclusive
      size="small"
      value={mode}
      onChange={(_event, val) => {
        if (val) {
          onChange(val as FilterMode);
        }
      }}
      sx={{ alignSelf: 'center' }}
    >
      <ToggleButton value="condition" sx={{ px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' }}>
        Condition
      </ToggleButton>
      <ToggleButton value="selection" sx={{ px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' }}>
        Selection
      </ToggleButton>
      <ToggleButton value="rank" sx={{ px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' }}>
        Rank
      </ToggleButton>
    </ToggleButtonGroup>
  );
}

// ─── Selection filter input ───────────────────────────────────────────────────

function SelectionFilterInput({
  values,
  selected,
  onChange,
}: {
  values: string[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  const [search, setSearch] = React.useState('');
  const filtered = values.filter((v) => v.toLowerCase().includes(search.toLowerCase()));

  const toggle = (v: string) => {
    if (selected.includes(v)) {
      onChange(selected.filter((s) => s !== v));
    } else {
      onChange([...selected, v]);
    }
  };

  return (
    <Stack spacing={0.5}>
      <TextField
        size="small"
        placeholder="Search values…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        slotProps={{
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon sx={{ fontSize: 16 }} />
              </InputAdornment>
            ),
          },
        }}
      />
      <Box
        sx={{
          maxHeight: 180,
          overflowY: 'auto',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
        }}
      >
        {filtered.length === 0 ? (
          <Typography variant="caption" color="text.secondary" sx={{ p: 1, display: 'block' }}>
            No values found.
          </Typography>
        ) : (
          filtered.map((v) => (
            <Box
              key={v}
              sx={{ display: 'flex', alignItems: 'center', px: 0.5, cursor: 'pointer' }}
              onClick={() => toggle(v)}
            >
              <Checkbox
                size="small"
                checked={selected.includes(v)}
                onChange={() => toggle(v)}
                onClick={(event) => event.stopPropagation()}
                sx={{ p: 0.5 }}
              />
              <Typography variant="body2" noWrap sx={{ flexGrow: 1, minWidth: 0, ml: 0.5 }}>
                {v}
              </Typography>
            </Box>
          ))
        )}
      </Box>
      {selected.length > 0 && (
        <Typography variant="caption" color="text.secondary">
          {selected.length} selected
        </Typography>
      )}
    </Stack>
  );
}

// ─── Rank filter input ────────────────────────────────────────────────────────

function RankFilterInput({
  direction,
  n,
  onChange,
}: {
  direction: 'top' | 'bottom';
  n: number | undefined;
  onChange: (changes: Partial<StudioFilterState>) => void;
}) {
  return (
    <Stack spacing={1}>
      <RadioGroup
        row
        value={direction}
        onChange={(event) => onChange({ rankDirection: event.target.value as 'top' | 'bottom' })}
        sx={{ gap: 1, justifyContent: 'center' }}
      >
        <FormControlLabel
          value="top"
          control={<Radio size="small" sx={{ p: 0.5 }} />}
          label="Top"
          sx={{ '& .MuiFormControlLabel-label': { fontSize: 13 } }}
        />
        <FormControlLabel
          value="bottom"
          control={<Radio size="small" sx={{ p: 0.5 }} />}
          label="Bottom"
          sx={{ '& .MuiFormControlLabel-label': { fontSize: 13 } }}
        />
      </RadioGroup>
      <TextField
        size="small"
        label="Count"
        type="number"
        value={n ?? ''}
        onChange={(event) => onChange({ value: Math.max(1, parseInt(event.target.value, 10) || 1) })}
        slotProps={{ htmlInput: { min: 1 } }}
        fullWidth
      />
    </Stack>
  );
}

// ─── Shared filter body ───────────────────────────────────────────────────────

function FilterBody({
  filter,
  fieldType,
  operators,
  activeOperator,
  activeOperator2,
  fieldValues,
  onChange,
}: {
  filter: StudioFilterState;
  fieldType: FieldType | undefined;
  operators: { value: StudioFilterOperator; label: string }[];
  activeOperator: StudioFilterOperator;
  activeOperator2: StudioFilterOperator;
  fieldValues: string[];
  onChange: (changes: Partial<StudioFilterState>) => void;
}) {
  const mode: FilterMode = filter.filterMode ?? 'condition';

  const handleModeChange = (newMode: FilterMode) => {
    const reset: Partial<StudioFilterState> = {
      filterMode: newMode,
      operator2: undefined,
      value2: undefined,
      conjunction: undefined,
      rankByField: undefined,
    };
    if (newMode === 'selection') {
      reset.value = [];
    } else if (newMode === 'rank') {
      reset.value = 10;
      reset.rankDirection = 'top';
    } else {
      reset.value = '';
    }
    onChange(reset);
  };

  return (
    <Stack spacing={1} sx={{ px: 1.5, pb: 1.5 }}>
      <FilterModeToggle mode={mode} onChange={handleModeChange} />

      {mode === 'condition' && (
        <React.Fragment>
          <FormControl size="small">
            <InputLabel>Operator</InputLabel>
            <Select
              label="Operator"
              value={activeOperator}
              onChange={(event) =>
                onChange({ operator: event.target.value as StudioFilterOperator })
              }
            >
              {operators.map((op) => (
                <MenuItem key={op.value} value={op.value}>
                  {op.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FilterValueInput
            fieldType={fieldType}
            operator={activeOperator}
            value={filter.value}
            onChange={(v) => onChange({ value: v })}
            fieldValues={fieldValues}
          />
          <SecondCondition
            filter={filter}
            operators={operators}
            activeOperator2={activeOperator2}
            fieldType={fieldType}
            fieldValues={fieldValues}
            onChange={onChange}
          />
        </React.Fragment>
      )}

      {mode === 'selection' && (
        <SelectionFilterInput
          values={fieldValues}
          selected={Array.isArray(filter.value) ? (filter.value as string[]) : []}
          onChange={(v) => onChange({ value: v })}
        />
      )}

      {mode === 'rank' && (
        <RankFilterInput
          direction={filter.rankDirection ?? 'top'}
          n={typeof filter.value === 'number' ? filter.value : undefined}
          onChange={onChange}
        />
      )}
    </Stack>
  );
}

// ─── Collapsible section ─────────────────────────────────────────────────────

interface CollapsibleSectionProps {
  title: string;
  children: React.ReactNode;
  onAdd: () => void;
  addDisabled?: boolean;
}

function CollapsibleSection(props: CollapsibleSectionProps) {
  const { title, children, onAdd, addDisabled } = props;
  const [expanded, setExpanded] = React.useState(true);

  return (
    <div>
      <Box
        sx={{ display: 'flex', alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <IconButton size="small" tabIndex={-1}>
          {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </IconButton>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          {title}
        </Typography>
        <Tooltip title="Add filter">
          <span>
            <IconButton
              size="small"
              disabled={addDisabled}
              onClick={(event) => {
                event.stopPropagation();
                onAdd();
              }}
            >
              <AddIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Box>
      <Collapse in={expanded}>
        <Box sx={{ pl: 0.5 }}>{children}</Box>
      </Collapse>
    </div>
  );
}

// ─── Second condition ────────────────────────────────────────────────────────

interface SecondConditionProps {
  filter: StudioFilterState;
  operators: { value: StudioFilterOperator; label: string }[];
  activeOperator2: StudioFilterOperator;
  fieldType: FieldType | undefined;
  fieldValues: string[];
  onChange: (changes: Partial<StudioFilterState>) => void;
}

function SecondCondition(props: SecondConditionProps) {
  const { filter, operators, activeOperator2, fieldType, fieldValues, onChange } = props;

  if (!filter.operator2) {
    return (
      <Button
        size="small"
        startIcon={<AddIcon sx={{ fontSize: 14 }} />}
        onClick={() => onChange({ operator2: operators[0].value, value2: '', conjunction: 'and' })}
        sx={{
          alignSelf: 'flex-start',
          textTransform: 'none',
          fontSize: 12,
          color: 'text.secondary',
          p: 0,
        }}
      >
        Add condition
      </Button>
    );
  }

  return (
    <React.Fragment>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Box sx={{ flexGrow: 1, display: 'flex', justifyContent: 'center' }}>
          <RadioGroup
            row
            value={filter.conjunction ?? 'and'}
            onChange={(event) => onChange({ conjunction: event.target.value as 'and' | 'or' })}
            sx={{ gap: 0.5 }}
          >
            <FormControlLabel
              value="and"
              control={<Radio size="small" sx={{ p: 0.5 }} />}
              label="AND"
              sx={{ '& .MuiFormControlLabel-label': { fontSize: 12, fontWeight: 600 } }}
            />
            <FormControlLabel
              value="or"
              control={<Radio size="small" sx={{ p: 0.5 }} />}
              label="OR"
              sx={{ '& .MuiFormControlLabel-label': { fontSize: 12, fontWeight: 600 } }}
            />
          </RadioGroup>
        </Box>
        <Tooltip title="Remove second condition">
          <IconButton
            size="small"
            onClick={() =>
              onChange({ operator2: undefined, value2: undefined, conjunction: undefined })
            }
          >
            <CloseIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      </Box>
      <FormControl size="small">
        <InputLabel>Operator</InputLabel>
        <Select
          label="Operator"
          value={activeOperator2}
          onChange={(event) => onChange({ operator2: event.target.value as StudioFilterOperator })}
        >
          {operators.map((op) => (
            <MenuItem key={op.value} value={op.value}>
              {op.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <FilterValueInput
        fieldType={fieldType}
        operator={activeOperator2}
        value={filter.value2}
        onChange={(v) => onChange({ value2: v })}
        fieldValues={fieldValues}
      />
    </React.Fragment>
  );
}

// ─── Filter rows ─────────────────────────────────────────────────────────────

interface FilterRowProps {
  filter: StudioFilterState;
  fields: SimpleField[];
  fieldOptions: FieldOption[];
  onRemove: (id: string) => void;
}

function FilterRow(props: FilterRowProps) {
  const { fields, fieldOptions, filter, onRemove } = props;
  const controller = useStudioController();
  const [expanded, setExpanded] = React.useState(true);

  const hasField = !!filter.field;
  const currentField = fields.find((f) => f.id === filter.field);
  const fieldType = filter.fieldType ?? currentField?.fieldType;
  const operators = getOperators(fieldType);
  const activeOperator = operators.find((o) => o.value === filter.operator)
    ? filter.operator
    : operators[0].value;
  const activeOperator2 =
    filter.operator2 && operators.find((o) => o.value === filter.operator2)
      ? filter.operator2
      : operators[0].value;
  const fieldValues = useFieldValues(filter.field, fieldType);
  const fieldLabel = currentField?.label ?? filter.field;

  const handleChange = (changes: Partial<StudioFilterState>) => {
    controller.addFilter({ ...filter, ...changes });
  };

  // Phase 1: no field selected yet — show picker grouped by source
  if (!hasField) {
    const groups = fieldOptions.reduce<Record<string, FieldOption[]>>((acc, opt) => {
      (acc[opt.sourceLabel] ??= []).push(opt);
      return acc;
    }, {});

    return (
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
        <FormControl size="small" sx={{ flexGrow: 1 }}>
          <InputLabel>Select a field…</InputLabel>
          <Select
            label="Select a field…"
            value=""
            onChange={(event) => {
              const opt = fieldOptions.find((o) => `${o.sourceId}:${o.id}` === event.target.value);
              if (opt) {
                handleChange({
                  field: opt.id,
                  fieldType: opt.fieldType,
                  value: '',
                  operator: 'equals',
                });
              }
            }}
          >
            {Object.entries(groups).map(([sourceLabel, opts]) => [
              <ListSubheader key={`hdr-${sourceLabel}`}>{sourceLabel}</ListSubheader>,
              ...opts.map((o) => (
                <MenuItem key={`${o.sourceId}:${o.id}`} value={`${o.sourceId}:${o.id}`}>
                  {o.label}
                </MenuItem>
              )),
            ])}
          </Select>
        </FormControl>
        <IconButton size="small" onClick={() => onRemove(filter.id)} aria-label="Remove filter">
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>
    );
  }

  // Phase 2: field selected — collapsible filter card
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          px: 0.5,
          py: 0.25,
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <IconButton size="small" tabIndex={-1}>
          {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </IconButton>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="body2" noWrap sx={{ fontWeight: 'medium' }}>
            {fieldLabel}
          </Typography>
          {!expanded && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {summarizeFilter(filter)}
            </Typography>
          )}
        </Box>
        <IconButton
          size="small"
          onClick={(event) => {
            event.stopPropagation();
            onRemove(filter.id);
          }}
          aria-label="Remove filter"
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      <Collapse in={expanded}>
        <FilterBody
          filter={filter}
          fieldType={fieldType}
          operators={operators}
          activeOperator={activeOperator}
          activeOperator2={activeOperator2}
          fieldValues={fieldValues}
          onChange={handleChange}
        />
      </Collapse>
    </Box>
  );
}

interface WidgetFilterRowProps {
  filter: StudioFilterState;
  widgetSourceId?: string;
  fieldOptions: FieldOption[];
  onRemove: (id: string) => void;
  /** xField of the chart widget — when provided, rank filters auto-use this field and skip the picker */
  chartXField?: string;
  /** Label for the y-measure shown in the rank card header */
  chartYFieldLabel?: string;
}

function WidgetFilterRow(props: WidgetFilterRowProps) {
  const { filter, widgetSourceId, fieldOptions, onRemove, chartXField, chartYFieldLabel } = props;
  const controller = useStudioController();
  const [expanded, setExpanded] = React.useState(true);

  const isChartRank = filter.filterMode === 'rank' && !!chartXField;
  // For chart rank filters, the field is always the chart's xField — treat as always "has field"
  const hasField = !!filter.field || isChartRank;

  const effectiveSourceId = filter.filterSourceId ?? widgetSourceId ?? '';
  const selectedOption =
    fieldOptions.find((o) => o.id === filter.field && o.sourceId === effectiveSourceId) ?? null;
  const fieldType = filter.fieldType ?? selectedOption?.fieldType;
  const operators = getOperators(fieldType);
  const activeOperator = operators.find((o) => o.value === filter.operator)
    ? filter.operator
    : operators[0].value;
  const activeOperator2 =
    filter.operator2 && operators.find((o) => o.value === filter.operator2)
      ? filter.operator2
      : operators[0].value;
  const fieldValues = useFieldValues(filter.field, fieldType);
  const fieldLabel = selectedOption?.label ?? filter.field;

  const handleChange = (changes: Partial<StudioFilterState>) => {
    const merged = { ...filter, ...changes };
    // Auto-wire field for chart rank filters so isFilterComplete passes
    if (merged.filterMode === 'rank' && chartXField && !merged.field) {
      merged.field = chartXField;
    }
    controller.removeFilter(filter.id);
    controller.addFilter(merged);
  };

  const handleFieldSelect = (_e: React.SyntheticEvent, option: FieldOption | null) => {
    if (!option) {
      return;
    }
    const isNowCrossSource = option.sourceId !== widgetSourceId;
    handleChange({
      field: option.id,
      fieldType: option.fieldType,
      filterSourceId: isNowCrossSource ? option.sourceId : undefined,
      value: '',
      operator: 'equals',
    });
  };

  // Phase 1: no field selected yet — show autocomplete picker
  if (!hasField) {
    return (
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
        <Autocomplete
          size="small"
          sx={{ flexGrow: 1 }}
          options={fieldOptions}
          groupBy={(option) => option.sourceLabel}
          getOptionLabel={(option) => option.label}
          value={null}
          onChange={handleFieldSelect}
          isOptionEqualToValue={(option, value) =>
            option.id === value.id && option.sourceId === value.sourceId
          }
          renderInput={(params) => <TextField {...params} label="Select a field…" />}
        />
        <IconButton size="small" onClick={() => onRemove(filter.id)} aria-label="Remove filter">
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>
    );
  }

  // Phase 2: field selected (or chart rank auto-field) — collapsible filter card
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          px: 0.5,
          py: 0.25,
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <IconButton size="small" tabIndex={-1}>
          {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </IconButton>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="body2" noWrap sx={{ fontWeight: 'medium' }}>
            {isChartRank
              ? `Rank${chartYFieldLabel ? ` by ${chartYFieldLabel}` : ''}`
              : fieldLabel}
          </Typography>
          {!expanded && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {summarizeFilter(filter)}
            </Typography>
          )}
        </Box>
        <IconButton
          size="small"
          onClick={(event) => {
            event.stopPropagation();
            onRemove(filter.id);
          }}
          aria-label="Remove filter"
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      <Collapse in={expanded}>
        <FilterBody
          filter={filter}
          fieldType={fieldType}
          operators={operators}
          activeOperator={activeOperator}
          activeOperator2={activeOperator2}
          fieldValues={fieldValues}
          onChange={handleChange}
        />
      </Collapse>
    </Box>
  );
}

interface FilterSectionProps {
  title: string;
  filters: StudioFilterState[];
  fields: SimpleField[];
  fieldOptions: FieldOption[];
  onAddFilter: () => void;
  onRemoveFilter: (id: string) => void;
}

function FilterSection(props: FilterSectionProps) {
  const { fields, fieldOptions, filters, onAddFilter, onRemoveFilter, title } = props;

  return (
    <CollapsibleSection title={title} onAdd={onAddFilter} addDisabled={fields.length === 0}>
      {filters.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 0.5 }}>
          No filters applied.
        </Typography>
      ) : (
        <Stack spacing={1} sx={{ pt: 0.5 }}>
          {filters.map((filter) => (
            <FilterRow
              key={filter.id}
              filter={filter}
              fields={fields}
              fieldOptions={fieldOptions}
              onRemove={onRemoveFilter}
            />
          ))}
        </Stack>
      )}
    </CollapsibleSection>
  );
}

interface WidgetFilterSectionProps {
  title: string;
  filters: StudioFilterState[];
  widgetSourceId?: string;
  fieldOptions: FieldOption[];
  dataSources: Record<string, StudioDataSource>;
  onAddFilter: () => void;
  onRemoveFilter: (id: string) => void;
  chartXField?: string;
  chartYFieldLabel?: string;
}

function WidgetFilterSection(props: WidgetFilterSectionProps) {
  const {
    filters,
    widgetSourceId,
    fieldOptions,
    dataSources,
    onAddFilter,
    onRemoveFilter,
    title,
    chartXField,
    chartYFieldLabel,
  } = props;
  const hasAnySources = Object.keys(dataSources).length > 0;

  return (
    <CollapsibleSection title={title} onAdd={onAddFilter} addDisabled={!hasAnySources}>
      {filters.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 0.5 }}>
          No filters applied.
        </Typography>
      ) : (
        <Stack spacing={1} sx={{ pt: 0.5 }}>
          {filters.map((filter) => (
            <WidgetFilterRow
              key={filter.id}
              filter={filter}
              widgetSourceId={widgetSourceId}
              fieldOptions={fieldOptions}
              onRemove={onRemoveFilter}
              chartXField={chartXField}
              chartYFieldLabel={chartYFieldLabel}
            />
          ))}
        </Stack>
      )}
    </CollapsibleSection>
  );
}

function CrossFilterSection({ filters }: { filters: StudioFilterState[] }) {
  const controller = useStudioController();
  const [expanded, setExpanded] = React.useState(true);

  return (
    <div>
      <Box
        sx={{ display: 'flex', alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <IconButton size="small" tabIndex={-1}>
          {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </IconButton>
        <Typography variant="subtitle2" sx={{ flexGrow: 1 }}>
          Cross-filters
        </Typography>
        {filters.length > 0 && (
          <Tooltip title="Clear all cross-filters">
            <IconButton
              size="small"
              color="inherit"
              onClick={(event) => {
                event.stopPropagation();
                controller.clearAllCrossFilters();
              }}
              aria-label="Clear all cross-filters"
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Box>

      <Collapse in={expanded}>
        <Box sx={{ pl: 0.5 }}>
          {filters.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ px: 1, pb: 1 }}>
              No cross-filters active. Click on chart elements or select grid rows to create
              cross-filters.
            </Typography>
          ) : (
            <Stack spacing={1} sx={{ pb: 0.5 }}>
              {filters.map((filter: StudioFilterState) => (
                <Box
                  key={filter.id}
                  sx={{
                    position: 'relative',
                    p: 1,
                    pr: 4,
                    borderRadius: 1,
                    border: 1,
                    borderColor: 'divider',
                  }}
                >
                  <Typography variant="body2">
                    {filter.field} = {String(filter.value)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    From widget: {filter.sourceWidgetId}
                  </Typography>
                  <Tooltip title="Remove cross-filter">
                    <IconButton
                      size="small"
                      onClick={() => controller.removeFilter(filter.id)}
                      aria-label="Remove cross-filter"
                      sx={{ position: 'absolute', top: 2, right: 2 }}
                    >
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Box>
              ))}
            </Stack>
          )}
        </Box>
      </Collapse>
    </div>
  );
}

export function StudioFiltersDrawer() {
  const controller = useStudioController();
  const filters = useStudioSelector((state) => state.filters);
  const selectedWidgetId = useStudioSelector((state) => state.shell.selectedWidgetId);
  const dataSources = useStudioSelector((state) => state.dataSources);
  const widgets = useStudioSelector((state) => state.widgets);
  const relationships = useStudioSelector((state) => state.relationships);

  const allFields = React.useMemo(() => {
    const fieldMap = new Map<string, SimpleField>();
    for (const source of Object.values(dataSources) as StudioDataSource[]) {
      for (const field of source.fields) {
        if (!fieldMap.has(field.id)) {
          fieldMap.set(field.id, { id: field.id, label: field.label, fieldType: field.type });
        }
      }
    }
    return Array.from(fieldMap.values());
  }, [dataSources]);

  const fieldOptions = React.useMemo(() => buildFieldOptions(dataSources), [dataSources]);

  const selectedWidget = selectedWidgetId ? widgets[selectedWidgetId] : null;

  /** Field options restricted to sources reachable from the selected widget's source. */
  const widgetFieldOptions = React.useMemo(() => {
    if (!selectedWidget?.sourceId) {
      return fieldOptions;
    }
    const reachable = getReachableSourceIds(selectedWidget.sourceId, relationships);
    return fieldOptions.filter((o) => reachable.has(o.sourceId));
  }, [fieldOptions, selectedWidget?.sourceId, relationships]);

  // Chart rank filter context — xField dimension and yField measure label
  const chartXField =
    selectedWidget?.kind === 'chart' ? (selectedWidget.config.xField ?? undefined) : undefined;
  const chartYFieldId = selectedWidget?.kind === 'chart'
    ? (selectedWidget.config.ySeries?.[0]?.fieldId ?? selectedWidget.config.yField ?? undefined)
    : undefined;
  const chartYFieldLabel = React.useMemo(() => {
    if (!chartYFieldId || !selectedWidget?.sourceId) {
      return undefined;
    }
    const source = dataSources[selectedWidget.sourceId];
    return source?.fields.find((f) => f.id === chartYFieldId)?.label ?? chartYFieldId;
  }, [chartYFieldId, selectedWidget?.sourceId, dataSources]);

  const pageFilters = (filters as StudioFilterState[]).filter(
    (f: StudioFilterState) => f.scope === 'page',
  );
  const widgetFilters = (filters as StudioFilterState[]).filter(
    (f: StudioFilterState) => f.scope === 'widget' && f.widgetId === selectedWidgetId,
  );
  const crossFilters = (filters as StudioFilterState[]).filter(
    (f: StudioFilterState) => f.scope === 'cross-filter',
  );

  const handleAddPageFilter = () => {
    if (allFields.length === 0) {
      return;
    }
    controller.addFilter({
      id: generateId(),
      field: '',
      operator: 'equals',
      value: '',
      scope: 'page',
    });
  };

  const handleAddWidgetFilter = () => {
    if (!selectedWidgetId || Object.keys(dataSources).length === 0) {
      return;
    }
    controller.addFilter({
      id: generateId(),
      field: '',
      operator: 'equals',
      value: '',
      scope: 'widget',
      widgetId: selectedWidgetId,
    });
  };

  return (
    <Stack spacing={2}>
      {allFields.length === 0 && (
        <Alert severity="info">Add a data source and widgets first.</Alert>
      )}

      <FilterSection
        title="Page filters"
        filters={pageFilters}
        fields={allFields}
        fieldOptions={fieldOptions}
        onAddFilter={handleAddPageFilter}
        onRemoveFilter={(id) => controller.removeFilter(id)}
      />

      <Divider />

      {selectedWidgetId ? (
        <React.Fragment>
          <Divider />
          <WidgetFilterSection
            title={`Widget: ${selectedWidget?.title ?? selectedWidgetId}`}
            filters={widgetFilters}
            widgetSourceId={selectedWidget?.sourceId}
            fieldOptions={widgetFieldOptions}
            dataSources={dataSources}
            onAddFilter={handleAddWidgetFilter}
            onRemoveFilter={(id) => controller.removeFilter(id)}
            chartXField={chartXField}
            chartYFieldLabel={chartYFieldLabel}
          />
        </React.Fragment>
      ) : null}

      {crossFilters.length > 0 && (
        <React.Fragment>
          <Divider />
          <CrossFilterSection filters={crossFilters} />
        </React.Fragment>
      )}
    </Stack>
  );
}
