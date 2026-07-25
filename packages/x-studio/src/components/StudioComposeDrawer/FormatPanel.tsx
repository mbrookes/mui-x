'use client';
import * as React from 'react';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import BoltIcon from '@mui/icons-material/Bolt';
import {
  Divider,
  FormControl,
  FormControlLabel,
  IconButton,
  InputAdornment,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Tooltip,
} from '@mui/material';
import {
  useStudioController,
  useStudioSelector,
  makeSelectWidget,
  selectDataSources,
  selectFilters,
  selectActivePageId,
  selectCrossFilterAllPages,
  useStudioLocaleText,
} from '../../context';
import { inferWidgetTitles, inferKpiDateSubtitle } from '../../internals/widgetUtils';
import type { StudioLocaleText } from '../../internals/StudioUIConfigContext';
import type { StudioWidgetConfig } from '../../models';
import { GridConditionalFormatSection } from './GridConditionalFormatSection';

type LegendPosition = 'bottom' | 'top' | 'left' | 'right' | 'hidden';
type LegendAlign = 'start' | 'center' | 'end';

/**
 * Shared legend position/alignment controls, used by both the map and heatmap
 * sections below. Extracted so the two ~60-line near-identical blocks (differing
 * only in the config-key prefix, `map*` vs `heat*`) can't drift apart
 * (architecture review 2.6, first bullet).
 */
function LegendPositionSection(props: {
  legendPosition: LegendPosition;
  legendAlign: LegendAlign;
  onPositionChange: (value: LegendPosition) => void;
  onAlignChange: (value: LegendAlign) => void;
  localeText: StudioLocaleText;
}) {
  const { legendPosition, legendAlign, onPositionChange, onAlignChange, localeText } = props;
  const isVerticalLegend = legendPosition === 'left' || legendPosition === 'right';
  return (
    <React.Fragment>
      <FormControl size="small" fullWidth>
        <InputLabel>{localeText.mapSetupLegendPositionLabel}</InputLabel>
        <Select
          label={localeText.mapSetupLegendPositionLabel}
          value={legendPosition}
          onChange={(event) => onPositionChange(event.target.value as LegendPosition)}
        >
          <MenuItem value="top">{localeText.mapSetupLegendTop}</MenuItem>
          <MenuItem value="bottom">{localeText.mapSetupLegendBottom}</MenuItem>
          <MenuItem value="left">{localeText.mapSetupLegendLeft}</MenuItem>
          <MenuItem value="right">{localeText.mapSetupLegendRight}</MenuItem>
          <MenuItem value="hidden">{localeText.mapSetupLegendHidden}</MenuItem>
        </Select>
      </FormControl>
      {legendPosition !== 'hidden' && (
        <FormControl size="small" fullWidth>
          <InputLabel>{localeText.mapSetupLegendAlignLabel}</InputLabel>
          <Select
            label={localeText.mapSetupLegendAlignLabel}
            value={legendAlign}
            onChange={(event) => onAlignChange(event.target.value as LegendAlign)}
          >
            <MenuItem value="start">
              {isVerticalLegend
                ? localeText.mapSetupLegendAlignStart
                : localeText.mapFormatLegendAlignLeft}
            </MenuItem>
            <MenuItem value="center">{localeText.mapSetupLegendAlignCenter}</MenuItem>
            <MenuItem value="end">
              {isVerticalLegend
                ? localeText.mapSetupLegendAlignEnd
                : localeText.mapFormatLegendAlignRight}
            </MenuItem>
          </Select>
        </FormControl>
      )}
    </React.Fragment>
  );
}

export function FormatPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const selectWidgetFn = React.useMemo(() => makeSelectWidget(widgetId), [widgetId]);
  const widget = useStudioSelector(selectWidgetFn);
  // This panel renders controls for several widget kinds and reads their config
  // keys behind per-kind `widget?.kind === …` branches. Because the widget union
  // includes a custom-kind member (which defeats automatic discriminated
  // narrowing), read config through the flat cross-kind `StudioWidgetConfig`.
  const config = widget?.config as StudioWidgetConfig | undefined;
  const dataSources = useStudioSelector(selectDataSources);
  const allFilters = useStudioSelector(selectFilters);
  const activePageId = useStudioSelector(selectActivePageId);
  const crossFilterAllPages = useStudioSelector(selectCrossFilterAllPages);
  const localeText = useStudioLocaleText();
  const [formState, setFormState] = React.useState({
    title: widget?.title ?? '',
    subtitle: widget?.subtitle ?? '',
    titleDirty: false,
    subtitleDirty: false,
    // Local text buffer for the grid-height input (Finding 1.3): kept separate from
    // `config?.gridHeight` so keystrokes are never dropped by clamp validation —
    // clamping/committing only happens on blur (see `handleGridHeightBlur`).
    gridHeight: String(config?.gridHeight ?? 400),
    gridHeightDirty: false,
  });
  const { title, subtitle, titleDirty, subtitleDirty, gridHeight, gridHeightDirty } = formState;

  const isAutoTitle = widget?.titleMode === 'auto' || (!widget?.titleMode && !widget?.title);
  const isAutoSubtitle =
    widget?.subtitleMode === 'auto' || (!widget?.subtitleMode && !widget?.subtitle);

  // KPI widgets derive their subtitle dynamically from active date filters (same as the card).
  // Show it in the text field so the user sees what the card displays.
  const effectiveAutoSubtitle = React.useMemo(() => {
    if (!widget || !isAutoSubtitle) {
      return null;
    }
    if (widget.kind === 'kpi') {
      return (
        inferKpiDateSubtitle(
          widget,
          allFilters,
          { activePageId, crossFilterAllPages },
          localeText,
        ) ?? ''
      );
    }
    return null;
  }, [widget, isAutoSubtitle, allFilters, activePageId, crossFilterAllPages, localeText]);

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- form state is intentionally reset when widget/page changes
  React.useEffect(() => {
    // react-doctor-disable-next-line react-doctor/no-derived-state -- locally buffered editable fields; saved on blur
    setFormState({
      title: widget?.title ?? '',
      subtitle: widget?.subtitle ?? '',
      titleDirty: false,
      subtitleDirty: false,
      gridHeight: String(config?.gridHeight ?? 400),
      gridHeightDirty: false,
    });
  }, [widget?.title, widget?.subtitle, widgetId, config?.gridHeight]);

  const handleTitleBlur = () => {
    if (!titleDirty) {
      return;
    }
    const trimmed = title.trim();
    if (trimmed !== (widget?.title ?? '')) {
      controller.updateWidget(widgetId, { title: trimmed, titleMode: 'manual' });
    }
    setFormState((prev) => ({ ...prev, titleDirty: false }));
  };

  const handleResetTitle = () => {
    if (!widget) {
      return;
    }
    const inferred = inferWidgetTitles(widget, dataSources, localeText);
    controller.updateWidget(widgetId, { title: inferred.title, titleMode: 'auto' });
    setFormState((prev) => ({ ...prev, title: inferred.title }));
  };

  const handleSubtitleBlur = () => {
    if (!subtitleDirty) {
      return;
    }
    const trimmed = subtitle.trim();
    if (trimmed !== (widget?.subtitle ?? '')) {
      controller.updateWidget(widgetId, {
        subtitle: trimmed || undefined,
        subtitleMode: 'manual',
      });
    }
    setFormState((prev) => ({ ...prev, subtitleDirty: false }));
  };

  // Commits the buffered grid-height text on blur (or Enter), clamping to the
  // documented minimum of 200px instead of silently dropping invalid keystrokes.
  const handleGridHeightBlur = () => {
    if (!gridHeightDirty) {
      return;
    }
    const parsed = parseInt(gridHeight, 10);
    const clamped = Number.isNaN(parsed) ? (config?.gridHeight ?? 400) : Math.max(200, parsed);
    if (clamped !== (config?.gridHeight ?? 400)) {
      controller.updateWidgetConfig(widgetId, { gridHeight: clamped });
    }
    setFormState((prev) => ({ ...prev, gridHeight: String(clamped), gridHeightDirty: false }));
  };

  const handleResetSubtitle = () => {
    if (!widget) {
      return;
    }
    const inferred = inferWidgetTitles(widget, dataSources, localeText);
    controller.updateWidget(widgetId, { subtitle: inferred.subtitle, subtitleMode: 'auto' });
    setFormState((prev) => ({ ...prev, subtitle: inferred.subtitle }));
  };

  const hasKindControls =
    widget?.kind === 'kpi' ||
    widget?.kind === 'grid' ||
    widget?.kind === 'map' ||
    (widget?.kind === 'chart' && config?.chartType === 'heatmap');

  return (
    <Stack spacing={2}>
      <TextField
        label={localeText.formatPanelWidgetTitleLabel}
        size="small"
        fullWidth
        helperText={localeText.formatPanelWidgetTitleHelperText}
        value={title}
        onChange={(event) => {
          setFormState((prev) => ({ ...prev, title: event.target.value, titleDirty: true }));
        }}
        onBlur={handleTitleBlur}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            handleTitleBlur();
          }
        }}
        slotProps={{
          input: {
            endAdornment: (
              <InputAdornment position="end">
                {(() => {
                  if (isAutoTitle && title === (widget?.title ?? '')) {
                    return (
                      <Tooltip title={localeText.formatAutoTitle}>
                        <BoltIcon fontSize="small" color="action" />
                      </Tooltip>
                    );
                  }
                  if (!isAutoTitle) {
                    return (
                      <Tooltip title={localeText.formatResetTitle}>
                        <IconButton size="small" onClick={handleResetTitle} edge="end">
                          <AutorenewIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    );
                  }
                  return null;
                })()}
              </InputAdornment>
            ),
          },
        }}
      />
      <TextField
        label={localeText.formatPanelSubtitleLabel}
        size="small"
        fullWidth
        helperText={localeText.formatPanelSubtitleHelperText}
        value={subtitleDirty ? subtitle : (effectiveAutoSubtitle ?? subtitle)}
        placeholder={isAutoSubtitle ? '' : localeText.formatPanelNoSubtitlePlaceholder}
        onChange={(event) => {
          setFormState((prev) => ({ ...prev, subtitle: event.target.value, subtitleDirty: true }));
        }}
        onBlur={handleSubtitleBlur}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            handleSubtitleBlur();
          }
        }}
        slotProps={{
          input: {
            endAdornment: (
              <InputAdornment position="end">
                {(() => {
                  if (isAutoSubtitle && subtitle === (widget?.subtitle ?? '')) {
                    return (
                      <Tooltip title={localeText.formatAutoSubtitle}>
                        <BoltIcon fontSize="small" color="action" />
                      </Tooltip>
                    );
                  }
                  if (!isAutoSubtitle) {
                    return (
                      <Tooltip title={localeText.formatResetSubtitle}>
                        <IconButton size="small" onClick={handleResetSubtitle} edge="end">
                          <AutorenewIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    );
                  }
                  return null;
                })()}
              </InputAdornment>
            ),
          },
        }}
      />
      {hasKindControls && <Divider />}
      {widget?.kind === 'kpi' && (
        <FormControlLabel
          slotProps={{ typography: { variant: 'body2' } }}
          control={
            <Switch
              size="small"
              checked={config?.kpiCompact ?? true}
              onChange={(event) =>
                controller.updateWidgetConfig(widgetId, { kpiCompact: event.target.checked })
              }
            />
          }
          label={localeText.formatPanelCompactNumbers}
        />
      )}
      {widget?.kind === 'grid' && (
        <React.Fragment>
          <TextField
            label={localeText.gridSetupHeightLabel}
            type="number"
            size="small"
            fullWidth
            value={gridHeight}
            slotProps={{ htmlInput: { min: 200, step: 50 } }}
            onChange={(event) => {
              setFormState((prev) => ({
                ...prev,
                gridHeight: event.target.value,
                gridHeightDirty: true,
              }));
            }}
            onBlur={handleGridHeightBlur}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                handleGridHeightBlur();
              }
            }}
          />
          <GridConditionalFormatSection widgetId={widgetId} />
        </React.Fragment>
      )}
      {widget?.kind === 'map' && (
        <LegendPositionSection
          legendPosition={(config?.mapLegendPosition ?? 'bottom') as LegendPosition}
          legendAlign={(config?.mapLegendAlign ?? 'center') as LegendAlign}
          onPositionChange={(value) =>
            controller.updateWidgetConfig(widgetId, { mapLegendPosition: value })
          }
          onAlignChange={(value) =>
            controller.updateWidgetConfig(widgetId, { mapLegendAlign: value })
          }
          localeText={localeText}
        />
      )}
      {widget?.kind === 'chart' && config?.chartType === 'heatmap' && (
        <LegendPositionSection
          legendPosition={(config?.heatLegendPosition ?? 'bottom') as LegendPosition}
          legendAlign={(config?.heatLegendAlign ?? 'center') as LegendAlign}
          onPositionChange={(value) =>
            controller.updateWidgetConfig(widgetId, { heatLegendPosition: value })
          }
          onAlignChange={(value) =>
            controller.updateWidgetConfig(widgetId, { heatLegendAlign: value })
          }
          localeText={localeText}
        />
      )}
    </Stack>
  );
}
