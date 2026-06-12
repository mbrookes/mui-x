'use client';
import * as React from 'react';
import AutorenewIcon from '@mui/icons-material/Autorenew';
import BoltIcon from '@mui/icons-material/Bolt';
import {
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
  useStudioLocaleText,
} from '../../context';
import { inferWidgetTitles } from '../../internals/widgetUtils';

export function FormatPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector(selectWidgets)[widgetId];
  const dataSources = useStudioSelector(selectDataSources);
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
    const inferred = inferWidgetTitles(widget, dataSources);
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
    const inferred = inferWidgetTitles(widget, dataSources);
    controller.updateWidget(widgetId, { subtitle: inferred.subtitle, subtitleMode: 'auto' });
    setFormState((prev) => ({ ...prev, subtitle: inferred.subtitle }));
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
          label={localeText.formatPanelCompactNumbers}
        />
      )}
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
        value={subtitle}
        placeholder={isAutoSubtitle ? '' : 'No subtitle'}
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
    </Stack>
  );
}
