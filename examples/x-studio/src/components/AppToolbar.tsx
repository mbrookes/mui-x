import * as React from 'react';
import * as ReactDOM from 'react-dom';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  IconButton,
  Switch,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/material';
import type { SwitchProps } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import FileUploadIcon from '@mui/icons-material/FileUpload';
import RedoIcon from '@mui/icons-material/Redo';
import RestoreIcon from '@mui/icons-material/Restore';
import SettingsIcon from '@mui/icons-material/Settings';
import UndoIcon from '@mui/icons-material/Undo';
import type { StudioMode, StudioPage } from '@mui/x-studio';
import { StudioWordmark } from '@mui/x-studio';
import { useAppLocaleText } from '../locales/AppLocaleContext';

export interface AppToolbarProps {
  title: string;
  mode: StudioMode;
  onModeChange: SwitchProps['onChange'];
  onSave: () => void;
  onLoad: () => void;
  onReset?: () => void;
  onOpenSettings: () => void;
  pages: StudioPage[];
  activePageId: string;
  onPageChange: (event: React.SyntheticEvent, pageId: string) => void;
  onPageClose?: (pageId: string) => void;
  onPageReorder?: (pageIds: string[]) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  /**
   * Called with the target pageId after a widget is held over a tab for 600ms (BL-107).
   * @param {string} pageId - The ID of the page to navigate to.
   */
  onPageDragNavigate?: (pageId: string) => void;
}

// react-doctor-disable-next-line react-doctor/no-giant-component -- top-level orchestration component; splitting would scatter related state
export function AppToolbar(props: AppToolbarProps) {
  const {
    title,
    mode,
    onModeChange,
    onSave,
    onLoad,
    onReset,
    onOpenSettings,
    pages,
    activePageId,
    onPageChange,
    onPageClose,
    onPageReorder,
    canUndo,
    canRedo,
    onUndo,
    onRedo,
    onPageDragNavigate,
  } = props;

  const t = useAppLocaleText();
  const [confirmPageId, setConfirmPageId] = React.useState<string | null>(null);
  const confirmPage = confirmPageId ? pages.find((p) => p.id === confirmPageId) : null;
  const showCloseButtons = mode === 'edit' && pages.length > 1 && Boolean(onPageClose);
  const showDragHandles = mode === 'edit' && pages.length > 1 && Boolean(onPageReorder);

  // BL-147: Chrome-style pointer-based tab drag state
  const tabsRef = React.useRef<HTMLDivElement>(null);
  const [activeDrag, setActiveDrag] = React.useState<{
    draggedIndex: number;
    targetIndex: number;
    tabWidth: number;
    ghostLeft: number;
    tabBarTop: number;
    tabBarHeight: number;
  } | null>(null);
  const ghostElRef = React.useRef<HTMLDivElement | null>(null);
  const rafRef = React.useRef<number | null>(null);
  const didDragRef = React.useRef(false);
  const dragCleanupRef = React.useRef<(() => void) | null>(null);

  React.useEffect(
    () => () => {
      dragCleanupRef.current?.();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    },
    [],
  );

  function getTabTransform(index: number): string {
    if (!activeDrag) {
      return 'none';
    }
    const { draggedIndex, targetIndex, tabWidth } = activeDrag;
    if (index === draggedIndex) {
      return 'none';
    }
    if (draggedIndex < targetIndex && index > draggedIndex && index <= targetIndex) {
      return `translateX(-${tabWidth}px)`;
    }
    if (draggedIndex > targetIndex && index < draggedIndex && index >= targetIndex) {
      return `translateX(${tabWidth}px)`;
    }
    return 'none';
  }

  function handleTabPointerDown(event: React.PointerEvent, index: number) {
    if (!showDragHandles) {
      return;
    }
    if (event.button !== 0) {
      return;
    }
    if ((event.target as HTMLElement).closest('.MuiIconButton-root')) {
      return;
    }

    const tabEls = Array.from(tabsRef.current?.querySelectorAll<HTMLElement>('.MuiTab-root') ?? []);
    const tabRects = tabEls.map((t) => t.getBoundingClientRect());
    const tabBarRect = tabsRef.current?.getBoundingClientRect();

    const startX = event.clientX;
    const grabOffsetX = startX - (tabRects[index]?.left ?? 0);
    let currentTarget = index;
    let triggered = false;
    const pointerId = event.pointerId;
    const el = event.currentTarget as HTMLElement;
    el.setPointerCapture(pointerId);

    function computeTarget(ghostLeft: number): number {
      const ghostCenter = ghostLeft + (tabRects[index]?.width ?? 100) / 2;
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < tabRects.length; i += 1) {
        const mid = tabRects[i].left + tabRects[i].width / 2;
        const dist = Math.abs(ghostCenter - mid);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
      return best;
    }

    function onMove(me: PointerEvent) {
      if (me.pointerId !== pointerId) {
        return;
      }
      const deltaX = me.clientX - startX;
      if (!triggered) {
        if (Math.abs(deltaX) < 5) {
          return;
        }
        triggered = true;
        didDragRef.current = true;
        const ghostLeft = me.clientX - grabOffsetX;
        setActiveDrag({
          draggedIndex: index,
          targetIndex: index,
          tabWidth: tabRects[index]?.width ?? 100,
          ghostLeft,
          tabBarTop: tabBarRect?.top ?? 0,
          tabBarHeight: tabBarRect?.height ?? 48,
        });
      }

      const ghostLeft = me.clientX - grabOffsetX;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
      rafRef.current = requestAnimationFrame(() => {
        if (ghostElRef.current) {
          ghostElRef.current.style.left = `${ghostLeft}px`;
        }
      });

      const newTarget = computeTarget(ghostLeft);
      if (newTarget !== currentTarget) {
        currentTarget = newTarget;
        setActiveDrag((prev) => (prev ? { ...prev, targetIndex: newTarget } : null));
      }
    }

    function onUp(ue: PointerEvent) {
      if (ue.pointerId !== pointerId) {
        return;
      }
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      dragCleanupRef.current = null;

      if (triggered && currentTarget !== index) {
        const newOrder = pages.map((p) => p.id);
        const [moved] = newOrder.splice(index, 1);
        // nearest-midpoint formula: currentTarget is the desired final index (no off-by-one)
        newOrder.splice(currentTarget, 0, moved);
        onPageReorder?.(newOrder);
      }
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setActiveDrag(null);
      setTimeout(() => {
        didDragRef.current = false;
      }, 0);
    }

    dragCleanupRef.current = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

  // BL-107: drag-to-navigate — tab-scoped timer + enter/leave counter
  const dragNavTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragNavCounterRef = React.useRef<number>(0);
  const dragNavPageIdRef = React.useRef<string | null>(null);

  const cancelDragNavTimer = React.useCallback(() => {
    if (dragNavTimerRef.current !== null) {
      clearTimeout(dragNavTimerRef.current);
      dragNavTimerRef.current = null;
    }
    dragNavCounterRef.current = 0;
    dragNavPageIdRef.current = null;
  }, []);

  // Clean up on unmount and listen for global dragend (widget drop/cancel outside tabs)
  // react-doctor-disable-next-line react-doctor/advanced-event-handler-refs -- event handler updated via stable wrapper
  React.useEffect(() => {
    document.addEventListener('dragend', cancelDragNavTimer);
    return () => {
      document.removeEventListener('dragend', cancelDragNavTimer);
      cancelDragNavTimer();
    };
  }, [cancelDragNavTimer]);

  function handleTabWidgetDragEnter(event: React.DragEvent, pageId: string) {
    if (!Array.from(event.dataTransfer.types).includes('application/json')) {
      return;
    }
    // If entering a different tab, cancel any in-flight timer for the previous tab
    if (dragNavPageIdRef.current !== pageId) {
      cancelDragNavTimer();
      dragNavPageIdRef.current = pageId;
    }
    dragNavCounterRef.current += 1;
    if (dragNavTimerRef.current === null) {
      dragNavTimerRef.current = setTimeout(() => {
        dragNavTimerRef.current = null;
        onPageDragNavigate?.(pageId);
      }, 600);
    }
  }

  function handleTabWidgetDragLeave(event: React.DragEvent, pageId: string) {
    if (!Array.from(event.dataTransfer.types).includes('application/json')) {
      return;
    }
    // Ignore stale leave events from previously hovered tabs
    if (dragNavPageIdRef.current !== pageId) {
      return;
    }
    dragNavCounterRef.current -= 1;
    if (dragNavCounterRef.current <= 0) {
      cancelDragNavTimer();
    }
  }

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        px: 2,
        borderBottom: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        gap: 1,
        minHeight: 48,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexShrink: 0 }}>
        <StudioWordmark height={30} />
        {title && (
          <React.Fragment>
            <Box sx={{ width: '1px', height: 20, bgcolor: 'divider', flexShrink: 0 }} aria-hidden />
            <Typography
              variant="body1"
              sx={{
                fontSize: 18,
                color: 'text.secondary',
                maxWidth: 240,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {title}
            </Typography>
          </React.Fragment>
        )}
      </Box>
      {pages.length > 1 && (
        <Tabs
          ref={tabsRef}
          value={activePageId}
          onChange={onPageChange}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          sx={{ flexGrow: 1, minWidth: 0 }}
          onClickCapture={(event) => {
            if (didDragRef.current) {
              event.stopPropagation();
              event.preventDefault();
              didDragRef.current = false;
            }
          }}
        >
          {pages.map((page, index) => (
            <Tab
              key={page.id}
              value={page.id}
              onPointerDown={
                showDragHandles ? (event) => handleTabPointerDown(event, index) : undefined
              }
              onDragEnter={(event) => handleTabWidgetDragEnter(event, page.id)}
              onDragLeave={(event) => handleTabWidgetDragLeave(event, page.id)}
              sx={{
                minHeight: 48,
                opacity: activeDrag?.draggedIndex === index ? 0 : 1,
                transform: getTabTransform(index),
                transition: activeDrag ? 'transform 150ms ease' : 'none',
                cursor: showDragHandles ? 'grab' : undefined,
              }}
              label={
                showCloseButtons ? (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <span>{page.title}</span>
                    <IconButton
                      size="small"
                      aria-label={`Remove page ${page.title}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setConfirmPageId(page.id);
                      }}
                      sx={{ p: 0.25, ml: 0.25 }}
                    >
                      <CloseIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                  </Box>
                ) : (
                  page.title
                )
              }
            />
          ))}
        </Tabs>
      )}
      {pages.length <= 1 && <Box sx={{ flexGrow: 1 }} />}

      {/* Ghost tab portal — rendered at document.body level during pointer drag */}
      {activeDrag &&
        ReactDOM.createPortal(
          <Box
            ref={(el) => {
              ghostElRef.current = el as HTMLDivElement | null;
            }}
            sx={{
              position: 'fixed',
              top: activeDrag.tabBarTop,
              left: activeDrag.ghostLeft,
              height: activeDrag.tabBarHeight,
              minWidth: activeDrag.tabWidth,
              bgcolor: 'background.paper',
              borderRadius: '4px 4px 0 0',
              boxShadow: 3,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              px: 2,
              pointerEvents: 'none',
              zIndex: 9999,
              fontSize: '0.875rem',
              fontFamily: 'inherit',
              color: 'text.primary',
              border: 1,
              borderColor: 'primary.main',
              userSelect: 'none',
            }}
          >
            {pages[activeDrag.draggedIndex]?.title}
          </Box>,
          document.body,
        )}

      {/* Confirmation dialog for page removal */}
      <Dialog
        open={Boolean(confirmPage)}
        onClose={() => setConfirmPageId(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{t.removePageTitle}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t.removePageDescription(confirmPage?.title ?? '')}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmPageId(null)}>{t.cancelButtonLabel}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              if (confirmPageId) {
                onPageClose?.(confirmPageId);
              }
              setConfirmPageId(null);
            }}
          >
            {t.removeButtonLabel}
          </Button>
        </DialogActions>
      </Dialog>
      {mode === 'edit' && (
        <React.Fragment>
          <Tooltip title={t.undoTooltip}>
            <span>
              <IconButton
                size="small"
                onClick={onUndo}
                disabled={!canUndo}
                aria-label={t.undoAriaLabel}
              >
                <UndoIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={t.redoTooltip}>
            <span>
              <IconButton
                size="small"
                onClick={onRedo}
                disabled={!canRedo}
                aria-label={t.redoAriaLabel}
              >
                <RedoIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Divider orientation="vertical" flexItem sx={{ mx: 0.5, my: 1 }} />
        </React.Fragment>
      )}
      <Tooltip title={t.downloadTooltip}>
        <IconButton size="small" onClick={onSave} aria-label={t.downloadAriaLabel}>
          <FileDownloadIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title={t.uploadTooltip}>
        <IconButton size="small" onClick={onLoad} aria-label={t.uploadAriaLabel}>
          <FileUploadIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      {onReset && (
        <Tooltip title={t.resetTooltip}>
          <IconButton size="small" onClick={onReset} aria-label={t.resetAriaLabel}>
            <RestoreIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
      <Tooltip title={t.settingsTooltip}>
        <IconButton size="small" onClick={onOpenSettings} aria-label={t.settingsAriaLabel}>
          <SettingsIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Divider orientation="vertical" flexItem sx={{ mx: 0.5, my: 1 }} />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Typography variant="body2" color={mode === 'view' ? 'text.primary' : 'text.secondary'}>
          {t.viewLabel}
        </Typography>
        <Switch
          checked={mode === 'edit'}
          onChange={onModeChange}
          size="small"
          slotProps={{ input: { 'aria-label': t.toggleEditModeAriaLabel } }}
        />
        <Typography variant="body2" color={mode === 'edit' ? 'text.primary' : 'text.secondary'}>
          {t.editLabel}
        </Typography>
      </Box>
    </Box>
  );
}
