'use client';
import * as React from 'react';
import { Box, Stack, Tooltip, Typography } from '@mui/material';
import { useStudioLocaleText } from '../../context';
import { formatFieldValue } from '../../internals/numberFormat';

import type { StudioDataSource } from '../../models';

// ─── Data source preview tooltip ─────────────────────────────────────────────

const DS_PREVIEW_ROWS = 5;
const DS_PREVIEW_COLS = 4;

export default function DataSourcePreviewTooltip({
  source,
  onOpenPreview,
  children,
}: {
  source: StudioDataSource;
  onOpenPreview?: (sourceId: string) => void;
  children: React.ReactElement;
}) {
  const [tooltipOpen, setTooltipOpen] = React.useState(false);
  const localeText = useStudioLocaleText();

  const handleOpenPreviewClick = React.useCallback(() => {
    setTooltipOpen(false);
    onOpenPreview?.(source.id);
  }, [onOpenPreview, source.id]);

  const rows = source.rows;
  if (!rows || rows.length === 0) {
    return children;
  }

  const visibleFields = source.fields.filter((f) => !f.hidden).slice(0, DS_PREVIEW_COLS);
  const columnDelta = source.fields.filter((f) => !f.hidden).length - DS_PREVIEW_COLS;
  const previewRows = rows.slice(0, DS_PREVIEW_ROWS);

  const title = (
    <Stack spacing={0.5}>
      <Typography variant="caption" sx={{ fontWeight: 700, opacity: 0.8 }}>
        {source.label}
      </Typography>
      <Box
        component="table"
        sx={{ borderCollapse: 'collapse', fontSize: 11, fontFamily: 'monospace', display: 'table' }}
      >
        <thead>
          <tr>
            {visibleFields.map((f) => (
              <Box
                key={f.id}
                component="th"
                sx={{
                  px: 0.75,
                  py: 0.25,
                  opacity: 0.6,
                  textAlign: 'left',
                  fontWeight: 700,
                  whiteSpace: 'nowrap',
                  maxWidth: 80,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  fontSize: 11,
                }}
              >
                {f.label}
              </Box>
            ))}
          </tr>
        </thead>
        <tbody>
          {previewRows.map((row, ri) => (
            // react-doctor-disable-next-line react-doctor/no-array-index-key -- preview table rows have no stable IDs
            <tr key={ri}>
              {visibleFields.map((f) => {
                const v = row[f.id];
                const display =
                  v === null || v === undefined
                    ? '—'
                    : formatFieldValue(v, {
                        type: f.type,
                        format: f.format,
                        precision: f.precision,
                        currencyCode: f.currencyCode,
                      });
                return (
                  <Box
                    key={f.id}
                    component="td"
                    sx={{
                      px: 0.75,
                      py: 0.125,
                      opacity: 0.85,
                      whiteSpace: 'nowrap',
                      maxWidth: 80,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      fontSize: 11,
                    }}
                  >
                    {display}
                  </Box>
                );
              })}
            </tr>
          ))}
        </tbody>
      </Box>
      {(rows.length > DS_PREVIEW_ROWS || columnDelta > 0) && (
        <Typography variant="caption" sx={{ opacity: 0.5 }}>
          {[
            rows.length > DS_PREVIEW_ROWS
              ? localeText.dataDrawerMoreRows(rows.length - DS_PREVIEW_ROWS)
              : null,
            columnDelta > 0 ? localeText.dataDrawerMoreColumns(columnDelta) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Typography>
      )}
      {onOpenPreview && (
        <Box
          component="button"
          type="button"
          onClick={handleOpenPreviewClick}
          sx={{
            alignSelf: 'flex-start',
            border: 0,
            m: 0,
            p: 0,
            background: 'transparent',
            font: 'inherit',
            fontSize: '0.75rem',
            color: 'inherit',
            textDecoration: 'underline',
            cursor: 'pointer',
            opacity: 0.8,
            '&:hover': { opacity: 1 },
            '&:focus-visible': {
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: 2,
            },
          }}
        >
          {localeText.dataDrawerViewSourceLink}
        </Box>
      )}
    </Stack>
  );

  return (
    <Tooltip
      title={title}
      placement="right"
      arrow
      open={tooltipOpen}
      onOpen={() => setTooltipOpen(true)}
      onClose={() => setTooltipOpen(false)}
      slotProps={{ tooltip: { sx: { maxWidth: 340 } } }}
    >
      {children}
    </Tooltip>
  );
}
