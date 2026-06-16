'use client';
import * as React from 'react';
import {
  Autocomplete,
  Button,
  Divider,
  IconButton,
  InputAdornment,
  Paper,
  type PaperProps,
  TextField,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import FunctionsIcon from '@mui/icons-material/Functions';
import { FieldOption } from './FieldOption';
import { FieldTypeIcon, type FieldType } from '../../internals/FieldTypeIcon';
import type { StudioDataSource, StudioDataField, StudioExpressionField } from '../../models';
import { fieldHasCapability, type FieldCapability } from '../../utils/fieldCapabilities';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';
import { StudioExpressionFieldDialog } from '../StudioExpressionFieldDialog';

interface CalcFieldPaperProps extends PaperProps {
  buttonLabel: string;
  onOpen: () => void;
}

function CalcFieldPaper({ children, buttonLabel, onOpen, ...rest }: CalcFieldPaperProps) {
  return (
    <Paper {...rest}>
      {children}
      <Divider />
      <Button
        fullWidth
        size="small"
        startIcon={<FunctionsIcon fontSize="small" />}
        onMouseDown={(event) => {
          event.preventDefault();
          onOpen();
        }}
        sx={{
          justifyContent: 'flex-start',
          textTransform: 'none',
          color: 'text.secondary',
          px: 2,
          py: 1,
        }}
      >
        {buttonLabel}
      </Button>
    </Paper>
  );
}

export interface DataSourceFieldEntry {
  id: string;
  label: string;
  type: StudioDataField['type'];
  generated?: boolean;
  sourceId: string;
  sourceLabel: string;
}

/**
 * BL-179/180: context for the in-dropdown "Add calculated field…" affordance.
 * When supplied, the picker renders a persistent footer entry in its options
 * list that opens the shared expression-field dialog; on save the new field is
 * selected via the picker's own `onChange`. Parents pass this object only when
 * calculated fields are enabled for the widget (global `calculatedFields` +
 * per-widget flag), so the shared component stays feature-flag-agnostic.
 */
export interface DataSourceFieldSelectCalculatedFieldContext {
  /** The data source the new expression field computes over (the widget's primary source). */
  dataSource: StudioDataSource;
  /** All existing expression fields, for validation and operand references. */
  expressionFields: StudioExpressionField[];
  /**
   * Source IDs reachable from the configuring widget. Scopes the expression-field
   * operands offered in the dialog (BL-180). Omit to keep all operands selectable.
   */
  reachableSourceIds?: ReadonlySet<string>;
}

interface DataSourceFieldSelectProps {
  /** Selected field ID (empty string = none). */
  value: string;
  /** Source ID of the selected field — used to disambiguate when multiple sources share the same field ID. */
  valueSourceId?: string;
  onChange: (fieldId: string, sourceId: string) => void;
  /**
   * Pre-computed field list. Use when the caller controls filtering, ordering,
   * or cross-source reachability. Ignored when `dataSources` is used instead.
   */
  fields?: DataSourceFieldEntry[];
  /**
   * Auto-compute field list from all visible data sources.
   * Ignored when `fields` is provided.
   */
  dataSources?: Record<string, StudioDataSource>;
  /** Only include fields with this capability (requires `dataSources`). */
  filterCapability?: FieldCapability;
  /**
   * Disable individual options (e.g. cross-source incompatibility checks).
   * @param {DataSourceFieldEntry} option - The field entry to evaluate.
   * @returns {boolean} Whether the option should be disabled.
   */
  getOptionDisabled?: (option: DataSourceFieldEntry) => boolean;
  /** Disable the entire control. */
  disabled?: boolean;
  label?: string;
  helperText?: string;
  size?: 'small' | 'medium';
  fullWidth?: boolean;
  /**
   * BL-179: when provided, renders a persistent "Add calculated field…" entry at
   * the bottom of the options list that opens the shared expression-field dialog.
   * On save, the new field is selected via `onChange`. Omit to hide the affordance.
   */
  calculatedField?: DataSourceFieldSelectCalculatedFieldContext;
}

/**
 * A shared Autocomplete field picker that groups options by data source and
 * shows field-type icons. Replaces the repeated Autocomplete + groupBy +
 * renderOption pattern across widget setup panels.
 */
export function DataSourceFieldSelect({
  value,
  valueSourceId,
  onChange,
  fields: fieldsProp,
  dataSources,
  filterCapability,
  getOptionDisabled,
  disabled,
  label = 'Field',
  helperText,
  size = 'small',
  fullWidth = true,
  calculatedField,
}: DataSourceFieldSelectProps) {
  const localeText = useStudioLocaleText();
  const [calcDialogOpen, setCalcDialogOpen] = React.useState(false);
  const computedFields = React.useMemo<DataSourceFieldEntry[]>(() => {
    if (fieldsProp) {
      return fieldsProp;
    }
    if (!dataSources) {
      return [];
    }
    return Object.values(dataSources).flatMap((src) => {
      if (src.hidden) {
        return [];
      }
      return src.fields.flatMap((f) => {
        if (f.hidden) {
          return [];
        }
        if (filterCapability && !fieldHasCapability(f, filterCapability)) {
          return [];
        }
        return [
          {
            id: f.id,
            label: f.label,
            type: f.type,
            generated: f.generated,
            sourceId: src.id,
            sourceLabel: src.label,
          },
        ];
      });
    });
  }, [fieldsProp, dataSources, filterCapability]);

  const selectedOption = React.useMemo(() => {
    if (!value) {
      return null;
    }
    return (
      (valueSourceId
        ? computedFields.find((f) => f.id === value && f.sourceId === valueSourceId)
        : undefined) ??
      computedFields.find((f) => f.id === value) ??
      null
    );
  }, [computedFields, value, valueSourceId]);

  const hasMultipleSources = React.useMemo(() => {
    const sourceIds = new Set(computedFields.map((f) => f.sourceId));
    return sourceIds.size > 1;
  }, [computedFields]);

  const getOptionLabel = React.useCallback(
    (option: DataSourceFieldEntry) =>
      hasMultipleSources ? `${option.sourceLabel} · ${option.label}` : option.label,
    [hasMultipleSources],
  );

  // BL-179: persistent "Add calculated field…" footer inside the Autocomplete popper.
  // Rendered via a custom Paper (not as an option) so it stays out of groupBy /
  // getOptionLabel / option-equality, and existing option-based tests are unaffected.
  // onMouseDown preventDefault keeps the click from blurring + closing the popper first.
  const handleOpenCalcDialog = React.useCallback(() => setCalcDialogOpen(true), []);
  const CalcFieldPaperWrapper = React.useCallback(
    (paperProps: PaperProps) => (
      <CalcFieldPaper
        {...paperProps}
        buttonLabel={localeText.dataSourceAddCalculatedField}
        onOpen={handleOpenCalcDialog}
      />
    ),
    [localeText.dataSourceAddCalculatedField, handleOpenCalcDialog],
  );
  const calcFieldPaperSlot = calculatedField ? CalcFieldPaperWrapper : undefined;

  const calcDialog = calculatedField ? (
    <StudioExpressionFieldDialog
      key={calcDialogOpen ? 'open' : 'closed'}
      open={calcDialogOpen}
      onClose={() => setCalcDialogOpen(false)}
      dataSource={calculatedField.dataSource}
      expressionFields={calculatedField.expressionFields}
      reachableSourceIds={calculatedField.reachableSourceIds}
      onSaved={(fieldId) => onChange(fieldId, calculatedField.dataSource.id)}
    />
  ) : null;

  return (
    <React.Fragment>
      {selectedOption ? (
        // BL-148: selected field shown as read-only with a clear icon
        <TextField
          size={size}
          fullWidth={fullWidth}
          label={label}
          value={selectedOption.label}
          slotProps={{
            input: {
              readOnly: true,
              startAdornment: (
                <InputAdornment position="start" sx={{ mr: 0.5 }}>
                  <FieldTypeIcon
                    type={(selectedOption.type as FieldType) ?? 'string'}
                    generated={selectedOption.generated}
                    size={14}
                  />
                </InputAdornment>
              ),
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    size="small"
                    edge="end"
                    aria-label={localeText.dataSourceClearFieldAriaLabel}
                    onClick={() => onChange('', '')}
                    disabled={disabled}
                  >
                    <CloseIcon sx={{ fontSize: 14 }} />
                  </IconButton>
                </InputAdornment>
              ),
            },
          }}
          helperText={helperText}
        />
      ) : (
        <Autocomplete
          size={size}
          fullWidth={fullWidth}
          options={computedFields}
          groupBy={(option) => option.sourceLabel}
          getOptionLabel={getOptionLabel}
          renderOption={(liProps, option) => {
            const { key, ...rest } = liProps;
            return (
              <li key={key} {...rest}>
                <FieldOption label={option.label} type={option.type} generated={option.generated} />
              </li>
            );
          }}
          slots={calcFieldPaperSlot ? { paper: calcFieldPaperSlot } : undefined}
          getOptionDisabled={getOptionDisabled}
          disabled={disabled}
          value={selectedOption}
          onChange={(_e, newValue) => {
            onChange(newValue?.id ?? '', newValue?.sourceId ?? '');
          }}
          renderInput={(params) => <TextField {...params} label={label} helperText={helperText} />}
          isOptionEqualToValue={(option, val) =>
            option.id === val.id && option.sourceId === val.sourceId
          }
        />
      )}
      {calcDialog}
    </React.Fragment>
  );
}
