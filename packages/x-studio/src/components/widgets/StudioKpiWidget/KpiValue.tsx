'use client';
import * as React from 'react';
import { Typography } from '@mui/material';

export interface KpiValueProps {
  value: string;
  hasData: boolean;
}

export function KpiValue(props: KpiValueProps) {
  const { value, hasData } = props;
  return (
    <Typography
      variant="h3"
      sx={{ fontSize: 32, fontWeight: 700, lineHeight: 1, flexShrink: 0 }}
      color={hasData ? 'text.primary' : 'text.disabled'}
    >
      {value}
    </Typography>
  );
}
