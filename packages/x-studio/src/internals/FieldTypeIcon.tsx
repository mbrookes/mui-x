'use client';
import * as React from 'react';
import { Box, Tooltip } from '@mui/material';
import { StringFieldIcon } from '../icons/StringFieldIcon';
import { NumberFieldIcon } from '../icons/NumberFieldIcon';
import { DateFieldIcon } from '../icons/DateFieldIcon';
import { DateTimeFieldIcon } from '../icons/DateTimeFieldIcon';
import { BooleanFieldIcon } from '../icons/BooleanFieldIcon';
import { StringFieldGeneratedIcon } from '../icons/StringFieldGeneratedIcon';
import { NumberFieldGeneratedIcon } from '../icons/NumberFieldGeneratedIcon';
import { DateFieldGeneratedIcon } from '../icons/DateFieldGeneratedIcon';
import { DateTimeFieldGeneratedIcon } from '../icons/DateTimeFieldGeneratedIcon';
import { BooleanFieldGeneratedIcon } from '../icons/BooleanFieldGeneratedIcon';
import type { StudioDataField } from '../models';

export type FieldType = StudioDataField['type'];

const TYPE_ICON: Record<FieldType, React.ComponentType<{ size?: number }>> = {
  string: StringFieldIcon,
  number: NumberFieldIcon,
  date: DateFieldIcon,
  datetime: DateTimeFieldIcon,
  boolean: BooleanFieldIcon,
};

const TYPE_GENERATED_ICON: Record<FieldType, React.ComponentType<{ size?: number }>> = {
  string: StringFieldGeneratedIcon,
  number: NumberFieldGeneratedIcon,
  date: DateFieldGeneratedIcon,
  datetime: DateTimeFieldGeneratedIcon,
  boolean: BooleanFieldGeneratedIcon,
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
  const iconMap = generated ? TYPE_GENERATED_ICON : TYPE_ICON;
  const Icon = iconMap[type] ?? (generated ? StringFieldGeneratedIcon : StringFieldIcon);
  const label = `${TYPE_LABEL[type] ?? type}${generated ? ' (generated)' : ''}`;

  return (
    <Tooltip title={label} placement="top">
      <Box
        component="span"
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          flexShrink: 0,
          color: 'text.disabled',
        }}
      >
        <Icon size={size} />
      </Box>
    </Tooltip>
  );
}
