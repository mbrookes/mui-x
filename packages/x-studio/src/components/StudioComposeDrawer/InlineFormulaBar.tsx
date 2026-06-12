'use client';
import * as React from 'react';
import {
  Box,
  Button,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
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
import FunctionsIcon from '@mui/icons-material/Functions';
import { useStudioController } from '../../context';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';
import type { StudioExpressionField, StudioExpression } from '../../models';

// ─── Operator options ────────────────────────────────────────────────────────

const OPERATORS = [
  { value: 'add' as const, label: '+' },
  { value: 'subtract' as const, label: '−' },
  { value: 'multiply' as const, label: '×' },
  { value: 'divide' as const, label: '÷' },
];

type ArithmeticOp = (typeof OPERATORS)[number]['value'];

// ─── Types ───────────────────────────────────────────────────────────────────

interface FieldOption {
  id: string;
  label: string;
}

type OperandType = 'field' | 'const';

interface OperandState {
  type: OperandType;
  fieldId: string;
  constant: string;
}

function defaultOperand(fallbackFieldId?: string): OperandState {
  return { type: 'field', fieldId: fallbackFieldId ?? '', constant: '' };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function operandLabel(op: OperandState, fields: FieldOption[]): string {
  if (op.type === 'const') {
    return op.constant || '0';
  }
  return fields.find((f) => f.id === op.fieldId)?.label ?? op.fieldId;
}

function opSymbol(operator: ArithmeticOp): string {
  return OPERATORS.find((o) => o.value === operator)?.label ?? operator;
}

function buildAutoLabel(
  left: OperandState,
  operator: ArithmeticOp,
  right: OperandState,
  fields: FieldOption[],
): string {
  return `${operandLabel(left, fields)} ${opSymbol(operator)} ${operandLabel(right, fields)}`;
}

function buildExpression(
  left: OperandState,
  operator: ArithmeticOp,
  right: OperandState,
): StudioExpression {
  const leftExpr: StudioExpression =
    left.type === 'const'
      ? { type: 'number', value: parseFloat(left.constant) || 0 }
      : { id: left.fieldId };
  const rightExpr: StudioExpression =
    right.type === 'const'
      ? { type: 'number', value: parseFloat(right.constant) || 0 }
      : { id: right.fieldId };
  return { operator, inputs: [leftExpr, rightExpr] };
}

// ─── Operand editor ───────────────────────────────────────────────────────────

function OperandEditor({
  label,
  value,
  onChange,
  fields,
}: {
  label: string;
  value: OperandState;
  onChange: (v: OperandState) => void;
  fields: FieldOption[];
}) {
  return (
    <Stack spacing={0.5}>
      <ToggleButtonGroup
        value={value.type}
        exclusive
        onChange={(_, t: OperandType) => t && onChange({ ...value, type: t })}
        size="small"
        sx={{ alignSelf: 'flex-start' }}
        aria-label={`${label} type`}
      >
        <ToggleButton
          value="field"
          sx={{ px: 1, py: 0.25, fontSize: '0.7rem', textTransform: 'none' }}
        >
          Field
        </ToggleButton>
        <ToggleButton
          value="const"
          sx={{ px: 1, py: 0.25, fontSize: '0.7rem', textTransform: 'none' }}
        >
          Number
        </ToggleButton>
      </ToggleButtonGroup>

      {value.type === 'field' ? (
        <FormControl size="small" fullWidth>
          <InputLabel sx={{ fontSize: '0.8rem' }}>{label}</InputLabel>
          <Select
            label={label}
            value={value.fieldId}
            onChange={(event) => onChange({ ...value, fieldId: event.target.value })}
            sx={{ fontSize: '0.8rem' }}
          >
            {fields.map((f) => (
              <MenuItem key={f.id} value={f.id} sx={{ fontSize: '0.8rem' }}>
                {f.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      ) : (
        <TextField
          size="small"
          label={label}
          type="number"
          value={value.constant}
          onChange={(event) => onChange({ ...value, constant: event.target.value })}
          slotProps={{ htmlInput: { style: { fontSize: '0.8rem' } } }}
          fullWidth
        />
      )}
    </Stack>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export interface InlineFormulaBarProps {
  /** Data source ID for the new expression field. */
  sourceId: string;
  /** Numeric (and expression) fields available as operands. */
  fields: FieldOption[];
  /**
   * Called with the newly created expression field's ID after successful creation.
   * @param {string} fieldId The ID of the newly created expression field.
   */
  onFieldCreated: (fieldId: string) => void;
}

/**
 * Compact inline formula builder that creates a simple two-operand arithmetic
 * expression field without opening the full expression dialog.
 *
 * Shows a collapsed "fx Formula" button; clicking it reveals a mini form with:
 * - Left operand (field picker or numeric constant)
 * - Arithmetic operator (+, −, ×, ÷)
 * - Right operand (field picker or numeric constant)
 * - Auto-generated label (editable)
 *
 * On "Add", creates a `StudioExpressionField` via the controller and calls `onFieldCreated`.
 */
// react-doctor-disable-next-line react-doctor/prefer-useReducer -- each useState is independent; useReducer would add complexity without benefit
export function InlineFormulaBar({ sourceId, fields, onFieldCreated }: InlineFormulaBarProps) {
  const controller = useStudioController();
  const localeText = useStudioLocaleText();
  const [open, setOpen] = React.useState(false);
  const firstFieldId = fields[0]?.id ?? '';
  const [left, setLeft] = React.useState<OperandState>(() => defaultOperand(firstFieldId));
  const [operator, setOperator] = React.useState<ArithmeticOp>('add');
  const [right, setRight] = React.useState<OperandState>(() => defaultOperand(firstFieldId));
  const [labelOverride, setLabelOverride] = React.useState('');

  // Reset form when opening
  const handleOpen = () => {
    setLeft(defaultOperand(firstFieldId));
    setOperator('add');
    setRight(defaultOperand(firstFieldId));
    setLabelOverride('');
    setOpen(true);
  };

  const handleCancel = () => {
    setOpen(false);
  };

  const autoLabel = buildAutoLabel(left, operator, right, fields);
  const effectiveLabel = labelOverride.trim() || autoLabel;

  const isValid =
    (left.type === 'field' ? Boolean(left.fieldId) : left.constant !== '') &&
    (right.type === 'field' ? Boolean(right.fieldId) : right.constant !== '');

  const handleAdd = () => {
    if (!isValid) {
      return;
    }
    const id = `expr_formula_${Date.now()}`;
    const expression = buildExpression(left, operator, right);
    const field: StudioExpressionField = {
      id,
      label: effectiveLabel,
      sourceId,
      isMeasure: false,
      expression,
    };
    controller.addExpressionField(field);
    onFieldCreated(id);
    setOpen(false);
  };

  if (!open) {
    return (
      <Tooltip title={localeText.inlineFormulaBarAddTooltip}>
        <Button
          size="small"
          variant="text"
          startIcon={<FunctionsIcon fontSize="small" />}
          endIcon={<AddIcon fontSize="small" />}
          onClick={handleOpen}
          sx={{
            fontSize: '0.75rem',
            textTransform: 'none',
            alignSelf: 'flex-start',
            color: 'text.secondary',
          }}
        >
          Formula
        </Button>
      </Tooltip>
    );
  }

  return (
    <Box
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        p: 1.5,
        backgroundColor: 'action.hover',
      }}
    >
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
          <FunctionsIcon fontSize="small" color="action" />
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
            Formula
          </Typography>
        </Stack>
        <IconButton
          size="small"
          onClick={handleCancel}
          aria-label={localeText.inlineFormulaBarCloseAriaLabel}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Stack>

      {/* Operand row */}
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', mb: 1 }}>
        <Box sx={{ flex: 1 }}>
          <OperandEditor label="A" value={left} onChange={setLeft} fields={fields} />
        </Box>

        {/* Operator */}
        <Box sx={{ pt: 3.5 }}>
          <FormControl size="small" sx={{ minWidth: 60 }}>
            <Select
              value={operator}
              onChange={(event) => setOperator(event.target.value as ArithmeticOp)}
              sx={{ fontSize: '0.85rem', fontWeight: 700 }}
            >
              {OPERATORS.map((op) => (
                <MenuItem
                  key={op.value}
                  value={op.value}
                  sx={{ fontSize: '0.9rem', fontWeight: 700 }}
                >
                  {op.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>

        <Box sx={{ flex: 1 }}>
          <OperandEditor label="B" value={right} onChange={setRight} fields={fields} />
        </Box>
      </Stack>

      {/* Label row */}
      <TextField
        size="small"
        label={localeText.inlineFormulaBarLabelLabel}
        placeholder={autoLabel}
        value={labelOverride}
        onChange={(event) => setLabelOverride(event.target.value)}
        fullWidth
        helperText="Auto-generated from the formula — edit to customise"
        sx={{ mb: 1 }}
      />

      <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
        <Button size="small" variant="text" onClick={handleCancel} sx={{ textTransform: 'none' }}>
          Cancel
        </Button>
        <Button
          size="small"
          variant="contained"
          onClick={handleAdd}
          disabled={!isValid}
          startIcon={<AddIcon fontSize="small" />}
          sx={{ textTransform: 'none' }}
        >
          Add
        </Button>
      </Stack>
    </Box>
  );
}
