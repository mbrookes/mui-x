'use client';
import * as React from 'react';
import { Box } from '@mui/material';
import { FieldTypeIcon, type FieldType } from '../internals/FieldTypeIcon';

interface FieldOptionProps {
  label: string;
  type?: string;
  generated?: boolean;
}

export function FieldOption({ label, type, generated }: FieldOptionProps) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
      <FieldTypeIcon type={(type as FieldType) ?? 'string'} generated={generated} size={14} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </Box>
  );
}
