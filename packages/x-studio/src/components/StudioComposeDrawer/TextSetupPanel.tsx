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
import type { StudioWidgetConfig, StudioWidgetConfigForKind } from '../../models';
import { useBufferedInput } from './useBufferedInput';

export function TextSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector(selectWidgets)[widgetId];
  const config = widget?.config as StudioWidgetConfigForKind<'text'> | undefined;
  const localeText = useStudioLocaleText();
  const { aiConfig } = useStudioUIConfig();
  // Three independent dirty-aware buffers (M15's shared `useBufferedInput`). They must be
  // independent: the compose drawer and the AI chat panel are usable at the same time, and
  // the AI tool surface includes `update_widget`, so an external write to (say) `textBody`
  // must not discard a subtitle the user is part-way through typing. A widget switch (the
  // `identity` argument) is the one case that discards a dirty buffer — an uncommitted edit
  // must never leak onto a different widget.
  const titleBuffer = useBufferedInput(widget?.title ?? '', widgetId);
  const subtitleBuffer = useBufferedInput(config?.textSubtitle ?? '', widgetId);
  const bodyBuffer = useBufferedInput(config?.textBody ?? '', widgetId);

  const aiEnabled = config?.textAiEnabled ?? false;

  const handleTitleBlur = () => {
    if (!titleBuffer.dirty) {
      return;
    }
    if (titleBuffer.value !== widget?.title) {
      controller.updateWidget(widgetId, { title: titleBuffer.value, titleMode: 'manual' });
    }
    titleBuffer.settle(titleBuffer.value);
  };

  // Commit only what actually changed. The unguarded version committed BOTH keys on every
  // blur, so two things went wrong: merely tabbing through the panel pushed undo entries
  // that change nothing (a later Ctrl+Z then appears to do nothing at all), and a config
  // with no `textSubtitle`/`textBody` key at all had `''` written into it — turning "unset,
  // inherit the default" into "explicitly empty", which persists into the doc and survives
  // export. The title field above already guards this way; this is the same guard.
  //
  // Subtitle and body share this one blur handler (either field's blur commits whichever of
  // the two actually changed), so both buffers are settled together.
  const handleTextFieldBlur = () => {
    if (!subtitleBuffer.dirty && !bodyBuffer.dirty) {
      return;
    }
    const changes: Partial<StudioWidgetConfig> = {};
    if (subtitleBuffer.value !== (config?.textSubtitle ?? '')) {
      changes.textSubtitle = subtitleBuffer.value;
    }
    if (bodyBuffer.value !== (config?.textBody ?? '')) {
      changes.textBody = bodyBuffer.value;
    }
    if (Object.keys(changes).length > 0) {
      controller.updateWidgetConfig(widgetId, changes);
    }
    subtitleBuffer.settle(subtitleBuffer.value);
    bodyBuffer.settle(bodyBuffer.value);
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
        value={titleBuffer.value}
        onChange={(event) => titleBuffer.setValue(event.target.value)}
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
          value={subtitleBuffer.value}
          onChange={(event) => subtitleBuffer.setValue(event.target.value)}
          onBlur={handleTextFieldBlur}
        />
      )}
      <TextField
        label={aiEnabled ? localeText.textSetupPromptLabel : localeText.textSetupBodyLabel}
        fullWidth
        multiline
        minRows={5}
        helperText={aiEnabled ? localeText.textSetupPromptHelper : localeText.textSetupBodyHelper}
        value={bodyBuffer.value}
        onChange={(event) => bodyBuffer.setValue(event.target.value)}
        onBlur={handleTextFieldBlur}
      />
    </Stack>
  );
}
