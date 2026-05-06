'use client';
import * as React from 'react';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import BoltIcon from '@mui/icons-material/Bolt';
import {
  Box,
  FormControlLabel,
  IconButton,
  InputAdornment,
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
} from '../context';
import { inferWidgetTitles } from '../internals/widgetUtils';

export function FormatPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector(selectWidgets)[widgetId];
  const dataSources = useStudioSelector(selectDataSources);
  const [title, setTitle] = React.useState(widget?.title ?? '');
  const [subtitle, setSubtitle] = React.useState(widget?.subtitle ?? '');
  const [titleDirty, setTitleDirty] = React.useState(false);
  const [subtitleDirty, setSubtitleDirty] = React.useState(false);

  const isAutoTitle = widget?.titleMode === 'auto' || (!widget?.titleMode && !widget?.title);
  const isAutoSubtitle =
    widget?.subtitleMode === 'auto' || (!widget?.subtitleMode && !widget?.subtitle);

  React.useEffect(() => {
    setTitle(widget?.title ?? '');
    setSubtitle(widget?.subtitle ?? '');
    setTitleDirty(false);
    setSubtitleDirty(false);
  }, [widget?.title, widget?.subtitle, widgetId]);

  const handleTitleBlur = () => {
    if (!titleDirty) {
      return;
    }
    const trimmed = title.trim();
    if (trimmed !== (widget?.title ?? '')) {
      controller.updateWidget(widgetId, { title: trimmed, titleMode: 'manual' });
    }
    setTitleDirty(false);
  };

  const handleResetTitle = () => {
    if (!widget) {
      return;
    }
    const inferred = inferWidgetTitles(widget, dataSources);
    controller.updateWidget(widgetId, { title: inferred.title, titleMode: 'auto' });
    setTitle(inferred.title);
  };

  const handleSubtitleBlur = () => {
    if (!subtitleDirty) {
      return;
    }
    const trimmed = subtitle.trim();
    if (trimmed !== (widget?.subtitle ?? '')) {
      controller.updateWidget(widgetId, {
        subtitle: trimmed || undefined,
        subtitleMode: trimmed ? 'manual' : 'auto',
      });
    }
    setSubtitleDirty(false);
  };

  const handleResetSubtitle = () => {
    if (!widget) {
      return;
    }
    const inferred = inferWidgetTitles(widget, dataSources);
    controller.updateWidget(widgetId, { subtitle: inferred.subtitle, subtitleMode: 'auto' });
    setSubtitle(inferred.subtitle);
  };

  return (
    <Stack spacing={2}>
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
          label="Compact numbers"
        />
      )}
      <TextField
        label="Widget title"
        size="small"
        fullWidth
        helperText="Shown in the widget header"
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
          setTitleDirty(true);
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
                {isAutoTitle && title === (widget?.title ?? '') ? (
                  <Tooltip title="Auto-generated title">
                    <BoltIcon fontSize="small" color="action" />
                  </Tooltip>
                ) : !isAutoTitle ? (
                  <Tooltip title="Reset to auto-generated title">
                    <IconButton size="small" onClick={handleResetTitle} edge="end">
                      <AutorenewIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                ) : null}
              </InputAdornment>
            ),
          },
        }}
      />
      <TextField
        label="Subtitle"
        size="small"
        fullWidth
        helperText="Optional line shown beneath the title"
        value={subtitle}
        placeholder={isAutoSubtitle ? '' : 'No subtitle'}
        onChange={(event) => {
          setSubtitle(event.target.value);
          setSubtitleDirty(true);
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
                {isAutoSubtitle && subtitle === (widget?.subtitle ?? '') ? (
                  <Tooltip title="Auto-generated subtitle">
                    <BoltIcon fontSize="small" color="action" />
                  </Tooltip>
                ) : !isAutoSubtitle ? (
                  <Tooltip title="Reset to auto-generated subtitle">
                    <IconButton size="small" onClick={handleResetSubtitle} edge="end">
                      <AutorenewIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                ) : null}
              </InputAdornment>
            ),
          },
        }}
      />
    </Stack>
  );
}
