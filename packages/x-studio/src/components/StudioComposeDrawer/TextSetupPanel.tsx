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

export function TextSetupPanel(props: { widgetId: string }) {
  const { widgetId } = props;
  const controller = useStudioController();
  const widget = useStudioSelector(selectWidgets)[widgetId];
  const config = widget?.config as StudioWidgetConfigForKind<'text'> | undefined;
  const localeText = useStudioLocaleText();
  const { aiConfig } = useStudioUIConfig();
  const [form, setForm] = React.useState({
    title: widget?.title ?? '',
    subtitle: config?.textSubtitle ?? '',
    body: config?.textBody ?? '',
    // Per-field "was typed in" flags. They gate BOTH the commit (a blur with no edit must not
    // write anything) and the resync below.
    titleDirty: false,
    textDirty: false,
  });

  // Tracks which widget the buffer was last synced FOR, so a widget switch can be told apart
  // from an external edit to the widget already being edited. Only the former discards dirty
  // buffers (see the effect below).
  const syncedWidgetIdRef = React.useRef(widgetId);

  // Resync is PER FIELD and DIRTY-AWARE. Title, subtitle and body share one state object but
  // are independent buffers: the compose drawer and the AI chat panel are usable at the same
  // time, and the AI tool surface includes `update_widget`, so an external write to (say)
  // `textBody` fires this effect while the user is part-way through typing a subtitle.
  // Overwriting the WHOLE object then silently discarded that uncommitted subtitle. A dirty
  // field keeps its in-progress text; clean fields still track the store, so undo/redo and
  // external edits are reflected as before. Subtitle and body share one dirty flag because
  // they also share one blur handler, which commits whichever of the two actually changed —
  // so they are always committed, and therefore always cleaned, together.
  //
  // A widget switch is the one case that resets everything including the dirty flags — an
  // uncommitted edit must never leak onto a different widget.
  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- text fields are buffered locally; reset when widget/page changes
  React.useEffect(() => {
    const widgetChanged = syncedWidgetIdRef.current !== widgetId;
    syncedWidgetIdRef.current = widgetId;
    // react-doctor-disable-next-line react-doctor/no-derived-state -- locally buffered; saved on blur
    setForm((prev) => {
      const fromStore = {
        title: widget?.title ?? '',
        subtitle: config?.textSubtitle ?? '',
        body: config?.textBody ?? '',
      };
      if (widgetChanged) {
        return { ...fromStore, titleDirty: false, textDirty: false };
      }
      return {
        ...prev,
        ...(prev.titleDirty ? {} : { title: fromStore.title }),
        ...(prev.textDirty ? {} : { subtitle: fromStore.subtitle, body: fromStore.body }),
      };
    });
  }, [widget?.title, config?.textSubtitle, config?.textBody, widgetId]);

  const aiEnabled = config?.textAiEnabled ?? false;

  const handleTitleBlur = () => {
    if (!form.titleDirty) {
      return;
    }
    if (form.title !== widget?.title) {
      controller.updateWidget(widgetId, { title: form.title, titleMode: 'manual' });
    }
    setForm((prev) => ({ ...prev, titleDirty: false }));
  };

  // Commit only what actually changed. The unguarded version committed BOTH keys on every
  // blur, so two things went wrong: merely tabbing through the panel pushed undo entries
  // that change nothing (a later Ctrl+Z then appears to do nothing at all), and a config
  // with no `textSubtitle`/`textBody` key at all had `''` written into it — turning "unset,
  // inherit the default" into "explicitly empty", which persists into the doc and survives
  // export. The title field above already guards this way; this is the same guard.
  const handleTextFieldBlur = () => {
    if (!form.textDirty) {
      return;
    }
    const changes: Partial<StudioWidgetConfig> = {};
    if (form.subtitle !== (config?.textSubtitle ?? '')) {
      changes.textSubtitle = form.subtitle;
    }
    if (form.body !== (config?.textBody ?? '')) {
      changes.textBody = form.body;
    }
    if (Object.keys(changes).length > 0) {
      controller.updateWidgetConfig(widgetId, changes);
    }
    setForm((prev) => ({ ...prev, textDirty: false }));
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
        onChange={(event) =>
          setForm((prev) => ({ ...prev, title: event.target.value, titleDirty: true }))
        }
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
          onChange={(event) =>
            setForm((prev) => ({ ...prev, subtitle: event.target.value, textDirty: true }))
          }
          onBlur={handleTextFieldBlur}
        />
      )}
      <TextField
        label={aiEnabled ? localeText.textSetupPromptLabel : localeText.textSetupBodyLabel}
        fullWidth
        multiline
        minRows={5}
        helperText={aiEnabled ? localeText.textSetupPromptHelper : localeText.textSetupBodyHelper}
        value={form.body}
        onChange={(event) =>
          setForm((prev) => ({ ...prev, body: event.target.value, textDirty: true }))
        }
        onBlur={handleTextFieldBlur}
      />
    </Stack>
  );
}
