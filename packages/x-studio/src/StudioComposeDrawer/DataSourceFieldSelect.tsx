'use client';
import * as React from 'react';
import { FormControl, InputLabel, ListSubheader, MenuItem, Select, Box } from '@mui/material';
import type { SelectProps } from '@mui/material/Select';
import { FieldTypeIcon } from '../internals/FieldTypeIcon';
import type { StudioDataSource, StudioDataField } from '../models';
import { fieldHasCapability, type FieldCapability } from '../utils/fieldCapabilities';

interface FieldEntry {
  fieldId: string;
  sourceId: string;
  fieldLabel: string;
  sourceLabel: string;
  type: StudioDataField['type'];
}

interface DataSourceFieldSelectProps {
  /** Currently selected fieldId */
  value: string;
  onChange: (fieldId: string, sourceId: string) => void;
  dataSources: Record<string, StudioDataSource>;
  /** Restrict to fields with this capability */
  filterCapability?: FieldCapability;
  label?: string;
  size?: SelectProps['size'];
  fullWidth?: boolean;
}

/**
 * A Select that lists all fields grouped by data source, with field-type icons.
 * Replaces the separate "Data source" + "Field" dropdown pattern.
 */
export function DataSourceFieldSelect({
  value,
  onChange,
  dataSources,
  filterCapability,
  label = 'Field',
  size = 'small',
  fullWidth = true,
}: DataSourceFieldSelectProps) {
  const entries = React.useMemo<FieldEntry[]>(() => {
    const sources = Object.values(dataSources).filter((s) => !s.hidden);
    return sources.flatMap((src) =>
      src.fields
        .filter((f) => !f.hidden)
        .filter((f) => !filterCapability || fieldHasCapability(f, filterCapability))
        .map((f) => ({
          fieldId: f.id,
          sourceId: src.id,
          fieldLabel: f.label,
          sourceLabel: src.label,
          type: f.type,
        })),
    );
  }, [dataSources, filterCapability]);

  // Group by source
  const grouped = React.useMemo(() => {
    const map = new Map<string, { sourceLabel: string; fields: FieldEntry[] }>();
    for (const entry of entries) {
      if (!map.has(entry.sourceId)) {
        map.set(entry.sourceId, { sourceLabel: entry.sourceLabel, fields: [] });
      }
      map.get(entry.sourceId)!.fields.push(entry);
    }
    return Array.from(map.values());
  }, [entries]);

  const showGroupHeaders = grouped.length > 1;

  const items: React.ReactNode[] = [];
  for (const group of grouped) {
    if (showGroupHeaders) {
      items.push(
        <ListSubheader key={`hdr-${group.sourceLabel}`} disableSticky>
          {group.sourceLabel}
        </ListSubheader>,
      );
    }
    for (const f of group.fields) {
      items.push(
        <MenuItem key={`${f.sourceId}-${f.fieldId}`} value={`${f.sourceId}::${f.fieldId}`}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
            <FieldTypeIcon type={f.type} size={14} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {f.fieldLabel}
            </span>
          </Box>
        </MenuItem>,
      );
    }
  }

  const compositeValue = value
    ? (entries.find((e) => e.fieldId === value)
        ? `${entries.find((e) => e.fieldId === value)!.sourceId}::${value}`
        : value)
    : '';

  const handleChange = (raw: string) => {
    if (!raw) {
      onChange('', '');
      return;
    }
    const sep = raw.indexOf('::');
    if (sep === -1) {
      onChange(raw, '');
    } else {
      onChange(raw.slice(sep + 2), raw.slice(0, sep));
    }
  };

  return (
    <FormControl size={size} fullWidth={fullWidth}>
      <InputLabel>{label}</InputLabel>
      <Select
        value={compositeValue}
        label={label}
        onChange={(e) => handleChange(e.target.value)}
      >
        <MenuItem value="">
          <em>None</em>
        </MenuItem>
        {items}
      </Select>
    </FormControl>
  );
}
