'use client';
import * as React from 'react';
import { Box, Tooltip } from '@mui/material';
import {
  StringFieldIcon,
  NumberFieldIcon,
  DateFieldIcon,
  DateTimeFieldIcon,
  BooleanFieldIcon,
} from './icons/FieldTypeIcons';
import type { StudioDataField } from '../models';

export type FieldType = StudioDataField['type'];

const TYPE_ICON: Record<FieldType, React.ComponentType<{ size?: number }>> = {
  string: StringFieldIcon,
  number: NumberFieldIcon,
  date: DateFieldIcon,
  datetime: DateTimeFieldIcon,
  boolean: BooleanFieldIcon,
};

const TYPE_LABEL: Record<FieldType, string> = {
  string: 'Text',
  number: 'Number',
  date: 'Date',
  datetime: 'Date & Time',
  boolean: 'Boolean',
};

interface FieldTypeIconProps {
  type: FieldType;
  generated?: boolean;
  size?: number;
}

export function FieldTypeIcon({ type, generated = false, size = 16 }: FieldTypeIconProps) {
  const Icon = TYPE_ICON[type] ?? StringFieldIcon;
  const label = `${TYPE_LABEL[type] ?? type}${generated ? ' (generated)' : ''}`;

  return (
    <Tooltip title={label} placement="top">
      <Box
        component="span"
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '1px',
          flexShrink: 0,
          color: 'text.disabled',
        }}
      >
        {generated && (
          <Box
            component="span"
            sx={{
              fontSize: size * 0.7,
              fontWeight: 700,
              lineHeight: 1,
              fontFamily: 'monospace',
            }}
          >
            =
          </Box>
        )}
        <Icon size={size} />
      </Box>
    </Tooltip>
  );
}
