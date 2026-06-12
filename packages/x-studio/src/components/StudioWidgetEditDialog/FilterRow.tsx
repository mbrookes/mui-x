'use client';
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

export interface FieldOption {
  id: string;
  label: string;
  type: StudioDataField['type'];
  /** The source that owns this field. Undefined means the widget's own source. */
  sourceId?: string;
  sourceLabel?: string;
}

// ── Operator metadata ─────────────────────────────────────────────────────────

const STRING_OPERATORS: { value: StudioFilterOperator; label: string }[] = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'not equals' },
  { value: 'contains', label: 'contains' },
  { value: 'does_not_contain', label: "doesn't contain" },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'is_not_empty', label: 'is not empty' },
];

const NUMBER_OPERATORS: { value: StudioFilterOperator; label: string }[] = [
  { value: 'equals', label: '=' },
  { value: 'not_equals', label: '≠' },
  { value: 'greater_than', label: '>' },
  { value: 'greater_than_or_equal', label: '≥' },
  { value: 'less_than', label: '<' },
  { value: 'less_than_or_equal', label: '≤' },
  { value: 'between', label: 'between' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'is_not_empty', label: 'is not empty' },
];

const DATE_OPERATORS = NUMBER_OPERATORS;

const BOOLEAN_OPERATORS: { value: StudioFilterOperator; label: string }[] = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'not equals' },
];

function operatorsForField(
  field: FieldOption | undefined,
): { value: StudioFilterOperator; label: string }[] {
  if (!field) {
    return STRING_OPERATORS;
  }
  if (field.type === 'number') {
    return NUMBER_OPERATORS;
  }
  if (field.type === 'date' || field.type === 'datetime') {
    return DATE_OPERATORS;
  }
  if (field.type === 'boolean') {
    return BOOLEAN_OPERATORS;
  }
  return STRING_OPERATORS;
}

const NO_VALUE_OPERATORS = new Set<StudioFilterOperator>(['is_empty', 'is_not_empty']);

// Encode field selection as "sourceId::fieldId" when cross-source to keep Select value unique
const encodeValue = (f: FieldOption) => (f.sourceId ? `${f.sourceId}::${f.id}` : f.id);

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
  const operators = operatorsForField(fieldMeta);
  const noValue = NO_VALUE_OPERATORS.has(filter.operator);

  const currentValue = filter.filterSourceId
    ? `${filter.filterSourceId}::${filter.field}`
    : filter.field;

  // Group field options by source label
  const ownFields = fieldOptions.filter((f) => !f.sourceId);
  const relatedSources = Array.from(
    fieldOptions.reduce((set, f) => {
      if (f.sourceId) {
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
            if (sep !== -1) {
              const srcId = raw.slice(0, sep);
              const fId = raw.slice(sep + 2);
              const meta = fieldOptions.find((f) => f.sourceId === srcId && f.id === fId);
              onUpdate({ field: fId, filterSourceId: srcId, fieldType: meta?.type });
            } else {
              const meta = fieldOptions.find((f) => !f.sourceId && f.id === raw);
              onUpdate({ field: raw, filterSourceId: undefined, fieldType: meta?.type });
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
            const srcFields = fieldOptions.filter((f) => f.sourceId === srcId);
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
          value={filter.operator}
          onChange={(evt) => onUpdate({ operator: evt.target.value as StudioFilterOperator })}
        >
          {operators.map((op) => (
            <MenuItem key={op.value} value={op.value}>
              {op.label}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {/* Value input */}
      {!noValue && (
        <TextField
          size="small"
          placeholder={localeText.filterValueLabel}
          value={filter.value === undefined || filter.value === null ? '' : String(filter.value)}
          onChange={(evt) => onUpdate({ value: evt.target.value })}
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
