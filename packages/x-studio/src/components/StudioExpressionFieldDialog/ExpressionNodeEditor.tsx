'use client';
import * as React from 'react';
import {
  Box,
  Chip,
  Collapse,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type {
  StudioDataField,
  StudioExpression,
  StudioExpressionField,
  StudioExpressionOperator,
  StudioFunctionExpression,
  StudioKpiAggregation,
  StudioValueExpression,
  StudioFieldExpression,
} from '../../models';
import { useStudioLocaleText } from '../../context';

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

function makeDefaultFunctionExpr(): StudioFunctionExpression {
  return { operator: 'add', inputs: [makeDefaultExpr(), makeDefaultExpr()] };
}

// Type guards for clear, maintainable expression classification
function isFieldExpr(expr: StudioExpression): expr is StudioFieldExpression {
  return 'id' in expr && !('operator' in expr);
}
function isValueExpr(expr: StudioExpression): expr is StudioValueExpression {
  return 'type' in expr && 'value' in expr;
}
function isFunctionExpr(expr: StudioExpression): expr is StudioFunctionExpression {
  return 'operator' in expr;
}

type InputKind = 'field' | 'literal' | 'function';

function getInputKind(expr: StudioExpression): InputKind {
  if (isFunctionExpr(expr)) {
    return 'function';
  }
  if (isFieldExpr(expr)) {
    return 'field';
  }
  return 'literal';
}

function InputNode({
  expr,
  label,
  sourceFields,
  expressionFields,
  isMeasure,
  onChange,
}: InputNodeProps) {
  const inputKind = getInputKind(expr);
  const localeText = useStudioLocaleText();
  const [functionCollapsed, setFunctionCollapsed] = React.useState(false);

  const allFieldOptions = [
    ...sourceFields.map((f) => ({ id: f.id, label: f.label, isExpr: false })),
    ...expressionFields.flatMap((ef) => {
      if (!ef.isMeasure || isMeasure) {
        return [{ id: ef.id, label: ef.label, isExpr: true }];
      }
      return [];
    }),
  ];

  const handleKindChange = (next: InputKind) => {
    if (next === 'field') {
      const firstField = allFieldOptions[0];
      onChange(firstField ? { id: firstField.id } : makeDefaultExpr());
    } else if (next === 'literal') {
      onChange({ type: 'number', value: 0 });
    } else {
      onChange(makeDefaultFunctionExpr());
    }
  };

  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1, mb: 0.5 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', mb: inputKind === 'function' ? 0.5 : 0 }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
          {label}
        </Typography>
        <Select
          size="small"
          value={inputKind}
          onChange={(event) => handleKindChange(event.target.value as InputKind)}
          sx={{ minWidth: 90, fontSize: '0.75rem' }}
        >
          <MenuItem value="field">{localeText.exprNodeTypeField}</MenuItem>
          <MenuItem value="literal">{localeText.exprNodeTypeLiteral}</MenuItem>
          <MenuItem value="function">{localeText.exprNodeTypeFunction}</MenuItem>
        </Select>
        {inputKind === 'function' && (
          <Tooltip
            title={
              functionCollapsed ? localeText.exprExpandTooltip : localeText.exprCollapseTooltip
            }
          >
            <IconButton
              size="small"
              onClick={() => setFunctionCollapsed((c) => !c)}
              aria-label={
                functionCollapsed ? localeText.exprExpandTooltip : localeText.exprCollapseTooltip
              }
            >
              {functionCollapsed ? (
                <ExpandMoreIcon fontSize="small" />
              ) : (
                <ExpandLessIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
        )}
      </Stack>

      {inputKind === 'field' && isFieldExpr(expr) && (
        <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }}>
          <Select
            size="small"
            value={expr.id}
            onChange={(event) => {
              onChange({ ...expr, id: event.target.value });
            }}
            sx={{ flexGrow: 1, fontSize: '0.75rem' }}
          >
            {allFieldOptions.map((opt) => (
              <MenuItem key={opt.id} value={opt.id}>
                {opt.label}
                {opt.isExpr && (
                  <Chip label="fx" size="small" sx={{ ml: 0.5, height: 16, fontSize: '0.6rem' }} />
                )}
              </MenuItem>
            ))}
          </Select>
          {isMeasure && (
            <Select
              size="small"
              value={expr.aggregation ?? 'sum'}
              onChange={(event) => {
                onChange({
                  ...expr,
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

      {inputKind === 'literal' && isValueExpr(expr) && (
        <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }}>
          <Select
            size="small"
            value={expr.type}
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
            <MenuItem value="number">{localeText.exprDataTypeNumber}</MenuItem>
            <MenuItem value="string">{localeText.exprDataTypeText}</MenuItem>
            <MenuItem value="boolean">{localeText.exprDataTypeBoolean}</MenuItem>
          </Select>
          {expr.type === 'boolean' ? (
            <Select
              size="small"
              value={String(expr.value)}
              onChange={(event) => {
                onChange({ ...expr, value: event.target.value === 'true' });
              }}
              sx={{ flexGrow: 1, fontSize: '0.75rem' }}
            >
              <MenuItem value="true">{localeText.exprBooleanTrue}</MenuItem>
              <MenuItem value="false">{localeText.exprBooleanFalse}</MenuItem>
            </Select>
          ) : (
            <TextField
              size="small"
              type={expr.type === 'number' ? 'number' : 'text'}
              value={String(expr.value ?? '')}
              onChange={(event) => {
                const raw = event.target.value;
                const val = expr.type === 'number' ? Number(raw) : raw;
                onChange({ ...expr, value: val });
              }}
              sx={{ flexGrow: 1, '& input': { fontSize: '0.75rem' } }}
            />
          )}
        </Stack>
      )}

      {inputKind === 'function' && isFunctionExpr(expr) && (
        <Collapse in={!functionCollapsed}>
          <Box
            sx={{
              mt: 1,
              pl: 1,
              borderLeft: '2px solid',
              borderColor: 'primary.light',
            }}
          >
            <ExpressionBuilder
              expression={expr}
              sourceFields={sourceFields}
              expressionFields={expressionFields}
              isMeasure={isMeasure}
              onChange={onChange}
            />
          </Box>
        </Collapse>
      )}
    </Box>
  );
}

// ─── Expression builder ───────────────────────────────────────────────────────

export interface ExpressionBuilderProps {
  expression: StudioExpression;
  sourceFields: StudioDataField[];
  expressionFields: StudioExpressionField[];
  isMeasure: boolean;
  onChange: (next: StudioExpression) => void;
}

export function ExpressionBuilder({
  expression,
  sourceFields,
  expressionFields,
  isMeasure,
  onChange,
}: ExpressionBuilderProps) {
  const localeText = useStudioLocaleText();
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
        <InputLabel>{localeText.filterOperatorLabel}</InputLabel>
        <Select
          label={localeText.filterOperatorLabel}
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
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key, react-doctor/no-array-index-key -- inputs schema list is stable and ordered by position
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
              <Tooltip title={localeText.exprRemoveInputTooltip}>
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

