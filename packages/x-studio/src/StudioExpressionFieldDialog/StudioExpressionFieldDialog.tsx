'use client';
import * as React from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import FunctionsIcon from '@mui/icons-material/Functions';

import type {
  StudioDataField,
  StudioDataSource,
  StudioExpression,
  StudioExpressionField,
  StudioExpressionOperator,
  StudioFunctionExpression,
  StudioKpiAggregation,
  StudioValueExpression,
  StudioFieldExpression,
} from '../models';
import { useStudioController } from '../context';
import {
  validateExpressionField,
  evaluateExpression,
  evaluateMeasure,
  inferExpressionType,
} from '../utils/expressionEvaluator';

// ─── Operator options ────────────────────────────────────────────────────────

const OPERATOR_OPTIONS: Array<{ value: StudioExpressionOperator; label: string; group: string }> = [
  // Arithmetic
  { value: 'add', label: 'Add (+)', group: 'Arithmetic' },
  { value: 'subtract', label: 'Subtract (−)', group: 'Arithmetic' },
  { value: 'multiply', label: 'Multiply (×)', group: 'Arithmetic' },
  { value: 'divide', label: 'Divide (÷)', group: 'Arithmetic' },
  { value: 'modulo', label: 'Modulo (%)', group: 'Arithmetic' },
  { value: 'negate', label: 'Negate (−x)', group: 'Arithmetic' },
  // Comparison
  { value: 'equals', label: 'Equals (=)', group: 'Comparison' },
  { value: 'notEqual', label: 'Not Equal (≠)', group: 'Comparison' },
  { value: 'lessThan', label: 'Less Than (<)', group: 'Comparison' },
  { value: 'greaterThan', label: 'Greater Than (>)', group: 'Comparison' },
  { value: 'lessThanOrEqual', label: 'Less Than or Equal (≤)', group: 'Comparison' },
  { value: 'greaterThanOrEqual', label: 'Greater Than or Equal (≥)', group: 'Comparison' },
  // Logical
  { value: 'and', label: 'And', group: 'Logical' },
  { value: 'or', label: 'Or', group: 'Logical' },
  { value: 'not', label: 'Not', group: 'Logical' },
  { value: 'isTrue', label: 'Is True', group: 'Logical' },
  { value: 'isFalse', label: 'Is False', group: 'Logical' },
  { value: 'isNull', label: 'Is Null', group: 'Logical' },
  { value: 'isNotNull', label: 'Is Not Null', group: 'Logical' },
  // Conditional
  { value: 'if', label: 'If / Then / Else', group: 'Conditional' },
  { value: 'in', label: 'In (value is one of)', group: 'Conditional' },
  // Date
  { value: 'datediff', label: 'Date Difference', group: 'Date' },
];

const MIN_INPUTS: Partial<Record<StudioExpressionOperator, number>> = {
  add: 2,
  subtract: 2,
  multiply: 2,
  divide: 2,
  modulo: 2,
  equals: 2,
  notEqual: 2,
  lessThan: 2,
  greaterThan: 2,
  lessThanOrEqual: 2,
  greaterThanOrEqual: 2,
  and: 2,
  or: 2,
  not: 1,
  negate: 1,
  isTrue: 1,
  isFalse: 1,
  isNull: 1,
  isNotNull: 1,
  if: 3,
  in: 2,
  datediff: 3,
};

const MAX_INPUTS: Partial<Record<StudioExpressionOperator, number>> = {
  not: 1,
  negate: 1,
  isTrue: 1,
  isFalse: 1,
  isNull: 1,
  isNotNull: 1,
  divide: 2,
  modulo: 2,
  equals: 2,
  notEqual: 2,
  lessThan: 2,
  greaterThan: 2,
  lessThanOrEqual: 2,
  greaterThanOrEqual: 2,
  if: 3,
  datediff: 3,
};

const AGGREGATION_OPTIONS: Array<{ value: StudioKpiAggregation; label: string }> = [
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
  { value: 'count', label: 'Count' },
];

// ─── Input node editor ────────────────────────────────────────────────────────

interface InputNodeProps {
  expr: StudioExpression;
  label: string;
  sourceFields: StudioDataField[];
  expressionFields: StudioExpressionField[];
  isMeasure: boolean;
  onChange: (next: StudioExpression) => void;
}

function makeDefaultExpr(): StudioExpression {
  return { type: 'number', value: 0 } satisfies StudioValueExpression;
}

function InputNode({
  expr,
  label,
  sourceFields,
  expressionFields,
  isMeasure,
  onChange,
}: InputNodeProps) {
  const isField = 'id' in expr && !('operator' in expr) && !('type' in expr && 'value' in expr);
  const isValue = 'type' in expr && 'value' in expr;

  const inputKind: 'field' | 'literal' = isField ? 'field' : 'literal';

  const allFieldOptions = [
    ...sourceFields.map((f) => ({ id: f.id, label: f.label, isExpr: false })),
    ...expressionFields.flatMap((ef) => {
      if (!ef.isMeasure || isMeasure) {
        return [{ id: ef.id, label: ef.label, isExpr: true }];
      }
      return [];
    }),
  ];

  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1, mb: 0.5 }}>
      <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block' }}>
        {label}
      </Typography>
      <Stack direction="row" spacing={1}>
        <Select
          size="small"
          value={inputKind}
          onChange={(event) => {
            if (event.target.value === 'field') {
              const firstField = allFieldOptions[0];
              onChange(firstField ? { id: firstField.id } : makeDefaultExpr());
            } else {
              onChange({ type: 'number', value: 0 });
            }
          }}
          sx={{ minWidth: 90, fontSize: '0.75rem' }}
        >
          <MenuItem value="field">Field</MenuItem>
          <MenuItem value="literal">Literal</MenuItem>
        </Select>

        {inputKind === 'field' && isField && (
          <Stack direction="row" spacing={0.5} sx={{ flexGrow: 1 }}>
            <Select
              size="small"
              value={(expr as StudioFieldExpression).id}
              onChange={(event) => {
                onChange({ ...(expr as StudioFieldExpression), id: event.target.value });
              }}
              sx={{ flexGrow: 1, fontSize: '0.75rem' }}
            >
              {allFieldOptions.map((opt) => (
                <MenuItem key={opt.id} value={opt.id}>
                  {opt.label}
                  {opt.isExpr && (
                    <Chip
                      label="fx"
                      size="small"
                      sx={{ ml: 0.5, height: 16, fontSize: '0.6rem' }}
                    />
                  )}
                </MenuItem>
              ))}
            </Select>
            {isMeasure && (
              <Select
                size="small"
                value={(expr as StudioFieldExpression).aggregation ?? 'sum'}
                onChange={(event) => {
                  onChange({
                    ...(expr as StudioFieldExpression),
                    aggregation: event.target.value as StudioKpiAggregation,
                  });
                }}
                sx={{ minWidth: 80, fontSize: '0.75rem' }}
              >
                {AGGREGATION_OPTIONS.map((opt) => (
                  <MenuItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </MenuItem>
                ))}
              </Select>
            )}
          </Stack>
        )}

        {inputKind === 'literal' && isValue && (
          <Stack direction="row" spacing={0.5} sx={{ flexGrow: 1 }}>
            <Select
              size="small"
              value={(expr as StudioValueExpression).type}
              onChange={(event) => {
                const type = event.target.value as StudioValueExpression['type'];
                let defaultValue: string | number | boolean = '';
                if (type === 'number') {
                  defaultValue = 0;
                } else if (type === 'boolean') {
                  defaultValue = false;
                }
                onChange({ type, value: defaultValue });
              }}
              sx={{ minWidth: 80, fontSize: '0.75rem' }}
            >
              <MenuItem value="number">Number</MenuItem>
              <MenuItem value="string">Text</MenuItem>
              <MenuItem value="boolean">Boolean</MenuItem>
            </Select>
            {(expr as StudioValueExpression).type === 'boolean' ? (
              <Select
                size="small"
                value={String((expr as StudioValueExpression).value)}
                onChange={(event) => {
                  onChange({
                    ...(expr as StudioValueExpression),
                    value: event.target.value === 'true',
                  });
                }}
                sx={{ flexGrow: 1, fontSize: '0.75rem' }}
              >
                <MenuItem value="true">True</MenuItem>
                <MenuItem value="false">False</MenuItem>
              </Select>
            ) : (
              <TextField
                size="small"
                type={(expr as StudioValueExpression).type === 'number' ? 'number' : 'text'}
                value={String((expr as StudioValueExpression).value ?? '')}
                onChange={(event) => {
                  const raw = event.target.value;
                  const val = (expr as StudioValueExpression).type === 'number' ? Number(raw) : raw;
                  onChange({ ...(expr as StudioValueExpression), value: val });
                }}
                sx={{ flexGrow: 1, '& input': { fontSize: '0.75rem' } }}
              />
            )}
          </Stack>
        )}
      </Stack>
    </Box>
  );
}

// ─── Expression builder ───────────────────────────────────────────────────────

interface ExpressionBuilderProps {
  expression: StudioExpression;
  sourceFields: StudioDataField[];
  expressionFields: StudioExpressionField[];
  isMeasure: boolean;
  onChange: (next: StudioExpression) => void;
}

function ExpressionBuilder({
  expression,
  sourceFields,
  expressionFields,
  isMeasure,
  onChange,
}: ExpressionBuilderProps) {
  const isFn = 'operator' in expression;
  const fnExpr = isFn ? (expression as StudioFunctionExpression) : null;

  const operator = fnExpr?.operator ?? 'add';
  const inputs: StudioExpression[] = fnExpr?.inputs ?? [];

  const minInputs = MIN_INPUTS[operator] ?? 1;
  const maxInputs = MAX_INPUTS[operator] ?? undefined;
  const canAddInput = maxInputs === undefined || inputs.length < maxInputs;

  const handleOperatorChange = (next: StudioExpressionOperator) => {
    const nextMin = MIN_INPUTS[next] ?? 1;
    const nextMax = MAX_INPUTS[next];
    let nextInputs = [...inputs];
    while (nextInputs.length < nextMin) {
      nextInputs.push(makeDefaultExpr());
    }
    if (nextMax !== undefined && nextInputs.length > nextMax) {
      nextInputs = nextInputs.slice(0, nextMax);
    }
    onChange({ operator: next, inputs: nextInputs });
  };

  const handleInputChange = (index: number, next: StudioExpression) => {
    const nextInputs = inputs.map((inp, i) => (i === index ? next : inp));
    onChange({ operator, inputs: nextInputs });
  };

  const handleAddInput = () => {
    onChange({ operator, inputs: [...inputs, makeDefaultExpr()] });
  };

  const handleRemoveInput = (index: number) => {
    onChange({ operator, inputs: inputs.filter((_, i) => i !== index) });
  };

  return (
    <div>
      <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
        <InputLabel>Operator</InputLabel>
        <Select
          label="Operator"
          value={operator}
          onChange={(event) => handleOperatorChange(event.target.value as StudioExpressionOperator)}
        >
          {OPERATOR_OPTIONS.map((opt) => (
            <MenuItem key={opt.value} value={opt.value}>
              <Stack direction="row" sx={{ justifyContent: 'space-between', width: '100%' }}>
                <span>{opt.label}</span>
                <Typography variant="caption" color="text.secondary">
                  {opt.group}
                </Typography>
              </Stack>
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {inputs.map((inp, i) => {
        let inputLabel: string;
        if (operator === 'datediff' && i === 0) {
          inputLabel = 'Unit (e.g. "day", "month", "year")';
        } else if (operator === 'if') {
          inputLabel = ['Condition', 'Then', 'Else'][i] ?? `Input ${i + 1}`;
        } else {
          inputLabel = `Input ${i + 1}`;
        }

        return (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- inputs schema list is stable and ordered by position
          <Stack key={`input-${i}`} direction="row" spacing={0.5} sx={{ alignItems: 'flex-start' }}>
            <Box sx={{ flexGrow: 1 }}>
              <InputNode
                expr={inp}
                label={inputLabel}
                sourceFields={sourceFields}
                expressionFields={expressionFields}
                isMeasure={isMeasure}
                onChange={(next) => handleInputChange(i, next)}
              />
            </Box>
            {inputs.length > minInputs && (
              <Tooltip title="Remove input">
                <IconButton size="small" onClick={() => handleRemoveInput(i)} sx={{ mt: 2.5 }}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </Stack>
        );
      })}

      {canAddInput && (
        <Button size="small" startIcon={<AddIcon />} onClick={handleAddInput} sx={{ mt: 0.5 }}>
          Add input
        </Button>
      )}
    </div>
  );
}

// ─── Preview ──────────────────────────────────────────────────────────────────

interface ExpressionPreviewProps {
  expression: StudioExpression;
  isMeasure: boolean;
  dataSource: StudioDataSource;
  expressionFields: StudioExpressionField[];
  currentFieldId: string;
}

function ExpressionPreview({
  expression,
  isMeasure,
  dataSource,
  expressionFields,
  currentFieldId,
}: ExpressionPreviewProps) {
  const previewResult = React.useMemo(() => {
    const rows = dataSource.rows ?? [];
    const otherExprFields = expressionFields.filter((ef) => ef.id !== currentFieldId);
    try {
      if (isMeasure) {
        const draftField: StudioExpressionField = {
          id: currentFieldId,
          label: 'Preview',
          sourceId: dataSource.id,
          isMeasure: true,
          expression,
        };
        const value = evaluateMeasure(draftField, rows, otherExprFields);
        return { kind: 'measure' as const, value, count: rows.length };
      }
      const previewRows = rows.slice(0, 5);
      if (previewRows.length === 0) {
        return null;
      }
      const values = previewRows.map((row) =>
        evaluateExpression(expression, { row, expressionFields: otherExprFields, allRows: rows }),
      );
      return { kind: 'column' as const, values, count: previewRows.length };
    } catch {
      return null;
    }
  }, [expression, isMeasure, currentFieldId, dataSource, expressionFields]);

  if (!previewResult) {
    return null;
  }

  if (previewResult.kind === 'measure') {
    return (
      <Box sx={{ mt: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
          Preview (measure over {previewResult.count} rows)
        </Typography>
        <Chip label={String(previewResult.value)} size="small" color="primary" variant="outlined" />
      </Box>
    );
  }

  return (
    <Box sx={{ mt: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
        Preview (first {previewResult.count} rows)
      </Typography>
      <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
        {previewResult.values.map((v, i) => (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- preview values are positional display only
          <Chip
            key={`preview-${i}`}
            label={v == null ? 'null' : String(v)}
            size="small"
            color="default"
            variant="outlined"
          />
        ))}
      </Stack>
    </Box>
  );
}

// ─── Dialog ───────────────────────────────────────────────────────────────────

export interface StudioExpressionFieldDialogProps {
  open: boolean;
  onClose: () => void;
  /** The data source this expression field will compute over. */
  dataSource: StudioDataSource;
  /** All existing expression fields (for validation and cross-field references). */
  expressionFields: StudioExpressionField[];
  /** When provided, the dialog is in edit mode for this field. */
  existingField?: StudioExpressionField;
}

function makeDefaultExpression(): StudioExpression {
  return {
    operator: 'add',
    inputs: [
      { type: 'number', value: 0 },
      { type: 'number', value: 0 },
    ],
  } satisfies StudioFunctionExpression;
}

export function StudioExpressionFieldDialog(props: StudioExpressionFieldDialogProps) {
  const { open, onClose, dataSource, expressionFields, existingField } = props;
  const controller = useStudioController();

  const isEdit = !!existingField;

  const [form, setForm] = React.useState({
    label: existingField?.label ?? '',
    description: existingField?.description ?? '',
    isMeasure: existingField?.isMeasure ?? false,
    expression: (existingField?.expression ?? makeDefaultExpression()) as StudioExpression,
  });
  const { label, description, isMeasure, expression } = form;

  const fieldId = existingField?.id ?? `expr-${Date.now()}`;

  const inferredType = React.useMemo(
    () => inferExpressionType(expression, dataSource.fields, expressionFields),
    [expression, dataSource.fields, expressionFields],
  );

  const draftField = React.useMemo<StudioExpressionField>(
    () => ({
      id: fieldId,
      label: label || 'Unnamed',
      sourceId: dataSource.id,
      isMeasure,
      expression,
      type: inferredType,
    }),
    [fieldId, label, dataSource.id, isMeasure, expression, inferredType],
  );

  const validationErrors = React.useMemo(() => {
    const allFields = isEdit
      ? expressionFields.map((ef) => (ef.id === fieldId ? draftField : ef))
      : [...expressionFields, draftField];
    return validateExpressionField(draftField, allFields, dataSource.fields);
  }, [draftField, expressionFields, dataSource.fields, isEdit, fieldId]);

  const handleSave = () => {
    if (validationErrors.length > 0) {
      return;
    }
    if (isEdit) {
      controller.updateExpressionField(fieldId, {
        label,
        description: description || undefined,
        isMeasure,
        expression,
        type: inferredType,
      });
    } else {
      controller.addExpressionField({
        id: fieldId,
        label,
        description: description || undefined,
        sourceId: dataSource.id,
        isMeasure,
        expression,
        type: inferredType,
      });
    }
    onClose();
  };

  const hasErrors = validationErrors.length > 0;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <FunctionsIcon color="primary" />
          <span>{isEdit ? 'Edit' : 'New'} Calculated Field</span>
        </Stack>
      </DialogTitle>

      <DialogContent dividers>
        <Stack spacing={2}>
          {/* Name */}
          <TextField
            label="Name"
            size="small"
            fullWidth
            required
            helperText="Used as the field label in pickers and grid columns"
            value={label}
            onChange={(event) => setForm((prev) => ({ ...prev, label: event.target.value }))}
            placeholder="e.g. Profit, Revenue per Unit"
          />

          {/* Description */}
          <TextField
            label="Description"
            size="small"
            fullWidth
            multiline
            rows={2}
            helperText="Optional. Shown as a tooltip in field pickers"
            value={description}
            onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
            placeholder="Optional: describe what this field computes"
          />

          {/* Measure toggle */}
          <div>
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={isMeasure}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, isMeasure: event.target.checked }))
                  }
                />
              }
              label={
                <Stack>
                  <Typography variant="body2">Measure (aggregate)</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {isMeasure
                      ? 'Computes a single value over the full dataset (e.g. total revenue).'
                      : 'Computes a value per row (e.g. price × quantity).'}
                  </Typography>
                </Stack>
              }
            />
          </div>

          <Divider />

          {/* Inferred output type */}
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Typography variant="caption" color="text.secondary">
              Output type:
            </Typography>
            <Chip label={inferredType} size="small" variant="outlined" />
          </Stack>

          {/* Expression builder */}
          <div>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Expression
            </Typography>
            <ExpressionBuilder
              expression={expression}
              sourceFields={dataSource.fields}
              expressionFields={expressionFields.filter((ef) => ef.id !== fieldId)}
              isMeasure={isMeasure}
              onChange={(expr) => setForm((prev) => ({ ...prev, expression: expr }))}
            />
          </div>

          {/* Preview */}
          <ExpressionPreview
            expression={expression}
            isMeasure={isMeasure}
            dataSource={dataSource}
            expressionFields={expressionFields}
            currentFieldId={fieldId}
          />

          {/* Validation errors */}
          {hasErrors && (
            <Alert severity="error">
              <Stack spacing={0.5}>
                {validationErrors.map((err, i) => (
                  // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- error list is ephemeral display, no reorder
                  <Typography key={`error-${i}`} variant="caption" component="div">
                    {err.message}
                  </Typography>
                ))}
              </Stack>
            </Alert>
          )}
        </Stack>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handleSave} disabled={hasErrors || !label.trim()}>
          {isEdit ? 'Save' : 'Add Field'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
