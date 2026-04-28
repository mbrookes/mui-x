'use client';

import * as React from 'react';
import { Box } from '@mui/material';
import FilterListIcon from '@mui/icons-material/FilterList';
import StorageIcon from '@mui/icons-material/Storage';
import TuneIcon from '@mui/icons-material/Tune';

import {
  StudioProvider,
  CanvasScrollContext,
  useStudioController,
  useStudioSelector,
} from '../context';
import type { StudioController } from '../store';
import { DrawerPanel } from './DrawerPanel';
import { StudioCanvas } from './StudioCanvas';
import { StudioDataDrawer } from './StudioDataDrawer';
import { StudioComposeDrawer } from './StudioComposeDrawer';
import { StudioFiltersDrawer } from './StudioFiltersDrawer';

export interface StudioSlots {
  dataDrawer?: React.ReactNode;
  composeDrawer?: React.ReactNode;
  filtersDrawer?: React.ReactNode;
  canvas?: React.ReactNode;
}

export interface StudioProps extends StudioSlots {
  controller: StudioController;
}

function StudioContent(props: StudioSlots) {
  const { canvas, composeDrawer, dataDrawer, filtersDrawer } = props;
  const mode = useStudioSelector((state) => state.mode);
  const controller = useStudioController();
  const canvasScrollRef = React.useRef<HTMLDivElement>(null);

  const selectedWidgetId = useStudioSelector((state) => state.shell.selectedWidgetId);
  const selectedFieldId = useStudioSelector((state) => state.shell.selectedFieldId);
  const selectedSourceId = useStudioSelector((state) => state.shell.selectedSourceId);
  const selectedWidget = useStudioSelector((state) =>
    state.shell.selectedWidgetId ? state.widgets[state.shell.selectedWidgetId] : null,
  );
  const selectedField = useStudioSelector((state) => {
    const { selectedSourceId: srcId, selectedFieldId: fldId } = state.shell;
    if (!srcId || !fldId) {
      return null;
    }
    return state.dataSources[srcId]?.fields.find((f) => f.id === fldId) ?? null;
  });

  const composeTitle = selectedWidget?.title ?? selectedField?.label ?? 'Compose';
  const hasSelection = Boolean(selectedWidgetId ?? selectedFieldId ?? selectedSourceId);
  const composeOnBack = hasSelection ? () => controller.clearSelection() : undefined;

  React.useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) {
        return false;
      }

      if (target.isContentEditable) {
        return true;
      }

      return Boolean(
        target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'),
      );
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        isEditableTarget(event.target)
      ) {
        return;
      }

      const key = event.key.toLowerCase();

      // Redo: Cmd+Shift+Z or Ctrl+Y
      if ((key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey)) {
        if (controller.canRedo()) {
          event.preventDefault();
          controller.redo();
        }
        return;
      }

      // Undo: Cmd+Z / Ctrl+Z (no shift)
      if (key === 'z' && !event.shiftKey) {
        if (controller.canUndo()) {
          event.preventDefault();
          controller.undo();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [controller]);

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        bgcolor: 'background.default',
      }}
    >
      <Box sx={{ display: 'flex', flexGrow: 1, minHeight: 0, overflow: 'hidden' }}>
        {mode === 'edit' && (
          <DrawerPanel drawer="data" title="Data" icon={<StorageIcon fontSize="small" />}>
            {dataDrawer ?? <StudioDataDrawer />}
          </DrawerPanel>
        )}
        {mode === 'edit' && (
          <DrawerPanel
            drawer="compose"
            title={composeTitle}
            icon={<TuneIcon fontSize="small" />}
            onBack={composeOnBack}
          >
            {composeDrawer ?? <StudioComposeDrawer />}
          </DrawerPanel>
        )}
        <DrawerPanel drawer="filters" title="Filters" icon={<FilterListIcon fontSize="small" />}>
          {filtersDrawer ?? <StudioFiltersDrawer />}
        </DrawerPanel>

        <CanvasScrollContext.Provider value={canvasScrollRef}>
          <Box
            ref={canvasScrollRef}
            sx={{
              flexGrow: 1,
              minWidth: 0,
              overflowY: 'auto',
              bgcolor: (theme) => (theme.palette.mode === 'dark' ? 'grey.900' : 'grey.100'),
            }}
          >
            {canvas ?? <StudioCanvas />}
          </Box>
        </CanvasScrollContext.Provider>
      </Box>
    </Box>
  );
}

export function Studio(props: StudioProps) {
  const { controller, ...slots } = props;

  return (
    <StudioProvider controller={controller}>
      <StudioContent {...slots} />
    </StudioProvider>
  );
}
