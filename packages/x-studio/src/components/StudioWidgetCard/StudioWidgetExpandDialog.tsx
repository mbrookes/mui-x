'use client';
import * as React from 'react';
import {
  Box,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';

import { useStudioLocaleText } from '../../context';
import type { StudioWidgetDef } from '../../internals/StudioUIConfigContext';
import { exportChartToPng } from '../../internals/widgetPresentation';
import { StudioWidgetErrorBoundary } from '../../internals/StudioWidgetErrorBoundary';
import type { StudioDataSource, StudioWidget } from '../../models';

export interface StudioWidgetExpandDialogProps {
  open: boolean;
  onClose: () => void;
  widget: StudioWidget;
  def: StudioWidgetDef;
  dataSource: StudioDataSource | undefined;
  pageId: string;
  effectiveSubtitle: string;
}

/**
 * Full-screen overlay dialog shown when a chart widget's "expand" action is used.
 * Extracted from `StudioWidgetCard` (which had grown past 800 lines) — this owns its
 * own `chartExpandContainerRef` and `useTheme()`, so the PNG export always passes the
 * current theme's background color as the transparent-canvas fallback (previously the
 * expanded-dialog export path omitted this argument, unlike the card's inline chart
 * export, so PNGs exported from the expanded view lost the theme background).
 */
export function StudioWidgetExpandDialog(props: StudioWidgetExpandDialogProps) {
  const { open, onClose, widget, def, dataSource, pageId, effectiveSubtitle } = props;
  const theme = useTheme();
  const localeText = useStudioLocaleText();
  const chartExpandContainerRef = React.useRef<HTMLDivElement>(null);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth={false}
      slotProps={{
        paper: {
          sx: {
            width: 'min(1400px, 90vw)',
            maxWidth: 'none',
          },
        },
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 1 }}>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="h6" noWrap>
            {/* The expand dialog is chart-only (see `capabilities.expand` in
                builtinWidgetDefs.ts), so the fallback title is always the localized
                "Chart" kind label rather than a hardcoded English literal. */}
            {widget.config?.cardExpandTitle || widget.title || localeText.widgetKindChart}
          </Typography>
          {effectiveSubtitle && (
            <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
              {effectiveSubtitle}
            </Typography>
          )}
        </Box>
        <IconButton
          size="small"
          onClick={onClose}
          aria-label={localeText.widgetCardCloseExpandedAriaLabel}
          sx={{ flexShrink: 0 }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ p: 2, pt: 0 }}>
        {/* Tier1 whole-dashboard-crash fix: this fullscreen "expand" view renders the same
            `def.component` the canvas card wraps in `StudioWidgetErrorBoundary`, but this
            dialog had no boundary of its own — a render throw here previously propagated
            all the way up and unmounted the whole `<Studio>` tree. `resetKeys` mirrors the
            canvas card's own keys (config identity + `sourceId` + the resolved source, i.e.
            the data/fetch generation) so a transient error clears once any of them moves,
            and the overlay's Retry button covers the case where none of them ever does.
            Compared by identity, never serialized — the previous
            `JSON.stringify(widget.config)` ran in THIS component's render, above the
            boundary, so a cyclic/`BigInt` config crashed the whole tree from the very prop
            meant to protect it. */}
        <StudioWidgetErrorBoundary resetKeys={[widget.config, widget.sourceId, dataSource]}>
          <def.component
            widget={widget}
            dataSource={dataSource}
            pageId={pageId}
            height={500}
            chartContainerRef={chartExpandContainerRef}
          />
        </StudioWidgetErrorBoundary>
      </DialogContent>
      <DialogActions sx={{ px: 2, pb: 1.5 }}>
        <Tooltip title={localeText.widgetExportPngTooltip}>
          <IconButton
            size="small"
            onClick={() =>
              exportChartToPng(
                widget,
                chartExpandContainerRef.current,
                theme.palette.background.default,
              )
            }
            aria-label={localeText.widgetCardExportPngAriaLabel}
          >
            <DownloadIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </DialogActions>
    </Dialog>
  );
}
