'use client';
import * as React from 'react';
import { Stack, TextField } from '@mui/material';
import {
  useStudioController,
  useStudioSelector,
  selectWidgets,
  useStudioLocaleText,
} from '../../context';

export function TextSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector(selectWidgets)[widgetId];
  const localeText = useStudioLocaleText();
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
      <TextField
        label={localeText.textSetupSubtitleLabel}
        size="small"
        fullWidth
        helperText={localeText.textSetupSubtitleHelper}
        value={form.subtitle}
        onChange={(event) => setForm((prev) => ({ ...prev, subtitle: event.target.value }))}
        onBlur={handleTextFieldBlur}
      />
      <TextField
        label={localeText.textSetupBodyLabel}
        fullWidth
        multiline
        minRows={5}
        helperText={localeText.textSetupBodyHelper}
        value={form.body}
        onChange={(event) => setForm((prev) => ({ ...prev, body: event.target.value }))}
        onBlur={handleTextFieldBlur}
      />
    </Stack>
  );
}
