'use client';
import * as React from 'react';
import {
  Autocomplete,
  Box,
  Chip,
  FormControl,
  IconButton,
  InputLabel,
  Menu,
  MenuItem,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import AddLinkIcon from '@mui/icons-material/AddLink';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import { NumberField } from '../../internals/NumberField';
import type { StudioFilterOperator, StudioMetricRef } from '../../models';
import type { RelativeDateUnit, RelativeDateValue } from '../../internals/filterTypes';
import type { FieldType } from './filterDrawerTypes';
import { isRelativeDateValue, absoluteToRelative, relativeToAbsolute } from './filterDrawerUtils';
import { useStudioSelector, selectDataSources, useStudioLocaleText } from '../../context';
import { fieldHasCapability } from '../../utils/fieldCapabilities';

function getRelativeUnits(localeText: ReturnType<typeof useStudioLocaleText>) {
  return [
    { value: 'second', label: localeText.filterRelativeUnitSeconds },
    { value: 'minute', label: localeText.filterRelativeUnitMinutes },
    { value: 'hour', label: localeText.filterRelativeUnitHours },
    { value: 'day', label: localeText.filterRelativeUnitDays },
    { value: 'week', label: localeText.filterRelativeUnitWeeks },
    { value: 'month', label: localeText.filterRelativeUnitMonths },
    { value: 'year', label: localeText.filterRelativeUnitYears },
  ] satisfies { value: RelativeDateUnit; label: string }[];
}

function getDatePresets(localeText: ReturnType<typeof useStudioLocaleText>) {
  return [
    {
      label: localeText.filterDatePreset7Days,
      value: { relative: true, amount: 7, unit: 'day', direction: 'past' },
    },
    {
      label: localeText.filterDatePreset30Days,
      value: { relative: true, amount: 30, unit: 'day', direction: 'past' },
    },
    {
      label: localeText.filterDatePreset3Months,
      value: { relative: true, amount: 3, unit: 'month', direction: 'past' },
    },
    {
      label: localeText.filterDatePreset12Months,
      value: { relative: true, amount: 12, unit: 'month', direction: 'past' },
    },
    {
      label: localeText.filterDatePreset1Year,
      value: { relative: true, amount: 1, unit: 'year', direction: 'past' },
    },
  ] satisfies { label: string; value: RelativeDateValue }[];
}

const OPERATORS_WITH_AUTOCOMPLETE = new Set<StudioFilterOperator>(['equals', 'not_equals']);
const OPERATORS_NO_VALUE = new Set<StudioFilterOperator>(['is_empty', 'is_not_empty']);

export interface MetricOption {
  label: string;
  sourceId: string;
  rowId: string;
  field: string;
  value: number | string;
}

/** Icon button that links the input to a field from any data source, or removes an existing link. */
export function MetricPickerButton({
  onSelect,
  onRemoveLink,
  isLinked,
  fieldType,
}: {
  onSelect: (opt: MetricOption) => void;
  onRemoveLink?: () => void;
  isLinked?: boolean;
  fieldType: 'number' | 'date' | 'datetime';
}) {
  const localeText = useStudioLocaleText();
  const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
  const dataSources = useStudioSelector(selectDataSources);

  const options = React.useMemo(() => {
    const result: MetricOption[] = [];
    const cap = fieldType === 'date' || fieldType === 'datetime' ? 'temporal' : 'numeric';
    for (const source of Object.values(dataSources)) {
      if (!source.rows) {
        continue;
      }
      const suitableFields = source.fields.filter((f) => !f.hidden && fieldHasCapability(f, cap));
      if (suitableFields.length === 0) {
        continue;
      }
      const suitableFieldMap = new Map(suitableFields.map((f) => [f.id, f]));
      const primaryField =
        (cap === 'numeric' ? suitableFieldMap.get('value') : undefined) ?? suitableFields[0];
      for (const row of source.rows) {
        const nameVal = row.name ?? row.label ?? row.metric ?? row.title;
        if (!nameVal) {
          continue;
        }
        const val = row[primaryField.id];
        if (cap === 'temporal' ? typeof val !== 'string' : typeof val !== 'number') {
          continue;
        }
        const rowId = row.id != null ? String(row.id) : undefined;
        if (!rowId) {
          continue;
        }
        result.push({
          label: String(nameVal),
          sourceId: source.id,
          rowId,
          field: primaryField.id,
          value: val as number | string,
        });
      }
    }
    return result;
  }, [dataSources, fieldType]);

  if (isLinked) {
    return (
      <Tooltip title={localeText.filterRemoveFieldLink}>
        <IconButton
          size="small"
          aria-label={localeText.filterRemoveFieldLink}
          onClick={() => onRemoveLink?.()}
          color="primary"
        >
          <LinkOffIcon sx={{ fontSize: 14 }} />
        </IconButton>
      </Tooltip>
    );
  }

  if (options.length === 0) {
    return null;
  }

  return (
    <React.Fragment>
      <Tooltip title={localeText.filterLinkToField}>
        <IconButton
          size="small"
          aria-label={localeText.filterLinkToField}
          onClick={(evt) => setAnchorEl(evt.currentTarget)}
        >
          <AddLinkIcon sx={{ fontSize: 14 }} />
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => setAnchorEl(null)}
        slotProps={{ paper: { sx: { maxHeight: 300 } } }}
      >
        {options.map((opt) => (
          <MenuItem
            key={`${opt.sourceId}-${opt.rowId}`}
            onClick={() => {
              onSelect(opt);
              setAnchorEl(null);
            }}
          >
            {opt.label}
          </MenuItem>
        ))}
      </Menu>
    </React.Fragment>
  );
}
