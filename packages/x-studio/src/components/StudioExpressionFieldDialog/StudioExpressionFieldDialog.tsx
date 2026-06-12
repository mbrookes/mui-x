'use client';
import * as React from 'react';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import FunctionsIcon from '@mui/icons-material/Functions';
import type {
  StudioDataSource,
  StudioExpression,
  StudioExpressionField,
  StudioFunctionExpression,
} from '../../models';
import { useStudioController, useStudioLocaleText } from '../../context';
import {
  validateExpressionField,
  inferExpressionType,
} from '../../utils/expressionEvaluator';
import { ExpressionBuilder } from './ExpressionNodeEditor';
import { ExpressionPreview } from './ExpressionPreview';

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
  /**
   * Called with the new field's ID after a successful create (not called for edits).
   * Useful for auto-selecting the new field in the parent component.
   * @param {string} fieldId The ID of the saved expression field.
   */
  onSaved?: (fieldId: string) => void;
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
  const { open, onClose, dataSource, expressionFields, existingField, onSaved } = props;
  const controller = useStudioController();
  const localeText = useStudioLocaleText();

  const isEdit = !!existingField;

  const [form, setForm] = React.useState({
    label: existingField?.label ?? '',
    description: existingField?.description ?? '',
    isMeasure: existingField?.isMeasure ?? false,
    expression: (existingField?.expression ?? makeDefaultExpression()) as StudioExpression,
    precision: existingField?.precision != null ? String(existingField.precision) : '2',
  });
  const { label, description, isMeasure, expression, precision } = form;

  const fieldId = existingField?.id ?? `expr-${Date.now()}`;

  const inferredType = React.useMemo(
    () => inferExpressionType(expression, dataSource.fields, expressionFields),
    [expression, dataSource.fields, expressionFields],
  );

  const parsedPrecision = React.useMemo(() => {
    if (inferredType !== 'number') {
      return undefined;
    }
    const trimmed = precision.trim();
    if (trimmed === '') {
      return undefined;
    }
    const value = Number(trimmed);
    if (!Number.isFinite(value)) {
      return undefined;
    }
    return Math.min(10, Math.max(0, Math.trunc(value)));
  }, [inferredType, precision]);

  const draftField = React.useMemo<StudioExpressionField>(
    () => ({
      id: fieldId,
      label: label || 'Unnamed',
      sourceId: dataSource.id,
      isMeasure,
      expression,
      type: inferredType,
      precision: parsedPrecision,
    }),
    [fieldId, label, dataSource.id, isMeasure, expression, inferredType, parsedPrecision],
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
        precision: parsedPrecision,
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
        precision: parsedPrecision,
      });
      onSaved?.(fieldId);
    }
    onClose();
  };

  const hasErrors = validationErrors.length > 0;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <FunctionsIcon color="primary" />
          <span>{isEdit ? localeText.exprDialogEditTitle : localeText.exprDialogNewTitle}</span>
        </Stack>
      </DialogTitle>

      <DialogContent dividers>
        <Stack spacing={2}>
          {/* Name */}
          <TextField
            label={localeText.expressionNameLabel}
            size="small"
            fullWidth
            required
            helperText={localeText.expressionNameHelperText}
            value={label}
            onChange={(event) => setForm((prev) => ({ ...prev, label: event.target.value }))}
            placeholder={localeText.expressionNamePlaceholder}
          />

          {/* Description */}
          <TextField
            label={localeText.expressionDescriptionLabel}
            size="small"
            fullWidth
            multiline
            rows={2}
            helperText={localeText.expressionDescriptionHelperText}
            value={description}
            onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
            placeholder={localeText.expressionDescriptionPlaceholder}
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

          {inferredType === 'number' && (
            <TextField
              label={localeText.expressionPrecisionLabel}
              size="small"
              type="number"
              fullWidth
              value={precision}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  precision: event.target.value,
                }))
              }
              helperText={localeText.expressionPrecisionHelperText}
              slotProps={{ htmlInput: { min: 0, max: 10, step: 1 } }}
            />
          )}

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
            precision={parsedPrecision}
          />

          {/* Validation errors */}
          {hasErrors && (
            <Alert severity="error">
              <Stack spacing={0.5}>
                {validationErrors.map((err, i) => (
                  // react-doctor-disable-next-line react-doctor/no-array-index-as-key, react-doctor/no-array-index-key -- error list is ephemeral display, no reorder
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
        <Button onClick={onClose}>{localeText.exprCancel}</Button>
        <Button variant="contained" onClick={handleSave} disabled={hasErrors || !label.trim()}>
          {isEdit ? localeText.exprSave : localeText.exprAddField}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

