'use client';
import * as React from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Collapse,
  Divider,
  IconButton,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AddIcon from '@mui/icons-material/Add';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import {
  CanvasScrollContext,
  useStudioController,
  useStudioSelector,
  selectShell,
  selectActivePage,
  selectWidgets,
  selectDataSources,
} from '../context';
import {
  createDefaultWidget,
  WIDGET_TYPES,
  widgetKindRequiresDataSource,
  getWidgetSubtypeIcon,
} from '../internals/widgetUtils';
import {
  WIDGET_TEMPLATES,
  applyWidgetTemplate,
  templateIsSatisfied,
} from '../internals/widgetTemplates';
import type { StudioWidget, StudioWidgetKind } from '../models';
import { KIND_LABEL } from './StudioComposeDrawer';

function getCursor(isDragging: boolean) {
  return isDragging ? 'grabbing' : 'grab';
}

// ── Template library ────────────────────────────────────────────────────────

interface TemplateSectionProps {
  onApply: (widget: StudioWidget) => void;
}

function TemplateSection({ onApply }: TemplateSectionProps) {
  const [open, setOpen] = React.useState(true);
  const dataSources = useStudioSelector(selectDataSources);
  const visibleSources = Object.values(dataSources).filter((s) => !s.hidden);
  const primarySource = visibleSources[0];

  return (
    <Box>
      <Box
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          cursor: 'pointer',
          userSelect: 'none',
          mb: 0.5,
        }}
      >
        <AutoAwesomeIcon sx={{ fontSize: 16, color: 'primary.main' }} />
        <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
          Templates
        </Typography>
        {open ? (
          <ExpandLessIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
        ) : (
          <ExpandMoreIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
        )}
      </Box>
      <Collapse in={open}>
        <Stack spacing={0.75}>
          {WIDGET_TEMPLATES.map((tpl) => {
            const canApply = templateIsSatisfied(tpl, primarySource);
            return (
              <Paper
                key={tpl.id}
                variant="outlined"
                onClick={() => {
                  if (canApply) {
                    onApply(applyWidgetTemplate(tpl, primarySource));
                  }
                }}
                tabIndex={canApply ? 0 : undefined}
                role="button"
                aria-label={`Add ${tpl.label} widget from template`}
                aria-disabled={!canApply}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    if (canApply) {
                      onApply(applyWidgetTemplate(tpl, primarySource));
                    }
                  }
                }}
                sx={{
                  p: 1,
                  px: 1.5,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.5,
                  cursor: canApply ? 'pointer' : 'not-allowed',
                  opacity: canApply ? 1 : 0.45,
                  transition: 'border-color 0.15s, background-color 0.15s',
                  '&:hover': canApply
                    ? { borderColor: 'primary.main', bgcolor: 'action.hover' }
                    : {},
                  '&:focus-visible': {
                    outline: 2,
                    outlineColor: 'primary.main',
                    outlineOffset: 2,
                  },
                }}
              >
                <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    <Typography variant="subtitle2" sx={{ fontSize: 12 }}>
                      {tpl.label}
                    </Typography>
                    <Chip
                      label={tpl.kind === 'kpi' ? 'KPI' : tpl.kind === 'grid' ? 'Table' : 'Chart'}
                      size="small"
                      sx={{ height: 16, fontSize: 10, px: 0.25 }}
                    />
                  </Box>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {tpl.description}
                  </Typography>
                </Box>
                <AddIcon sx={{ fontSize: 16, color: canApply ? 'primary.main' : 'text.disabled', flexShrink: 0 }} />
              </Paper>
            );
          })}
        </Stack>
      </Collapse>
    </Box>
  );
}

// ── Widget type cards ────────────────────────────────────────────────────────

interface WidgetTypeEntry {
  kind: StudioWidgetKind;
  label: string;
  description: string;
  icon: React.ReactNode;
}

interface WidgetTypeCardProps {
  wt: WidgetTypeEntry;
  canAdd: boolean;
  onSelect: (kind: StudioWidgetKind) => void;
}

function WidgetTypeCard({ wt, canAdd, onSelect }: WidgetTypeCardProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = React.useState(false);
  React.useEffect(() => {
    if (!canAdd) {
      return undefined;
    }
    const node = ref.current;
    if (!node) {
      return undefined;
    }
    function handleDragStart(event: DragEvent) {
      setIsDragging(true);
      event.dataTransfer?.setData(
        'application/json',
        JSON.stringify({ type: 'compose-widget', kind: wt.kind }),
      );
      if (node) {
        event.dataTransfer?.setDragImage(node, 0, 0);
      }
    }
    function handleDragEnd() {
      setIsDragging(false);
    }
    node.setAttribute('draggable', 'true');
    node.addEventListener('dragstart', handleDragStart);
    node.addEventListener('dragend', handleDragEnd);
    return () => {
      node.removeEventListener('dragstart', handleDragStart);
      node.removeEventListener('dragend', handleDragEnd);
    };
  }, [canAdd, wt.kind]);

  return (
    <Paper
      ref={ref}
      variant="outlined"
      onClick={() => {
        if (canAdd) {
          onSelect(wt.kind);
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`${wt.label} widgets`}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (canAdd) {
            onSelect(wt.kind);
          }
        }
      }}
      sx={{
        p: 1.5,
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        cursor: canAdd ? getCursor(isDragging) : 'not-allowed',
        opacity: canAdd ? 1 : 0.5,
        transition: 'border-color 0.15s, background-color 0.15s',
        '&:hover': canAdd ? { borderColor: 'primary.main', bgcolor: 'action.hover' } : {},
        '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 },
        boxShadow: isDragging ? 4 : undefined,
      }}
    >
      <Box sx={{ color: 'primary.main', display: 'flex', flexShrink: 0 }}>{wt.icon}</Box>
      <div>
        <Typography variant="subtitle2">{wt.label}</Typography>
        <Typography variant="caption" color="text.secondary">
          {wt.description}
        </Typography>
      </div>
    </Paper>
  );
}

interface WidgetInstanceItemProps {
  widget: StudioWidget;
  isSelected: boolean;
  onSelect: (id: string) => void;
}

function WidgetInstanceItem({ widget, isSelected, onSelect }: WidgetInstanceItemProps) {
  return (
    <Paper
      variant="outlined"
      onClick={() => onSelect(widget.id)}
      tabIndex={0}
      role="button"
      aria-label={`Select widget: ${widget.title || widget.kind}`}
      aria-pressed={isSelected}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(widget.id);
        }
      }}
      sx={{
        p: 1,
        px: 1.5,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        cursor: 'pointer',
        transition: 'border-color 0.15s, background-color 0.15s',
        borderColor: isSelected ? 'primary.main' : 'divider',
        bgcolor: isSelected ? 'primary.50' : undefined,
        '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' },
        '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 },
      }}
    >
      <Box sx={{ color: 'primary.main', display: 'flex', flexShrink: 0 }}>
        {getWidgetSubtypeIcon(widget)}
      </Box>
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Typography variant="body2" noWrap>
          {widget.title || KIND_LABEL[widget.kind]}
        </Typography>
        {widget.subtitle && (
          <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
            {widget.subtitle}
          </Typography>
        )}
      </Box>
    </Paper>
  );
}

interface WidgetInstanceListProps {
  kind: StudioWidgetKind;
  onBack: () => void;
  onAdd: (kind: StudioWidgetKind) => void;
}

function WidgetInstanceList({ kind, onBack, onAdd }: WidgetInstanceListProps) {
  const controller = useStudioController();
  const shell = useStudioSelector(selectShell);
  const selectedWidgetId = shell.selectedWidgetId;
  const activePage = useStudioSelector(selectActivePage);
  const widgetRows = React.useMemo(() => activePage?.widgetRows ?? [], [activePage]);
  const widgets = useStudioSelector(selectWidgets);

  const pageWidgetIds = React.useMemo(() => new Set(widgetRows.flat()), [widgetRows]);

  const widgetsOfKind = React.useMemo(
    () => Object.values(widgets).filter((w) => w.kind === kind && pageWidgetIds.has(w.id)),
    [widgets, kind, pageWidgetIds],
  );

  const wt = WIDGET_TYPES.find((w) => w.kind === kind)!;

  return (
    <Stack spacing={1.5}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <IconButton size="small" onClick={onBack} aria-label="Back to widget types">
          <ArrowBackIcon fontSize="small" />
        </IconButton>
        <Box sx={{ color: 'primary.main', display: 'flex' }}>{wt.icon}</Box>
        <Typography variant="subtitle2">{wt.label}</Typography>
      </Box>

      <Divider />

      {widgetsOfKind.length > 0 && (
        <Stack spacing={0.75}>
          <Typography variant="caption" color="text.secondary">
            On this page
          </Typography>
          {widgetsOfKind.map((widget) => (
            <WidgetInstanceItem
              key={widget.id}
              widget={widget}
              isSelected={selectedWidgetId === widget.id}
              onSelect={(id) => controller.setSelectedWidget(id)}
            />
          ))}
        </Stack>
      )}

      <Button
        variant="outlined"
        size="small"
        startIcon={<AddIcon />}
        onClick={() => onAdd(kind)}
        fullWidth
      >
        Add {wt.label} widget
      </Button>
    </Stack>
  );
}

/**
 * Smoothly scrolls a container to its bottom over `duration` ms using ease-out cubic.
 * The target is re-evaluated each frame so the animation tracks content that loads
 * asynchronously (e.g. widget card content rendered via useTransition).
 */
function smoothScrollToBottom(container: HTMLElement, duration = 420) {
  const startY = container.scrollTop;
  const startTime = performance.now();
  function easeOutCubic(t: number): number {
    return 1 - (1 - t) ** 3;
  }
  function step(now: number) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    // Re-read bottom each frame — widget content may still be loading
    const targetY = container.scrollHeight - container.clientHeight;
    container.scrollTop = startY + (targetY - startY) * easeOutCubic(progress);
    if (progress < 1) {
      requestAnimationFrame(step);
    } else {
      // Final snap: catches any content that finished loading after the animation
      container.scrollTop = container.scrollHeight - container.clientHeight;
    }
  }
  requestAnimationFrame(step);
}

export function AddWidgetView() {
  const controller = useStudioController();
  const dataSources = useStudioSelector(selectDataSources);
  const canvasScrollRef = React.use(CanvasScrollContext);
  const [selectedKind, setSelectedKind] = React.useState<StudioWidgetKind | null>(null);

  const scrollToBottom = React.useCallback(() => {
    // Double-rAF: first waits for React to commit the new card, second for the
    // browser to complete layout — so scrollHeight reflects the new widget height.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const container = canvasScrollRef?.current;
        if (container) {
          smoothScrollToBottom(container);
        }
      });
    });
  }, [canvasScrollRef]);

  const handleAdd = React.useCallback(
    (kind: StudioWidgetKind) => {
      const sources = Object.values(dataSources).filter((s) => !s.hidden);
      if (widgetKindRequiresDataSource(kind) && sources.length === 0) {
        return;
      }
      controller.addWidget(createDefaultWidget(kind));
      scrollToBottom();
    },
    [controller, dataSources, scrollToBottom],
  );

  const handleApplyTemplate = React.useCallback(
    (widget: StudioWidget) => {
      controller.addWidget(widget);
      scrollToBottom();
    },
    [controller, scrollToBottom],
  );

  const handleSelectKind = React.useCallback((kind: StudioWidgetKind) => {
    setSelectedKind(kind);
  }, []);

  const hasSources = Object.values(dataSources).some((s) => !s.hidden);

  if (selectedKind) {
    return (
      <WidgetInstanceList
        kind={selectedKind}
        onBack={() => setSelectedKind(null)}
        onAdd={(kind) => {
          handleAdd(kind);
          setSelectedKind(null);
        }}
      />
    );
  }

  return (
    <Stack spacing={1.5}>
      {hasSources && (
        <>
          <TemplateSection onApply={handleApplyTemplate} />
          <Divider />
        </>
      )}
      <Typography variant="caption" color="text.secondary">
        Choose a widget type
      </Typography>
      {!hasSources && (
        <Alert severity="warning" sx={{ fontSize: 12 }}>
          No data sources available yet. Only text widgets can be added until one is connected.
        </Alert>
      )}
      {WIDGET_TYPES.map((wt) => {
        const canAdd = !widgetKindRequiresDataSource(wt.kind) || hasSources;
        return <WidgetTypeCard key={wt.kind} wt={wt} canAdd={canAdd} onSelect={handleSelectKind} />;
      })}
    </Stack>
  );
}
