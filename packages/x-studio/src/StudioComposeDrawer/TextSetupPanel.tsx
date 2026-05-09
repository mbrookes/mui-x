'use client';
import * as React from 'react';
import { Stack, TextField } from '@mui/material';
import { useStudioController, useStudioSelector, selectWidgets } from '../context';

export function TextSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector(selectWidgets)[widgetId];
  const [form, setForm] = React.useState({
    title: widget?.title ?? '',
    subtitle: widget?.config.textSubtitle ?? '',
    body: widget?.config.textBody ?? '',
  });

  React.useEffect(() => {
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

  const handleBlur = () => {
    controller.updateWidgetConfig(widgetId, {
      textSubtitle: form.subtitle,
      textBody: form.body,
    });
  };

  return (
    <Stack spacing={2}>
      <TextField
        label="Title"
        size="small"
        fullWidth
        helperText="Heading displayed at the top of the widget"
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
        label="Subtitle"
        size="small"
        fullWidth
        helperText="Smaller text below the heading"
        value={form.subtitle}
        onChange={(event) => setForm((prev) => ({ ...prev, subtitle: event.target.value }))}
        onBlur={handleBlur}
      />
      <TextField
        label="Body"
        fullWidth
        multiline
        minRows={5}
        helperText="Main content of the widget; supports plain text"
        value={form.body}
        onChange={(event) => setForm((prev) => ({ ...prev, body: event.target.value }))}
        onBlur={handleBlur}
      />
    </Stack>
  );
}
