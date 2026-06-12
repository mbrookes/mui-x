'use client';
import * as React from 'react';
import { Stack, Tooltip, Typography } from '@mui/material';
import { useStudioLocaleText } from '../../context';
import { formatFieldValue } from '../../internals/numberFormat';

const PREVIEW_ROWS = 5;

export default function FieldPreviewTooltip({
  field,
  rows,
  children,
}: {
  field: {
    id: string;
    label: string;
    type?: 'string' | 'number' | 'boolean' | 'date' | 'datetime';
    format?: 'integer' | 'decimal' | 'percent' | 'currency';
    precision?: number;
    currencyCode?: string;
  };
  rows?: Record<string, unknown>[];
  children: React.ReactElement;
}) {
  const localeText = useStudioLocaleText();
  if (!rows || rows.length === 0) {
    return children;
  }

  const values = rows.slice(0, PREVIEW_ROWS).map((row) => {
    const v = row[field.id];
    if (v === null || v === undefined) {
      return '—';
    }
    return formatFieldValue(v, {
      type: field.type ?? 'string',
      format: field.format,
      precision: field.precision,
      currencyCode: field.currencyCode,
    });
  });

  const title = (
    <Stack spacing={0.25}>
      <Typography variant="caption" sx={{ fontWeight: 700, opacity: 0.8 }}>
        {field.label}
      </Typography>
      {values.map((v, i) => (
        // react-doctor-disable-next-line react-doctor/no-array-index-as-key, react-doctor/no-array-index-key -- display-only list of enum values, ordering is stable
        <Typography
          key={`val-${i}`}
          variant="caption"
          sx={{ fontFamily: 'monospace', opacity: 0.9 }}
        >
          {v}
        </Typography>
      ))}
      {rows.length > PREVIEW_ROWS && (
        <Typography variant="caption" sx={{ opacity: 0.5 }}>
          {localeText.dataDrawerMorePreviewRows(rows.length - PREVIEW_ROWS)}
        </Typography>
      )}
    </Stack>
  );

  return (
    <Tooltip title={title} placement="right" arrow>
      {children}
    </Tooltip>
  );
}
