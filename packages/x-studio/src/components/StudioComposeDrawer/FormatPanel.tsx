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
  selectWidgets,
  selectDataSources,
  selectFilters,
  useStudioLocaleText,
} from '../../context';
import { inferWidgetTitles, inferKpiDateSubtitle } from '../../internals/widgetUtils';

export function FormatPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector(selectWidgets)[widgetId];
  const dataSources = useStudioSelector(selectDataSources);
  const allFilters = useStudioSelector(selectFilters);
  const localeText = useStudioLocaleText();
  const [formState, setFormState] = React.useState({
    title: widget?.title ?? '',
    subtitle: widget?.subtitle ?? '',
    titleDirty: false,
    subtitleDirty: false,
  });
  const { title, subtitle, titleDirty, subtitleDirty } = formState;

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
      return inferKpiDateSubtitle(widget, allFilters, localeText) ?? '';
    }
    return null;
  }, [widget, isAutoSubtitle, allFilters, localeText]);

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- form state is intentionally reset when widget/page changes
  React.useEffect(() => {
    // react-doctor-disable-next-line react-doctor/no-derived-state -- locally buffered editable fields; saved on blur
    setFormState({
      title: widget?.title ?? '',
      subtitle: widget?.subtitle ?? '',
      titleDirty: false,
      subtitleDirty: false,
    });
  }, [widget?.title, widget?.subtitle, widgetId]);

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

  const handleResetSubtitle = () => {
    if (!widget) {
      return;
    }
    const inferred = inferWidgetTitles(widget, dataSources, localeText);
    controller.updateWidget(widgetId, { subtitle: inferred.subtitle, subtitleMode: 'auto' });
    setFormState((prev) => ({ ...prev, subtitle: inferred.subtitle }));
  };

  const hasKindControls =
    widget?.kind === 'kpi' || widget?.kind === 'grid' || widget?.kind === 'map';

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
              checked={widget.config.kpiCompact ?? true}
              onChange={(event) =>
                controller.updateWidgetConfig(widgetId, { kpiCompact: event.target.checked })
              }
            />
          }
          label={localeText.formatPanelCompactNumbers}
        />
      )}
      {widget?.kind === 'grid' && (
        <TextField
          label={localeText.gridSetupHeightLabel}
          type="number"
          size="small"
          fullWidth
          value={widget.config.gridHeight ?? 400}
          slotProps={{ htmlInput: { min: 200, step: 50 } }}
          onChange={(event) => {
            const parsed = parseInt(event.target.value, 10);
            if (!Number.isNaN(parsed) && parsed >= 200) {
              controller.updateWidgetConfig(widgetId, { gridHeight: parsed });
            }
          }}
        />
      )}
      {widget?.kind === 'map' &&
        (() => {
          const mapLegendPosition = (widget.config.mapLegendPosition ?? 'bottom') as string;
          const mapLegendAlign = (widget.config.mapLegendAlign ?? 'center') as string;
          const isVerticalLegend = mapLegendPosition === 'left' || mapLegendPosition === 'right';
          return (
            <React.Fragment>
              <FormControl size="small" fullWidth>
                <InputLabel>{localeText.mapSetupLegendPositionLabel}</InputLabel>
                <Select
                  label={localeText.mapSetupLegendPositionLabel}
                  value={mapLegendPosition}
                  onChange={(event) =>
                    controller.updateWidgetConfig(widgetId, {
                      mapLegendPosition: event.target.value as
                        | 'bottom'
                        | 'top'
                        | 'left'
                        | 'right'
                        | 'hidden',
                    })
                  }
                >
                  <MenuItem value="bottom">{localeText.mapSetupLegendBottom}</MenuItem>
                  <MenuItem value="top">{localeText.mapSetupLegendTop}</MenuItem>
                  <MenuItem value="left">{localeText.mapSetupLegendLeft}</MenuItem>
                  <MenuItem value="right">{localeText.mapSetupLegendRight}</MenuItem>
                  <MenuItem value="hidden">{localeText.mapSetupLegendHidden}</MenuItem>
                </Select>
              </FormControl>
              {mapLegendPosition !== 'hidden' && (
                <FormControl size="small" fullWidth>
                  <InputLabel>{localeText.mapSetupLegendAlignLabel}</InputLabel>
                  <Select
                    label={localeText.mapSetupLegendAlignLabel}
                    value={mapLegendAlign}
                    onChange={(event) =>
                      controller.updateWidgetConfig(widgetId, {
                        mapLegendAlign: event.target.value as 'start' | 'center' | 'end',
                      })
                    }
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
        })()}
    </Stack>
  );
}
