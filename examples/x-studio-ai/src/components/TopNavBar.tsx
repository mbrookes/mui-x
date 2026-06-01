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
  InputBase,
  Switch,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import FileUploadIcon from '@mui/icons-material/FileUpload';
import SettingsIcon from '@mui/icons-material/Settings';
import {
  StudioWordmark,
  selectActivePage,
  selectMode,
  selectPages,
  useStudioController,
  useStudioSelector,
} from '@mui/x-studio';
import type { StudioPage } from '@mui/x-studio';

interface TopNavBarProps {
  chatId: string | null;
  onSettingsOpen: () => void;
  onSave: () => void;
  onLoad: () => void;
}

export function TopNavBar({ chatId, onSettingsOpen, onSave, onLoad }: TopNavBarProps) {
  const controller = useStudioController();
  const mode = useStudioSelector(selectMode);
  const pages = useStudioSelector(selectPages);
  const activePage = useStudioSelector(selectActivePage);
  const pageList = React.useMemo(() => Object.values(pages), [pages]);

  const [confirmPageId, setConfirmPageId] = React.useState<string | null>(null);
  const [editingPageId, setEditingPageId] = React.useState<string | null>(null);
  const [titleDraft, setTitleDraft] = React.useState('');

  const confirmPage = confirmPageId ? pageList.find((page) => page.id === confirmPageId) : null;
  const showPages = chatId !== null && (pageList.length > 0 || mode === 'edit');
  const showCloseButtons = mode === 'edit' && pageList.length > 1;
  const showDragHandles = mode === 'edit' && pageList.length > 1;

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

  const dragNavTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragNavCounterRef = React.useRef(0);
  const dragNavPageIdRef = React.useRef<string | null>(null);

  React.useEffect(
    () => () => {
      dragCleanupRef.current?.();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
      if (dragNavTimerRef.current !== null) {
        clearTimeout(dragNavTimerRef.current);
      }
    },
    [],
  );

  const cancelDragNavTimer = React.useCallback(() => {
    if (dragNavTimerRef.current !== null) {
      clearTimeout(dragNavTimerRef.current);
      dragNavTimerRef.current = null;
    }
    dragNavCounterRef.current = 0;
    dragNavPageIdRef.current = null;
  }, []);

  React.useEffect(() => {
    document.addEventListener('dragend', cancelDragNavTimer);
    return () => {
      document.removeEventListener('dragend', cancelDragNavTimer);
      cancelDragNavTimer();
    };
  }, [cancelDragNavTimer]);

  const startRename = React.useCallback((page: StudioPage) => {
    setEditingPageId(page.id);
    setTitleDraft(page.title);
  }, []);

  const commitRename = React.useCallback(() => {
    if (!editingPageId) {
      return;
    }

    const nextTitle = titleDraft.trim();
    if (nextTitle) {
      controller.renamePage(editingPageId, nextTitle);
    }
    setEditingPageId(null);
  }, [controller, editingPageId, titleDraft]);

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
    if (!showDragHandles || editingPageId !== null) {
      return;
    }
    if (event.button !== 0) {
      return;
    }
    if ((event.target as HTMLElement).closest('.MuiIconButton-root,input,textarea')) {
      return;
    }

    const tabEls = Array.from(tabsRef.current?.querySelectorAll<HTMLElement>('.MuiTab-root') ?? []);
    const tabRects = tabEls.map((tab) => tab.getBoundingClientRect());
    const tabBarRect = tabsRef.current?.getBoundingClientRect();

    const startX = event.clientX;
    const grabOffsetX = startX - (tabRects[index]?.left ?? 0);
    let currentTarget = index;
    let triggered = false;
    const pointerId = event.pointerId;
    const element = event.currentTarget as HTMLElement;
    element.setPointerCapture(pointerId);

    function computeTarget(ghostLeft: number): number {
      const ghostCenter = ghostLeft + (tabRects[index]?.width ?? 100) / 2;
      let best = 0;
      let bestDist = Infinity;
      for (let currentIndex = 0; currentIndex < tabRects.length; currentIndex += 1) {
        const midpoint = tabRects[currentIndex].left + tabRects[currentIndex].width / 2;
        const distance = Math.abs(ghostCenter - midpoint);
        if (distance < bestDist) {
          bestDist = distance;
          best = currentIndex;
        }
      }
      return best;
    }

    function onMove(moveEvent: PointerEvent) {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }

      const deltaX = moveEvent.clientX - startX;
      if (!triggered) {
        if (Math.abs(deltaX) < 5) {
          return;
        }
        triggered = true;
        didDragRef.current = true;
        const ghostLeft = moveEvent.clientX - grabOffsetX;
        setActiveDrag({
          draggedIndex: index,
          targetIndex: index,
          tabWidth: tabRects[index]?.width ?? 100,
          ghostLeft,
          tabBarTop: tabBarRect?.top ?? 0,
          tabBarHeight: tabBarRect?.height ?? 48,
        });
      }

      const ghostLeft = moveEvent.clientX - grabOffsetX;
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

    function onUp(upEvent: PointerEvent) {
      if (upEvent.pointerId !== pointerId) {
        return;
      }

      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      dragCleanupRef.current = null;

      if (triggered && currentTarget !== index) {
        const pageIds = pageList.map((page) => page.id);
        const [moved] = pageIds.splice(index, 1);
        pageIds.splice(currentTarget, 0, moved);
        controller.reorderPages(pageIds);
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

  function handleTabWidgetDragEnter(event: React.DragEvent, pageId: string) {
    if (!Array.from(event.dataTransfer.types).includes('application/json')) {
      return;
    }
    if (dragNavPageIdRef.current !== pageId) {
      cancelDragNavTimer();
      dragNavPageIdRef.current = pageId;
    }
    dragNavCounterRef.current += 1;
    if (dragNavTimerRef.current === null) {
      dragNavTimerRef.current = setTimeout(() => {
        dragNavTimerRef.current = null;
        controller.setActivePage(pageId);
      }, 600);
    }
  }

  function handleTabWidgetDragLeave(event: React.DragEvent, pageId: string) {
    if (!Array.from(event.dataTransfer.types).includes('application/json')) {
      return;
    }
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
      </Box>

      {showPages ? (
        <Box sx={{ display: 'flex', alignItems: 'center', flexGrow: 1, minWidth: 0 }}>
          {pageList.length > 0 && (
            <Tabs
              ref={tabsRef}
              value={activePage?.id ?? false}
              onChange={(_event, pageId) => controller.setActivePage(pageId)}
              variant="scrollable"
              scrollButtons="auto"
              allowScrollButtonsMobile
              sx={{ minWidth: 0, flexGrow: 1 }}
              onClickCapture={(event) => {
                if (didDragRef.current) {
                  event.stopPropagation();
                  event.preventDefault();
                  didDragRef.current = false;
                }
              }}
            >
              {pageList.map((page, index) => (
                <Tab
                  key={page.id}
                  value={page.id}
                  onPointerDown={showDragHandles ? (event) => handleTabPointerDown(event, index) : undefined}
                  onDragEnter={(event) => handleTabWidgetDragEnter(event, page.id)}
                  onDragLeave={(event) => handleTabWidgetDragLeave(event, page.id)}
                  onDoubleClick={() => {
                    if (mode === 'edit') {
                      startRename(page);
                    }
                  }}
                  sx={{
                    minHeight: 48,
                    opacity: activeDrag?.draggedIndex === index ? 0 : 1,
                    transform: getTabTransform(index),
                    transition: activeDrag ? 'transform 150ms ease' : 'none',
                    cursor: showDragHandles ? 'grab' : undefined,
                  }}
                  label={
                    editingPageId === page.id ? (
                      <InputBase
                        autoFocus
                        value={titleDraft}
                        onChange={(event) => setTitleDraft(event.target.value)}
                        onClick={(event) => event.stopPropagation()}
                        onBlur={commitRename}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                          if (event.key === 'Enter') {
                            commitRename();
                          }
                          if (event.key === 'Escape') {
                            setEditingPageId(null);
                          }
                        }}
                        sx={{ fontSize: '0.875rem', fontWeight: 500, minWidth: 80 }}
                      />
                    ) : showCloseButtons ? (
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

          {mode === 'edit' && (
            <Tooltip title="Add page">
              <IconButton
                size="small"
                onClick={() => controller.addPage(`Page ${pageList.length + 1}`)}
                aria-label="Add page"
                sx={{ ml: pageList.length > 0 ? 0.5 : 0 }}
              >
                <AddIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Box>
      ) : (
        <Box sx={{ flexGrow: 1 }} />
      )}

      {activeDrag &&
        ReactDOM.createPortal(
          <Box
            ref={(element: HTMLDivElement | null) => {
              ghostElRef.current = element;
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
            {pageList[activeDrag.draggedIndex]?.title}
          </Box>,
          document.body,
        )}

      <Tooltip title="Download dashboard">
        <span>
          <IconButton size="small" onClick={onSave} aria-label="Download dashboard" disabled={!chatId}>
            <FileDownloadIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Upload dashboard">
        <span>
          <IconButton size="small" onClick={onLoad} aria-label="Upload dashboard" disabled={!chatId}>
            <FileUploadIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Settings">
        <IconButton size="small" onClick={onSettingsOpen} aria-label="Settings">
          <SettingsIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Divider orientation="vertical" flexItem sx={{ mx: 0.5, my: 1 }} />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Typography variant="body2" color={mode === 'view' ? 'text.primary' : 'text.secondary'}>
          View
        </Typography>
        <Switch
          checked={mode === 'edit'}
          onChange={(_event, checked) => controller.setMode(checked ? 'edit' : 'view')}
          size="small"
          slotProps={{ input: { 'aria-label': 'Toggle edit mode' } }}
        />
        <Typography variant="body2" color={mode === 'edit' ? 'text.primary' : 'text.secondary'}>
          Edit
        </Typography>
      </Box>

      <Dialog open={Boolean(confirmPage)} onClose={() => setConfirmPageId(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Remove page?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Remove &ldquo;{confirmPage?.title}&rdquo; and all its widgets? This action can be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmPageId(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              if (confirmPageId) {
                controller.removePage(confirmPageId);
              }
              setConfirmPageId(null);
            }}
          >
            Remove
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
