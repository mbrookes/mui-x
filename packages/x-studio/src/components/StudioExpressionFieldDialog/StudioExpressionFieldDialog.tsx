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
  type ExpressionValidationError,
} from '../../utils/expressionEvaluator';
import { StudioDrawerErrorBoundary } from '../../internals/StudioDrawerErrorBoundary';
import { lookup } from '../../utils/safeLookup';
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
  /**
   * BL-180: The set of source IDs reachable from the source being configured (itself +
   * related sources via declared relationships) — normally
   * `getReachableSourceIds(sourceId, relationships)`.
   *
   * Expression fields owned by sources outside this set are both hidden from the operand
   * picker AND rejected by validation, because such a reference can never compute: at
   * evaluation time the referenced field runs against THIS source's rows, which don't carry
   * its columns, so every value comes out `null`/`NaN`. Validating on the same set is what
   * catches the case for expressions that never went through the picker (persisted docs,
   * AI-authored fields).
   *
   * Every in-repo caller passes it. When omitted, all expression fields stay selectable and
   * the reachability check does not run — a host with no relationship graph on hand keeps
   * the unscoped behavior.
   */
  reachableSourceIds?: ReadonlySet<string>;
}

/**
 * Renders a validation error in the active locale.
 *
 * `ExpressionValidationError` carries a stable `code` plus its interpolation operands
 * precisely so this boundary can pick a `StudioLocaleText` template instead of printing the
 * evaluator's English `message`. That `message` remains the fallback for a code this build's
 * locale bundle doesn't cover, so the banner always says something.
 */
function localizeValidationError(
  error: ExpressionValidationError,
  localeText: ReturnType<typeof useStudioLocaleText>,
): string {
  switch (error.code) {
    case 'missingId':
      return localeText.exprErrorMissingId;
    case 'missingLabel':
      return localeText.exprErrorMissingLabel;
    case 'missingSourceId':
      return localeText.exprErrorMissingSourceId;
    case 'maxDepth':
      return localeText.exprErrorMaxDepth(error.maxDepth);
    case 'unknownField':
      return localeText.exprErrorUnknownField(error.fieldId);
    case 'unreachableField':
      return localeText.exprErrorUnreachableField(error.fieldId, error.fieldSourceId);
    case 'malformedNode':
      return localeText.exprErrorMalformedNode;
    case 'insufficientArity':
      return localeText.exprErrorInsufficientArity(error.operator, error.required, error.actual);
    case 'circularDependency':
      return localeText.exprErrorCircularDependency(error.fieldId);
    default:
      // Unreachable while every code above is handled (TypeScript narrows this to `never`),
      // but kept so a code added to the evaluator without a matching locale key degrades to
      // the English fallback instead of rendering nothing.
      return (error as ExpressionValidationError).message;
  }
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

// Collision-resistant id generator for newly-created expression fields (finding
// 3.11): a plain `expr-${Date.now()}` collides whenever two fields are created
// within the same millisecond. Pairs the timestamp with a module-level monotonic
// counter, same scheme as `chatIds.ts`/`RelationshipPanel.tsx` elsewhere in x-studio.
let newExpressionFieldIdCounter = 0;
function createNewExpressionFieldId(): string {
  newExpressionFieldIdCounter += 1;
  return `expr-${Date.now()}-${newExpressionFieldIdCounter}`;
}

interface ExpressionFieldFormState {
  label: string;
  description: string;
  isMeasure: boolean;
  expression: StudioExpression;
  precision: string;
}

/** The buffered form state a given `existingField` (or `undefined` = create mode) starts from. */
function buildFormState(
  existingField: StudioExpressionField | undefined,
): ExpressionFieldFormState {
  return {
    label: existingField?.label ?? '',
    description: existingField?.description ?? '',
    isMeasure: existingField?.isMeasure ?? false,
    expression: (existingField?.expression ?? makeDefaultExpression()) as StudioExpression,
    precision: existingField?.precision != null ? String(existingField.precision) : '2',
  };
}

export function StudioExpressionFieldDialog(props: StudioExpressionFieldDialogProps) {
  const {
    open,
    onClose,
    dataSource,
    expressionFields,
    existingField,
    onSaved,
    reachableSourceIds,
  } = props;
  const controller = useStudioController();
  const localeText = useStudioLocaleText();

  const isEdit = !!existingField;

  const [form, setForm] = React.useState<ExpressionFieldFormState>(() =>
    buildFormState(existingField),
  );
  const { label, description, isMeasure, expression, precision } = form;

  // H8: `addExpressionField`/`updateExpressionField` now RETURN a `StudioMutationResult`, so
  // the dialog branches on the controller's own verdict instead of re-reading the committed
  // doc and guessing. `null` = no rejection to show; otherwise the localized reason.
  const [saveError, setSaveError] = React.useState<string | null>(null);

  // Stable across re-renders (finding 3.11): the previous `expr-${Date.now()}` was
  // recomputed on every render for a new (non-edit) field, churning the `draftField`/
  // `validationErrors` memos below (both depend on `fieldId`) on every keystroke until
  // save. Generated once per mount via a lazy ref initializer, not `useMemo` (which
  // isn't guaranteed to preserve identity across renders without deps discipline).
  const newFieldIdRef = React.useRef<string | null>(null);
  if (newFieldIdRef.current === null) {
    newFieldIdRef.current = createNewExpressionFieldId();
  }
  const fieldId = existingField?.id ?? newFieldIdRef.current;

  // H6: resync the buffered form whenever the dialog is (re-)opened or the field being
  // edited changes. MUI's `Dialog` keeps its subtree MOUNTED across `open` toggles, so
  // without this the `React.useState` initializer above only ever runs once per mount and
  // the form keeps showing — and, on save, WRITES — the first field it was opened with:
  // edit "Margin %", cancel, open "Revenue Growth", and `handleSave` would call
  // `updateExpressionField('rev-growth', {…Margin %'s label/description/isMeasure/expression})`.
  // Every in-repo caller happened to paper over this with a `key=` remount, but this is a
  // public export (`index.ts`) documented without any such requirement, so the contract must
  // hold inside the component. Mirrors the sibling `RelationshipDialog`'s resync effect.
  // `newFieldIdRef` is reset alongside so two consecutive creates can't share one id.
  // The last-synced inputs are tracked explicitly rather than left to the dependency array
  // alone, so the effect is a no-op both on mount (the `useState` initializer already
  // produced exactly this state — re-running it would cost every caller an extra render and
  // a needlessly churned `fieldId`) and on StrictMode's double-invoke.
  const syncedRef = React.useRef({ existingField, open });
  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change, react-doctor/no-derived-state-effect -- form is intentionally buffered locally and synced when the dialog re-opens or the edited field changes
  React.useEffect(() => {
    if (syncedRef.current.existingField === existingField && syncedRef.current.open === open) {
      return;
    }
    syncedRef.current = { existingField, open };
    newFieldIdRef.current = createNewExpressionFieldId();
    // react-doctor-disable-next-line react-doctor/no-derived-state -- locally buffered form; sync on external change is intentional
    setForm(buildFormState(existingField));
    // A rejection banner belongs to the save attempt that produced it, not to the next field
    // the dialog is opened on.
    setSaveError(null);
  }, [existingField, open]);

  // BL-180: expression fields offered as operands in the builder, scoped to those
  // reachable from the configuring widget. The unfiltered `expressionFields` is still
  // used for validation (below) so ID-uniqueness and reference checks stay correct.
  const selectableExpressionFields = React.useMemo(() => {
    const withoutSelf = expressionFields.filter((ef) => ef.id !== fieldId);
    if (!reachableSourceIds) {
      return withoutSelf;
    }
    return withoutSelf.filter((ef) => reachableSourceIds.has(ef.sourceId));
  }, [expressionFields, reachableSourceIds, fieldId]);

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
      // The draft is validated on every keystroke, including before a name has been typed.
      // `label` must stay non-empty so the "must have a label" error doesn't drown out the
      // real expression errors — the Save button's own `!label.trim()` guard is what keeps an
      // unnamed field from being saved. The stand-in is localized because it can be
      // interpolated into a user-visible validation message.
      label: label || localeText.exprUnnamedFieldLabel,
      sourceId: dataSource.id,
      isMeasure,
      expression,
      type: inferredType,
      precision: parsedPrecision,
    }),
    [
      fieldId,
      label,
      localeText.exprUnnamedFieldLabel,
      dataSource.id,
      isMeasure,
      expression,
      inferredType,
      parsedPrecision,
    ],
  );

  const validationErrors = React.useMemo(() => {
    const allFields = isEdit
      ? expressionFields.map((ef) => (ef.id === fieldId ? draftField : ef))
      : [...expressionFields, draftField];
    // Validation sees the UNFILTERED field list (so id-uniqueness and cycle detection stay
    // correct) but the same reachability scope as the operand picker, so an operand the
    // picker would never offer can't be saved either.
    return validateExpressionField(draftField, allFields, dataSource.fields, {
      reachableSourceIds,
    });
  }, [draftField, expressionFields, dataSource.fields, isEdit, fieldId, reachableSourceIds]);

  const handleSave = () => {
    if (validationErrors.length > 0) {
      return;
    }
    const patch = {
      label,
      description: description || undefined,
      isMeasure,
      expression,
      type: inferredType,
      precision: parsedPrecision,
    };
    const result = isEdit
      ? controller.updateExpressionField(fieldId, patch)
      : controller.addExpressionField({ id: fieldId, sourceId: dataSource.id, ...patch });
    if (!result.ok) {
      // The controller distinguishes the rejection modes, so the banner can too: a cycle is a
      // problem the user can act on (the doc gained a reference back to this field while the
      // dialog held a stale `expressionFields` list), while `duplicate-id`/`not-found` mean
      // the field moved out from under the dialog.
      setSaveError(
        result.reason === 'cycle'
          ? localeText.exprErrorCircularDependency(fieldId)
          : localeText.saveRejectedMessage,
      );
      return;
    }
    // `result.ok` with `committed: false` is a value-equal no-op — open, glance, Save with no
    // edits. That is success, not a rejection, so the dialog closes normally.
    setSaveError(null);
    if (!isEdit) {
      onSaved?.(fieldId);
    }
    onClose();
  };

  const hasErrors = validationErrors.length > 0;

  /**
   * Localized label for the inferred output type.
   *
   * The chip rendered `inferredType` raw — the `'number'`/`'string'`/`'boolean'` discriminant —
   * next to a fully localized caption, so a French user read "Type de sortie: boolean". The same
   * three keys the literal-type picker in `ExpressionNodeEditor` already uses cover this.
   */
  const inferredTypeLabel =
    lookup(
      {
        number: localeText.exprDataTypeNumber,
        string: localeText.exprDataTypeText,
        boolean: localeText.exprDataTypeBoolean,
      },
      inferredType,
    ) ??
    // `date`/`datetime` have no dedicated key; the raw discriminant is the honest fallback.
    inferredType;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <FunctionsIcon color="primary" />
          <span>{isEdit ? localeText.exprDialogEditTitle : localeText.exprDialogNewTitle}</span>
        </Stack>
      </DialogTitle>

      <DialogContent dividers>
        {/* Tier2 fix: this dialog renders both user- and AI-authored expression trees
            (`ExpressionBuilder`/`ExpressionNodeEditor` and `ExpressionPreview`). Every
            existing render site happens to sit inside some other drawer's
            `StudioDrawerErrorBoundary` (e.g. `DataSourceSection.tsx` under
            `StudioDataDrawer`, or `GridSetupPanel.tsx`/`StudioMapWidget.tsx` under
            `StudioComposeDrawer`), so today's protection is incidental — a future caller
            (e.g. a standalone or AI-chat-triggered flow) would get none. Give the dialog
            its own boundary so the guarantee doesn't depend on the caller. `resetKey` is
            the field id being edited (or 'new' for a fresh field), so switching fields
            clears a latched error instead of leaving the dialog stuck on the fallback. */}
        <StudioDrawerErrorBoundary resetKey={fieldId}>
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
              onChange={(event) =>
                setForm((prev) => ({ ...prev, description: event.target.value }))
              }
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
                    <Typography variant="body2">{localeText.exprMeasureLabel}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {isMeasure
                        ? localeText.exprMeasureHelperText
                        : localeText.exprDimensionHelperText}
                    </Typography>
                  </Stack>
                }
              />
            </div>

            <Divider />

            {/* Inferred output type */}
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Typography variant="caption" color="text.secondary">
                {localeText.exprOutputTypeLabel}
              </Typography>
              <Chip label={inferredTypeLabel} size="small" variant="outlined" />
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
                {localeText.expressionBuilderSectionLabel}
              </Typography>
              <ExpressionBuilder
                expression={expression}
                sourceFields={dataSource.fields}
                expressionFields={selectableExpressionFields}
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

            {/* H8: the controller rejected the write; the dialog stays open and says so. */}
            {saveError !== null && (
              <Alert severity="error" role="alert">
                {saveError}
              </Alert>
            )}

            {/* Validation errors */}
            {hasErrors && (
              <Alert severity="error" role="alert">
                <Stack spacing={0.5}>
                  {validationErrors.map((err, i) => (
                    // react-doctor-disable-next-line react-doctor/no-array-index-as-key, react-doctor/no-array-index-key -- error list is ephemeral display, no reorder
                    <Typography key={`error-${i}`} variant="caption" component="div">
                      {localizeValidationError(err, localeText)}
                    </Typography>
                  ))}
                </Stack>
              </Alert>
            )}
          </Stack>
        </StudioDrawerErrorBoundary>
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
