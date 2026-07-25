'use client';
import * as React from 'react';
import { Box, IconButton, TextField } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

import { ColorSwatch } from './ColorSwatch';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';

/**
 * Inline color swatch + text field. Uses native <input type="color"> for the picker.
 *
 * Finding 2.9: the text field used to call `onChange` (an undoable
 * `controller.updateWidgetConfig` at the call site) on every keystroke — typing a
 * 6-character hex value committed 6 separate undo entries. Buffer the typed text
 * locally and only commit on blur/Enter, mirroring the established
 * `AnnotationLabelInput` pattern (`ChartSetupPanel/AnnotationsEditorSection.tsx`).
 * The Clear button remains an immediate commit — it's a single deliberate action, not
 * a keystroke stream.
 *
 * M2: a buffered input MUST resync on the edited ENTITY's identity, not only on its
 * value. With `[value]` alone, re-pointing this input at a different entity that holds
 * the SAME value (typically `''` — neither widget has the colour set) never fires the
 * effect, so a still-dirty buffer from the previous entity survives and the next
 * blur/Enter commits it to the new one. The primary fix lives at the drawer level
 * (`StudioComposeDrawer` keys `WidgetConfigView` on the selected widget id, remounting
 * this subtree on a switch); `identity` is defense in depth for the other contexts this
 * reusable input is dropped into.
 */
export function ColorInput({
  label,
  value,
  onChange,
  placeholder,
  identity,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /**
   * Identifies the entity being edited (e.g. `` `${widgetId}:titleColor` ``). Changing it
   * discards any dirty buffer, so an uncommitted edit can never leak onto a different
   * entity that happens to hold the same value.
   */
  identity?: string;
}) {
  const localeText = useStudioLocaleText();
  const [text, setText] = React.useState(value);
  const [dirty, setDirty] = React.useState(false);

  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- buffered text mirrors the committed value; resync on external change (undo/redo, clear, swatch drag) AND on `identity` (see M2 above — `[value]` alone cannot tell "same value, different entity" from "no change")
  React.useEffect(() => {
    setText(value);
    setDirty(false);
  }, [value, identity]);

  const commit = () => {
    if (!dirty) {
      return;
    }
    onChange(text);
    setDirty(false);
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <ColorSwatch
        value={value}
        onChange={onChange}
        label={localeText.colorInputPickerAriaLabel(label)}
      />
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
        placeholder={placeholder ?? '#rrggbb'}
        sx={{ flexGrow: 1 }}
        slotProps={{
          htmlInput: { spellCheck: false },
          input: value
            ? {
                endAdornment: (
                  <IconButton
                    size="small"
                    edge="end"
                    aria-label={localeText.colorInputClearAriaLabel(label)}
                    onClick={() => {
                      setText('');
                      setDirty(false);
                      onChange('');
                    }}
                  >
                    <CloseIcon fontSize="small" />
                  </IconButton>
                ),
              }
            : undefined,
        }}
      />
    </Box>
  );
}
