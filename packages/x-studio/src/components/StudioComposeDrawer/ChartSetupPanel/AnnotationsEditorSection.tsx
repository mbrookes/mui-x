'use client';
import * as React from 'react';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import {
  Divider,
  FormControl,
  IconButton,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { createIdFactory } from '@mui/x-studio-schema';
import { useStudioController, useStudioLocaleText } from '../../../context';
import type { StudioChartAnnotation } from '../../../models';

// Collision-resistant (timestamp + monotonic counter + random suffix) instead of the
// previous bare `Math.random()` — see `createIdFactory` in `@mui/x-studio-schema`.
const generateAnnotationId = createIdFactory('ann');

/**
 * Reference-line value input (architecture review finding 1.14): re-rendering the
 * controlled `value` from the doc on every keystroke meant a still-typing "10."
 * round-tripped through `Number('10.')` → `10` → back into the field as "10",
 * silently eating the trailing decimal point mid-edit. Buffer the displayed text
 * locally and only parse/commit on blur, mirroring `FormatPanel.tsx`'s grid-height
 * input. `value` may be a non-numeric string (an x-axis annotation on a band-scale
 * chart references an axis label, not a number) — an unparseable commit falls back
 * to the raw string, same as the original per-keystroke behavior.
 *
 * M2: the resync effect must also depend on `identity` (`${widgetId}:${ann.id}`). `value`
 * alone cannot distinguish "no change" from "same value, different annotation" — and
 * `key={ann.id}` is not enough either, because `duplicateWidget` clones `config` by
 * REFERENCE, so a duplicated widget carries identical annotation ids AND identical values.
 * Both the key and the effect then stay quiet across the switch and a dirty buffer from the
 * original widget commits onto the duplicate.
 */
function AnnotationValueInput(props: {
  value: number | string;
  label: string;
  identity: string;
  onCommit: (next: number | string) => void;
}) {
  const { value, label, identity, onCommit } = props;
  const [text, setText] = React.useState(String(value));
  const [dirty, setDirty] = React.useState(false);

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- buffered text mirrors the committed annotation value; resync on external change (undo/redo) AND on `identity` (see M2 above)
  React.useEffect(() => {
    setText(String(value));
    setDirty(false);
  }, [value, identity]);

  const commit = () => {
    if (!dirty) {
      return;
    }
    const raw = text.trim();
    if (raw === '') {
      // An emptied field reverts to the last committed value rather than silently
      // coercing to 0 (`Number('')` is `0`, not `NaN`).
      setText(String(value));
      setDirty(false);
      return;
    }
    const num = Number(raw);
    const next = Number.isNaN(num) ? raw : num;
    if (next !== value) {
      onCommit(next);
    }
    setText(String(next));
    setDirty(false);
  };

  return (
    <TextField
      size="small"
      label={label}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        setDirty(true);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commit();
        }
      }}
      sx={{ flexGrow: 1, minWidth: 0 }}
    />
  );
}

/**
 * Reference-line label input (architecture review finding 2.3): the value input
 * above was buffered first; this label field was missed and still called
 * `controller.updateWidgetConfig` on every keystroke — each an undoable commit plus
 * a mutation-log line plus a full pipeline recompute. Buffer the displayed text
 * locally and only commit on blur/Enter, mirroring `AnnotationValueInput` above.
 *
 * M2: `identity` is in the resync deps for the same reason as `AnnotationValueInput`.
 */
function AnnotationLabelInput(props: {
  value: string;
  label: string;
  identity: string;
  onCommit: (next: string) => void;
}) {
  const { value, label, identity, onCommit } = props;
  const [text, setText] = React.useState(value);
  const [dirty, setDirty] = React.useState(false);

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- buffered text mirrors the committed label; resync on external change (undo/redo) AND on `identity` (see M2 above)
  React.useEffect(() => {
    setText(value);
    setDirty(false);
  }, [value, identity]);

  const commit = () => {
    if (!dirty) {
      return;
    }
    onCommit(text);
    setDirty(false);
  };

  return (
    <TextField
      size="small"
      label={label}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        setDirty(true);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commit();
        }
      }}
      sx={{ flexGrow: 1, minWidth: 0 }}
    />
  );
}

export interface AnnotationsEditorSectionProps {
  widgetId: string;
  // Annotations are shared by exactly the bar / line-area / mixed / scatter families,
  // so this section takes a minimal STRUCTURAL prop rather than one family's config —
  // the flat `StudioChartConfig` the parent passes satisfies it.
  config: { annotations?: StudioChartAnnotation[] };
}

/** Reference-line (annotation) editor: add/edit/remove Y or X reference lines. */
export function AnnotationsEditorSection({ widgetId, config }: AnnotationsEditorSectionProps) {
  const controller = useStudioController();
  const localeText = useStudioLocaleText();
  const annotations = config.annotations ?? [];

  return (
    <div>
      <Divider sx={{ mb: 1.5 }} />
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1, fontWeight: 600 }}>
          {localeText.chartSetupAnnotationsTitle}
        </Typography>
        <Tooltip title={localeText.chartSetupAddReferenceLine}>
          <IconButton
            size="small"
            onClick={() => {
              const newAnn: StudioChartAnnotation = {
                id: generateAnnotationId(),
                axis: 'y',
                value: 0,
                label: '',
              };
              controller.updateWidgetConfig(widgetId, {
                annotations: [...annotations, newAnn],
              });
            }}
          >
            <AddIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      {annotations.length === 0 && (
        <Typography variant="caption" color="text.disabled" sx={{ fontStyle: 'italic' }}>
          {localeText.chartSetupNoReferenceLines}
        </Typography>
      )}
      <Stack spacing={1}>
        {annotations.map((ann) => (
          <Stack key={ann.id} direction="row" spacing={0.5} sx={{ alignItems: 'flex-start' }}>
            <FormControl size="small" sx={{ width: 56 }}>
              <Select
                value={ann.axis}
                aria-label={localeText.chartAnnotationAxisAriaLabel}
                onChange={(event) => {
                  controller.updateWidgetConfig(widgetId, {
                    annotations: annotations.map((a) =>
                      a.id === ann.id ? { ...a, axis: event.target.value as 'y' | 'x' } : a,
                    ),
                  });
                }}
              >
                <MenuItem value="y">Y</MenuItem>
                <MenuItem value="x">X</MenuItem>
              </Select>
            </FormControl>
            <AnnotationValueInput
              value={ann.value}
              identity={`${widgetId}:${ann.id}`}
              label={localeText.chartSetupReferenceLineValueLabel}
              onCommit={(next) => {
                controller.updateWidgetConfig(widgetId, {
                  annotations: annotations.map((a) =>
                    a.id === ann.id ? { ...a, value: next } : a,
                  ),
                });
              }}
            />
            <AnnotationLabelInput
              value={ann.label ?? ''}
              identity={`${widgetId}:${ann.id}`}
              label={localeText.chartSetupReferenceLineLabelLabel}
              onCommit={(next) => {
                controller.updateWidgetConfig(widgetId, {
                  annotations: annotations.map((a) =>
                    a.id === ann.id ? { ...a, label: next } : a,
                  ),
                });
              }}
            />
            <Tooltip title={localeText.chartSetupRemoveAnnotation}>
              <IconButton
                size="small"
                onClick={() => {
                  controller.updateWidgetConfig(widgetId, {
                    annotations: annotations.filter((a) => a.id !== ann.id),
                  });
                }}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        ))}
      </Stack>
    </div>
  );
}
