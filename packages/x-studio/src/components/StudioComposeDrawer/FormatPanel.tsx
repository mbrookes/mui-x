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
  Typography,
} from '@mui/material';
import { inferWidgetTitles, inferKpiDateSubtitle } from '@mui/x-studio-core/engine';
import type { StudioLocaleText } from '@mui/x-studio-core/engine';
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
import { STUDIO_COLUMN_ALIGNS, STUDIO_DATE_FORMATS } from '../../models';
import type {
  StudioColumnAlign,
  StudioDateFormat,
  StudioGridColumn,
  StudioWidgetConfig,
} from '../../models';
import { GridConditionalFormatSection } from './GridConditionalFormatSection';
import { useBufferedInput } from './useBufferedInput';

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
  // MUI's `Select` only emits `aria-labelledby` when it is handed an explicit `labelId`, and
  // `InputLabel` does not derive an `id`/`htmlFor` from `FormControl` context — the `label`
  // prop merely sizes the outline notch. Without this pairing the combobox has NO accessible
  // name at all (`combobox` is not a name-from-content role). Pair every `InputLabel`/`Select`
  // with a `React.useId()` value, as `FieldDetailView` already does.
  const positionLabelId = React.useId();
  const alignLabelId = React.useId();
  return (
    <React.Fragment>
      <FormControl size="small" fullWidth>
        <InputLabel id={positionLabelId}>{localeText.mapSetupLegendPositionLabel}</InputLabel>
        <Select
          labelId={positionLabelId}
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
          <InputLabel id={alignLabelId}>{localeText.mapSetupLegendAlignLabel}</InputLabel>
          <Select
            labelId={alignLabelId}
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
  // Three independent dirty-aware buffers (M15's shared `useBufferedInput`). They must be
  // independent: the compose drawer and the AI chat panel are usable at the same time, and the
  // AI tool surface includes `update_widget`, so an external write to (say) `subtitle` must
  // not discard a title the user is part-way through typing. `gridHeight` is buffered for the
  // additional reason that keystrokes must never be dropped by clamp validation — the clamp
  // only runs on blur. A widget switch (the
  // `identity` argument) is the one case that discards a dirty buffer.
  const titleBuffer = useBufferedInput(widget?.title ?? '', widgetId);
  const subtitleBuffer = useBufferedInput(widget?.subtitle ?? '', widgetId);
  const gridHeightBuffer = useBufferedInput(String(config?.gridHeight ?? 400), widgetId);
  const { value: title, dirty: titleDirty } = titleBuffer;
  const { value: subtitle, dirty: subtitleDirty } = subtitleBuffer;
  const { value: gridHeight, dirty: gridHeightDirty } = gridHeightBuffer;

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

  const handleTitleBlur = () => {
    if (!titleDirty) {
      return;
    }
    const trimmed = title.trim();
    if (trimmed !== (widget?.title ?? '')) {
      controller.updateWidget(widgetId, { title: trimmed, titleMode: 'manual' });
    }
    titleBuffer.settle(title);
  };

  const handleResetTitle = () => {
    if (!widget) {
      return;
    }
    const inferred = inferWidgetTitles(widget, dataSources, localeText);
    controller.updateWidget(widgetId, { title: inferred.title, titleMode: 'auto' });
    titleBuffer.settle(inferred.title);
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
    subtitleBuffer.settle(subtitle);
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
    gridHeightBuffer.settle(String(clamped));
  };

  const handleResetSubtitle = () => {
    if (!widget) {
      return;
    }
    const inferred = inferWidgetTitles(widget, dataSources, localeText);
    controller.updateWidget(widgetId, { subtitle: inferred.subtitle, subtitleMode: 'auto' });
    subtitleBuffer.settle(inferred.subtitle);
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
          titleBuffer.setValue(event.target.value);
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
          subtitleBuffer.setValue(event.target.value);
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
              gridHeightBuffer.setValue(event.target.value);
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
      {widget?.kind === 'grid' && <GridColumnFormatSection widgetId={widgetId} />}
    </Stack>
  );
}

/**
 * Per-column alignment and date presentation for a grid widget.
 *
 * The Format tab previously exposed only title/subtitle and compact mode, so the two
 * presentation choices a table actually needs — how a column is aligned, and how its dates read —
 * were reachable from no UI at all (AG_STUDIO_GAP_ANALYSIS XS-GRID-003). They were not stored
 * either; both fields are new on `StudioGridColumn`.
 *
 * Only columns the widget ALREADY has are listed. An unconfigured grid renders every field of its
 * source, and offering a formatting row per field would turn a wide table's Format tab into a
 * hundred pickers — the column list is the compose drawer's job, and this formats what that chose.
 */
function GridColumnFormatSection({ widgetId }: { widgetId: string }) {
  const controller = useStudioController();
  const localeText = useStudioLocaleText();
  const selectWidget = React.useMemo(() => makeSelectWidget(widgetId), [widgetId]);
  const widget = useStudioSelector(selectWidget);
  const dataSources = useStudioSelector(selectDataSources);
  const columns = (widget?.config as StudioWidgetConfig | undefined)?.columns ?? [];
  const source = widget?.sourceId ? dataSources[widget.sourceId] : undefined;

  const patchColumn = (fieldId: string, patch: Partial<StudioGridColumn>) => {
    controller.updateWidgetConfig(widgetId, {
      columns: columns.map((column) =>
        column.fieldId === fieldId ? { ...column, ...patch } : column,
      ),
    });
  };

  if (columns.length === 0) {
    return (
      <Stack spacing={0.5}>
        <Typography variant="subtitle2">{localeText.formatPanelColumnsSectionLabel}</Typography>
        <Typography variant="body2" color="text.secondary">
          {localeText.formatPanelColumnsEmpty}
        </Typography>
      </Stack>
    );
  }

  return (
    <Stack spacing={1.5}>
      <Stack spacing={0.5}>
        <Typography variant="subtitle2">{localeText.formatPanelColumnsSectionLabel}</Typography>
        <Typography variant="body2" color="text.secondary">
          {localeText.formatPanelColumnsSectionHelperText}
        </Typography>
      </Stack>
      {columns.map((column) => {
        const field = source?.fields.find((candidate) => candidate.id === column.fieldId);
        const label = column.label ?? field?.label ?? column.fieldId;
        // The date picker is offered only where it means something. On a non-date column it would
        // be a control that silently does nothing, which is worse than an absent one.
        const isDate = field?.type === 'date' || field?.type === 'datetime';
        return (
          <Stack key={column.fieldId} spacing={1}>
            <Typography variant="body2">{label}</Typography>
            <Stack direction="row" spacing={1}>
              <FormControl size="small" fullWidth>
                <InputLabel id={`align-${widgetId}-${column.fieldId}`}>
                  {localeText.formatPanelColumnAlignLabel}
                </InputLabel>
                <Select
                  labelId={`align-${widgetId}-${column.fieldId}`}
                  label={localeText.formatPanelColumnAlignLabel}
                  value={column.align ?? ''}
                  onChange={(event) =>
                    patchColumn(column.fieldId, {
                      // Empty string is the "Automatic" option. Written as `undefined` rather than
                      // `''` so the stored config carries no key at all — the absence IS the
                      // "follow the field type" default, and an empty string would be a third
                      // state the renderer would have to know about.
                      align: (event.target.value || undefined) as StudioColumnAlign | undefined,
                    })
                  }
                >
                  <MenuItem value="">{localeText.formatPanelColumnAutoOption}</MenuItem>
                  {STUDIO_COLUMN_ALIGNS.map((align) => (
                    <MenuItem key={align} value={align}>
                      {localeText.formatPanelColumnAlignOption(align)}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              {isDate && (
                <FormControl size="small" fullWidth>
                  <InputLabel id={`datefmt-${widgetId}-${column.fieldId}`}>
                    {localeText.formatPanelColumnDateFormatLabel}
                  </InputLabel>
                  <Select
                    labelId={`datefmt-${widgetId}-${column.fieldId}`}
                    label={localeText.formatPanelColumnDateFormatLabel}
                    value={column.dateFormat ?? ''}
                    onChange={(event) =>
                      patchColumn(column.fieldId, {
                        dateFormat: (event.target.value || undefined) as
                          | StudioDateFormat
                          | undefined,
                      })
                    }
                  >
                    <MenuItem value="">{localeText.formatPanelColumnAutoOption}</MenuItem>
                    {STUDIO_DATE_FORMATS.map((preset) => (
                      <MenuItem key={preset} value={preset}>
                        {localeText.formatPanelColumnDateFormatOption(preset)}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              )}
            </Stack>
          </Stack>
        );
      })}
    </Stack>
  );
}
