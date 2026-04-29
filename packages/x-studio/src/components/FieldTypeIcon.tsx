'use client';
import * as React from 'react';
import { Box, Tooltip } from '@mui/material';
import AbcIcon from '@mui/icons-material/Abc';
import NumbersIcon from '@mui/icons-material/Numbers';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import EventNoteIcon from '@mui/icons-material/EventNote';
import RuleIcon from '@mui/icons-material/Rule';
import type { StudioDataField } from '../models';

export type FieldType = StudioDataField['type'];

const TYPE_ICON: Record<FieldType, React.ElementType> = {
  string: AbcIcon,
  number: NumbersIcon,
  date: CalendarTodayIcon,
  datetime: EventNoteIcon,
  boolean: RuleIcon,
};

const TYPE_COLOR: Record<FieldType, string> = {
  string: 'text.disabled',
  number: 'text.disabled',
  date: 'text.disabled',
  datetime: 'text.disabled',
  boolean: 'text.disabled',
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
  const Icon = TYPE_ICON[type] ?? AbcIcon;
  const color = TYPE_COLOR[type] ?? 'text.secondary';
  const label = `${TYPE_LABEL[type] ?? type}${generated ? ' (generated)' : ''}`;

  return (
    <Tooltip title={label} placement="top">
      <Box
        component="span"
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          flexShrink: 0,
          width: size + (generated ? 6 : 0),
          height: size,
          color,
        }}
      >
        <Icon sx={{ fontSize: size }} />
        {generated && (
          <Box
            component="span"
            sx={{
              position: 'absolute',
              bottom: -1,
              right: 0,
              fontSize: size * 0.55,
              fontWeight: 700,
              lineHeight: 1,
              color,
              fontFamily: 'monospace',
            }}
          >
            =
          </Box>
        )}
      </Box>
    </Tooltip>
  );
}
