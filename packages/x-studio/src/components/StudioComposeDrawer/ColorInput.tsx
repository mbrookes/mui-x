'use client';
import * as React from 'react';
import { Box, IconButton, TextField } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

import { ColorSwatch } from './ColorSwatch';
import { useBufferedInput } from './useBufferedInput';
import { useStudioLocaleText } from '../../internals/StudioUIConfigContext';

/**
 * Inline color swatch + text field. Uses native <input type="color"> for the picker.
 *
 * The text field used to call `onChange` (an undoable
 * `controller.updateWidgetConfig` at the call site) on every keystroke — typing a
 * 6-character hex value committed 6 separate undo entries. Buffer the typed text
 * locally through the shared `useBufferedInput` and only commit on blur/Enter. The Clear
 * button remains an immediate commit — it's a single deliberate action, not a keystroke
 * stream.
 *
 * A buffered input MUST resync on the edited ENTITY's identity, not only on its value —
 * see `useBufferedInput`, which owns that rule for every buffered control now. The primary
 * fix lives at the drawer level (`StudioComposeDrawer` keys `WidgetConfigView` on the
 * selected widget id, remounting this subtree on a switch); `identity` is defense in depth
 * for the other contexts this reusable input is dropped into.
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
   *
   * REQUIRED: it used to be optional with an `''` default, which silently disabled the discard for
   * any caller that forgot it — the exact defect `identity` exists to prevent, made invisible. A
   * missing identity is a caller bug, so it is a type error.
   */
  identity: string;
}) {
  const localeText = useStudioLocaleText();
  const { value: text, dirty, setValue, settle } = useBufferedInput(value, identity);

  const commit = () => {
    if (!dirty) {
      return;
    }
    // "Dirty" only means the buffer was TYPED IN, not that it differs from the committed
    // value: editing `#ff0000` and undoing the edit by hand before blurring leaves `dirty`
    // set with an identical value. `onChange` is an undoable `updateWidgetConfig` at every
    // call site, so committing that would push an undo entry whose content matches its
    // predecessor and a later Ctrl+Z would appear to do nothing.
    if (text !== value) {
      onChange(text);
    }
    settle(text);
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <ColorSwatch
        value={value}
        onChange={onChange}
        identity={identity}
        label={localeText.colorInputPickerAriaLabel(label)}
      />
      <TextField
        size="small"
        label={label}
        value={text}
        onChange={(event) => {
          setValue(event.target.value);
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
                      settle('');
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
