'use client';
import * as React from 'react';
import { Box, Stack, Tooltip, Typography } from '@mui/material';
import type { PopperProps } from '@mui/material/Popper';
import { useStudioLocaleText } from '../../context';
import { formatFieldValue } from '../../internals/numberFormat';

import type { StudioDataSource } from '../../models';

// ─── Data source preview tooltip ─────────────────────────────────────────────

const DS_PREVIEW_ROWS = 5;
const DS_PREVIEW_COLS = 4;

/** `document.activeElement`, guarded for SSR/jsdom teardown. */
function getActiveElement(): Element | null {
  return typeof document === 'undefined' ? null : document.activeElement;
}

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
  // The tooltip's popper element — used to tell "focus is inside the tooltip" (keep it open)
  // apart from "focus is merely on the trigger" (a mouseleave may close it).
  const popperRef = React.useRef<HTMLElement>(null);

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

  // M11: the "View source" button lives INSIDE the tooltip, and with a single data source the
  // preview dialog has no other entry point ("View lineage" in `StudioDataDrawer` is gated on
  // `sourceList.length >= 2`), so the whole feature used to be mouse-only: the tooltip was
  // portaled to the end of `<body>` (so Tab from the trigger never reached the button) and
  // MUI's own focus-out handler closed it the moment focus moved anyway.
  //
  // Three changes make it keyboard-reachable without altering the hover behaviour:
  //   1. `disablePortal` renders the popper as a sibling of the trigger, so it sits next in
  //      DOM order and Tab from the trigger lands on the "View source" button.
  //   2. The wrapper opens on focus-in. MUI's own focus handling is gated on
  //      `:focus-visible`, which is exactly right for a purely informational tooltip but
  //      leaves an interactive one unreachable.
  //   3. The wrapper's focus-out (React `onBlur` = the bubbling `focusout`) owns closing on
  //      focus loss, so the tooltip survives focus moving from the trigger into it. MUI's own
  //      blur-driven `onClose` is therefore ignored; every other close reason (mouseleave,
  //      Escape) still closes — except a `mouseleave` while focus is inside the POPPER, which
  //      would yank the focused button out from under a keyboard user. The narrower
  //      popper-only test (rather than the whole wrapper) matters: after a plain mouse click
  //      the trigger keeps focus, and a wrapper-wide test would leave the tooltip stuck open
  //      once the pointer moved away.
  return (
    <Box
      onFocus={() => setTooltipOpen(true)}
      onBlur={(event: React.FocusEvent<HTMLDivElement>) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }
        setTooltipOpen(false);
      }}
    >
      <Tooltip
        title={title}
        placement="right"
        arrow
        // The tooltip DESCRIBES the trigger, it does not name it. Without this, MUI wires the
        // popper to the trigger with `aria-labelledby` (its default for a non-string `title`),
        // which replaces the trigger's own accessible name — "Orders" — with the flattened
        // text of the entire preview table, ending in "View source data →". A screen-reader
        // user then hears the whole five-row table read out as the button's name, and the
        // source name itself is buried in the middle of it. `describeChild` switches the
        // wiring to `aria-describedby`, so the trigger keeps its name and the preview is
        // announced as supplementary detail.
        describeChild
        open={tooltipOpen}
        onOpen={() => setTooltipOpen(true)}
        onClose={(event) => {
          if (event.type === 'blur' || event.type === 'focusout') {
            return;
          }
          if (event.type === 'mouseleave' && popperRef.current?.contains(getActiveElement())) {
            return;
          }
          setTooltipOpen(false);
        }}
        slotProps={{
          // MUI types the popper slot's `ref` against the `Popper` component instance,
          // but at runtime the ref receives the rendered DOM node — which is what the
          // `contains()` focus check above needs. Cast to the declared slot type rather
          // than to what we actually get, since only the declaration is wrong.
          popper: {
            disablePortal: true,
            ref: popperRef as unknown as PopperProps['ref'],
          },
          tooltip: { sx: { maxWidth: 340 } },
        }}
      >
        {children}
      </Tooltip>
    </Box>
  );
}
