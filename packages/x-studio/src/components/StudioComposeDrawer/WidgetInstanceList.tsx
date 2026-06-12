'use client';
import * as React from 'react';
import {
  Box,
  Button,
  Divider,
  IconButton,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AddIcon from '@mui/icons-material/Add';

import {
  useStudioController,
  useStudioSelector,
  useCustomWidgetMap,
  selectShell,
  selectActivePage,
  selectWidgets,
  useStudioLocaleText,
} from '../../context';
import { getWidgetSubtypeIcon } from '../../internals/widgetUtils';
import { WIDGET_TYPES } from '../../internals/widgetUtils';
import type { StudioWidget, StudioWidgetKind } from '../../models';
import { useWidgetKindLabels, getBuiltInWidgetKindInfo } from './StudioComposeDrawerLabels';

// ── Widget instance list ─────────────────────────────────────────────────────

interface WidgetInstanceItemProps {
  widget: StudioWidget;
  isSelected: boolean;
  onSelect: (id: string) => void;
}

function WidgetInstanceItem({ widget, isSelected, onSelect }: WidgetInstanceItemProps) {
  const widgetKindLabels = useWidgetKindLabels();
  const localeText = useStudioLocaleText();

  return (
    <Paper
      variant="outlined"
      onClick={() => onSelect(widget.id)}
      tabIndex={0}
      role="button"
      aria-label={localeText.addWidgetSelectAriaLabel(widget.title || widget.kind)}
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
        cursor: 'default',
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
          {widget.title || widgetKindLabels[widget.kind]}
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

export interface WidgetInstanceListProps {
  kind: StudioWidgetKind;
  onBack: () => void;
  onAdd: (kind: StudioWidgetKind) => void;
}

export function WidgetInstanceList({ kind, onBack, onAdd }: WidgetInstanceListProps) {
  const localeText = useStudioLocaleText();
  const controller = useStudioController();
  const shell = useStudioSelector(selectShell);
  const selectedWidgetId = shell.selectedWidgetId;
  const activePage = useStudioSelector(selectActivePage);
  const widgetRows = React.useMemo(() => activePage?.widgetRows ?? [], [activePage]);
  const widgets = useStudioSelector(selectWidgets);
  const customWidgetMap = useCustomWidgetMap();

  const pageWidgetIds = React.useMemo(() => new Set(widgetRows.flat()), [widgetRows]);

  const widgetsOfKind = React.useMemo(
    () => Object.values(widgets).filter((w) => w.kind === kind && pageWidgetIds.has(w.id)),
    [widgets, kind, pageWidgetIds],
  );

  const builtIn = WIDGET_TYPES.find((w) => w.kind === kind);
  const customDef = customWidgetMap.get(kind);
  const kindInfo = getBuiltInWidgetKindInfo(localeText);
  const localizedBuiltIn = builtIn ? { ...builtIn, ...(kindInfo[kind] ?? {}) } : null;
  const wt = localizedBuiltIn ?? {
    kind,
    label: customDef?.label ?? kind,
    description: customDef?.description ?? localeText.composeCustomWidgetDescription,
    icon: customDef?.icon ?? null,
  };

  return (
    <Stack spacing={1.5}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <IconButton
          size="small"
          onClick={onBack}
          aria-label={localeText.composeBackToWidgetTypesAriaLabel}
        >
          <ArrowBackIcon fontSize="small" />
        </IconButton>
        <Box sx={{ color: 'primary.main', display: 'flex' }}>{wt.icon}</Box>
        <Typography variant="subtitle2">{wt.label}</Typography>
      </Box>

      <Divider />

      {widgetsOfKind.length > 0 && (
        <Stack spacing={0.75}>
          <Typography variant="caption" color="text.secondary">
            {localeText.composeOnThisPage}
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
        {localeText.composeAddWidgetLabel(wt.label)}
      </Button>
    </Stack>
  );
}
