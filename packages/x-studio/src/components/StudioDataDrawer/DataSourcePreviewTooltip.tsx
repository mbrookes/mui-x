'use client';
import * as React from 'react';
import {
  Box,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';

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

  const rows = source.rows;
  if (!rows || rows.length === 0) {
    return children;
  }

  const visibleFields = source.fields.filter((f) => !f.hidden).slice(0, DS_PREVIEW_COLS);
  const columnDelta = source.fields.filter((f) => !f.hidden).length - DS_PREVIEW_COLS;
  const previewRows = rows.slice(0, DS_PREVIEW_ROWS);

  const handleOpenPreviewClick = React.useCallback(() => {
    setTooltipOpen(false);
    onOpenPreview?.(source.id);
  }, [onOpenPreview, source.id]);
  
  const title = (
    <Stack spacing={0.5}>
      <Typography variant="caption" sx={{ fontWeight: 600, opacity: 0.8 }}>
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
                  fontWeight: 600,
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
                const display = v === null || v === undefined ? '—' : String(v);
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
              ? `${rows.length - DS_PREVIEW_ROWS} more ${rows.length - DS_PREVIEW_ROWS === 1 ? 'row' : 'rows'}`
              : null,
            columnDelta > 0
              ? `${columnDelta} more ${columnDelta === 1 ? 'column' : 'columns'}`
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Typography>
      )}
      {onOpenPreview && (
        <Typography
          component="span"
          variant="caption"
          onClick={handleOpenPreviewClick}
          sx={{ opacity: 0.8, cursor: 'pointer', '&:hover': { opacity: 1 } }}
        >
          View source data →
        </Typography>
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
