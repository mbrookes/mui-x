'use client';
import * as React from 'react';
import { Stack, TextField } from '@mui/material';
import { useStudioController, useStudioSelector } from '../context';

export function TextSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector((state) => state.widgets[widgetId]);
  const [title, setTitle] = React.useState(widget?.title ?? '');
  const [subtitle, setSubtitle] = React.useState(widget?.config.textSubtitle ?? '');
  const [body, setBody] = React.useState(widget?.config.textBody ?? '');

  React.useEffect(() => {
    setTitle(widget?.title ?? '');
    setSubtitle(widget?.config.textSubtitle ?? '');
    setBody(widget?.config.textBody ?? '');
  }, [widget?.title, widget?.config.textSubtitle, widget?.config.textBody, widgetId]);

  const handleTitleBlur = () => {
    if (title !== widget?.title) {
      controller.updateWidget(widgetId, { title });
    }
  };

  const handleBlur = () => {
    controller.updateWidgetConfig(widgetId, {
      textSubtitle: subtitle,
      textBody: body,
    });
  };

  return (
    <Stack spacing={2}>
      <TextField
        label="Title"
        size="small"
        fullWidth
        helperText="Heading displayed at the top of the widget"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
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
        value={subtitle}
        onChange={(event) => setSubtitle(event.target.value)}
        onBlur={handleBlur}
      />
      <TextField
        label="Body"
        fullWidth
        multiline
        minRows={5}
        helperText="Main content of the widget; supports plain text"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onBlur={handleBlur}
      />
    </Stack>
  );
}
