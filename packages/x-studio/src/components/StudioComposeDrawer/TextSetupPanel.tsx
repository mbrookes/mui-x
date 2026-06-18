'use client';
import * as React from 'react';
import { FormControlLabel, Stack, Switch, TextField } from '@mui/material';
import {
  useStudioController,
  useStudioSelector,
  selectWidgets,
  useStudioLocaleText,
} from '../../context';
import { useStudioUIConfig } from '../../internals/StudioUIConfigContext';

export function TextSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector(selectWidgets)[widgetId];
  const localeText = useStudioLocaleText();
  const { aiConfig } = useStudioUIConfig();
  const [form, setForm] = React.useState({
    title: widget?.title ?? '',
    subtitle: widget?.config.textSubtitle ?? '',
    body: widget?.config.textBody ?? '',
  });

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- text fields are buffered locally; reset when widget/page changes
  React.useEffect(() => {
    // react-doctor-disable-next-line react-doctor/no-derived-state -- locally buffered; saved on blur
    setForm({
      title: widget?.title ?? '',
      subtitle: widget?.config.textSubtitle ?? '',
      body: widget?.config.textBody ?? '',
    });
  }, [widget?.title, widget?.config.textSubtitle, widget?.config.textBody, widgetId]);

  const aiEnabled = widget?.config.textAiEnabled ?? false;

  const handleTitleBlur = () => {
    if (form.title !== widget?.title) {
      controller.updateWidget(widgetId, { title: form.title });
    }
  };

  const handleTextFieldBlur = () => {
    controller.updateWidgetConfig(widgetId, {
      textSubtitle: form.subtitle,
      textBody: form.body,
    });
  };

  const handleAiToggle = () => {
    controller.updateWidgetConfig(widgetId, { textAiEnabled: !aiEnabled });
  };

  return (
    <Stack spacing={2}>
      <TextField
        label={localeText.textSetupTitleLabel}
        size="small"
        fullWidth
        helperText={localeText.textSetupTitleHelper}
        value={form.title}
        onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
        onBlur={handleTitleBlur}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            handleTitleBlur();
          }
        }}
      />
      {!!aiConfig && (
        <FormControlLabel
          control={<Switch checked={aiEnabled} onChange={handleAiToggle} size="small" />}
          label={localeText.textSetupAiModeLabel}
        />
      )}
      {!aiEnabled && (
        <TextField
          label={localeText.textSetupSubtitleLabel}
          size="small"
          fullWidth
          helperText={localeText.textSetupSubtitleHelper}
          value={form.subtitle}
          onChange={(event) => setForm((prev) => ({ ...prev, subtitle: event.target.value }))}
          onBlur={handleTextFieldBlur}
        />
      )}
      <TextField
        label={aiEnabled ? 'Prompt' : localeText.textSetupBodyLabel}
        fullWidth
        multiline
        minRows={5}
        helperText={
          aiEnabled
            ? 'Describe what the AI should write — it can query the data sources on this page'
            : localeText.textSetupBodyHelper
        }
        value={form.body}
        onChange={(event) => setForm((prev) => ({ ...prev, body: event.target.value }))}
        onBlur={handleTextFieldBlur}
      />
    </Stack>
  );
}
