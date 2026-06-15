'use client';
import * as React from 'react';
import { IconButton, Menu, MenuItem, Tooltip } from '@mui/material';
import AddLinkIcon from '@mui/icons-material/AddLink';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import { useStudioSelector, selectDataSources, useStudioLocaleText } from '../../context';
import { fieldHasCapability } from '../../utils/fieldCapabilities';

interface MetricOption {
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
