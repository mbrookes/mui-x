'use client';
import * as React from 'react';
import { Autocomplete, TextField } from '@mui/material';
import { FieldOption } from './FieldOption';
import type { StudioDataSource, StudioDataField } from '../models';
import { fieldHasCapability, type FieldCapability } from '../utils/fieldCapabilities';

export interface DataSourceFieldEntry {
  id: string;
  label: string;
  type: StudioDataField['type'];
  generated?: boolean;
  sourceId: string;
  sourceLabel: string;
}

export interface DataSourceFieldSelectProps {
  /** Selected field ID (empty string = none). */
  value: string;
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
}

/**
 * A shared Autocomplete field picker that groups options by data source and
 * shows field-type icons. Replaces the repeated Autocomplete + groupBy +
 * renderOption pattern across widget setup panels.
 */
export function DataSourceFieldSelect({
  value,
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
}: DataSourceFieldSelectProps) {
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

  const selectedOption = computedFields.find((f) => f.id === value) ?? null;

  const hasMultipleSources = React.useMemo(() => {
    const sourceIds = new Set(computedFields.map((f) => f.sourceId));
    return sourceIds.size > 1;
  }, [computedFields]);

  const getOptionLabel = React.useCallback(
    (option: DataSourceFieldEntry) =>
      hasMultipleSources ? `${option.sourceLabel} · ${option.label}` : option.label,
    [hasMultipleSources],
  );

  return (
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
  );
}
