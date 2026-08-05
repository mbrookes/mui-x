'use client';
import * as React from 'react';
import {
  Box,
  Button,
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
import { lookup } from '../../utils/safeLookup';

// ─── Operator options ────────────────────────────────────────────────────────

function getOperatorOptions(
  localeText: ReturnType<typeof useStudioLocaleText>,
): Array<{ value: StudioExpressionOperator; label: string; group: string }> {
  return [
    // Arithmetic
    { value: 'add', label: localeText.exprOpAdd, group: localeText.exprGroupArithmetic },
    {
      value: 'subtract',
      label: localeText.exprOpSubtract,
      group: localeText.exprGroupArithmetic,
    },
    {
      value: 'multiply',
      label: localeText.exprOpMultiply,
      group: localeText.exprGroupArithmetic,
    },
    { value: 'divide', label: localeText.exprOpDivide, group: localeText.exprGroupArithmetic },
    { value: 'modulo', label: localeText.exprOpModulo, group: localeText.exprGroupArithmetic },
    { value: 'negate', label: localeText.exprOpNegate, group: localeText.exprGroupArithmetic },
    // Comparison
    { value: 'equals', label: localeText.exprOpEquals, group: localeText.exprGroupComparison },
    {
      value: 'notEqual',
      label: localeText.exprOpNotEqual,
      group: localeText.exprGroupComparison,
    },
    {
      value: 'lessThan',
      label: localeText.exprOpLessThan,
      group: localeText.exprGroupComparison,
    },
    {
      value: 'greaterThan',
      label: localeText.exprOpGreaterThan,
      group: localeText.exprGroupComparison,
    },
    {
      value: 'lessThanOrEqual',
      label: localeText.exprOpLessThanOrEqual,
      group: localeText.exprGroupComparison,
    },
    {
      value: 'greaterThanOrEqual',
      label: localeText.exprOpGreaterThanOrEqual,
      group: localeText.exprGroupComparison,
    },
    // Logical
    { value: 'and', label: localeText.exprOpAnd, group: localeText.exprGroupLogical },
    { value: 'or', label: localeText.exprOpOr, group: localeText.exprGroupLogical },
    { value: 'not', label: localeText.exprOpNot, group: localeText.exprGroupLogical },
    { value: 'isTrue', label: localeText.exprOpIsTrue, group: localeText.exprGroupLogical },
    { value: 'isFalse', label: localeText.exprOpIsFalse, group: localeText.exprGroupLogical },
    { value: 'isNull', label: localeText.exprOpIsNull, group: localeText.exprGroupLogical },
    {
      value: 'isNotNull',
      label: localeText.exprOpIsNotNull,
      group: localeText.exprGroupLogical,
    },
    // Conditional
    { value: 'if', label: localeText.exprOpIf, group: localeText.exprGroupConditional },
    { value: 'in', label: localeText.exprOpIn, group: localeText.exprGroupConditional },
    // Date
    { value: 'datediff', label: localeText.exprOpDatediff, group: localeText.exprGroupDate },
  ];
}

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

function getAggregationOptions(
  localeText: ReturnType<typeof useStudioLocaleText>,
): Array<{ value: StudioKpiAggregation; label: string }> {
  return [
    { value: 'sum', label: localeText.aggFnSum },
    { value: 'avg', label: localeText.aggFnAverage },
    { value: 'min', label: localeText.aggFnMin },
    { value: 'max', label: localeText.aggFnMax },
    { value: 'count', label: localeText.aggFnCount },
    { value: 'count_non_null', label: localeText.aggFnCountValues },
  ];
}

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

// Type guards for clear, maintainable expression classification.
//
// They are declared over `StudioExpression` but are reached with values only *typed* as one:
// a persisted/AI-authored `expression` is never structurally screened at the load boundary,
// so it can be a string, a number, `null`, or a function node whose `inputs` isn't an array.
// `isRecord` first (applying `in` to a primitive throws a raw `TypeError`), and — matching
// `expressionEvaluator`'s `isFunctionExpression` — a function node must carry an `inputs`
// ARRAY, since every consumer below immediately iterates it.
function isRecord(expr: StudioExpression): expr is Record<string, unknown> & StudioExpression {
  return typeof expr === 'object' && expr !== null && !Array.isArray(expr);
}
function isFieldExpr(expr: StudioExpression): expr is StudioFieldExpression {
  return isRecord(expr) && 'id' in expr && !('operator' in expr);
}
function isValueExpr(expr: StudioExpression): expr is StudioValueExpression {
  return isRecord(expr) && 'type' in expr && 'value' in expr;
}
function isFunctionExpr(expr: StudioExpression): expr is StudioFunctionExpression {
  return isRecord(expr) && 'operator' in expr && Array.isArray(expr.inputs);
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

/**
 * Numeric-literal input for a value expression: a `type="number"` input reports `badInput` (and an
 * empty `event.target.value`) while the user is still typing a bare "-" or a trailing "." — reading
 * that per-keystroke used to coerce the in-progress text straight to a committed `0`. Buffer the
 * displayed text locally and only parse/commit on blur, mirroring `FormatPanel.tsx`'s grid-height
 * input.
 */
function LiteralNumberInput(props: {
  value: number;
  onChange: (next: number) => void;
  ariaLabel: string;
}) {
  const { value, onChange, ariaLabel } = props;
  const [text, setText] = React.useState(String(value));
  const [dirty, setDirty] = React.useState(false);

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- buffered text mirrors the committed literal value; resync on external change (undo/redo, switching input kind back to number)
  React.useEffect(() => {
    setText(String(value));
    setDirty(false);
  }, [value]);

  const commit = () => {
    if (!dirty) {
      return;
    }
    const raw = text.trim();
    // An emptied field reverts to the last committed value rather than silently
    // coercing to 0 (`Number('')` is `0`, not `NaN`).
    const parsed = raw === '' ? NaN : Number(raw);
    const next = Number.isNaN(parsed) ? value : parsed;
    if (next !== value) {
      onChange(next);
    }
    setText(String(next));
    setDirty(false);
  };

  return (
    <TextField
      size="small"
      type="number"
      value={text}
      // The literal-TYPE select sitting immediately to the left is labelled
      // (`exprLiteralTypeAriaLabel`); without this the value box next to it is announced as a
      // bare edit box. Both halves of the pair carry an accessible name.
      slotProps={{ htmlInput: { 'aria-label': ariaLabel } }}
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
      sx={{ flexGrow: 1, '& input': { fontSize: '0.75rem' } }}
    />
  );
}

/** The value editor for a literal expression, branched on its declared `type`. */
function LiteralValueEditor(props: {
  expr: StudioValueExpression;
  onChange: (next: StudioExpression) => void;
  localeText: ReturnType<typeof useStudioLocaleText>;
}) {
  const { expr, onChange, localeText } = props;
  if (expr.type === 'boolean') {
    return (
      <Select
        size="small"
        value={String(expr.value)}
        onChange={(event) => {
          onChange({ ...expr, value: event.target.value === 'true' });
        }}
        aria-label={localeText.exprBooleanValueAriaLabel}
        sx={{ flexGrow: 1, fontSize: '0.75rem' }}
      >
        <MenuItem value="true">{localeText.exprBooleanTrue}</MenuItem>
        <MenuItem value="false">{localeText.exprBooleanFalse}</MenuItem>
      </Select>
    );
  }
  if (expr.type === 'number') {
    return (
      <LiteralNumberInput
        value={typeof expr.value === 'number' ? expr.value : 0}
        onChange={(next) => onChange({ ...expr, value: next })}
        ariaLabel={localeText.exprLiteralValueAriaLabel}
      />
    );
  }
  return (
    <TextField
      size="small"
      type="text"
      value={String(expr.value ?? '')}
      // Same pairing as the number branch: the literal-type select to the left is labelled,
      // so this value box carries an accessible name too.
      slotProps={{ htmlInput: { 'aria-label': localeText.exprLiteralValueAriaLabel } }}
      onChange={(event) => {
        onChange({ ...expr, value: event.target.value });
      }}
      sx={{ flexGrow: 1, '& input': { fontSize: '0.75rem' } }}
    />
  );
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

  // A source with no fields (and no selectable expression fields) has nothing to reference, so
  // "Field" is disabled rather than silently emitting a literal — which made the Select snap
  // straight back to "Literal" with no explanation.
  const hasFieldOptions = allFieldOptions.length > 0;

  const handleKindChange = (next: InputKind) => {
    if (next === 'field') {
      const firstField = allFieldOptions[0];
      if (!firstField) {
        return;
      }
      onChange({ id: firstField.id });
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
          aria-label={localeText.exprNodeKindAriaLabel}
          sx={{ minWidth: 90, fontSize: '0.75rem' }}
        >
          <MenuItem value="field" disabled={!hasFieldOptions}>
            {localeText.exprNodeTypeField}
          </MenuItem>
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
            aria-label={localeText.exprFieldAriaLabel}
            sx={{ flexGrow: 1, fontSize: '0.75rem' }}
          >
            {/* An expression can reference a field that has since been dropped from the data
                source (or an expression field that no longer resolves). Without a matching
                `MenuItem` the `Select` value is out of range: MUI logs a warning and the
                control renders blank, so the operand silently looks unset even though the
                stale id is still stored. Surface the raw id as its own option instead. */}
            {!allFieldOptions.some((opt) => opt.id === expr.id) && (
              <MenuItem value={expr.id}>{expr.id}</MenuItem>
            )}
            {allFieldOptions.map((opt) => (
              <MenuItem key={opt.id} value={opt.id}>
                {opt.label}
                {opt.isExpr && (
                  // The "fx" glyph is the only thing distinguishing a calculated field from a
                  // physical one in this list, and as bare decorative text it carried no
                  // accessible name — a screen-reader user heard "Margin fx" at best, "Margin" at
                  // worst. `aria-label` names it with the same localized string the drawer uses
                  // for a calculated field.
                  <Chip
                    label="fx"
                    aria-label={localeText.exprCalculatedFieldBadgeLabel}
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
              value={expr.aggregation ?? 'sum'}
              onChange={(event) => {
                onChange({
                  ...expr,
                  aggregation: event.target.value as StudioKpiAggregation,
                });
              }}
              aria-label={localeText.exprAggregationAriaLabel}
              sx={{ minWidth: 80, fontSize: '0.75rem' }}
            >
              {/* `StudioKpiAggregation` is wider than the offered options (e.g.
                  `count_distinct`), and `expr.aggregation` is doc-authored — same
                  out-of-range-value blanking as the field `Select` above. */}
              {!getAggregationOptions(localeText).some(
                (opt) => opt.value === (expr.aggregation ?? 'sum'),
              ) && <MenuItem value={expr.aggregation}>{expr.aggregation}</MenuItem>}
              {getAggregationOptions(localeText).map((opt) => (
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
            aria-label={localeText.exprLiteralTypeAriaLabel}
            sx={{ minWidth: 80, fontSize: '0.75rem' }}
          >
            {/* Same out-of-range-value guard as the field/operator pickers: a persisted
                literal can declare a type outside the three offered here. */}
            {!['number', 'string', 'boolean'].includes(expr.type) && (
              <MenuItem value={expr.type}>{expr.type}</MenuItem>
            )}
            <MenuItem value="number">{localeText.exprDataTypeNumber}</MenuItem>
            <MenuItem value="string">{localeText.exprDataTypeText}</MenuItem>
            <MenuItem value="boolean">{localeText.exprDataTypeBoolean}</MenuItem>
          </Select>
          <LiteralValueEditor expr={expr} onChange={onChange} localeText={localeText} />
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

interface ExpressionBuilderProps {
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
  const fnExpr = isFunctionExpr(expression) ? expression : null;

  const operator = fnExpr?.operator ?? 'add';
  const inputs: StudioExpression[] = fnExpr?.inputs ?? [];

  // `operator` comes straight off a persisted/AI-authored expression node with no closed-enum
  // validation, so both arity tables are indexed through the prototype-chain-safe `lookup`. A
  // bare bracket lookup on "constructor"/"toString"/… resolves an inherited `Object.prototype`
  // function: `??` never fires, `minInputs` becomes a function so `inputs.length > minInputs`
  // is false for every operand (no remove buttons), and `maxInputs` becomes a function so
  // `inputs.length < maxInputs` is false too (no add button) — the operand list is completely
  // uneditable.
  const minInputs = lookup(MIN_INPUTS, operator) ?? 1;
  const maxInputs = lookup(MAX_INPUTS, operator);
  const canAddInput = maxInputs === undefined || inputs.length < maxInputs;

  // Stable per-operand React keys. Array indices pin each `InputNode`'s local state (its
  // function-collapse toggle) to a POSITION, so removing operand 1 of 3 leaves operand 2
  // rendering under operand 1's old key and inheriting its collapsed state. The keys can't be
  // derived from the operand objects either — every edit replaces the edited node with a fresh
  // object, so an identity-derived key would remount that node (dropping input focus) on every
  // keystroke. Instead this component, which owns every mutation, tracks one generated key per
  // operand slot: `handleRemoveInput` splices the matching key out, and the length reconcile
  // below covers every other length change (operator switch, add, undo/redo, or a parent
  // swapping the whole expression), which only ever appends or truncates at the end.
  const [keyState, setKeyState] = React.useState<{ keys: string[]; seq: number }>(() => ({
    keys: inputs.map((_, i) => `operand-${i + 1}`),
    seq: inputs.length,
  }));

  // A root expression that isn't a function node (a bare field reference or literal — both are
  // valid `StudioExpression`s and both are reachable from a persisted or AI-authored field) is
  // rendered by `InputNode`, which handles all three kinds. Rendering the operator picker for
  // it instead would show a fabricated "Add (+)" with zero operands — the real definition
  // nowhere on screen — and one click on "Add input" would overwrite it with that fabrication.
  if (!fnExpr) {
    return (
      <InputNode
        expr={expression}
        label={localeText.exprRootNodeLabel}
        sourceFields={sourceFields}
        expressionFields={expressionFields}
        isMeasure={isMeasure}
        onChange={onChange}
      />
    );
  }

  let inputKeys = keyState.keys;
  if (inputKeys.length !== inputs.length) {
    // Reconcile during render (rather than in an effect) so this pass already renders with
    // correctly-sized keys instead of one `key={undefined}` child.
    const keys = inputKeys.slice(0, inputs.length);
    let { seq } = keyState;
    while (keys.length < inputs.length) {
      seq += 1;
      keys.push(`operand-${seq}`);
    }
    inputKeys = keys;
    setKeyState({ keys, seq });
  }

  const handleOperatorChange = (next: StudioExpressionOperator) => {
    const nextMin = lookup(MIN_INPUTS, next) ?? 1;
    const nextMax = lookup(MAX_INPUTS, next);
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
    // Drop the removed operand's key alongside the operand itself, so every surviving
    // `InputNode` keeps the key (and therefore the local collapse state) it already had.
    setKeyState((prev) => ({ ...prev, keys: prev.keys.filter((_, i) => i !== index) }));
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
          {/* A persisted/AI-authored expression can carry an operator this build doesn't
              offer. Without a matching `MenuItem` the `Select` value is out of range — MUI
              logs a warning and the control renders blank, so the node looks operator-less
              while still evaluating under the stored operator. Show the raw operator. */}
          {!getOperatorOptions(localeText).some((opt) => opt.value === operator) && (
            <MenuItem value={operator}>{operator}</MenuItem>
          )}
          {getOperatorOptions(localeText).map((opt) => (
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
          inputLabel = localeText.exprInputLabelUnit;
        } else if (operator === 'if') {
          inputLabel =
            [
              localeText.exprInputLabelCondition,
              localeText.exprInputLabelThen,
              localeText.exprInputLabelElse,
            ][i] ?? localeText.exprInputLabelGeneric(i + 1);
        } else {
          inputLabel = localeText.exprInputLabelGeneric(i + 1);
        }

        return (
          <Stack key={inputKeys[i]} direction="row" spacing={0.5} sx={{ alignItems: 'flex-start' }}>
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
          {localeText.exprAddInputButton}
        </Button>
      )}
    </div>
  );
}
